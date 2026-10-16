//! Антивирус: проверка ПК, карантин, обновляемые базы сигнатур.
//!
//! Что делает:
//!   • сверяет SHA-256 исполняемых файлов с базой хешей (свежие образцы MalwareBazaar, база обновляется с нашего сервера);
//!   • ищет майнеры и хакерские утилиты по имени файла, командной строке процесса, доменам и портам майнинг-пулов;
//!   • смотрит автозапуск и исключения Защитника Windows (там майнеры любят прятаться);
//!   • подозрительное уходит в карантин (файл перекладывается и «портится» XOR, запустить его нельзя): восстановить, удалить
//!     совсем или добавить в исключения.
//!
//! Чего НЕ делает: не заменяет Защитник Windows (поведенческий анализ, драйверы, облачная защита) — он остаётся основным; здесь
//! сигнатуры и эвристики поверх него, плюс кнопки для запуска проверки и обновления самого Защитника. Ничего не удаляется
//! без явного действия пользователя, системные папки и сама программа защищены от карантина.

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::collections::{HashMap, HashSet};
use std::fs;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::atomic::{AtomicBool, Ordering};
use tauri::{AppHandle, Emitter, Manager};

const BASELINE: &str = include_str!("../av-baseline.json");
const API_BASE: &str = "https://minitg.shitstudent.com:8443/api";
const MAX_HASH_BYTES: u64 = 300 * 1024 * 1024;
const XOR_KEY: u8 = 0x5A;
const SCAN_EXTS: &[&str] = &[
    // исполняемые и скрипты
    "exe", "dll", "scr", "bat", "cmd", "ps1", "vbs", "vbe", "jse", "js", "wsf", "msi", "jar", "com", "hta", "cpl", "ocx", "sys", "pif", "reg", "lnk",
    // документы (макросы, эксплойты) и контейнеры, в которых прячут вирусы
    "doc", "docm", "dot", "dotm", "xls", "xlsm", "xlsb", "xlam", "ppt", "pptm", "rtf", "pdf", "iso", "img", "zip", "rar", "7z", "cab",
];

static CANCEL: AtomicBool = AtomicBool::new(false);

// ---------------------------------------------------------------- базы

#[derive(Deserialize, Serialize, Clone, Default)]
struct NameSig {
    p: String,
    n: String,
    #[serde(default)]
    s: String,
}

#[derive(Deserialize, Serialize, Clone, Default)]
struct Signatures {
    #[serde(default)]
    version: u64,
    #[serde(default)]
    updated: String,
    #[serde(default)]
    sha256: HashMap<String, String>,
    #[serde(default)]
    names: Vec<NameSig>,
    #[serde(default)]
    cmdline: Vec<String>,
    #[serde(default)]
    pool_domains: Vec<String>,
    #[serde(default)]
    pool_ports: Vec<u16>,
    /// Адреса управляющих серверов вредоносов (Feodo, SSLBL, ThreatFox) и домены, раздающие вредоносное (URLhaus, NoCoin).
    #[serde(default)]
    bad_ips: Vec<String>,
    #[serde(default)]
    bad_domains: Vec<String>,
}

/// Окружение проверки: каталог данных антивируса и приёмник прогресса. Не привязано к окну Tauri, поэтому та же проверка
/// запускается и в отдельном процессе с правами администратора (headless).
pub struct Env {
    dir: PathBuf,
    sink: Box<dyn Fn(Value) + Send + Sync>,
}

fn env_for_app(app: &AppHandle) -> Result<Env, String> {
    let dir = av_dir(app)?;
    let handle = app.clone();
    Ok(Env { dir, sink: Box::new(move |v| { let _ = handle.emit("av-progress", v); }) })
}

fn av_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?.join("av");
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir)
}

/// Полная база хешей (MalwareBazaar + ThreatFox): сортированные первые 8 байт SHA-256. Формат: «AVH1», u32 версия, u64 число, записи.
fn parse_full(bytes: &[u8]) -> Option<(u32, Vec<u64>)> {
    if bytes.len() < 16 || &bytes[..4] != b"AVH1" {
        return None;
    }
    let version = u32::from_be_bytes(bytes[4..8].try_into().ok()?);
    let count = u64::from_be_bytes(bytes[8..16].try_into().ok()?) as usize;
    if bytes.len() != 16 + count * 8 {
        return None;
    }
    let data = bytes[16..].chunks_exact(8).map(|c| u64::from_be_bytes(c.try_into().unwrap_or([0; 8]))).collect();
    Some((version, data))
}

fn load_full_in(dir: &Path) -> Vec<u64> {
    fs::read(dir.join("bazaar_full.bin")).ok().and_then(|b| parse_full(&b)).map(|(_, d)| d).unwrap_or_default()
}

fn full_version_in(dir: &Path) -> (u32, usize) {
    fs::read(dir.join("bazaar_full.bin")).ok().and_then(|b| parse_full(&b)).map(|(v, d)| (v, d.len())).unwrap_or((0, 0))
}

fn load_signatures_in(dir: &Path) -> Signatures {
    let baseline: Signatures = serde_json::from_str(BASELINE).unwrap_or_default();
    if let Ok(text) = fs::read_to_string(dir.join("signatures.json")) {
        if let Ok(local) = serde_json::from_str::<Signatures>(&text) {
            if local.version >= baseline.version {
                return local;
            }
        }
    }
    baseline
}

fn load_signatures(app: &AppHandle) -> Signatures {
    av_dir(app).map(|d| load_signatures_in(&d)).unwrap_or_else(|_| serde_json::from_str(BASELINE).unwrap_or_default())
}

// ------------------------------------------------------ исключения и карантин

#[derive(Deserialize, Serialize, Default, Clone)]
struct Exclusions {
    #[serde(default)]
    paths: Vec<String>,
    #[serde(default)]
    hashes: Vec<String>,
}

fn load_exclusions_in(dir: &Path) -> Exclusions {
    fs::read_to_string(dir.join("exclusions.json"))
        .ok()
        .and_then(|t| serde_json::from_str(&t).ok())
        .unwrap_or_default()
}

fn load_exclusions(app: &AppHandle) -> Exclusions {
    av_dir(app).map(|d| load_exclusions_in(&d)).unwrap_or_default()
}

fn save_exclusions(app: &AppHandle, ex: &Exclusions) -> Result<(), String> {
    let dir = av_dir(app)?;
    fs::write(dir.join("exclusions.json"), serde_json::to_vec(ex).unwrap_or_default()).map_err(|e| e.to_string())
}

#[derive(Deserialize, Serialize, Clone)]
struct QItem {
    id: String,
    original: String,
    name: String,
    sha256: String,
    label: String,
    size: u64,
    at: u64,
}

fn qdir(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = av_dir(app)?.join("quarantine");
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir)
}

fn load_quarantine(app: &AppHandle) -> Vec<QItem> {
    av_dir(app)
        .ok()
        .and_then(|d| fs::read_to_string(d.join("quarantine.json")).ok())
        .and_then(|t| serde_json::from_str(&t).ok())
        .unwrap_or_default()
}

fn save_quarantine(app: &AppHandle, items: &[QItem]) -> Result<(), String> {
    let dir = av_dir(app)?;
    fs::write(dir.join("quarantine.json"), serde_json::to_vec(items).unwrap_or_default()).map_err(|e| e.to_string())
}

/// Журнал: проверки, карантин, восстановление, исключения, срабатывания защиты — вкладка «История». Хранятся последние 300.
fn log_event_in(dir: &Path, kind: &str, title: &str, detail: &str) {
    let path = dir.join("history.json");
    let mut list: Vec<Value> = fs::read_to_string(&path).ok().and_then(|t| serde_json::from_str(&t).ok()).unwrap_or_default();
    list.insert(0, json!({ "at": now_secs(), "kind": kind, "title": title, "detail": detail }));
    list.truncate(300);
    let _ = fs::write(&path, serde_json::to_vec(&list).unwrap_or_default());
}

