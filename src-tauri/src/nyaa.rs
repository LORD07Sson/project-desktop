
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

#[tauri::command(async)]
pub async fn fetch_image(url: String) -> Result<String, String> {
    let u = check_public_https(&url)?;
    let (b, ctype) = get_bytes(u, MAX_IMAGE, Some("image/*")).await?;
    let mime = ctype.split(';').next().unwrap_or("").trim().to_string();
    if !mime.starts_with("image/") || mime.contains("svg") {
        return Err("Это не картинка.".into());
    }
    Ok(format!("data:{mime};base64,{}", base64(&b)))
}

const META_HOSTS: [&str; 5] = ["feed.animetosho.org", "feed.animetosho.xyz", "releases.moe", "nekobt.to", "api.tsukihime.org"];

pub fn meta_url_allowed(url: &str) -> Result<Url, String> {
    let u = check_public_https(url)?;
    let host = u.host_str().unwrap_or("");
    if META_HOSTS.contains(&host) {
        Ok(u)
    } else {
        Err("Этот источник не поддерживается.".into())
    }
}

#[tauri::command(async)]
pub async fn meta_get(url: String) -> Result<String, String> {
    let u = meta_url_allowed(&url)?;
    let (b, _) = get_bytes(u, MAX_BYTES, Some("application/json")).await?;
    Ok(String::from_utf8_lossy(&b).into_owned())
}

#[tauri::command(async)]
pub async fn anilist_query(query: String, variables: serde_json::Value) -> Result<String, String> {
    if query.len() > 4000 {
        return Err("Слишком длинный запрос.".into());
    }
    let body = serde_json::json!({ "query": query, "variables": variables });
    let resp = client()
        .post("https://graphql.anilist.co")
        .timeout(Duration::from_secs(15))
        .header("User-Agent", "Project-Desktop/1.0")
        .header("Accept", "application/json")
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("Нет связи с AniList: {e}"))?;
    let status = resp.status();
    let text = resp.text().await.map_err(|e| e.to_string())?;
    if text.len() > MAX_BYTES {
        return Err("Ответ слишком большой.".into());
    }
    if !status.is_success() && status.as_u16() != 404 {
        return Err(format!("AniList ответил {}", status.as_u16()));
    }
    Ok(text)
}

#[derive(Serialize)]
pub struct NetCheck {
    pub url: String,
    pub ok: bool,
    pub status: u16,
    pub ms: u64,
    pub ping: Option<u64>,
    pub error: String,
}

async fn tcp_ping(u: &Url) -> Option<u64> {
    let host = u.host_str()?;
    let port = u.port().unwrap_or(443);
    let addr = tokio::net::lookup_host((host, port)).await.ok()?.next()?;
    let t0 = Instant::now();
    match tokio::time::timeout(Duration::from_secs(5), tokio::net::TcpStream::connect(addr)).await {
        Ok(Ok(_stream)) => Some(t0.elapsed().as_millis() as u64),
        _ => None,
    }
}

async fn check_one(url: String) -> NetCheck {
    let started = Instant::now();
    let ping = match check_public_https(&url) {
        Ok(u) => tcp_ping(&u).await,
        Err(_) => None,
    };
    let started = if ping.is_some() { Instant::now() } else { started };
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
        Ok(status) => NetCheck { url, ok: status < 500, status, ms, ping, error: String::new() },
        Err(error) => NetCheck { url, ok: false, status: 0, ms, ping, error },
    }
}

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

pub fn valid_magnet(m: &str) -> bool {
    const HEAD: &str = "magnet:?xt=urn:btih:";
    if m.len() > 2000 || !m.starts_with(HEAD) {
        return false;
    }
    if m.chars().any(|c| c.is_control() || c == ' ' || c == '"' || c == '<' || c == '>' || c == '\\' || c == '^' || c == '`') {
        return false;
    }
    let hash: String = m[HEAD.len()..].chars().take_while(|c| *c != '&').collect();
    match hash.len() {
        40 => hash.chars().all(|c| c.is_ascii_hexdigit()),
        32 => hash.chars().all(|c| c.is_ascii_alphanumeric()),
        _ => false,
    }
}

#[tauri::command(async)]
pub fn open_magnet(app: tauri::AppHandle, magnet: String) -> Result<(), String> {
    use tauri_plugin_opener::OpenerExt;
    if !valid_magnet(&magnet) {
        return Err("Некорректная magnet-ссылка.".into());
    }
    app.opener().open_url(&magnet, None::<&str>).map_err(|e| format!("Не удалось открыть: {e}"))
}
