// Безопасная загрузка текста по https для ленточек, текстов песен и курсов
// валют. Webview из-за CSP чужие сайты не открывает, поэтому запрос идёт
// из Rust. Только https, без адресов своей сети и localhost, ограничение
// размера и времени ожидания — чтобы команда не превратилась в «сходи
// куда скажут» внутри локальной сети пользователя.

use std::net::IpAddr;
use std::sync::OnceLock;
use std::time::Duration;

const MAX_BYTES: usize = 2 * 1024 * 1024;

fn host_is_public(host: &str) -> bool {
    let h = host.trim_matches(|c| c == '[' || c == ']').to_ascii_lowercase();
    if h.is_empty() || h == "localhost" || h.ends_with(".localhost") || h.ends_with(".local") || h.ends_with(".internal") {
        return false;
    }
    if let Ok(ip) = h.parse::<IpAddr>() {
        return match ip {
            IpAddr::V4(v4) => {
                !(v4.is_private() || v4.is_loopback() || v4.is_link_local() || v4.is_unspecified() || v4.is_broadcast())
            }
            IpAddr::V6(v6) => !(v6.is_loopback() || v6.is_unspecified()),
        };
    }
    h.contains('.')
}

pub fn check_url(url: &str) -> Result<reqwest::Url, String> {
    let u = reqwest::Url::parse(url).map_err(|_| "Некорректная ссылка.".to_string())?;
    if u.scheme() != "https" {
        return Err("Нужна ссылка https://".into());
    }
    let host = u.host_str().unwrap_or("");
    if !host_is_public(host) {
        return Err("Этот адрес недоступен.".into());
    }
    Ok(u)
}

// Свой клиент: перенаправления проверяются тем же правилом, иначе публичный
// адрес мог бы перекинуть запрос на локальный.
fn client() -> &'static reqwest::Client {
    static C: OnceLock<reqwest::Client> = OnceLock::new();
    C.get_or_init(|| {
        let policy = reqwest::redirect::Policy::custom(|attempt| {
            if attempt.previous().len() >= 5 {
                return attempt.error("Слишком много перенаправлений");
            }
            if check_url(attempt.url().as_str()).is_ok() {
                attempt.follow()
            } else {
                attempt.error("Перенаправление на недоступный адрес")
            }
        });
        reqwest::Client::builder().redirect(policy).build().unwrap_or_default()
    })
}

pub async fn get_text(url: &str) -> Result<String, String> {
    let u = check_url(url)?;
    let mut resp = client()
        .get(u)
        .timeout(Duration::from_secs(12))
        .header("User-Agent", "Project-Desktop/1.0")
        .send()
        .await
        .map_err(|e| format!("Не удалось загрузить: {e}"))?;
    if !resp.status().is_success() {
        return Err(format!("Сервер ответил {}", resp.status().as_u16()));
    }
    let mut buf: Vec<u8> = Vec::new();
    while let Some(chunk) = resp.chunk().await.map_err(|e| e.to_string())? {
        if buf.len() + chunk.len() > MAX_BYTES {
            return Err("Ответ слишком большой.".into());
        }
        buf.extend_from_slice(&chunk);
    }
    Ok(String::from_utf8_lossy(&buf).into_owned())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_non_https_and_private() {
        assert!(check_url("http://example.com/a").is_err());
        assert!(check_url("https://localhost/a").is_err());
        assert!(check_url("https://127.0.0.1/a").is_err());
        assert!(check_url("https://192.168.1.5/a").is_err());
        assert!(check_url("https://10.0.0.1/a").is_err());
        assert!(check_url("https://router.local/a").is_err());
        assert!(check_url("https://intranet/a").is_err());
        assert!(check_url("not a url").is_err());
    }

    #[test]
    fn accepts_public_https() {
        assert!(check_url("https://lrclib.net/api/get?artist_name=a").is_ok());
        assert!(check_url("https://nyaa.si/?page=rss").is_ok());
    }
}
