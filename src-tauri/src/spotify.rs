// Spotify: вход по OAuth (PKCE) и обращения к Web API из Rust.
//
// У каждого человека своё приложение в Spotify for Developers (свой
// Client ID, режим разработки) и свой Premium. Секрета у PKCE нет, так
// что на диске лежит только refresh-токен — в хранилище учётных данных ОС.
// Окно приложения чужие сайты не открывает (CSP), поэтому и обмен кода
// на токен, и запросы к API идут отсюда. Разрешены только два адреса:
// accounts.spotify.com и api.spotify.com.

use std::io::{Read, Write};
use std::net::TcpListener;
use std::sync::OnceLock;
use std::time::{Duration, Instant};

use keyring::Entry;
use serde::{Deserialize, Serialize};

/// Порт для возврата из браузера: адрес http://127.0.0.1:8898/callback
/// нужно один раз вписать в Redirect URIs своего приложения Spotify.
pub const REDIRECT_PORT: u16 = 8898;

fn entry() -> Result<Entry, String> {
    Entry::new("ProjectDesktop", "spotify-refresh").map_err(|e| e.to_string())
}

#[tauri::command(async)]
pub fn spotify_save_refresh(token: String) -> Result<(), String> {
    entry()?.set_password(&token).map_err(|e| e.to_string())
}

#[tauri::command(async)]
pub fn spotify_load_refresh() -> Option<String> {
    entry().ok()?.get_password().ok()
}

#[tauri::command(async)]
pub fn spotify_clear_refresh() -> Result<(), String> {
    match entry()?.delete_credential() {
        Ok(_) => Ok(()),
        Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(e.to_string()),
    }
}

/// Из первой строки HTTP-запроса «GET /callback?code=..&state=.. HTTP/1.1»
/// достаёт (code, state). Ok(None) — это не наш путь (например, favicon).
pub fn parse_callback(request_line: &str) -> Result<Option<(String, String)>, String> {
    let mut parts = request_line.split_whitespace();
    if parts.next() != Some("GET") {
        return Ok(None);
    }
    let target = parts.next().unwrap_or("");
    let url = reqwest::Url::parse(&format!("http://127.0.0.1{target}")).map_err(|_| "Некорректный ответ браузера.".to_string())?;
    if url.path() != "/callback" {
        return Ok(None);
    }
    let mut code = None;
    let mut state = None;
    let mut error = None;
    for (k, v) in url.query_pairs() {
        match k.as_ref() {
            "code" => code = Some(v.into_owned()),
            "state" => state = Some(v.into_owned()),
            "error" => error = Some(v.into_owned()),
            _ => {}
        }
    }
    if let Some(e) = error {
        return Err(if e == "access_denied" { "Доступ не разрешён.".into() } else { format!("Spotify вернул ошибку: {e}") });
    }
    match (code, state) {
        (Some(c), Some(s)) => Ok(Some((c, s))),
        _ => Err("В ответе нет кода авторизации.".into()),
    }
}

const DONE_PAGE: &str = "<!doctype html><meta charset=utf-8><title>Project</title><body style=\"font-family:system-ui;background:#16110e;color:#eee;display:grid;place-items:center;height:100vh;margin:0\"><div style=\"text-align:center\"><h2>Spotify подключён</h2><p>Можно закрыть эту вкладку и вернуться в Project.</p></div>";

/// Ждёт, пока браузер вернётся на 127.0.0.1:REDIRECT_PORT/callback.
#[tauri::command(async)]
pub fn spotify_wait_callback(timeout_secs: u64) -> Result<(String, String), String> {
    let listener = TcpListener::bind(("127.0.0.1", REDIRECT_PORT))
        .map_err(|e| format!("Порт {REDIRECT_PORT} занят: {e}"))?;
    listener.set_nonblocking(true).map_err(|e| e.to_string())?;
    let deadline = Instant::now() + Duration::from_secs(timeout_secs.clamp(10, 600));
    loop {
        if Instant::now() > deadline {
            return Err("Время ожидания вышло. Попробуйте ещё раз.".into());
        }
        let (mut stream, _) = match listener.accept() {
            Ok(s) => s,
            Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                std::thread::sleep(Duration::from_millis(120));
                continue;
            }
            Err(e) => return Err(e.to_string()),
        };
        let _ = stream.set_nonblocking(false);
        let _ = stream.set_read_timeout(Some(Duration::from_secs(3)));
        let mut buf = [0u8; 4096];
        let n = stream.read(&mut buf).unwrap_or(0);
        let head = String::from_utf8_lossy(&buf[..n]);
        let first = head.lines().next().unwrap_or("");
        let parsed = parse_callback(first);
        let (status, body) = match &parsed {
            Ok(Some(_)) => ("200 OK", DONE_PAGE),
            Ok(None) => ("404 Not Found", ""),
            Err(_) => ("400 Bad Request", "Ошибка авторизации."),
        };
        let resp = format!(
            "HTTP/1.1 {status}\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
            body.len()
        );
        let _ = stream.write_all(resp.as_bytes());
        match parsed {
            Ok(Some(pair)) => return Ok(pair),
            Ok(None) => continue,
            Err(e) => return Err(e),
        }
    }
}

