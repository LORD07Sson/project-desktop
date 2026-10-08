// «VPN помощник» (вкладка разработчика, src/app/vpn-helper.js) — сетевые
// пробы до своего VPS с X-UI, запускаемые С КОМПЬЮТЕРА РАЗРАБОТЧИКА.
//
// Почему здесь, а не на сервере: блокировки (подмена DNS, DPI по SNI,
// блок IP или порта, «заморозка» после ~16 КБ у ТСПУ) видны только изнутри
// сети, где сидит клиент. Сервер про них ничего не знает — для него
// соединение просто не пришло. Сервер бота отдаёт только список inbound'ов
// из X-UI (порты, протоколы, SNI), а что из этого доходит — меряем тут.
//
// Осторожность (не светиться и не долбить сервер):
// - не больше двух соединений одновременно на всё приложение (PROBE_SLOTS);
// - перед каждым соединением случайная пауза, серии TCP идут с джиттером;
// - короткие таймауты, ограничение на размер чтения;
// - в пробах нет VPN-протокола: только TCP connect, обычный TLS ClientHello
//   (rustls) и, по запросу, один GET / на свой домен;
// - частоту прогонов и кэш держит JS-сторона, здесь — жёсткие потолки на
//   число попыток и цели, чтобы скомпрометированный webview не превратил
//   команду в сканер портов.

use std::net::{IpAddr, SocketAddr};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use rustls::client::danger::{HandshakeSignatureValid, ServerCertVerified, ServerCertVerifier};
use rustls::client::WebPkiServerVerifier;
use rustls::pki_types::{CertificateDer, ServerName, UnixTime};
use rustls::{ClientConfig, DigitallySignedStruct, RootCertStore, SignatureScheme};
use serde::Serialize;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpStream;
use tokio::sync::Semaphore;
use tokio::time::{sleep, timeout};

const CONNECT_TIMEOUT: Duration = Duration::from_secs(5);
const HANDSHAKE_TIMEOUT: Duration = Duration::from_secs(6);
const READ_TIMEOUT: Duration = Duration::from_secs(6);
const HTTP_TOTAL_TIMEOUT: Duration = Duration::from_secs(15);
// ТСПУ обычно «замораживает» TLS-сессию где-то на 14–24 КБ входящих
// данных; 96 КБ хватает, чтобы перешагнуть эту границу с запасом.
const HTTP_READ_CAP: usize = 96 * 1024;
const TCP_MAX_ATTEMPTS: u32 = 10;
// Обычный браузерный UA для одного GET / на свой домен — чтобы запрос
// в логах nginx выглядел как обычный заход, а не как подпись сканера.
const BROWSER_UA: &str = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36";

fn probe_slots() -> &'static Semaphore {
    static SLOTS: OnceLock<Semaphore> = OnceLock::new();
    SLOTS.get_or_init(|| Semaphore::new(2))
}

// Без отдельного крейта rand: xorshift от времени и счётчика — для
// джиттера пауз криптостойкость не нужна.
fn rand_between(lo: u64, hi: u64) -> u64 {
    static COUNTER: AtomicU64 = AtomicU64::new(0);
    let nanos = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_nanos() as u64).unwrap_or(0);
    let mut x = nanos ^ COUNTER.fetch_add(0x9E37_79B9_7F4A_7C15, Ordering::Relaxed);
    x ^= x << 13;
    x ^= x >> 7;
    x ^= x << 17;
    if hi <= lo { lo } else { lo + x % (hi - lo) }
}

async fn jitter(lo_ms: u64, hi_ms: u64) {
    sleep(Duration::from_millis(rand_between(lo_ms, hi_ms))).await;
}

// Доли миллисекунды важны: connect за 0–1 мс до удалённого сервера
// значит, что соединение перехватил локальный VPN/прокси (TUN), и пробы
// меряют его, а не реальную сеть, — JS это подсвечивает.
fn ms(since: Instant) -> f64 {
    (since.elapsed().as_micros() as f64 / 100.0).round() / 10.0
}