pub fn log_event(app: &AppHandle, kind: &str, title: &str, detail: &str) {
    if let Ok(dir) = av_dir(app) {
        log_event_in(&dir, kind, title, detail);
    }
}

#[tauri::command]
pub fn av_history(app: AppHandle) -> Vec<Value> {
    av_dir(&app)
        .ok()
        .and_then(|d| fs::read_to_string(d.join("history.json")).ok())
        .and_then(|t| serde_json::from_str(&t).ok())
        .unwrap_or_default()
}

fn now_secs() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

/// Копирует файл через XOR: «карантинный» файл невозможно запустить, и сигнатурные сканеры его не узнают.
fn xor_copy(from: &Path, to: &Path) -> std::io::Result<()> {
    let mut src = fs::File::open(from)?;
    let mut dst = fs::File::create(to)?;
    let mut buf = vec![0u8; 1 << 20];
    loop {
        let n = src.read(&mut buf)?;
        if n == 0 {
            break;
        }
        for b in &mut buf[..n] {
            *b ^= XOR_KEY;
        }
        dst.write_all(&buf[..n])?;
    }
    dst.flush()
}

// ------------------------------------------------------------ защита системы

/// Пути, которые нельзя трогать никогда: Windows, сама программа, каталог карантина.
fn is_protected(path: &Path, own_dirs: &[PathBuf]) -> bool {
    let lower = path.to_string_lossy().to_lowercase().replace('/', "\\");
    if let Ok(windir) = std::env::var("WINDIR") {
        let w = windir.to_lowercase();
        if lower.starts_with(&format!("{w}\\")) || lower == w {
            return true;
        }
    }
    if lower.contains("\\windows\\system32\\") || lower.contains("\\windows\\syswow64\\") || lower.contains("\\windows\\winsxs\\") {
        return true;
    }
    own_dirs.iter().any(|d| {
        let o = d.to_string_lossy().to_lowercase().replace('/', "\\");
        !o.is_empty() && (lower == o || lower.starts_with(&format!("{o}\\")))
    })
}

fn is_own(path: &Path, own_dirs: &[PathBuf]) -> bool {
    let lower = path.to_string_lossy().to_lowercase().replace('/', "\\");
    own_dirs.iter().any(|d| {
        let o = d.to_string_lossy().to_lowercase().replace('/', "\\");
        !o.is_empty() && (lower == o || lower.starts_with(&format!("{o}\\")))
    })
}

fn own_dirs(app: &AppHandle) -> Vec<PathBuf> {
    own_dirs_in(av_dir(app).ok())
}

fn own_dirs_in(av: Option<PathBuf>) -> Vec<PathBuf> {
    let mut dirs = Vec::new();
    if let Ok(exe) = std::env::current_exe() {
        if let Some(parent) = exe.parent() {
            dirs.push(parent.to_path_buf());
            // Velopack кладёт текущую версию в <корень>\current; корень содержит Update.exe и пакеты.
            if let Some(root) = parent.parent() {
                if root.join("Update.exe").exists() {
                    dirs.push(root.to_path_buf());
                }
            }
        }
    }
    if let Some(d) = av {
        dirs.push(d);
    }
    dirs
}

// -------------------------------------------------------------------- утилиты

fn sha256_file(path: &Path) -> Option<String> {
    let meta = fs::metadata(path).ok()?;
    if !meta.is_file() || meta.len() > MAX_HASH_BYTES {
        return None;
    }
    let mut file = fs::File::open(path).ok()?;
    let mut hasher = Sha256::new();
    let mut buf = vec![0u8; 1 << 20];
    loop {
        let n = file.read(&mut buf).ok()?;
        if n == 0 {
            break;
        }
        hasher.update(&buf[..n]);
    }
    Some(hex(&hasher.finalize()))
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

fn detection_id(kind: &str, key: &str) -> String {
    let mut h = Sha256::new();
    h.update(kind.as_bytes());
    h.update(b"|");
    h.update(key.as_bytes());
    hex(&h.finalize())[..16].to_string()
}

/// PowerShell без окна, вывод в UTF-8. На не-Windows возвращает ошибку (проверка процессов и реестра только для Windows).
fn powershell(script: &str) -> Result<String, String> {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        let full = format!("[Console]::OutputEncoding=[Text.UTF8Encoding]::new(); $ProgressPreference='SilentlyContinue'; {script}");
        let out = Command::new("powershell")
            .args(["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", &full])
            .creation_flags(0x0800_0000)
            .output()
            .map_err(|e| e.to_string())?;
        Ok(String::from_utf8_lossy(&out.stdout).to_string())
    }
    #[cfg(not(windows))]
    {
        let _ = script;
        Err("Проверка процессов и реестра доступна только в Windows".into())
    }
}

/// PowerShell отдаёт один объект без массива — приводим к списку.
fn json_items(text: &str) -> Vec<Value> {
    match serde_json::from_str::<Value>(text.trim()) {
        Ok(Value::Array(a)) => a,
        Ok(v @ Value::Object(_)) => vec![v],
        _ => Vec::new(),
    }
}

/// Путь к exe из значения автозапуска: `"C:\x\a.exe" -arg` или `C:\x\a.exe /arg`.
fn extract_exe(data: &str) -> Option<String> {
    let t = data.trim();
    if let Some(rest) = t.strip_prefix('"') {
        return rest.split('"').next().map(|s| s.to_string());
    }
    let lower = t.to_lowercase();
    for ext in [".exe", ".bat", ".cmd", ".ps1", ".vbs", ".scr", ".com", ".jar"] {
        if let Some(i) = lower.find(ext) {
            return Some(t[..i + ext.len()].to_string());
        }
    }
    None
}

fn file_stem_lower(path: &str) -> String {
    Path::new(path)
        .file_stem()
        .map(|s| s.to_string_lossy().to_lowercase())
        .unwrap_or_default()
}

fn match_name<'a>(sigs: &'a Signatures, stem: &str) -> Option<&'a NameSig> {
    if stem.len() < 4 {
        return None;
    }
    sigs.names.iter().find(|n| {
        let p = n.p.to_lowercase();
        stem == p || stem.starts_with(&format!("{p}-")) || stem.starts_with(&format!("{p}_")) || stem.starts_with(&format!("{p}.")) || (p.len() >= 6 && stem.contains(&p))
    })
}

fn match_cmdline<'a>(sigs: &'a Signatures, cmd: &str) -> Option<&'a str> {
    let lower = cmd.to_lowercase();
    sigs.cmdline
        .iter()
        .map(|s| s.as_str())
        .find(|s| lower.contains(&s.to_lowercase()))
        .or_else(|| sigs.pool_domains.iter().map(|s| s.as_str()).find(|d| lower.contains(&d.to_lowercase())))
}

/// Домен из списка вредоносных, упомянутый в командной строке.
fn match_bad_domain<'a>(sigs: &'a Signatures, cmd: &str) -> Option<&'a str> {
    let lower = cmd.to_lowercase();
    if !lower.contains('.') {
        return None;
    }
    sigs.bad_domains.iter().map(|d| d.as_str()).find(|d| d.len() >= 6 && lower.contains(d))
}

/// Множество адресов C2 для быстрой проверки соединений.
pub fn bad_ip_set(app: &AppHandle) -> HashSet<String> {
    load_signatures(app).bad_ips.into_iter().collect()
}

#[derive(Serialize, Clone)]
pub struct Detection {
    pub id: String,
    pub kind: String,
    pub severity: String,
    pub title: String,
    pub detail: String,
    pub path: Option<String>,
    pub pid: Option<u64>,
    pub sha256: Option<String>,
    pub extra: Value,
}

