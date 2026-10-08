// Nyaa внутри программы: публичная RSS-лента, страница раздачи, картинки из
// описания и проверка зеркал. Окно приложения чужие сайты не открывает
// (CSP), поэтому запросы идут отсюда — но только по https и только на
// публичные адреса: localhost, адреса своей сети и перенаправления туда
// отклоняются. Адреса запросов собираются здесь из проверенных частей, а не
// принимаются готовой строкой от интерфейса (кроме картинок описания и
// проверки зеркал, где проверяется сам адрес). Сами раздачи программа не
// качает: сохраняется только маленький .torrent и только по кнопке.

use std::net::IpAddr;
use std::sync::OnceLock;
use std::time::{Duration, Instant};

use reqwest::Url;
use serde::Serialize;
use tauri::Manager;

const MAX_BYTES: usize = 2 * 1024 * 1024;
const MAX_IMAGE: usize = 8 * 1024 * 1024;

fn host_is_public(host: &str) -> bool {
    let h = host.trim_matches(|c| c == '[' || c == ']').to_ascii_lowercase();
    if h.is_empty() || h == "localhost" || h.ends_with(".localhost") || h.ends_with(".local") || h.ends_with(".internal") {
        return false;
    }
    if let Ok(ip) = h.parse::<IpAddr>() {
        return match ip {
            IpAddr::V4(v4) => !(v4.is_private() || v4.is_loopback() || v4.is_link_local() || v4.is_unspecified() || v4.is_broadcast()),
            IpAddr::V6(v6) => !(v6.is_loopback() || v6.is_unspecified()),
        };
    }
    h.contains('.')
}

/// Любой публичный https-адрес.
pub fn check_public_https(url: &str) -> Result<Url, String> {
    let u = Url::parse(url).map_err(|_| "Некорректный адрес.".to_string())?;
    if u.scheme() != "https" {
        return Err("Нужен адрес https://".into());
    }
    if !host_is_public(u.host_str().unwrap_or("")) {
        return Err("Этот адрес недоступен.".into());
    }
    Ok(u)
}

/// Основа зеркала: только схема и хост (с портом), без пути.
pub fn base_origin(base: &str) -> Result<String, String> {
    let u = check_public_https(base.trim())?;
    let host = u.host_str().ok_or("Нет адреса сайта.")?;
    Ok(match u.port() {
        Some(p) => format!("https://{host}:{p}"),
        None => format!("https://{host}"),
    })
}

fn client() -> &'static reqwest::Client {
    static C: OnceLock<reqwest::Client> = OnceLock::new();
    C.get_or_init(|| {
        let policy = reqwest::redirect::Policy::custom(|attempt| {
            if attempt.previous().len() >= 5 {
                return attempt.error("Слишком много перенаправлений");
            }
            if check_public_https(attempt.url().as_str()).is_ok() {
                attempt.follow()
            } else {
                attempt.error("Перенаправление на недоступный адрес")
            }
        });
        reqwest::Client::builder().redirect(policy).build().unwrap_or_default()
    })
}

fn valid_category(c: &str) -> bool {
    let b = c.as_bytes();
    b.len() == 3 && b[0].is_ascii_digit() && b[1] == b'_' && b[2].is_ascii_digit()
}

pub fn rss_url(base: &str, query: &str, category: &str, filter: &str, page: u32, user: Option<&str>) -> Result<Url, String> {
    if !(1..=40).contains(&page) {
        return Err("Неверный номер страницы.".into());
    }
    if !valid_category(category) {
        return Err("Неверная категория.".into());
    }
    if !matches!(filter, "0" | "1" | "2") {
        return Err("Неверный фильтр.".into());
    }
    let q = query.trim();
    if q.chars().count() > 200 {
        return Err("Слишком длинный запрос.".into());
    }
    let mut u = Url::parse(&format!("{}/", base_origin(base)?)).map_err(|e| e.to_string())?;
    u.query_pairs_mut()
        .append_pair("page", "rss")
        .append_pair("q", q)
        .append_pair("c", category)
        .append_pair("f", filter);
    if page > 1 {
        u.query_pairs_mut().append_pair("p", &page.to_string());
    }
    if let Some(name) = user.map(str::trim).filter(|n| !n.is_empty()) {
        if name.len() > 40 || !name.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '-' | '.')) {
            return Err("Неверное имя загрузчика.".into());
        }
        u.query_pairs_mut().append_pair("u", name);
    }
    Ok(u)
}

