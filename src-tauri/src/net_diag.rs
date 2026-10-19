//! Проверка связи для «Карты работы»: удаётся ли определить адрес нашего сервера через DNS компьютера, какие DNS-серверы
//! настроены и чьи они. Из окна приложения (WebView) это не видно, поэтому делается здесь. Сам запрос к серверу — в JS.
//! Проверяется только адрес нашего сервера, произвольные имена команда не принимает.

use std::net::ToSocketAddrs;
use std::time::Instant;

use serde::Serialize;

#[derive(Serialize)]
pub struct NetDiag {
    pub dns_ok: bool,
    pub dns_ms: u64,
    pub resolved: Vec<String>,
    pub dns_servers: Vec<String>,
    pub dns_provider: String,
}

/// Известные публичные DNS; локальные адреса — это обычно роутер или DNS провайдера, который он раздаёт.
fn provider_of(ip: &str) -> Option<&'static str> {
    const KNOWN: &[(&str, &str)] = &[
        ("8.8.8.8", "Google"), ("8.8.4.4", "Google"), ("2001:4860:4860::8888", "Google"),
        ("1.1.1.1", "Cloudflare"), ("1.0.0.1", "Cloudflare"), ("2606:4700:4700::1111", "Cloudflare"),
        ("77.88.8.8", "Яндекс DNS"), ("77.88.8.1", "Яндекс DNS"), ("77.88.8.88", "Яндекс DNS (безопасный)"), ("77.88.8.7", "Яндекс DNS (семейный)"),
        ("9.9.9.9", "Quad9"), ("149.112.112.112", "Quad9"),
        ("94.140.14.14", "AdGuard"), ("94.140.15.15", "AdGuard"),
        ("208.67.222.222", "OpenDNS"), ("208.67.220.220", "OpenDNS"),
        ("185.228.168.9", "CleanBrowsing"), ("76.76.2.0", "Control D"), ("45.90.28.0", "NextDNS"),
    ];
    KNOWN.iter().find(|(k, _)| *k == ip).map(|(_, v)| *v)
}

fn is_local(ip: &str) -> bool {
    ip.starts_with("10.")
        || ip.starts_with("192.168.")
        || ip.starts_with("169.254.")
        || ip.starts_with("127.")
        || ip.starts_with("fe80:")
        || ip == "::1"
        || ip.strip_prefix("172.").and_then(|r| r.split('.').next()).and_then(|n| n.parse::<u8>().ok()).map(|n| (16..=31).contains(&n)).unwrap_or(false)
}

#[cfg(windows)]
fn system_dns_servers() -> Vec<String> {
    let out = crate::audio_qc::hidden_command("powershell")
        .args([
            "-NoProfile",
            "-NonInteractive",
            "-Command",
            "Get-DnsClientServerAddress | Where-Object { $_.ServerAddresses } | ForEach-Object { $_.ServerAddresses } | Select-Object -Unique",
        ])
        .output();
    match out {
        Ok(o) => String::from_utf8_lossy(&o.stdout).lines().map(|l| l.trim().to_string()).filter(|l| !l.is_empty()).collect(),
        Err(_) => Vec::new(),
    }
}

#[cfg(not(windows))]
fn system_dns_servers() -> Vec<String> {
    std::fs::read_to_string("/etc/resolv.conf")
        .map(|t| t.lines().filter_map(|l| l.strip_prefix("nameserver ").map(|s| s.trim().to_string())).collect())
        .unwrap_or_default()
}

pub fn diagnose(host: &str) -> NetDiag {
    let started = Instant::now();
    let resolved: Vec<String> = match (host, 443u16).to_socket_addrs() {
        Ok(it) => it.map(|a| a.ip().to_string()).collect::<std::collections::BTreeSet<_>>().into_iter().take(3).collect(),
        Err(_) => Vec::new(),
    };
    let dns_ms = started.elapsed().as_millis() as u64;

    let mut servers = system_dns_servers();
    servers.dedup();
    servers.truncate(4);
    // Провайдер = первый известный публичный DNS из списка; если все локальные — роутер/провайдер; иначе — неизвестный
    let provider = servers
        .iter()
        .find_map(|s| provider_of(s))
        .map(str::to_string)
        .or_else(|| servers.first().map(|s| if is_local(s) { "роутер или DNS провайдера (локальный адрес)".to_string() } else { format!("другой ({s})") }))
        .unwrap_or_else(|| "не определён".to_string());

    NetDiag { dns_ok: !resolved.is_empty(), dns_ms, resolved, dns_servers: servers, dns_provider: provider }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn knows_public_dns_and_local() {
        assert_eq!(provider_of("8.8.8.8"), Some("Google"));
        assert_eq!(provider_of("77.88.8.8"), Some("Яндекс DNS"));
        assert!(is_local("192.168.0.1") && is_local("172.20.1.1") && !is_local("172.40.1.1") && !is_local("8.8.8.8"));
    }
}
