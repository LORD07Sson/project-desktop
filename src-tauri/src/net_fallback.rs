
use std::collections::HashMap;
use std::net::{IpAddr, SocketAddr, ToSocketAddrs};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};

const DOH: [&str; 3] = [
    "https://1.1.1.1/dns-query",
    "https://8.8.8.8/resolve",
    "https://1.0.0.1/dns-query",
];
const CACHE_FOR: Duration = Duration::from_secs(30 * 60);

#[derive(Deserialize)]
struct DohAnswer {
    #[serde(rename = "type")]
    kind: u16,
    data: String,
}

#[derive(Deserialize)]
struct DohReply {
    #[serde(rename = "Answer", default)]
    answer: Vec<DohAnswer>,
}

#[derive(Serialize)]
pub struct FallbackResponse {
    pub status: u16,
    pub body: String,
    pub via: &'static str,
}

struct Cached {
    ip: IpAddr,
    at: Instant,
    client: reqwest::Client,
}

static CACHE: Mutex<Option<Cached>> = Mutex::new(None);

fn host_port(base: &str) -> (String, u16) {
    let rest = base.trim_start_matches("https://");
    let hp = rest.split('/').next().unwrap_or("");
    match hp.rsplit_once(':') {
        Some((h, p)) => (h.to_string(), p.parse().unwrap_or(443)),
        None => (hp.to_string(), 443),
    }
}

pub fn system_dns_ok(base: &str) -> bool {
    let (host, port) = host_port(base);
    (host.as_str(), port).to_socket_addrs().map(|mut a| a.next().is_some()).unwrap_or(false)
}

async fn doh_resolve(host: &str) -> Result<IpAddr, String> {
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(5))
        .build()
        .map_err(|e| e.to_string())?;
    let mut last = String::from("DoH не ответил");
    for url in DOH {
        let resp = client
            .get(url)
            .query(&[("name", host), ("type", "A")])
            .header("accept", "application/dns-json")
            .send()
            .await;
        match resp {
            Ok(r) => match r.json::<DohReply>().await {
                Ok(reply) => {
                    if let Some(ip) = reply.answer.iter().filter(|a| a.kind == 1).find_map(|a| a.data.parse::<IpAddr>().ok()) {
                        return Ok(ip);
                    }
                    last = format!("{url}: нет A-записи");
                }
                Err(e) => last = format!("{url}: {e}"),
            },
            Err(e) => last = format!("{url}: {e}"),
        }
    }
    Err(last)
}

async fn client_for(base: &str, fresh: bool) -> Result<reqwest::Client, String> {
    if !fresh {
        if let Some(c) = CACHE.lock().unwrap().as_ref() {
            if c.at.elapsed() < CACHE_FOR {
                return Ok(c.client.clone());
            }
        }
    }
    let (host, port) = host_port(base);
    let ip = doh_resolve(&host).await?;
    let client = reqwest::Client::builder()
        .resolve(&host, SocketAddr::new(ip, port))
        .timeout(Duration::from_secs(30))
        .build()
        .map_err(|e| e.to_string())?;
    *CACHE.lock().unwrap() = Some(Cached { ip, at: Instant::now(), client: client.clone() });
    Ok(client)
}

pub async fn request(
    base: &str,
    method: &str,
    path: &str,
    headers: HashMap<String, String>,
    body: Option<String>,
    write: bool,
) -> Result<FallbackResponse, String> {
    if !path.starts_with('/') || path.contains("://") || path.contains('\\') {
        return Err("недопустимый путь".into());
    }
    if write && system_dns_ok(base) {
        return Err("системный DNS работает — запасной путь не нужен".into());
    }
    let method = reqwest::Method::from_bytes(method.as_bytes()).map_err(|e| e.to_string())?;
    if !matches!(method.as_str(), "GET" | "POST" | "DELETE" | "PUT" | "PATCH") {
        return Err("недопустимый метод".into());
    }
    let url = format!("{base}{path}");
    let mut last = String::new();
    for fresh in [false, true] {
        let client = client_for(base, fresh).await?;
        let mut req = client.request(method.clone(), &url);
        for (k, v) in &headers {
            if matches!(k.to_ascii_lowercase().as_str(), "content-type" | "x-init-data" | "x-app-version" | "x-preview-role") {
                req = req.header(k, v);
            }
        }
        if let Some(b) = &body {
            req = req.body(b.clone());
        }
        match req.send().await {
            Ok(resp) => {
                let status = resp.status().as_u16();
                let body = resp.text().await.map_err(|e| e.to_string())?;
                return Ok(FallbackResponse { status, body, via: "doh" });
            }
            Err(e) => {
                last = e.to_string();
                if write {
                    break;
                }
            }
        }
    }
    Err(last)
}

pub fn cached_ip() -> Option<String> {
    CACHE.lock().unwrap().as_ref().map(|c| c.ip.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn splits_host_and_port() {
        assert_eq!(host_port("https://abuse.example.com:8443/api"), ("abuse.example.com".into(), 8443));
        assert_eq!(host_port("https://example.com/api"), ("example.com".into(), 443));
    }
}