async fn get_bytes(url: Url, limit: usize, accept: Option<&str>) -> Result<(Vec<u8>, String), String> {
    let mut rb = client().get(url).timeout(Duration::from_secs(15)).header("User-Agent", "Project-Desktop/1.0");
    if let Some(a) = accept {
        rb = rb.header("Accept", a);
    }
    let mut resp = rb.send().await.map_err(|e| format!("Не удалось загрузить: {e}"))?;
    if !resp.status().is_success() {
        return Err(format!("Сайт ответил {}", resp.status().as_u16()));
    }
    let ctype = resp
        .headers()
        .get("content-type")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("")
        .to_ascii_lowercase();
    let mut buf = Vec::new();
    while let Some(chunk) = resp.chunk().await.map_err(|e| e.to_string())? {
        if buf.len() + chunk.len() > limit {
            return Err("Ответ слишком большой.".into());
        }
        buf.extend_from_slice(&chunk);
    }
    Ok((buf, ctype))
}

#[tauri::command(async)]
pub async fn nyaa_rss(base: String, query: String, category: String, filter: String, page: Option<u32>, user: Option<String>) -> Result<String, String> {
    let (b, _) = get_bytes(rss_url(&base, &query, &category, &filter, page.unwrap_or(1), user.as_deref())?, MAX_BYTES, None).await?;
    Ok(String::from_utf8_lossy(&b).into_owned())
}

/// Страница раздачи /view/{id} (HTML; разбирается в интерфейсе).
#[tauri::command(async)]
pub async fn nyaa_view(base: String, id: u64) -> Result<String, String> {
    let u = Url::parse(&format!("{}/view/{id}", base_origin(&base)?)).map_err(|e| e.to_string())?;
    let (b, _) = get_bytes(u, MAX_BYTES, Some("text/html")).await?;
    Ok(String::from_utf8_lossy(&b).into_owned())
}

#[tauri::command(async)]
pub async fn nyaa_save_torrent(app: tauri::AppHandle, base: String, id: u64, path: String) -> Result<(), String> {
    let target = app.state::<crate::file_scope::FileScope>().check_write(&path)?;
    let u = Url::parse(&format!("{}/download/{id}.torrent", base_origin(&base)?)).map_err(|e| e.to_string())?;
    let (b, _) = get_bytes(u, MAX_BYTES, None).await?;
    // .torrent — это bencode-словарь, он начинается с «d»
    if b.first() != Some(&b'd') {
        return Err("Сайт вернул не .torrent.".into());
    }
    std::fs::write(target, b).map_err(|e| e.to_string())
}

pub fn base64(bytes: &[u8]) -> String {
    const T: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for c in bytes.chunks(3) {
        let n = (c[0] as u32) << 16 | (*c.get(1).unwrap_or(&0) as u32) << 8 | *c.get(2).unwrap_or(&0) as u32;
        out.push(T[(n >> 18) as usize & 63] as char);
        out.push(T[(n >> 12) as usize & 63] as char);
        out.push(if c.len() > 1 { T[(n >> 6) as usize & 63] as char } else { '=' });
        out.push(if c.len() > 2 { T[n as usize & 63] as char } else { '=' });
    }
    out
}

/// Картинка из описания раздачи → data-URL (окно чужие картинки не грузит).
#[tauri::command(async)]
pub async fn fetch_image(url: String) -> Result<String, String> {
    let u = check_public_https(&url)?;
    let (b, ctype) = get_bytes(u, MAX_IMAGE, Some("image/*")).await?;
    let mime = ctype.split(';').next().unwrap_or("").trim().to_string();
    // SVG не пускаем: внутри него бывает скрипт
    if !mime.starts_with("image/") || mime.contains("svg") {
        return Err("Это не картинка.".into());
    }
    Ok(format!("data:{mime};base64,{}", base64(&b)))
}

#[derive(Serialize)]
pub struct NetCheck {
    pub url: String,
    pub ok: bool,
    pub status: u16,
    pub ms: u64,
    pub error: String,
}

async fn check_one(url: String) -> NetCheck {
    let started = Instant::now();
    let res = match check_public_https(&url) {
        Err(e) => Err(e),
        Ok(u) => client()
            .get(u)
            .timeout(Duration::from_secs(8))
            .header("User-Agent", "Project-Desktop/1.0")
            .header("Range", "bytes=0-0")
            .send()
            .await
            .map(|r| r.status().as_u16())
            .map_err(|e| if e.is_timeout() { "нет ответа за 8 секунд".to_string() } else { "не удалось подключиться".to_string() }),
    };
    let ms = started.elapsed().as_millis() as u64;
    match res {
        Ok(status) => NetCheck { url, ok: status < 500, status, ms, error: String::new() },
        Err(error) => NetCheck { url, ok: false, status: 0, ms, error },
    }
}