struct Ctx {
    sigs: Signatures,
    excl: Exclusions,
    own: Vec<PathBuf>,
    found: Vec<Detection>,
    seen: HashSet<String>,
    hashed: HashMap<String, Option<String>>,
    scanned: u64,
    /// Сколько реально проверено и что пропущено — чтобы отчёт честно показывал охват.
    files: u64,
    procs: u64,
    folders: u64,
    skipped_large: u64,
    denied_dirs: u64,
    denied_list: Vec<String>,
    /// Все файлы, которые прошёл обход, и сколько из них пропущено как «не тот тип» (картинки, видео, текст…).
    total_files: u64,
    skipped_type: u64,
    all_files: bool,
    full: Vec<u64>,
}

impl Ctx {
    fn push(&mut self, d: Detection) {
        if self.seen.insert(d.id.clone()) {
            self.found.push(d);
        }
    }

    fn excluded(&self, path: &str, sha: Option<&str>) -> bool {
        let lower = path.to_lowercase();
        self.excl.paths.iter().any(|p| p.to_lowercase() == lower) || sha.map(|h| self.excl.hashes.iter().any(|x| x == h)).unwrap_or(false)
    }

    /// Проверка одного файла: хеш по базе, затем имя. Возвращает true, если что-то нашли.
    fn check_file(&mut self, path: &str, kind: &str, pid: Option<u64>) -> bool {
        let p = Path::new(path);
        let sha = if let Some(c) = self.hashed.get(path) {
            c.clone()
        } else {
            let h = sha256_file(p);
            self.hashed.insert(path.to_string(), h.clone());
            h
        };
        if self.excluded(path, sha.as_deref()) {
            return false;
        }
        if let Some(h) = &sha {
            if let Some(label) = self.sigs.sha256.get(h).cloned() {
                self.push(Detection {
                    id: detection_id("hash", path),
                    kind: kind.into(),
                    severity: "high".into(),
                    title: format!("Найден вредоносный файл: {label}"),
                    detail: "SHA-256 файла есть в базе вредоносных образцов.".into(),
                    path: Some(path.into()),
                    pid,
                    sha256: sha.clone(),
                    extra: json!({ "label": label }),
                });
                return true;
            }
        }
        if let Some(h) = &sha {
            if h.len() >= 16 {
                if let Ok(prefix) = u64::from_str_radix(&h[..16], 16) {
                    if self.full.binary_search(&prefix).is_ok() {
                        self.push(Detection {
                            id: detection_id("hash", path),
                            kind: kind.into(),
                            severity: "high".into(),
                            title: "Найден вредоносный файл: образец из полной базы MalwareBazaar".into(),
                            detail: "SHA-256 файла есть в полной базе известных вредоносных образцов (MalwareBazaar / ThreatFox).".into(),
                            path: Some(path.into()),
                            pid,
                            sha256: sha.clone(),
                            extra: json!({ "label": "MalwareBazaar" }),
                        });
                        return true;
                    }
                }
            }
        }
        let stem = file_stem_lower(path);
        if let Some(n) = match_name(&self.sigs, &stem).cloned() {
            self.push(Detection {
                id: detection_id("name", path),
                kind: kind.into(),
                severity: if n.s.is_empty() { "medium".into() } else { n.s.clone() },
                title: format!("Подозрительная программа: {}", n.n),
                detail: "Имя файла совпадает с известным майнером или хакерской утилитой.".into(),
                path: Some(path.into()),
                pid,
                sha256: sha,
                extra: json!({ "label": n.n }),
            });
            return true;
        }
        false
    }
}

/// Проверка одного файла «на лету» (защита в реальном времени): базы и исключения подхватываются раз в 5 минут.
pub struct Checker {
    ctx: Ctx,
    dir: PathBuf,
    loaded: std::time::Instant,
}

impl Checker {
    pub fn new(app: &AppHandle) -> Option<Self> {
        let dir = av_dir(app).ok()?;
        Some(Checker {
            ctx: Ctx {
                sigs: load_signatures_in(&dir),
                excl: load_exclusions_in(&dir),
                own: own_dirs_in(Some(dir.clone())),
                found: Vec::new(),
                seen: HashSet::new(),
                hashed: HashMap::new(),
                scanned: 0,
                files: 0,
                procs: 0,
                folders: 0,
                skipped_large: 0,
                denied_dirs: 0,
                denied_list: Vec::new(),
                total_files: 0,
                skipped_type: 0,
                all_files: false,
                full: load_full_in(&dir),
            },
            dir,
            loaded: std::time::Instant::now(),
        })
    }

    pub fn check(&mut self, path: &str) -> Option<Detection> {
        if self.loaded.elapsed().as_secs() > 300 {
            self.ctx.sigs = load_signatures_in(&self.dir);
            self.ctx.excl = load_exclusions_in(&self.dir);
            self.ctx.full = load_full_in(&self.dir);
            self.loaded = std::time::Instant::now();
        }
        self.ctx.found.clear();
        self.ctx.seen.clear();
        self.ctx.hashed.clear(); // файл мог поменяться — хеш считаем заново
        if is_protected(Path::new(path), &self.ctx.own) {
            return None;
        }
        if self.ctx.check_file(path, "file", None) {
            self.ctx.found.pop()
        } else {
            None
        }
    }
}

pub fn is_scan_ext(path: &Path) -> bool {
    path.extension().map(|e| SCAN_EXTS.contains(&e.to_string_lossy().to_lowercase().as_str())).unwrap_or(false)
}

// -------------------------------------------------------------------- проверка

fn emit(env: &Env, stage: &str, scanned: u64, found: usize, current: &str) {
    (env.sink)(json!({ "stage": stage, "scanned": scanned, "found": found, "current": current }));
}

/// Все фиксированные диски (C:, D:…): полная проверка идёт по ним целиком, а не только по профилю пользователя.
fn fixed_drives() -> Vec<PathBuf> {
    let mut drives = Vec::new();
    if let Ok(text) = powershell("Get-CimInstance Win32_LogicalDisk -Filter 'DriveType=3' | Select-Object -ExpandProperty DeviceID | ConvertTo-Json -Compress") {
        match serde_json::from_str::<Value>(text.trim()) {
            Ok(Value::Array(a)) => drives.extend(a.iter().filter_map(|v| v.as_str()).map(|d| PathBuf::from(format!("{d}\\")))),
            Ok(Value::String(d)) => drives.push(PathBuf::from(format!("{d}\\"))),
            _ => {}
        }
    }
    if drives.is_empty() {
        if let Ok(sd) = std::env::var("SystemDrive") {
            drives.push(PathBuf::from(format!("{sd}\\")));
        }
    }
    drives
}

fn roots_for(mode: &str, custom: &[String]) -> Vec<(PathBuf, usize)> {
    let var = |n: &str| std::env::var(n).ok().map(PathBuf::from);
    let mut roots: Vec<(PathBuf, usize)> = Vec::new();
    match mode {
        "custom" => roots.extend(custom.iter().map(|p| (PathBuf::from(p), 12))),
        "full" => {
            // Все фиксированные диски целиком (в том числе Windows и Program Files); глубина — практически без ограничения.
            for d in fixed_drives() {
                roots.push((d, 24));
            }
        }
        _ => {
            // Быстрая: места, где чаще всего оседают вирусы — пользовательские папки, AppData, Temp, автозагрузка, общие папки
            // и «критичные» каталоги Windows. Для полного охвата (все диски) есть «Полная проверка».
            if let Some(u) = var("USERPROFILE") {
                for sub in ["Downloads", "Desktop", "Documents", "Pictures", "Videos", "Music"] {
                    roots.push((u.join(sub), 5));
                }
            }
            if let Some(a) = var("APPDATA") {
                roots.push((a.join("Microsoft\\Windows\\Start Menu\\Programs\\Startup"), 2));
                roots.push((a, 8));
            }
            if let Some(l) = var("LOCALAPPDATA") {
                roots.push((l, 8));
            }
            if let Some(p) = var("ProgramData") {
                roots.push((p, 6));
            }
            roots.push((PathBuf::from("C:\\Users\\Public"), 5));
            if let Some(w) = var("WINDIR") {
                roots.push((w.join("Temp"), 4));
                roots.push((w.join("Tasks"), 3));
                roots.push((w.join("System32\\Tasks"), 3));
                roots.push((w.join("System32\\drivers"), 2));
            }
            for n in ["ProgramFiles", "ProgramFiles(x86)"] {
                if let Some(p) = var(n) {
                    roots.push((p, 3));
                }
            }
        }
    }
    roots
}