// Классы ошибок важнее текста: «refused» — порт закрыт на сервере (не
// блокировка), «reset» — RST посреди пути (типично для DPI), «timeout» —
// пакеты молча дропаются (блок IP/порта или DPI в режиме drop).
fn io_kind(e: &std::io::Error) -> &'static str {
    use std::io::ErrorKind::*;
    match e.kind() {
        ConnectionRefused => "refused",
        ConnectionReset | ConnectionAborted => "reset",
        TimedOut => "timeout",
        UnexpectedEof => "eof",
        HostUnreachable | NetworkUnreachable => "unreachable",
        _ => {
            // rustls заворачивает TLS-ошибки в io::Error(InvalidData).
            if let Some(inner) = e.get_ref().and_then(|i| i.downcast_ref::<rustls::Error>()) {
                return match inner {
                    rustls::Error::AlertReceived(_) => "tls_alert",
                    _ => "tls_other",
                };
            }
            "other"
        }
    }
}

fn check_host(host: &str) -> Result<(), String> {
    let h = host.trim();
    if h.is_empty() || h.len() > 253 {
        return Err("Пустой или слишком длинный адрес.".into());
    }
    if !h.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | ':' | '_')) {
        return Err("Адрес содержит недопустимые символы.".into());
    }
    Ok(())
}

async fn resolve_one(host: &str) -> Result<IpAddr, String> {
    check_host(host)?;
    if let Ok(ip) = host.parse::<IpAddr>() {
        return Ok(ip);
    }
    let mut addrs = tokio::net::lookup_host((host, 443)).await.map_err(|e| format!("DNS: {e}"))?;
    addrs.next().map(|a| a.ip()).ok_or_else(|| "DNS: пустой ответ".to_string())
}

// ---------- DNS ----------

#[derive(Serialize, Default)]
pub struct DohAnswer {
    resolver: String,
    ips: Vec<String>,
    ms: Option<f64>,
    error: Option<String>,
}

#[derive(Serialize)]
pub struct DnsReport {
    host: String,
    system: Vec<String>,
    system_ms: Option<f64>,
    system_error: Option<String>,
    doh: Vec<DohAnswer>,
    // Системный резолвер вернул адреса, которых нет ни у одного DoH-
    // резолвера, — признак подмены DNS провайдером.
    mismatch: bool,
}

async fn doh_query(client: &reqwest::Client, resolver: &str, url: &str) -> DohAnswer {
    let started = Instant::now();
    let mut out = DohAnswer { resolver: resolver.to_string(), ..Default::default() };
    let resp = client.get(url).header("accept", "application/dns-json").send().await;
    match resp {
        Ok(r) => match r.json::<serde_json::Value>().await {
            Ok(v) => {
                out.ms = Some(ms(started));
                out.ips = v["Answer"]
                    .as_array()
                    .map(|a| {
                        a.iter()
                            .filter(|x| x["type"].as_u64() == Some(1))
                            .filter_map(|x| x["data"].as_str().map(str::to_string))
                            .collect()
                    })
                    .unwrap_or_default();
            }
            Err(e) => out.error = Some(format!("ответ не JSON: {e}")),
        },
        Err(e) => out.error = Some(if e.is_timeout() { "timeout".into() } else { e.to_string() }),
    }
    out
}

#[tauri::command(async)]
pub async fn vpn_dns(host: String) -> Result<DnsReport, String> {
    let host = host.trim().to_ascii_lowercase();
    check_host(&host)?;
    if host.parse::<IpAddr>().is_ok() {
        return Err("Это IP-адрес, DNS проверять нечего.".into());
    }
    let _slot = probe_slots().acquire().await.map_err(|e| e.to_string())?;
    jitter(80, 300).await;

    let started = Instant::now();
    let (system, system_ms, system_error) = match timeout(CONNECT_TIMEOUT, tokio::net::lookup_host((host.as_str(), 443))).await {
        Ok(Ok(addrs)) => {
            let mut ips: Vec<String> = addrs.filter(|a| a.is_ipv4()).map(|a| a.ip().to_string()).collect();
            ips.sort();
            ips.dedup();
            (ips, Some(ms(started)), None)
        }
        Ok(Err(e)) => (vec![], None, Some(e.to_string())),
        Err(_) => (vec![], None, Some("timeout".to_string())),
    };

    let client = reqwest::Client::builder().timeout(CONNECT_TIMEOUT).build().map_err(|e| e.to_string())?;
    let name = urlencode(&host);
    let cf_url = format!("https://cloudflare-dns.com/dns-query?name={name}&type=A");
    let gg_url = format!("https://dns.google/resolve?name={name}&type=A");
    let cf = doh_query(&client, "Cloudflare", &cf_url);
    let gg = doh_query(&client, "Google", &gg_url);
    let (cf, gg) = tokio::join!(cf, gg);
    let doh = vec![cf, gg];

    let doh_ips: Vec<&String> = doh.iter().flat_map(|d| d.ips.iter()).collect();
    let mismatch = !system.is_empty() && !doh_ips.is_empty() && system.iter().any(|ip| !doh_ips.contains(&ip));
    Ok(DnsReport { host, system, system_ms, system_error, doh, mismatch })
}