#[derive(Deserialize)]
pub struct SpotifyRequest {
    pub method: String,
    pub url: String,
    pub bearer: Option<String>,
    /// application/x-www-form-urlencoded (обмен кода, обновление токена).
    pub form: Option<Vec<(String, String)>>,
    pub json: Option<serde_json::Value>,
}

#[derive(Serialize)]
pub struct SpotifyResponse {
    pub status: u16,
    pub body: String,
}

fn allowed_url(url: &str) -> Result<reqwest::Url, String> {
    let u = reqwest::Url::parse(url).map_err(|_| "Некорректный адрес.".to_string())?;
    let host = u.host_str().unwrap_or("");
    if u.scheme() != "https" || !(host == "accounts.spotify.com" || host == "api.spotify.com") {
        return Err("Этот адрес недоступен.".into());
    }
    Ok(u)
}

fn client() -> &'static reqwest::Client {
    static C: OnceLock<reqwest::Client> = OnceLock::new();
    C.get_or_init(|| {
        reqwest::Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .build()
            .unwrap_or_default()
    })
}

#[tauri::command(async)]
pub async fn spotify_http(req: SpotifyRequest) -> Result<SpotifyResponse, String> {
    let url = allowed_url(&req.url)?;
    let method = reqwest::Method::from_bytes(req.method.to_uppercase().as_bytes()).map_err(|_| "Неверный метод.".to_string())?;
    if !matches!(method, reqwest::Method::GET | reqwest::Method::POST | reqwest::Method::PUT | reqwest::Method::DELETE) {
        return Err("Неверный метод.".into());
    }
    let mut rb = client().request(method, url).timeout(Duration::from_secs(15));
    if let Some(b) = &req.bearer {
        rb = rb.bearer_auth(b);
    }
    if let Some(f) = &req.form {
        rb = rb.form(f);
    } else if let Some(j) = &req.json {
        rb = rb.json(j);
    } else if req.method.eq_ignore_ascii_case("PUT") || req.method.eq_ignore_ascii_case("POST") {
        rb = rb.header("Content-Length", "0");
    }
    let resp = rb.send().await.map_err(|e| format!("Нет связи со Spotify: {e}"))?;
    let status = resp.status().as_u16();
    let body = resp.text().await.map_err(|e| e.to_string())?;
    Ok(SpotifyResponse { status, body })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_callback() {
        let r = parse_callback("GET /callback?code=AB%20C&state=xyz HTTP/1.1").unwrap();
        assert_eq!(r, Some(("AB C".to_string(), "xyz".to_string())));
    }

    #[test]
    fn ignores_other_paths() {
        assert_eq!(parse_callback("GET /favicon.ico HTTP/1.1").unwrap(), None);
        assert_eq!(parse_callback("POST /callback HTTP/1.1").unwrap(), None);
    }

    #[test]
    fn reports_denied_and_missing() {
        assert!(parse_callback("GET /callback?error=access_denied&state=x HTTP/1.1").unwrap_err().contains("не разрешён"));
        assert!(parse_callback("GET /callback?state=x HTTP/1.1").is_err());
    }

    #[test]
    fn only_spotify_hosts() {
        assert!(allowed_url("https://api.spotify.com/v1/me").is_ok());
        assert!(allowed_url("https://accounts.spotify.com/api/token").is_ok());
        assert!(allowed_url("http://api.spotify.com/v1/me").is_err());
        assert!(allowed_url("https://evil.example/v1/me").is_err());
        assert!(allowed_url("https://api.spotify.com.evil.example/").is_err());
    }
}
