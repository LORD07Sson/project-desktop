// Генерирует контекст Tauri (tauri.conf.json, иконки, права) для сборки.
fn main() {
    encode_av_baseline();
    server_origin();
    tauri_build::build()
}

// Адрес сервера — из ../server.json (единственное место, его же читает интерфейс). Свой мини-разбор: тянуть
// serde_json в build-зависимости ради одной строки незачем.
fn server_origin() {
    println!("cargo:rerun-if-changed=../server.json");
    let text = std::fs::read_to_string("../server.json").expect("server.json");
    let after = &text[text.find("\"origin\"").expect("server.json: нет origin")..];
    let value = after.splitn(3, '"').nth(2).and_then(|rest| rest.split('"').nth(1)).expect("server.json: origin не строка");
    assert!(value.starts_with("https://") && !value.ends_with('/'), "server.json: origin — https://домен[:порт] без / в конце");
    println!("cargo:rustc-env=SERVER_ORIGIN={value}");
}

// База встроенного антивируса — имена майнеров, адреса пулов, «stratum+tcp» и т. п. Открытым текстом внутри
// exe это ровно то, по чему ClamAV/Kaspersky узнают сам майнер (Win.Coinminer.Generic, RiskTool.BitMiner), поэтому
// в бинарник кладём её закодированной; раскодирует antivirus.rs::baseline_json() тем же ключом.
fn encode_av_baseline() {
    const KEY: &[u8] = b"DUB-av-baseline/1";
    println!("cargo:rerun-if-changed=av-baseline.json");
    let src = std::fs::read("av-baseline.json").expect("av-baseline.json");
    let out: Vec<u8> = src.iter().enumerate().map(|(i, b)| b ^ KEY[i % KEY.len()]).collect();
    let dir = std::env::var("OUT_DIR").expect("OUT_DIR");
    std::fs::write(std::path::Path::new(&dir).join("av-baseline.bin"), out).expect("av-baseline.bin");
}