fn urlencode(s: &str) -> String {
    s.bytes()
        .map(|b| if b.is_ascii_alphanumeric() || b == b'.' || b == b'-' { (b as char).to_string() } else { format!("%{b:02X}") })
        .collect()
}

// ---------- TCP ----------

#[derive(Serialize)]
pub struct TcpAttempt {
    ok: bool,
    ms: f64,
    error: Option<&'static str>,
}

#[derive(Serialize)]
pub struct TcpReport {
    ip: String,
    port: u16,
    attempts: Vec<TcpAttempt>,
    ok_count: u32,
    median_ms: Option<f64>,
    // Средний модуль разницы между соседними успешными попытками.
    jitter_ms: Option<f64>,
}

async fn tcp_connect(addr: SocketAddr) -> Result<(TcpStream, f64), (&'static str, f64)> {
    let started = Instant::now();
    match timeout(CONNECT_TIMEOUT, TcpStream::connect(addr)).await {
        Ok(Ok(s)) => Ok((s, ms(started))),
        Ok(Err(e)) => Err((io_kind(&e), ms(started))),
        Err(_) => Err(("timeout", ms(started))),
    }
}

#[tauri::command(async)]
pub async fn vpn_tcp(host: String, port: u16, count: Option<u32>) -> Result<TcpReport, String> {
    if port == 0 {
        return Err("Порт 0.".into());
    }
    let ip = resolve_one(host.trim()).await?;
    let count = count.unwrap_or(3).clamp(1, TCP_MAX_ATTEMPTS);
    let addr = SocketAddr::new(ip, port);
    let mut attempts = Vec::with_capacity(count as usize);
    for i in 0..count {
        let _slot = probe_slots().acquire().await.map_err(|e| e.to_string())?;
        if i > 0 {
            jitter(250, 900).await;
        } else {
            jitter(50, 250).await;
        }
        match tcp_connect(addr).await {
            Ok((mut s, t)) => {
                // Сразу закрываем, ничего не отправляя.
                let _ = s.shutdown().await;
                attempts.push(TcpAttempt { ok: true, ms: t, error: None });
            }
            Err((kind, t)) => attempts.push(TcpAttempt { ok: false, ms: t, error: Some(kind) }),
        }
    }
    let mut oks: Vec<f64> = attempts.iter().filter(|a| a.ok).map(|a| a.ms).collect();
    let jitter_ms = if oks.len() > 1 {
        let j = oks.windows(2).map(|w| (w[0] - w[1]).abs()).sum::<f64>() / (oks.len() as f64 - 1.0);
        Some((j * 10.0).round() / 10.0)
    } else {
        None
    };
    oks.sort_by(|a, b| a.total_cmp(b));
    let median_ms = oks.get(oks.len() / 2).copied();
    Ok(TcpReport { ip: ip.to_string(), port, ok_count: oks.len() as u32, attempts, median_ms, jitter_ms })
}

// ---------- TLS ----------

// Пропускает любой сертификат, но запоминает вердикт настоящего webpki-
// проверяющего: для Reality сертификат чужой (маскировочного сайта) и
// это нормально, а для своего домена хотим увидеть причину отказа, а не
// просто оборванное соединение.
#[derive(Debug)]
struct RecordingVerifier {
    inner: Arc<WebPkiServerVerifier>,
    verdict: Mutex<Option<Result<(), String>>>,
}

