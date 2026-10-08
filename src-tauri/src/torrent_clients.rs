// Отправка magnet-ссылок в торрент-клиент пользователя: qBittorrent,
// Transmission или Deluge (через их веб-интерфейс). Клиент — личный, часто
// на этом же компьютере (127.0.0.1) или в домашней сети, поэтому здесь, в
// отличие от загрузки чужих сайтов, локальные адреса разрешены; зато
// принимаются только http/https, а в сам клиент уходит только проверенный
// magnet. Пароль хранится в хранилище учётных данных ОС, а не в файлах.

use std::time::Duration;

use keyring::Entry;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::sync::OnceLock;

const MAX_MAGNETS: usize = 100;

#[derive(Serialize, Deserialize, Clone, Default)]
pub struct TcConfig {
    pub kind: String,     // qbittorrent | transmission | deluge
    pub url: String,
    pub user: String,
    #[serde(default)]
    pub pass: String,
    #[serde(default)]
    pub category: String,
    #[serde(default)]
    pub tags: String,
    #[serde(default)]
    pub paused: bool,
}

#[derive(Serialize)]
pub struct TcPublic {
    pub kind: String,
    pub url: String,
    pub user: String,
    pub category: String,
    pub tags: String,
    pub paused: bool,
    pub has_pass: bool,
}

fn entry() -> Result<Entry, String> {
    Entry::new("ProjectDesktop", "torrent-client").map_err(|e| e.to_string())
}

fn client() -> &'static reqwest::Client {
    static C: OnceLock<reqwest::Client> = OnceLock::new();
    C.get_or_init(|| {
        reqwest::Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .timeout(Duration::from_secs(12))
            .build()
            .unwrap_or_default()
    })
}

/// «http://127.0.0.1:8080/» → «http://127.0.0.1:8080»; всё, кроме http/https, — ошибка.
pub fn normalize_base(url: &str) -> Result<String, String> {
    let u = reqwest::Url::parse(url.trim()).map_err(|_| "Некорректный адрес клиента.".to_string())?;
    if !matches!(u.scheme(), "http" | "https") {
        return Err("Адрес клиента должен начинаться с http:// или https://".into());
    }
    let host = u.host_str().ok_or("В адресе нет хоста.")?;
    let mut base = format!("{}://{}", u.scheme(), host);
    if let Some(p) = u.port() {
        base.push_str(&format!(":{p}"));
    }
    let path = u.path().trim_end_matches('/');
    if !path.is_empty() {
        base.push_str(path);
    }
    Ok(base)
}

pub fn valid_magnet(m: &str) -> bool {
    m.len() < 4000 && m.starts_with("magnet:?xt=urn:btih:") && !m.contains(['\n', '\r'])
}

/// Значение cookie `name` из заголовков Set-Cookie.
pub fn extract_cookie(set_cookies: &[String], name: &str) -> Option<String> {
    let prefix = format!("{name}=");
    set_cookies.iter().find_map(|c| {
        let first = c.split(';').next()?.trim();
        first.strip_prefix(&prefix).map(|v| v.to_string())
    })
}

fn set_cookies(resp: &reqwest::Response) -> Vec<String> {
    resp.headers()
        .get_all(reqwest::header::SET_COOKIE)
        .iter()
        .filter_map(|v| v.to_str().ok().map(|s| s.to_string()))
        .collect()
}

fn load_cfg() -> Result<TcConfig, String> {
    let raw = entry()?.get_password().map_err(|_| "Клиент не настроен.".to_string())?;
    serde_json::from_str(&raw).map_err(|e| e.to_string())
}

#[tauri::command(async)]
pub fn tc_save(mut cfg: TcConfig) -> Result<(), String> {
    cfg.url = normalize_base(&cfg.url)?;
    if !matches!(cfg.kind.as_str(), "qbittorrent" | "transmission" | "deluge") {
        return Err("Неизвестный клиент.".into());
    }
    // пустое поле пароля при сохранении = оставить прежний
    if cfg.pass.is_empty() {
        if let Ok(old) = load_cfg() {
            if old.kind == cfg.kind && old.user == cfg.user {
                cfg.pass = old.pass;
            }
        }
    }
    let raw = serde_json::to_string(&cfg).map_err(|e| e.to_string())?;
    entry()?.set_password(&raw).map_err(|e| e.to_string())
}

#[tauri::command(async)]
pub fn tc_load() -> Option<TcPublic> {
    let c = load_cfg().ok()?;
    Some(TcPublic { kind: c.kind, url: c.url, user: c.user, category: c.category, tags: c.tags, paused: c.paused, has_pass: !c.pass.is_empty() })
}

#[tauri::command(async)]
pub fn tc_clear() -> Result<(), String> {
    match entry()?.delete_credential() {
        Ok(_) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(e.to_string()),
    }
}

// ---------- qBittorrent ----------

