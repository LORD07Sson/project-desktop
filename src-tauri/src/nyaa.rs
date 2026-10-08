// Nyaa внутри программы: публичная RSS-лента поиска и сохранение
// .torrent-файла. Окно приложения чужие сайты не открывает (CSP), поэтому
// запросы идут отсюда, но только на два зеркала (nyaa.si, nyaa.land) и по
// строго собираемым адресам: параметры проходят проверку, произвольный
// URL из интерфейса не принимается. Сами раздачи программа не качает:
// сохраняется только маленький .torrent и только по выбору человека.

use std::time::Duration;

use reqwest::Url;
use std::sync::OnceLock;
use tauri::Manager;

const HOSTS: [&str; 2] = ["nyaa.si", "nyaa.land"];
const MAX_BYTES: usize = 2 * 1024 * 1024;

fn client() -> &'static reqwest::Client {
    static C: OnceLock<reqwest::Client> = OnceLock::new();
    C.get_or_init(|| {
        let policy = reqwest::redirect::Policy::custom(|attempt| {
            let ok = attempt.previous().len() < 4
                && attempt.url().scheme() == "https"
                && attempt.url().host_str().map(|h| HOSTS.contains(&h)).unwrap_or(false);
            if ok { attempt.follow() } else { attempt.error("Перенаправление на недоступный адрес") }
        });
        reqwest::Client::builder().redirect(policy).build().unwrap_or_default()
    })
}

/// Категория вида «1_2» (или «0_0» — все), фильтр 0/1/2.
fn valid_category(c: &str) -> bool {
    let b = c.as_bytes();
    b.len() == 3 && b[0].is_ascii_digit() && b[1] == b'_' && b[2].is_ascii_digit()
}

pub fn rss_url(host: &str, query: &str, category: &str, filter: &str) -> Result<Url, String> {
    if !HOSTS.contains(&host) {
        return Err("Неизвестное зеркало.".into());
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
    let mut u = Url::parse(&format!("https://{host}/")).map_err(|e| e.to_string())?;
    u.query_pairs_mut()
        .append_pair("page", "rss")
        .append_pair("q", q)
        .append_pair("c", category)
        .append_pair("f", filter);
    Ok(u)
}

async fn get_bytes(url: Url) -> Result<Vec<u8>, String> {
    let mut resp = client()
        .get(url)
        .timeout(Duration::from_secs(15))
        .header("User-Agent", "Project-Desktop/1.0")
        .send()
        .await
        .map_err(|e| format!("Не удалось загрузить: {e}"))?;
    if !resp.status().is_success() {
        return Err(format!("Сайт ответил {}", resp.status().as_u16()));
    }
    let mut buf = Vec::new();
    while let Some(chunk) = resp.chunk().await.map_err(|e| e.to_string())? {
        if buf.len() + chunk.len() > MAX_BYTES {
            return Err("Ответ слишком большой.".into());
        }
        buf.extend_from_slice(&chunk);
    }
    Ok(buf)
}

#[tauri::command(async)]
pub async fn nyaa_rss(query: String, category: String, filter: String) -> Result<String, String> {
    let mut last = String::from("Не удалось загрузить.");
    for host in HOSTS {
        match get_bytes(rss_url(host, &query, &category, &filter)?).await {
            Ok(b) => return Ok(String::from_utf8_lossy(&b).into_owned()),
            Err(e) => last = e,
        }
    }
    Err(last)
}

#[tauri::command(async)]
pub async fn nyaa_save_torrent(app: tauri::AppHandle, id: u64, path: String) -> Result<(), String> {
    let target = app.state::<crate::file_scope::FileScope>().check_write(&path)?;
    let mut last = String::from("Не удалось скачать .torrent.");
    for host in HOSTS {
        let url = Url::parse(&format!("https://{host}/download/{id}.torrent")).map_err(|e| e.to_string())?;
        match get_bytes(url).await {
            // .torrent — это bencode-словарь, он начинается с «d»
            Ok(b) if b.first() == Some(&b'd') => return std::fs::write(target, b).map_err(|e| e.to_string()),
            Ok(_) => last = "Сайт вернул не .torrent.".into(),
            Err(e) => last = e,
        }
    }
    Err(last)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn builds_rss_url() {
        let u = rss_url("nyaa.si", "night watch 1080p", "1_2", "0").unwrap();
        assert_eq!(u.host_str(), Some("nyaa.si"));
        let pairs: Vec<(String, String)> = u.query_pairs().map(|(k, v)| (k.into_owned(), v.into_owned())).collect();
        assert!(pairs.contains(&("page".into(), "rss".into())));
        assert!(pairs.contains(&("q".into(), "night watch 1080p".into())));
        assert!(pairs.contains(&("c".into(), "1_2".into())));
    }

    #[test]
    fn query_is_encoded_not_injected() {
        let u = rss_url("nyaa.si", "a&c=9_9#x", "0_0", "1").unwrap();
        assert_eq!(u.query_pairs().filter(|(k, _)| k == "c").count(), 1);
        assert!(u.fragment().is_none());
    }

    #[test]
    fn rejects_bad_params() {
        assert!(rss_url("evil.example", "x", "1_2", "0").is_err());
        assert!(rss_url("nyaa.si", "x", "12", "0").is_err());
        assert!(rss_url("nyaa.si", "x", "1_2", "5").is_err());
        assert!(rss_url("nyaa.si", &"я".repeat(201), "1_2", "0").is_err());
    }
}