impl ServerCertVerifier for RecordingVerifier {
    fn verify_server_cert(
        &self,
        end_entity: &CertificateDer<'_>,
        intermediates: &[CertificateDer<'_>],
        server_name: &ServerName<'_>,
        ocsp_response: &[u8],
        now: UnixTime,
    ) -> Result<ServerCertVerified, rustls::Error> {
        let r = self.inner.verify_server_cert(end_entity, intermediates, server_name, ocsp_response, now);
        *self.verdict.lock().unwrap() = Some(r.map(|_| ()).map_err(|e| e.to_string()));
        Ok(ServerCertVerified::assertion())
    }
    fn verify_tls12_signature(&self, message: &[u8], cert: &CertificateDer<'_>, dss: &DigitallySignedStruct) -> Result<HandshakeSignatureValid, rustls::Error> {
        self.inner.verify_tls12_signature(message, cert, dss)
    }
    fn verify_tls13_signature(&self, message: &[u8], cert: &CertificateDer<'_>, dss: &DigitallySignedStruct) -> Result<HandshakeSignatureValid, rustls::Error> {
        self.inner.verify_tls13_signature(message, cert, dss)
    }
    fn supported_verify_schemes(&self) -> Vec<SignatureScheme> {
        self.inner.supported_verify_schemes()
    }
}

#[derive(Serialize, Default)]
pub struct HttpProbe {
    bytes: usize,
    status_line: Option<String>,
    // Данные шли, а потом встали посреди ответа (не EOF) — главный
    // признак «заморозки» ТСПУ, если оборвалось в районе 14–24 КБ.
    stalled: bool,
    eof: bool,
    ms: f64,
    error: Option<&'static str>,
}

#[derive(Serialize, Default)]
pub struct TlsReport {
    ip: String,
    port: u16,
    sni: Option<String>,
    tcp_ok: bool,
    tcp_ms: Option<f64>,
    tls_ok: bool,
    tls_ms: Option<f64>,
    error: Option<&'static str>,
    error_text: Option<String>,
    version: Option<String>,
    alpn: Option<String>,
    cert_valid: Option<bool>,
    cert_error: Option<String>,
    cert_not_after: Option<String>,
    cert_days_left: Option<i64>,
    http: Option<HttpProbe>,
}

fn tls_config(verifier: Arc<RecordingVerifier>, alpn: Vec<Vec<u8>>) -> Result<ClientConfig, String> {
    let provider = Arc::new(rustls::crypto::ring::default_provider());
    let mut cfg = ClientConfig::builder_with_provider(provider)
        .with_safe_default_protocol_versions()
        .map_err(|e| e.to_string())?
        .dangerous()
        .with_custom_certificate_verifier(verifier)
        .with_no_client_auth();
    cfg.alpn_protocols = alpn;
    Ok(cfg)
}

#[tauri::command(async)]
pub async fn vpn_tls(host: String, port: u16, sni: Option<String>, http_get: Option<bool>) -> Result<TlsReport, String> {
    if port == 0 {
        return Err("Порт 0.".into());
    }
    let sni = sni.map(|s| s.trim().to_ascii_lowercase()).filter(|s| !s.is_empty());
    if let Some(s) = &sni {
        check_host(s)?;
    }
    let ip = resolve_one(host.trim()).await?;
    let http_get = http_get.unwrap_or(false) && sni.is_some();
    let mut rep = TlsReport { ip: ip.to_string(), port, sni: sni.clone(), ..Default::default() };

    let _slot = probe_slots().acquire().await.map_err(|e| e.to_string())?;
    jitter(100, 400).await;

    let tcp = match tcp_connect(SocketAddr::new(ip, port)).await {
        Ok((s, t)) => {
            rep.tcp_ok = true;
            rep.tcp_ms = Some(t);
            s
        }
        Err((kind, _)) => {
            rep.error = Some(kind);
            return Ok(rep);
        }
    };

    let roots = RootCertStore { roots: webpki_roots::TLS_SERVER_ROOTS.to_vec() };
    let inner = WebPkiServerVerifier::builder_with_provider(Arc::new(roots), Arc::new(rustls::crypto::ring::default_provider()))
        .build()
        .map_err(|e| e.to_string())?;
    let verifier = Arc::new(RecordingVerifier { inner, verdict: Mutex::new(None) });
    // Для GET нужен HTTP/1.1, иначе — набор, как у браузера.
    let alpn = if http_get { vec![b"http/1.1".to_vec()] } else { vec![b"h2".to_vec(), b"http/1.1".to_vec()] };
    let cfg = tls_config(verifier.clone(), alpn)?;
    // Без SNI: имя — сам IP, rustls тогда расширение server_name не шлёт.
    // Это «контрольный» хендшейк: если он проходит, а с вашим SNI — нет,
    // режут именно по имени.
    let server_name: ServerName<'static> = match &sni {
        Some(s) => ServerName::try_from(s.clone()).map_err(|e| format!("SNI: {e}"))?,
        None => ServerName::IpAddress(ip.into()),
    };
    let connector = tokio_rustls::TlsConnector::from(Arc::new(cfg));
    let started = Instant::now();
    let mut stream = match timeout(HANDSHAKE_TIMEOUT, connector.connect(server_name, tcp)).await {
        Ok(Ok(s)) => s,
        Ok(Err(e)) => {
            rep.error = Some(io_kind(&e));
            rep.error_text = Some(e.to_string());
            rep.tls_ms = Some(ms(started));
            return Ok(rep);
        }
        Err(_) => {
            rep.error = Some("timeout");
            rep.tls_ms = Some(ms(started));
            return Ok(rep);
        }
    };
    rep.tls_ok = true;
    rep.tls_ms = Some(ms(started));
    {
        let (_, conn) = stream.get_ref();
        rep.version = conn.protocol_version().map(|v| format!("{v:?}"));
        rep.alpn = conn.alpn_protocol().map(|a| String::from_utf8_lossy(a).into_owned());
        if let Some(leaf) = conn.peer_certificates().and_then(|c| c.first()) {
            if let Some((iso, unix)) = cert_not_after(leaf.as_ref()) {
                rep.cert_not_after = Some(iso);
                let now = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs() as i64).unwrap_or(0);
                rep.cert_days_left = Some((unix - now).div_euclid(86_400));
            }
        }
    }
    if let Some(v) = verifier.verdict.lock().unwrap().take() {
        rep.cert_valid = Some(v.is_ok());
        rep.cert_error = v.err();
    }

    if http_get {
        let host_hdr = sni.clone().unwrap_or_default();
        rep.http = Some(http_read(&mut stream, &host_hdr).await);
    }
    let _ = stream.shutdown().await;
    Ok(rep)
}