async fn qb_login(base: &str, c: &TcConfig) -> Result<String, String> {
    let resp = client()
        .post(format!("{base}/api/v2/auth/login"))
        .header("Referer", base)
        .form(&[("username", c.user.as_str()), ("password", c.pass.as_str())])
        .send()
        .await
        .map_err(|e| format!("Нет связи с qBittorrent: {e}"))?;
    let cookies = set_cookies(&resp);
    let status = resp.status();
    let body = resp.text().await.unwrap_or_default();
    if body.trim() == "Fails." || status.as_u16() == 403 {
        return Err("qBittorrent не принял логин или пароль.".into());
    }
    if !status.is_success() {
        return Err(format!("qBittorrent ответил {}", status.as_u16()));
    }
    // при отключённой авторизации для localhost cookie может не быть — это нормально
    Ok(extract_cookie(&cookies, "SID").map(|s| format!("SID={s}")).unwrap_or_default())
}

async fn qb_version(base: &str, cookie: &str) -> Result<String, String> {
    let resp = client().get(format!("{base}/api/v2/app/version")).header("Cookie", cookie).header("Referer", base).send().await.map_err(|e| e.to_string())?;
    if !resp.status().is_success() {
        return Err("qBittorrent не пускает: проверьте логин и пароль.".into());
    }
    Ok(format!("qBittorrent {}", resp.text().await.unwrap_or_default().trim()))
}

async fn qb_add(base: &str, cookie: &str, c: &TcConfig, magnets: &[String]) -> Result<(), String> {
    let mut form: Vec<(&str, String)> = vec![("urls", magnets.join("\n"))];
    if !c.category.trim().is_empty() {
        form.push(("category", c.category.trim().to_string()));
    }
    if !c.tags.trim().is_empty() {
        form.push(("tags", c.tags.trim().to_string()));
    }
    if c.paused {
        // v4 понимает paused, v5 — stopped
        form.push(("paused", "true".into()));
        form.push(("stopped", "true".into()));
    }
    let resp = client().post(format!("{base}/api/v2/torrents/add")).header("Cookie", cookie).header("Referer", base).form(&form).send().await.map_err(|e| e.to_string())?;
    let status = resp.status();
    let body = resp.text().await.unwrap_or_default();
    if !status.is_success() || body.trim() == "Fails." {
        return Err(format!("qBittorrent не добавил раздачу ({}).", status.as_u16()));
    }
    Ok(())
}

// ---------- Transmission ----------

fn tr_url(base: &str) -> String {
    if base.ends_with("/rpc") { base.to_string() } else { format!("{base}/transmission/rpc") }
}

async fn tr_call(base: &str, c: &TcConfig, session: &mut String, body: &Value) -> Result<Value, String> {
    for _ in 0..2 {
        let mut rb = client().post(tr_url(base)).json(body);
        if !c.user.is_empty() {
            rb = rb.basic_auth(&c.user, Some(&c.pass));
        }
        if !session.is_empty() {
            rb = rb.header("X-Transmission-Session-Id", session.as_str());
        }
        let resp = rb.send().await.map_err(|e| format!("Нет связи с Transmission: {e}"))?;
        if resp.status().as_u16() == 409 {
            *session = resp.headers().get("X-Transmission-Session-Id").and_then(|v| v.to_str().ok()).unwrap_or("").to_string();
            continue;
        }
        if resp.status().as_u16() == 401 {
            return Err("Transmission не принял логин или пароль.".into());
        }
        if !resp.status().is_success() {
            return Err(format!("Transmission ответил {}", resp.status().as_u16()));
        }
        return resp.json::<Value>().await.map_err(|e| e.to_string());
    }
    Err("Transmission не выдал сессию.".into())
}

// ---------- Deluge ----------

async fn dl_call(base: &str, cookie: &str, id: u32, method: &str, params: Value) -> Result<(Value, Vec<String>), String> {
    let mut rb = client().post(format!("{base}/json")).json(&json!({ "method": method, "params": params, "id": id }));
    if !cookie.is_empty() {
        rb = rb.header("Cookie", cookie);
    }
    let resp = rb.send().await.map_err(|e| format!("Нет связи с Deluge: {e}"))?;
    if !resp.status().is_success() {
        return Err(format!("Deluge ответил {}", resp.status().as_u16()));
    }
    let cookies = set_cookies(&resp);
    let v = resp.json::<Value>().await.map_err(|e| e.to_string())?;
    if !v["error"].is_null() {
        return Err(format!("Deluge: {}", v["error"]["message"].as_str().unwrap_or("ошибка")));
    }
    Ok((v["result"].clone(), cookies))
}

async fn dl_session(base: &str, c: &TcConfig) -> Result<String, String> {
    let (ok, cookies) = dl_call(base, "", 1, "auth.login", json!([c.pass])).await?;
    if ok != json!(true) {
        return Err("Deluge не принял пароль.".into());
    }
    let cookie = extract_cookie(&cookies, "_session_id").map(|s| format!("_session_id={s}")).unwrap_or_default();
    // веб-интерфейс должен быть подключён к демону
    let (connected, _) = dl_call(base, &cookie, 2, "web.connected", json!([])).await?;
    if connected != json!(true) {
        let (hosts, _) = dl_call(base, &cookie, 3, "web.get_hosts", json!([])).await?;
        let host_id = hosts.get(0).and_then(|h| h.get(0)).and_then(|v| v.as_str()).ok_or("В Deluge нет ни одного демона.")?;
        dl_call(base, &cookie, 4, "web.connect", json!([host_id])).await?;
    }
    Ok(cookie)
}

