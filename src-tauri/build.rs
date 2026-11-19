fn main() {
    encode_av_baseline();
    server_origin();
    tauri_build::build()
}

fn server_origin() {
    println!("cargo:rerun-if-changed=../server.json");
    let text = std::fs::read_to_string("../server.json").expect("server.json");
    let after = &text[text.find("\"origin\"").expect("server.json: нет origin")..];
    let value = after.splitn(3, '"').nth(2).and_then(|rest| rest.split('"').nth(1)).expect("server.json: origin не строка");
    assert!(value.starts_with("https://") && !value.ends_with('/'), "server.json: origin — https://домен[:порт] без / в конце");
    println!("cargo:rustc-env=SERVER_ORIGIN={value}");
}

fn encode_av_baseline() {
    const KEY: &[u8] = b"DUB-av-baseline/1";
    println!("cargo:rerun-if-changed=av-baseline.json");
    let src = std::fs::read("av-baseline.json").expect("av-baseline.json");
    let out: Vec<u8> = src.iter().enumerate().map(|(i, b)| b ^ KEY[i % KEY.len()]).collect();
    let dir = std::env::var("OUT_DIR").expect("OUT_DIR");
    std::fs::write(std::path::Path::new(&dir).join("av-baseline.bin"), out).expect("av-baseline.bin");
}