async fn http_read<S: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin>(stream: &mut S, host: &str) -> HttpProbe {
    let mut out = HttpProbe::default();
    let started = Instant::now();
    let req = format!(
        "GET / HTTP/1.1\r\nHost: {host}\r\nUser-Agent: {BROWSER_UA}\r\nAccept: text/html,*/*;q=0.8\r\nAccept-Language: ru-RU,ru;q=0.9,en;q=0.8\r\nConnection: close\r\n\r\n"
    );
    if let Err(e) = stream.write_all(req.as_bytes()).await {
        out.error = Some(io_kind(&e));
        return out;
    }
    let mut buf = vec![0u8; 16 * 1024];
    let mut head: Vec<u8> = Vec::new();
    while out.bytes < HTTP_READ_CAP && started.elapsed() < HTTP_TOTAL_TIMEOUT {
        match timeout(READ_TIMEOUT, stream.read(&mut buf)).await {
            Ok(Ok(0)) => {
                out.eof = true;
                break;
            }
            Ok(Ok(n)) => {
                if head.len() < 256 {
                    head.extend_from_slice(&buf[..n.min(256)]);
                }
                out.bytes += n;
            }
            Ok(Err(e)) => {
                let kind = io_kind(&e);
                // close_notify без TLS-закрытия — многие серверы так делают,
                // это не обрыв.
                if kind == "eof" {
                    out.eof = true;
                } else {
                    out.error = Some(kind);
                }
                break;
            }
            Err(_) => {
                out.stalled = out.bytes > 0;
                out.error = Some("timeout");
                break;
            }
        }
    }
    out.status_line = String::from_utf8_lossy(&head).lines().next().map(|l| l.chars().take(80).collect());
    out.ms = ms(started);
    out
}

// ---------- X.509: только notAfter ----------
//
// Ради одной даты не тянем x509-parser: Certificate ::= SEQUENCE {
// tbsCertificate SEQUENCE { [0] version?, serial, signature, issuer,
// validity SEQUENCE { notBefore, notAfter }, ... }, ... }.