fn walk(env: &Env, ctx: &mut Ctx, dir: &Path, depth: usize, stage: &str) {
    if depth == 0 || CANCEL.load(Ordering::Relaxed) {
        return;
    }
    let rd = match fs::read_dir(dir) {
        Ok(rd) => rd,
        Err(_) => {
            ctx.denied_dirs += 1;
            if ctx.denied_list.len() < 40 {
                ctx.denied_list.push(dir.to_string_lossy().to_string());
            }
            return;
        }
    };
    ctx.folders += 1;
    let mut last = std::time::Instant::now();
    for entry in rd.flatten() {
        if CANCEL.load(Ordering::Relaxed) {
            return;
        }
        let path = entry.path();
        let Ok(ft) = entry.file_type() else { continue };
        if ft.is_symlink() {
            continue; // не ходим по ссылкам: петли и выход за пределы проверяемой области
        }
        if ft.is_dir() {
            if is_own(&path, &ctx.own) {
                continue; // свою папку и карантин не проверяем
            }
            let name = entry.file_name().to_string_lossy().to_lowercase();
            if name == "$recycle.bin" || name == "node_modules" || name == "system volume information" || name == "winsxs" {
                continue;
            }
            walk(env, ctx, &path, depth - 1, stage);
        } else if ft.is_file() {
            let ext = path.extension().map(|e| e.to_string_lossy().to_lowercase()).unwrap_or_default();
            ctx.total_files += 1;
            if !ctx.all_files && !SCAN_EXTS.contains(&ext.as_str()) {
                ctx.skipped_type += 1;
                continue;
            }
            let s = path.to_string_lossy().to_string();
            ctx.scanned += 1;
            ctx.files += 1;
            if entry.metadata().map(|m| m.len() > MAX_HASH_BYTES).unwrap_or(false) {
                ctx.skipped_large += 1;
            }
            ctx.check_file(&s, "file", None);
            if last.elapsed().as_millis() > 250 {
                emit(env, stage, ctx.scanned, ctx.found.len(), &s);
                last = std::time::Instant::now();
            }
        }
    }
}

fn scan_processes(env: &Env, ctx: &mut Ctx) -> HashMap<u64, String> {
    emit(env, "Процессы", ctx.scanned, ctx.found.len(), "");
    let mut names = HashMap::new();
    let script = "Get-CimInstance Win32_Process | Select-Object ProcessId,Name,ExecutablePath,CommandLine | ConvertTo-Json -Compress";
    let Ok(text) = powershell(script) else { return names };
    for item in json_items(&text) {
        let pid = item["ProcessId"].as_u64().unwrap_or(0);
        let name = item["Name"].as_str().unwrap_or("").to_string();
        names.insert(pid, name.to_lowercase());
        ctx.procs += 1;
        let path = item["ExecutablePath"].as_str().unwrap_or("");
        let cmd = item["CommandLine"].as_str().unwrap_or("");
        ctx.scanned += 1;
        if pid == 0 || pid == std::process::id() as u64 {
            continue;
        }
        let mut hit = false;
        if !path.is_empty() && !is_protected(Path::new(path), &ctx.own) {
            hit = ctx.check_file(path, "process", Some(pid));
        }
        if !hit {
            if let Some(dom) = match_bad_domain(&ctx.sigs, cmd).map(|d| d.to_string()) {
                if !is_protected(Path::new(path), &ctx.own) && !ctx.excluded(path, None) {
                    ctx.push(Detection {
                        id: detection_id("baddom", &format!("{pid}:{dom}")),
                        kind: "process".into(),
                        severity: "medium".into(),
                        title: format!("Процесс обращается к вредоносному домену: {name}"),
                        detail: format!("В командной строке — «{dom}», домен из списков сайтов, раздающих вредоносное."),
                        path: if path.is_empty() { None } else { Some(path.into()) },
                        pid: Some(pid),
                        sha256: None,
                        extra: json!({ "label": name }),
                    });
                }
            }
            if let Some(sig) = match_cmdline(&ctx.sigs, cmd).map(|s| s.to_string()) {
                if !ctx.excluded(path, None) && !is_protected(Path::new(path), &ctx.own) && !cmd.is_empty() {
                    ctx.push(Detection {
                        id: detection_id("cmd", &format!("{pid}:{path}")),
                        kind: "process".into(),
                        severity: "high".into(),
                        title: format!("Процесс похож на майнер: {name}"),
                        detail: format!("В командной строке найдено «{sig}» — так запускают майнеры."),
                        path: if path.is_empty() { None } else { Some(path.into()) },
                        pid: Some(pid),
                        sha256: None,
                        extra: json!({ "label": name }),
                    });
                }
            }
        }
    }
    names
}

fn scan_network(env: &Env, ctx: &mut Ctx, pnames: &HashMap<u64, String>) {
    emit(env, "Сеть", ctx.scanned, ctx.found.len(), "");
    let script = "Get-NetTCPConnection -State Established -ErrorAction SilentlyContinue | Select-Object OwningProcess,RemoteAddress,RemotePort | ConvertTo-Json -Compress";
    let Ok(text) = powershell(script) else { return };
    // Эти программы часто ходят на «пуловые» порты по своим причинам — не считаем их подозрительными.
    let calm = ["chrome", "msedge", "firefox", "brave", "opera", "steam", "discord", "telegram", "adb", "system", "svchost", "code", "java", "javaw"];
    for item in json_items(&text) {
        let pid = item["OwningProcess"].as_u64().unwrap_or(0);
        let port = item["RemotePort"].as_u64().unwrap_or(0) as u16;
        let addr = item["RemoteAddress"].as_str().unwrap_or("");
        if pid != 0 && ctx.sigs.bad_ips.iter().any(|b| b == addr) {
            let name = pnames.get(&pid).cloned().unwrap_or_default();
            ctx.push(Detection {
                id: detection_id("c2", &format!("{pid}:{addr}")),
                kind: "connection".into(),
                severity: "high".into(),
                title: format!("Соединение с известным управляющим сервером: {}", if name.is_empty() { "неизвестный процесс" } else { &name }),
                detail: format!("Адрес {addr}:{port} числится в списках серверов управления вредоносами (C2). Завершите процесс и проверьте его файл."),
                path: None,
                pid: Some(pid),
                sha256: None,
                extra: json!({ "remote": format!("{addr}:{port}") }),
            });
            continue;
        }
        if pid == 0 || !ctx.sigs.pool_ports.contains(&port) || addr.starts_with("127.") || addr == "::1" {
            continue;
        }
        let name = pnames.get(&pid).cloned().unwrap_or_default();
        let stem = name.trim_end_matches(".exe");
        if calm.iter().any(|c| stem == *c) {
            continue;
        }
        ctx.push(Detection {
            id: detection_id("net", &format!("{pid}:{addr}:{port}")),
            kind: "connection".into(),
            severity: "low".into(),
            title: format!("Подозрительное соединение: {}", if name.is_empty() { "неизвестный процесс" } else { &name }),
            detail: format!("Соединение с {addr}:{port} — порт часто используют майнинг-пулы. Проверьте, что это за программа."),
            path: None,
            pid: Some(pid),
            sha256: None,
            extra: json!({ "remote": format!("{addr}:{port}") }),
        });
    }
}