// ---------- общие команды ----------

fn merge_test_cfg(mut cfg: TcConfig) -> Result<TcConfig, String> {
    cfg.url = normalize_base(&cfg.url)?;
    if cfg.pass.is_empty() {
        if let Ok(old) = load_cfg() {
            if old.kind == cfg.kind && old.user == cfg.user {
                cfg.pass = old.pass;
            }
        }
    }
    Ok(cfg)
}

#[tauri::command(async)]
pub async fn tc_test(cfg: TcConfig) -> Result<String, String> {
    let c = merge_test_cfg(cfg)?;
    match c.kind.as_str() {
        "qbittorrent" => {
            let cookie = qb_login(&c.url, &c).await?;
            qb_version(&c.url, &cookie).await
        }
        "transmission" => {
            let mut sess = String::new();
            let v = tr_call(&c.url, &c, &mut sess, &json!({ "method": "session-get" })).await?;
            Ok(format!("Transmission {}", v["arguments"]["version"].as_str().unwrap_or("")))
        }
        "deluge" => {
            let cookie = dl_session(&c.url, &c).await?;
            let (v, _) = dl_call(&c.url, &cookie, 5, "daemon.get_version", json!([])).await.unwrap_or((Value::Null, vec![]));
            Ok(format!("Deluge {}", v.as_str().unwrap_or("")))
        }
        _ => Err("Неизвестный клиент.".into()),
    }
}

#[tauri::command(async)]
pub async fn tc_add(magnets: Vec<String>) -> Result<usize, String> {
    if magnets.is_empty() || magnets.len() > MAX_MAGNETS {
        return Err(format!("За раз можно отправить от 1 до {MAX_MAGNETS} раздач."));
    }
    if let Some(bad) = magnets.iter().find(|m| !valid_magnet(m)) {
        return Err(format!("Это не magnet-ссылка: {}", bad.chars().take(40).collect::<String>()));
    }
    let c = load_cfg()?;
    match c.kind.as_str() {
        "qbittorrent" => {
            let cookie = qb_login(&c.url, &c).await?;
            qb_add(&c.url, &cookie, &c, &magnets).await?;
        }
        "transmission" => {
            let mut sess = String::new();
            for m in &magnets {
                let v = tr_call(&c.url, &c, &mut sess, &json!({ "method": "torrent-add", "arguments": { "filename": m, "paused": c.paused } })).await?;
                if v["result"].as_str() != Some("success") {
                    return Err(format!("Transmission: {}", v["result"].as_str().unwrap_or("ошибка")));
                }
            }
        }
        "deluge" => {
            let cookie = dl_session(&c.url, &c).await?;
            for (i, m) in magnets.iter().enumerate() {
                dl_call(&c.url, &cookie, 10 + i as u32, "core.add_torrent_magnet", json!([m, { "add_paused": c.paused }])).await?;
            }
        }
        _ => return Err("Неизвестный клиент.".into()),
    }
    Ok(magnets.len())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalizes_base() {
        assert_eq!(normalize_base("http://127.0.0.1:8080/").unwrap(), "http://127.0.0.1:8080");
        assert_eq!(normalize_base("https://nas.local:9091/transmission/rpc/").unwrap(), "https://nas.local:9091/transmission/rpc");
        assert_eq!(normalize_base("  http://localhost:8112 ").unwrap(), "http://localhost:8112");
        assert!(normalize_base("ftp://x").is_err());
        assert!(normalize_base("javascript:alert(1)").is_err());
        assert!(normalize_base("127.0.0.1:8080").is_err());
    }

    #[test]
    fn validates_magnets() {
        assert!(valid_magnet("magnet:?xt=urn:btih:abcdef&dn=x"));
        assert!(!valid_magnet("http://evil/x.torrent"));
        assert!(!valid_magnet("magnet:?xt=urn:btih:abc\nmagnet:?xt=urn:btih:def"));
        assert!(!valid_magnet(&format!("magnet:?xt=urn:btih:{}", "a".repeat(4000))));
    }

    #[test]
    fn extracts_cookie() {
        let c = vec!["foo=1; Path=/".to_string(), "SID=abc123; HttpOnly; path=/".to_string()];
        assert_eq!(extract_cookie(&c, "SID").as_deref(), Some("abc123"));
        assert_eq!(extract_cookie(&c, "_session_id"), None);
    }

    #[test]
    fn transmission_rpc_url() {
        assert_eq!(tr_url("http://h:9091"), "http://h:9091/transmission/rpc");
        assert_eq!(tr_url("http://h:9091/transmission/rpc"), "http://h:9091/transmission/rpc");
    }
}