fn der_next(buf: &[u8]) -> Option<(u8, &[u8], &[u8])> {
    let tag = *buf.first()?;
    let first = *buf.get(1)? as usize;
    let (len, hdr) = if first < 0x80 {
        (first, 2)
    } else {
        let n = first & 0x7f;
        if n == 0 || n > 4 {
            return None;
        }
        let mut len = 0usize;
        for i in 0..n {
            len = (len << 8) | *buf.get(2 + i)? as usize;
        }
        (len, 2 + n)
    };
    let body = buf.get(hdr..hdr + len)?;
    Some((tag, body, &buf[hdr + len..]))
}

fn cert_not_after(der: &[u8]) -> Option<(String, i64)> {
    let (_, cert, _) = der_next(der)?;
    let (_, tbs, _) = der_next(cert)?;
    let mut rest = tbs;
    let (tag, _, r) = der_next(rest)?;
    if tag == 0xA0 {
        rest = r;
    }
    for _ in 0..3 {
        // serial, signature, issuer
        rest = der_next(rest)?.2;
    }
    let (_, validity, _) = der_next(rest)?;
    let (_, _, after_nb) = der_next(validity)?;
    let (tag, t, _) = der_next(after_nb)?;
    let s = std::str::from_utf8(t).ok()?;
    let (year, tail) = match tag {
        0x17 => {
            let yy: i64 = s.get(0..2)?.parse().ok()?;
            (if yy < 50 { 2000 + yy } else { 1900 + yy }, s.get(2..)?)
        }
        0x18 => (s.get(0..4)?.parse().ok()?, s.get(4..)?),
        _ => return None,
    };
    let num = |r: std::ops::Range<usize>| -> Option<i64> { tail.get(r)?.parse().ok() };
    let (mo, d, h, mi, sec) = (num(0..2)?, num(2..4)?, num(4..6)?, num(6..8)?, num(8..10).unwrap_or(0));
    let unix = days_from_civil(year, mo, d) * 86_400 + h * 3600 + mi * 60 + sec;
    Some((format!("{year:04}-{mo:02}-{d:02}T{h:02}:{mi:02}:{sec:02}Z"), unix))
}

// Howard Hinnant, days_from_civil.
fn days_from_civil(y: i64, m: i64, d: i64) -> i64 {
    let y = if m <= 2 { y - 1 } else { y };
    let era = y.div_euclid(400);
    let yoe = y - era * 400;
    let mp = (m + 9) % 12;
    let doy = (153 * mp + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn civil_epoch() {
        assert_eq!(days_from_civil(1970, 1, 1), 0);
        assert_eq!(days_from_civil(2000, 3, 1), 11_017);
    }

    #[test]
    fn der_long_length() {
        let mut v = vec![0x30, 0x81, 0x03, 1, 2, 3, 9];
        let (tag, body, rest) = der_next(&v).unwrap();
        assert_eq!((tag, body, rest), (0x30, &[1u8, 2, 3][..], &[9u8][..]));
        v.truncate(4);
        assert!(der_next(&v).is_none());
    }

    #[test]
    fn host_validation() {
        assert!(check_host("vpn.example.com").is_ok());
        assert!(check_host("1.2.3.4").is_ok());
        assert!(check_host("a b").is_err());
        assert!(check_host("").is_err());
    }

    // Ручная проверка с сетью: cargo test vpn_probe -- --ignored --nocapture
    #[tokio::test]
    #[ignore]
    async fn live_smoke() {
        let d = vpn_dns("one.one.one.one".into()).await.unwrap();
        println!("{}", serde_json::to_string(&d).unwrap());
        let t = vpn_tls("1.1.1.1".into(), 443, Some("one.one.one.one".into()), Some(true)).await.unwrap();
        println!("{}", serde_json::to_string(&t).unwrap());
        assert!(t.tls_ok && t.cert_valid == Some(true) && t.cert_days_left.unwrap() > 0);
        let n = vpn_tls("1.1.1.1".into(), 443, None, None).await.unwrap();
        println!("{}", serde_json::to_string(&n).unwrap());
        let c = vpn_tcp("1.1.1.1".into(), 443, Some(3)).await.unwrap();
        println!("{}", serde_json::to_string(&c).unwrap());
    }
}