fn scan_autorun(env: &Env, ctx: &mut Ctx) {
    emit(env, "Автозапуск", ctx.scanned, ctx.found.len(), "");
    let script = "$r=@(); foreach($h in 'HKCU','HKLM'){ foreach($k in 'Run','RunOnce'){ $p=\"${h}:\\Software\\Microsoft\\Windows\\CurrentVersion\\$k\"; if(Test-Path $p){ $o=Get-ItemProperty $p; foreach($n in $o.PSObject.Properties){ if($n.Name -notlike 'PS*'){ $r+=[pscustomobject]@{Hive=$h;Key=$k;Name=$n.Name;Data=[string]$n.Value} } } } } }; $r | ConvertTo-Json -Compress";
    let Ok(text) = powershell(script) else { return };
    for item in json_items(&text) {
        let data = item["Data"].as_str().unwrap_or("");
        let name = item["Name"].as_str().unwrap_or("");
        let hive = item["Hive"].as_str().unwrap_or("");
        let Some(exe) = extract_exe(data) else { continue };
        let lower = exe.to_lowercase();
        ctx.scanned += 1;
        let mut flagged = false;
        let before = ctx.found.len();
        ctx.check_file(&exe, "autorun", None);
        if ctx.found.len() > before {
            flagged = true;
        }
        let in_temp = lower.contains("\\temp\\") || lower.contains("\\appdata\\local\\temp");
        if !flagged && in_temp && !ctx.excluded(&exe, None) {
            ctx.push(Detection {
                id: detection_id("autorun", &format!("{hive}:{name}")),
                kind: "autorun".into(),
                severity: "medium".into(),
                title: format!("Автозапуск из временной папки: {name}"),
                detail: "Нормальные программы так не запускаются: из Temp стартуют вирусы и загрузчики.".into(),
                path: Some(exe),
                pid: None,
                sha256: None,
                extra: json!({ "hive": hive, "value": name }),
            });
        } else if flagged {
            // к найденному файлу добавляем, откуда он стартует — чтобы можно было убрать запись
            if let Some(d) = ctx.found.last_mut() {
                d.extra = json!({ "hive": hive, "value": name, "label": d.extra["label"].clone() });
            }
        }
    }
}

fn scan_defender_exclusions(env: &Env, ctx: &mut Ctx) {
    emit(env, "Защитник Windows", ctx.scanned, ctx.found.len(), "");
    let script = "$p=Get-MpPreference -ErrorAction SilentlyContinue; if($p){ [pscustomobject]@{Paths=@($p.ExclusionPath);Procs=@($p.ExclusionProcess)} | ConvertTo-Json -Compress }";
    let Ok(text) = powershell(script) else { return };
    let Ok(v) = serde_json::from_str::<Value>(text.trim()) else { return };
    let risky = ["\\temp", "\\appdata", "\\downloads", "\\users\\public", "\\programdata"];
    let mut paths: Vec<String> = Vec::new();
    for key in ["Paths", "Procs"] {
        match &v[key] {
            Value::Array(a) => paths.extend(a.iter().filter_map(|x| x.as_str()).map(String::from)),
            Value::String(s) => paths.push(s.clone()),
            _ => {}
        }
    }
    for p in paths {
        let lower = p.to_lowercase();
        let root_drive = lower.len() <= 3 && lower.contains(':');
        if root_drive || risky.iter().any(|r| lower.contains(r)) {
            ctx.push(Detection {
                id: detection_id("defex", &lower),
                kind: "defender-exclusion".into(),
                severity: "medium".into(),
                title: "Подозрительное исключение в Защитнике Windows".into(),
                detail: format!("Защитник не проверяет «{p}». Так часто прячут майнеры. Если вы это не настраивали — уберите."),
                path: Some(p.clone()),
                pid: None,
                sha256: None,
                extra: json!({ "exclusion": p }),
            });
        }
    }
}

fn is_elevated() -> bool {
    powershell("([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)")
        .map(|t| t.trim().eq_ignore_ascii_case("true"))
        .unwrap_or(false)
}

fn scan_core(env: &Env, mode: String, custom: Vec<String>, all_files: bool) -> Value {
    CANCEL.store(false, Ordering::Relaxed);
    let started = now_secs();
    let mut ctx = Ctx {
        sigs: load_signatures_in(&env.dir),
        excl: load_exclusions_in(&env.dir),
        own: own_dirs_in(Some(env.dir.clone())),
        found: Vec::new(),
        seen: HashSet::new(),
        hashed: HashMap::new(),
        scanned: 0,
        files: 0,
        procs: 0,
        folders: 0,
        skipped_large: 0,
        denied_dirs: 0,
        denied_list: Vec::new(),
        total_files: 0,
        skipped_type: 0,
        all_files,
        full: load_full_in(&env.dir),
    };
    let pnames = scan_processes(env, &mut ctx);
    scan_network(env, &mut ctx, &pnames);
    scan_autorun(env, &mut ctx);
    scan_defender_exclusions(env, &mut ctx);
    let roots = roots_for(&mode, &custom);
    for (root, depth) in roots.iter().cloned() {
        if CANCEL.load(Ordering::Relaxed) {
            break;
        }
        if root.is_file() {
            ctx.scanned += 1;
            let s = root.to_string_lossy().to_string();
            ctx.check_file(&s, "file", None);
            continue;
        }
        let label = format!("Файлы: {}", root.to_string_lossy());
        walk(env, &mut ctx, &root, depth, &label);
    }
    let cancelled = CANCEL.load(Ordering::Relaxed);
    let report = json!({
        "mode": mode,
        "finished": now_secs(),
        "seconds": now_secs().saturating_sub(started),
        "scanned": ctx.scanned,
        "coverage": {
            "files": ctx.files,
            "total_files": ctx.total_files,
            "skipped_type": ctx.skipped_type,
            "all_files": ctx.all_files,
            "processes": ctx.procs,
            "folders": ctx.folders,
            "skipped_large": ctx.skipped_large,
            "denied_dirs": ctx.denied_dirs,
            "denied_list": ctx.denied_list,
            "elevated": is_elevated(),
            "roots": roots.iter().map(|(p, _)| p.to_string_lossy().to_string()).collect::<Vec<_>>(),
            "types": SCAN_EXTS,
        },
        "cancelled": cancelled,
        "db_version": ctx.sigs.version,
        "detections": ctx.found,
    });
    let summary = json!({ "finished": report["finished"], "mode": report["mode"], "scanned": report["scanned"], "found": ctx.found.len(), "cancelled": cancelled });
    let _ = fs::write(env.dir.join("last_scan.json"), summary.to_string());
    let mode_name = match report["mode"].as_str().unwrap_or("") { "full" => "Полная проверка", "custom" => "Проверка папки", _ => "Быстрая проверка" };
    log_event_in(
        &env.dir,
        "scan",
        &format!("{mode_name}{}", if cancelled { " (остановлена)" } else { "" }),
        &format!("Проверено {}, найдено угроз: {}, {} с{}", ctx.scanned, ctx.found.len(), report["seconds"], if report["coverage"]["elevated"].as_bool() == Some(true) { ", с правами администратора" } else { "" }),
    );
    report
}