/// Проверка связи сразу с несколькими адресами (параллельно).
#[tauri::command(async)]
pub async fn net_check(urls: Vec<String>) -> Vec<NetCheck> {
    let handles: Vec<_> = urls.into_iter().take(24).map(|u| tauri::async_runtime::spawn(check_one(u))).collect();
    let mut out = Vec::new();
    for h in handles {
        if let Ok(r) = h.await {
            out.push(r);
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn builds_rss_url_for_any_public_mirror() {
        let u = rss_url("https://nyaa.land/some/path?x=1", "night watch 1080p", "1_2", "0", 1, None).unwrap();
        assert_eq!(u.host_str(), Some("nyaa.land"));
        assert_eq!(u.path(), "/");
        let pairs: Vec<(String, String)> = u.query_pairs().map(|(k, v)| (k.into_owned(), v.into_owned())).collect();
        assert!(pairs.contains(&("page".into(), "rss".into())));
        assert!(pairs.contains(&("q".into(), "night watch 1080p".into())));
        assert!(!pairs.iter().any(|(k, _)| k == "x"), "чужие параметры базы отбрасываются");
    }

    #[test]
    fn query_is_encoded_not_injected() {
        let u = rss_url("https://nyaa.si", "a&c=9_9#x", "0_0", "1", 1, None).unwrap();
        assert_eq!(u.query_pairs().filter(|(k, _)| k == "c").count(), 1);
        assert!(u.fragment().is_none());
    }

    #[test]
    fn rejects_bad_params_and_private_hosts() {
        assert!(rss_url("https://nyaa.si", "x", "12", "0", 1, None).is_err());
        assert!(rss_url("https://nyaa.si", "x", "1_2", "5", 1, None).is_err());
        assert!(rss_url("https://nyaa.si", &"я".repeat(201), "1_2", "0", 1, None).is_err());
        assert!(base_origin("http://nyaa.si").is_err());
        assert!(base_origin("https://localhost").is_err());
        assert!(base_origin("https://192.168.0.5").is_err());
        assert!(base_origin("https://10.0.0.1:8080").is_err());
        assert!(base_origin("https://router.local").is_err());
        assert!(base_origin("javascript:alert(1)").is_err());
    }

    #[test]
    fn page_parameter() {
        let u = rss_url("https://nyaa.si", "x", "1_2", "0", 3, None).unwrap();
        assert!(u.query_pairs().any(|(k, v)| k == "p" && v == "3"));
        let first = rss_url("https://nyaa.si", "x", "1_2", "0", 1, None).unwrap();
        assert!(!first.query_pairs().any(|(k, _)| k == "p"));
        assert!(rss_url("https://nyaa.si", "x", "1_2", "0", 0, None).is_err());
        assert!(rss_url("https://nyaa.si", "x", "1_2", "0", 41, None).is_err());
    }

    #[test]
    fn uploader_parameter() {
        let u = rss_url("https://nyaa.si", "", "0_0", "0", 1, Some("JMAX")).unwrap();
        assert!(u.query_pairs().any(|(k, v)| k == "u" && v == "JMAX"));
        assert!(rss_url("https://nyaa.si", "", "0_0", "0", 1, Some("a&b")).is_err());
        assert!(rss_url("https://nyaa.si", "", "0_0", "0", 1, Some("")).is_ok());
        assert!(!rss_url("https://nyaa.si", "", "0_0", "0", 1, None).unwrap().query_pairs().any(|(k, _)| k == "u"));
    }

    #[test]
    fn base_origin_keeps_port() {
        assert_eq!(base_origin("https://mirror.example:8443/x").unwrap(), "https://mirror.example:8443");
        assert_eq!(base_origin("https://nyaa.si/").unwrap(), "https://nyaa.si");
    }

    #[test]
    fn base64_matches_known_values() {
        assert_eq!(base64(b""), "");
        assert_eq!(base64(b"f"), "Zg==");
        assert_eq!(base64(b"fo"), "Zm8=");
        assert_eq!(base64(b"foo"), "Zm9v");
        assert_eq!(base64(b"foobar"), "Zm9vYmFy");
    }
}