/// Точка входа отдельного процесса с правами администратора: `project-desktop.exe --av-scan <mode> --data-dir <dir> [--path <p>]…`.
/// Окна нет: прогресс и итог пишутся в файлы каталога данных, а отмена — файлом cancel.flag.
pub fn headless(args: &[String]) -> i32 {
    let mut mode = "quick".to_string();
    let mut dir: Option<PathBuf> = None;
    let mut custom: Vec<String> = Vec::new();
    let mut all_files = false;
    let mut i = 0;
    while i < args.len() {
        match args[i].as_str() {
            "--av-scan" => {
                if let Some(m) = args.get(i + 1) {
                    mode = m.clone();
                }
                i += 1;
            }
            "--data-dir" => {
                dir = args.get(i + 1).map(|d| PathBuf::from(d.trim_matches('"')));
                i += 1;
            }
            "--all-files" => all_files = true,
            "--path" => {
                if let Some(p) = args.get(i + 1) {
                    custom.push(p.trim_matches('"').to_string());
                }
                i += 1;
            }
            _ => {}
        }
        i += 1;
    }
    let Some(dir) = dir else { return 2 };
    let progress_path = dir.join("scan_progress.json");
    let sink_path = progress_path.clone();
    let env = Env { dir: dir.clone(), sink: Box::new(move |v| { let _ = fs::write(&sink_path, v.to_string()); }) };
    let cancel_dir = dir.clone();
    let done = std::sync::Arc::new(AtomicBool::new(false));
    let done_flag = done.clone();
    std::thread::spawn(move || {
        while !done_flag.load(Ordering::Relaxed) {
            if cancel_dir.join("cancel.flag").exists() {
                CANCEL.store(true, Ordering::Relaxed);
                let _ = fs::remove_file(cancel_dir.join("cancel.flag"));
            }
            std::thread::sleep(std::time::Duration::from_millis(300));
        }
    });
    let report = scan_core(&env, mode, custom, all_files);
    let _ = fs::write(dir.join("scan_report.json"), report.to_string());
    done.store(true, Ordering::Relaxed);
    0
}

fn scan_blocking(app: AppHandle, mode: String, custom: Vec<String>, all_files: bool) -> Value {
    match env_for_app(&app) {
        Ok(env) => scan_core(&env, mode, custom, all_files),
        Err(e) => json!({ "error": e, "detections": [], "scanned": 0 }),
    }
}

/// Проверка в отдельном процессе с правами администратора (запрос UAC): так открываются папки, закрытые обычному пользователю.
fn scan_elevated(app: &AppHandle, mode: &str, custom: &[String], all_files: bool) -> Result<Value, String> {
    let dir = av_dir(app)?;
    for f in ["scan_report.json", "scan_progress.json", "cancel.flag"] {
        let _ = fs::remove_file(dir.join(f));
    }
    let exe = std::env::current_exe().map_err(|e| e.to_string())?;
    let q = |v: &str| v.replace('\'', "''");
    let mut args = vec![
        "'--av-scan'".to_string(),
        format!("'{}'", q(mode)),
        "'--data-dir'".to_string(),
        format!("'\"{}\"'", q(&dir.to_string_lossy())),
    ];
    if all_files {
        args.push("'--all-files'".into());
    }
    for p in custom {
        args.push("'--path'".into());
        args.push(format!("'\"{}\"'", q(p)));
    }
    let script = format!(
        "try {{ Start-Process -FilePath '{}' -ArgumentList {} -Verb RunAs -WindowStyle Hidden -Wait -ErrorAction Stop; 'DONE' }} catch {{ 'FAIL:' + $_.Exception.Message }}",
        q(&exe.to_string_lossy()),
        args.join(",")
    );
    // Пока администраторский процесс работает, пересылаем его прогресс в окно.
    let stop = std::sync::Arc::new(AtomicBool::new(false));
    let stop_flag = stop.clone();
    let progress_file = dir.join("scan_progress.json");
    let handle = app.clone();
    let poller = std::thread::spawn(move || {
        let mut last = String::new();
        while !stop_flag.load(Ordering::Relaxed) {
            if let Ok(text) = fs::read_to_string(&progress_file) {
                if text != last {
                    if let Ok(v) = serde_json::from_str::<Value>(&text) {
                        let _ = handle.emit("av-progress", v);
                    }
                    last = text;
                }
            }
            std::thread::sleep(std::time::Duration::from_millis(400));
        }
    });
    let out = powershell(&script);
    stop.store(true, Ordering::Relaxed);
    let _ = poller.join();
    let out = out?;
    if out.contains("FAIL:") {
        return Err("Запрос прав администратора отклонён или не удался. Проверьте «Да» в окне Windows и повторите.".into());
    }
    fs::read_to_string(dir.join("scan_report.json"))
        .ok()
        .and_then(|t| serde_json::from_str(&t).ok())
        .ok_or_else(|| "Проверка с правами администратора не вернула результат.".to_string())
}

// ------------------------------------------------------------------ команды

#[tauri::command(async)]
pub async fn av_scan(app: AppHandle, mode: String, paths: Option<Vec<String>>, elevated: Option<bool>, all_files: Option<bool>) -> Result<Value, String> {
    let all_files = all_files.unwrap_or(false);
    let custom = paths.unwrap_or_default();
    if elevated.unwrap_or(false) {
        return tauri::async_runtime::spawn_blocking(move || scan_elevated(&app, &mode, &custom, all_files))
            .await
            .map_err(|e| e.to_string())?;
    }
    tauri::async_runtime::spawn_blocking(move || scan_blocking(app, mode, custom, all_files))
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn av_cancel(app: AppHandle) {
    CANCEL.store(true, Ordering::Relaxed);
    // Проверка с правами администратора идёт в другом процессе — просим её остановиться файлом.
    if let Ok(dir) = av_dir(&app) {
        let _ = fs::write(dir.join("cancel.flag"), b"1");
    }
}

#[tauri::command]
pub fn av_status(app: AppHandle) -> Value {
    let sigs = load_signatures(&app);
    let last: Value = av_dir(&app)
        .ok()
        .and_then(|d| fs::read_to_string(d.join("last_scan.json")).ok())
        .and_then(|t| serde_json::from_str(&t).ok())
        .unwrap_or(Value::Null);
    json!({
        "version": sigs.version,
        "updated": sigs.updated,
        "hashes": sigs.sha256.len(),
        "full_hashes": full_version_in(&av_dir(&app).unwrap_or_default()).1,
        "ips": sigs.bad_ips.len(),
        "domains": sigs.bad_domains.len(),
        "rules": sigs.names.len() + sigs.cmdline.len() + sigs.pool_domains.len(),
        "quarantine": load_quarantine(&app).len(),
        "exclusions": { "paths": load_exclusions(&app).paths.len(), "hashes": load_exclusions(&app).hashes.len() },
        "last_scan": last,
    })
}

#[tauri::command(async)]
pub async fn av_update_signatures(app: AppHandle) -> Result<Value, String> {
    let current = load_signatures(&app);
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(60))
        .build()
        .map_err(|e| e.to_string())?;
    let resp = client
        .get(format!("{API_BASE}/av/signatures?have={}", current.version))
        .send()
        .await
        .map_err(|e| format!("Сервер баз недоступен: {e}"))?;
    if !resp.status().is_success() {
        return Err(format!("Сервер баз ответил {}", resp.status()));
    }
    let bytes = resp.bytes().await.map_err(|e| e.to_string())?;
    if bytes.len() > 40 * 1024 * 1024 {
        return Err("Файл баз слишком большой — отклонён".into());
    }
    let value: Value = serde_json::from_slice(&bytes).map_err(|e| format!("Базы повреждены: {e}"))?;
    let full = update_full(&app, &client).await;
    if value["unchanged"].as_bool() == Some(true) {
        return Ok(json!({ "updated": full.0, "version": current.version, "hashes": current.sha256.len(), "full": full.1 }));
    }
    let fresh: Signatures = serde_json::from_value(value).map_err(|e| format!("Базы повреждены: {e}"))?;
    if fresh.version <= current.version || fresh.names.is_empty() {
        return Ok(json!({ "updated": full.0, "version": current.version, "hashes": current.sha256.len(), "full": full.1 }));
    }
    let dir = av_dir(&app)?;
    let tmp = dir.join("signatures.json.tmp");
    fs::write(&tmp, &bytes).map_err(|e| e.to_string())?;
    fs::rename(&tmp, dir.join("signatures.json")).map_err(|e| e.to_string())?;
    Ok(json!({ "updated": true, "version": fresh.version, "hashes": fresh.sha256.len(), "when": fresh.updated, "full": full.1 }))
}

/// Полная база: проверяем версию на сервере и качаем (7–9 МБ), только если там новее. Возвращает (обновлено?, число записей).
async fn update_full(app: &AppHandle, client: &reqwest::Client) -> (bool, usize) {
    let Ok(dir) = av_dir(app) else { return (false, 0) };
    let (local_version, local_count) = full_version_in(&dir);
    let Ok(resp) = client.get(format!("{API_BASE}/av/full-info")).send().await else { return (false, local_count) };
    let Ok(info) = resp.json::<Value>().await else { return (false, local_count) };
    let server_version = info["version"].as_u64().unwrap_or(0);
    if server_version == 0 || server_version <= local_version as u64 {
        return (false, local_count);
    }
    let Ok(resp) = client.get(format!("{API_BASE}/av/full?have={local_version}")).send().await else { return (false, local_count) };
    if !resp.status().is_success() {
        return (false, local_count);
    }
    let Ok(bytes) = resp.bytes().await else { return (false, local_count) };
    if bytes.len() > 200 * 1024 * 1024 {
        return (false, local_count);
    }
    match parse_full(&bytes) {
        Some((_, data)) if data.len() > 100_000 => {
            let tmp = dir.join("bazaar_full.bin.tmp");
            if fs::write(&tmp, &bytes).is_ok() && fs::rename(&tmp, dir.join("bazaar_full.bin")).is_ok() {
                return (true, data.len());
            }
            (false, local_count)
        }
        _ => (false, local_count),
    }
}

fn kill_pid(pid: u64) {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        let _ = Command::new("taskkill").args(["/PID", &pid.to_string(), "/F"]).creation_flags(0x0800_0000).output();
    }
    #[cfg(not(windows))]
    {
        let _ = Command::new("kill").args(["-9", &pid.to_string()]).output();
    }
}

/// Файл в карантин. Если им занят процесс (pid) — сначала завершаем его (пользователь нажал кнопку).
#[tauri::command(async)]
pub async fn av_quarantine(app: AppHandle, path: String, pid: Option<u64>, label: Option<String>) -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(move || quarantine_path(&app, &path, pid, label))
        .await
        .map_err(|e| e.to_string())?
}

pub fn quarantine_path(app: &AppHandle, path: &str, pid: Option<u64>, label: Option<String>) -> Result<Value, String> {
    let path = path.to_string();
    let p = PathBuf::from(&path);
    if is_protected(&p, &own_dirs(app)) {
        return Err("Это системный файл или файл самой программы — в карантин его отправить нельзя.".into());
    }
    if !p.is_file() {
        return Err("Файл не найден — возможно, уже удалён.".into());
    }
    if let Some(pid) = pid {
        kill_pid(pid);
        std::thread::sleep(std::time::Duration::from_millis(600));
    }
    let sha = sha256_file(&p).unwrap_or_default();
    let size = fs::metadata(&p).map(|m| m.len()).unwrap_or(0);
    let id = detection_id("q", &format!("{path}{}", now_secs()));
    let dest = qdir(app)?.join(format!("{id}.qz"));
    xor_copy(&p, &dest).map_err(|e| format!("Не удалось скопировать в карантин: {e}"))?;
    if let Err(e) = fs::remove_file(&p) {
        let _ = fs::remove_file(&dest);
        return Err(format!("Файл занят или защищён, убрать не удалось: {e}. Закройте программу и повторите."));
    }
    let mut items = load_quarantine(app);
    items.push(QItem {
        id: id.clone(),
        original: path.clone(),
        name: p.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default(),
        sha256: sha,
        label: label.unwrap_or_default(),
        size,
        at: now_secs(),
    });
    save_quarantine(app, &items)?;
    log_event(app, "quarantine", &format!("В карантин: {}", p.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default()), &path);
    Ok(json!({ "id": id }))
}

#[tauri::command]
pub fn av_quarantine_list(app: AppHandle) -> Vec<Value> {
    let mut items = load_quarantine(&app);
    items.sort_by(|a, b| b.at.cmp(&a.at));
    items.iter().map(|i| serde_json::to_value(i).unwrap_or(Value::Null)).collect()
}

#[tauri::command(async)]
pub async fn av_quarantine_restore(app: AppHandle, id: String, exclude: Option<bool>) -> Result<(), String> {
    let mut items = load_quarantine(&app);
    let pos = items.iter().position(|i| i.id == id).ok_or("Записи нет в карантине")?;
    let item = items[pos].clone();
    let target = PathBuf::from(&item.original);
    if target.exists() {
        return Err("На прежнем месте уже лежит другой файл — освободите путь и повторите.".into());
    }
    if let Some(parent) = target.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let src = qdir(&app)?.join(format!("{}.qz", item.id));
    xor_copy(&src, &target).map_err(|e| format!("Не удалось восстановить: {e}"))?;
    let _ = fs::remove_file(&src);
    items.remove(pos);
    save_quarantine(&app, &items)?;
    log_event(&app, "restore", &format!("Восстановлено из карантина: {}", item.name), &item.original);
    if exclude.unwrap_or(false) {
        let mut ex = load_exclusions(&app);
        if !ex.paths.contains(&item.original) {
            ex.paths.push(item.original.clone());
        }
        if !item.sha256.is_empty() && !ex.hashes.contains(&item.sha256) {
            ex.hashes.push(item.sha256.clone());
        }
        save_exclusions(&app, &ex)?;
    }
    Ok(())
}

#[tauri::command]
pub fn av_quarantine_delete(app: AppHandle, id: String) -> Result<(), String> {
    let mut items = load_quarantine(&app);
    let name = items.iter().find(|i| i.id == id).map(|i| i.name.clone()).unwrap_or_default();
    items.retain(|i| i.id != id);
    let _ = fs::remove_file(qdir(&app)?.join(format!("{id}.qz")));
    log_event(&app, "delete", &format!("Удалено навсегда: {name}"), "");
    save_quarantine(&app, &items)
}

/// Исключить: путь и/или хеш больше не считаются угрозой при проверках.
#[tauri::command]
pub fn av_exclude(app: AppHandle, path: Option<String>, sha256: Option<String>) -> Result<(), String> {
    let mut ex = load_exclusions(&app);
    if let Some(p) = path.filter(|p| !p.is_empty()) {
        if !ex.paths.contains(&p) {
            log_event(&app, "exclude", "Добавлено в исключения", &p);
            ex.paths.push(p);
        }
    }
    if let Some(h) = sha256.filter(|h| !h.is_empty()) {
        if !ex.hashes.contains(&h) {
            ex.hashes.push(h);
        }
    }
    save_exclusions(&app, &ex)
}

#[tauri::command]
pub fn av_exclusions(app: AppHandle) -> Value {
    let ex = load_exclusions(&app);
    json!({ "paths": ex.paths, "hashes": ex.hashes })
}

#[tauri::command]
pub fn av_exclusion_remove(app: AppHandle, value: String) -> Result<(), String> {
    let mut ex = load_exclusions(&app);
    ex.paths.retain(|p| *p != value);
    ex.hashes.retain(|h| *h != value);
    save_exclusions(&app, &ex)
}

#[tauri::command]
pub fn av_kill(pid: u64) {
    if pid != std::process::id() as u64 && pid > 4 {
        kill_pid(pid);
    }
}

/// Убрать запись автозапуска (HKCU без прав администратора; HKLM — только из-под администратора).
#[tauri::command(async)]
pub async fn av_remove_autorun(hive: String, value: String) -> Result<(), String> {
    if hive != "HKCU" && hive != "HKLM" {
        return Err("Неизвестный раздел реестра".into());
    }
    let name = value.replace('\'', "''");
    let script = format!(
        "foreach($k in 'Run','RunOnce'){{ $p='{hive}:\\Software\\Microsoft\\Windows\\CurrentVersion\\'+$k; if(Get-ItemProperty -Path $p -Name '{name}' -ErrorAction SilentlyContinue){{ Remove-ItemProperty -Path $p -Name '{name}' -ErrorAction Stop; 'ok' }} }}"
    );
    let out = powershell(&script)?;
    if out.contains("ok") {
        Ok(())
    } else {
        Err("Запись не удалена: нужны права администратора или её уже нет.".into())
    }
}

/// Убрать исключение Защитника Windows (нужны права администратора).
#[tauri::command(async)]
pub async fn av_remove_defender_exclusion(path: String) -> Result<(), String> {
    let p = path.replace('\'', "''");
    let out = powershell(&format!(
        "try {{ Remove-MpPreference -ExclusionPath '{p}' -ErrorAction Stop; Remove-MpPreference -ExclusionProcess '{p}' -ErrorAction SilentlyContinue; 'ok' }} catch {{ 'fail' }}"
    ))?;
    if out.contains("ok") {
        Ok(())
    } else {
        Err("Не удалось: запустите программу от имени администратора или уберите исключение в «Безопасность Windows».".into())
    }
}

/// Защитник Windows: состояние, обновление его баз, быстрая проверка. Основной антивирус системы — не заменяем, а запускаем.
#[tauri::command(async)]
pub async fn av_defender(action: String) -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(move || -> Result<Value, String> {
        match action.as_str() {
            "status" => {
                let out = powershell("Get-MpComputerStatus -ErrorAction SilentlyContinue | Select-Object AntivirusEnabled,RealTimeProtectionEnabled,AntivirusSignatureLastUpdated,AntivirusSignatureVersion | ConvertTo-Json -Compress")?;
                Ok(serde_json::from_str(out.trim()).unwrap_or(Value::Null))
            }
            "update" => {
                let out = powershell("try { Update-MpSignature -ErrorAction Stop; 'ok' } catch { $_.Exception.Message }")?;
                Ok(json!({ "ok": out.trim().ends_with("ok"), "message": out.trim() }))
            }
            "fullscan" => {
                let out = powershell("try { Start-MpScan -ScanType FullScan -ErrorAction Stop; $t=@(Get-MpThreatDetection | Sort-Object InitialDetectionTime -Descending | Select-Object -First 5 ThreatID,InitialDetectionTime,Resources); @{ok=$true;threats=$t} | ConvertTo-Json -Compress -Depth 4 } catch { @{ok=$false;message=$_.Exception.Message} | ConvertTo-Json -Compress }")?;
                Ok(serde_json::from_str(out.trim()).unwrap_or(Value::Null))
            }
            "quickscan" => {
                let out = powershell("try { Start-MpScan -ScanType QuickScan -ErrorAction Stop; $t=@(Get-MpThreatDetection | Sort-Object InitialDetectionTime -Descending | Select-Object -First 5 ThreatID,InitialDetectionTime,Resources); @{ok=$true;threats=$t} | ConvertTo-Json -Compress -Depth 4 } catch { @{ok=$false;message=$_.Exception.Message} | ConvertTo-Json -Compress }")?;
                Ok(serde_json::from_str(out.trim()).unwrap_or(Value::Null))
            }
            _ => Err("Неизвестное действие".into()),
        }
    })
    .await
    .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sigs() -> Signatures {
        serde_json::from_str(BASELINE).expect("baseline должен разбираться")
    }

    #[test]
    fn baseline_has_rules() {
        let s = sigs();
        assert!(!s.names.is_empty() && !s.cmdline.is_empty() && !s.pool_domains.is_empty() && !s.pool_ports.is_empty());
    }

    #[test]
    fn name_matching_is_strict() {
        let s = sigs();
        assert!(match_name(&s, "xmrig").is_some());
        assert!(match_name(&s, "xmrig-6.21.0").is_some());
        assert!(match_name(&s, "nbminer_win").is_some());
        assert!(match_name(&s, "chrome").is_none());
        assert!(match_name(&s, "minerva").is_none());
        assert!(match_name(&s, "app").is_none());
    }

    #[test]
    fn full_db_format_and_lookup() {
        let mut bytes = b"AVH1".to_vec();
        bytes.extend_from_slice(&1234u32.to_be_bytes());
        let list: Vec<u64> = vec![5, 99, 0xdead_beef_0000_0001, u64::MAX];
        bytes.extend_from_slice(&(list.len() as u64).to_be_bytes());
        for v in &list {
            bytes.extend_from_slice(&v.to_be_bytes());
        }
        let (version, data) = parse_full(&bytes).expect("формат");
        assert_eq!(version, 1234);
        assert_eq!(data, list);
        assert!(data.binary_search(&0xdead_beef_0000_0001).is_ok());
        assert!(data.binary_search(&7).is_err());
        assert!(parse_full(&bytes[..bytes.len() - 3]).is_none()); // обрезанный файл не принимаем
        assert!(parse_full(b"XXXX").is_none());
        // префикс из hex-строки SHA-256 берётся так же, как на сервере
        assert_eq!(u64::from_str_radix(&"dead beef 0000 0001".replace(' ', ""), 16).unwrap(), 0xdead_beef_0000_0001);
    }

    #[test]
    fn bad_domains_and_ips() {
        let mut s = sigs();
        s.bad_domains = vec!["evil-cdn.example".into(), "x.io".into()];
        s.bad_ips = vec!["203.0.113.9".into()];
        assert_eq!(match_bad_domain(&s, "curl https://evil-cdn.example/a.exe"), Some("evil-cdn.example"));
        assert!(match_bad_domain(&s, "curl https://github.com/a").is_none());
        assert!(match_bad_domain(&s, "x.io").is_none()); // слишком короткие записи не используем: много ложных
        assert!(s.bad_ips.iter().any(|b| b == "203.0.113.9"));
    }

    #[test]
    fn cmdline_matching() {
        let s = sigs();
        assert!(match_cmdline(&s, "xmr.exe -o stratum+tcp://pool.example:3333 -u wallet").is_some());
        assert!(match_cmdline(&s, "miner.exe --url pool.supportxmr.com:443").is_some());
        assert!(match_cmdline(&s, "C:\\Program Files\\Chrome\\chrome.exe --type=renderer").is_none());
    }

    #[test]
    fn autorun_exe_extraction() {
        assert_eq!(extract_exe("\"C:\\Users\\a\\x y\\app.exe\" --silent").as_deref(), Some("C:\\Users\\a\\x y\\app.exe"));
        assert_eq!(extract_exe("C:\\tools\\run.exe /min").as_deref(), Some("C:\\tools\\run.exe"));
        assert_eq!(extract_exe("rundll32 something"), None);
    }

    #[test]
    fn xor_roundtrip_and_hash() {
        let dir = std::env::temp_dir().join(format!("av_test_{}", now_secs()));
        fs::create_dir_all(&dir).unwrap();
        let a = dir.join("a.bin");
        let q = dir.join("a.qz");
        let b = dir.join("b.bin");
        fs::write(&a, b"hello world").unwrap();
        xor_copy(&a, &q).unwrap();
        assert_ne!(fs::read(&q).unwrap(), b"hello world");
        xor_copy(&q, &b).unwrap();
        assert_eq!(fs::read(&b).unwrap(), b"hello world");
        assert_eq!(sha256_file(&a).unwrap(), "b94d27b9934d3e08a52e52d7da7dabfac484efe37a5380ee9088f7ace2efcde9");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn protected_paths() {
        let own = vec![PathBuf::from("C:\\Users\\a\\AppData\\Local\\Project")];
        assert!(is_protected(Path::new("C:\\Windows\\System32\\cmd.exe"), &own));
        assert!(is_protected(Path::new("C:\\Users\\a\\AppData\\Local\\Project\\current\\app.exe"), &own));
        assert!(!is_protected(Path::new("C:\\Users\\a\\Downloads\\x.exe"), &own));
    }

    #[test]
    fn json_items_accepts_object_and_array() {
        assert_eq!(json_items("{\"a\":1}").len(), 1);
        assert_eq!(json_items("[{\"a\":1},{\"a\":2}]").len(), 2);
        assert!(json_items("").is_empty());
    }
}
