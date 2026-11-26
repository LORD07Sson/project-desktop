
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod antivirus;
mod audio_qc;
mod behavior;
mod board;
mod desktop_notify;
mod file_scope;
mod installs;
mod library;
mod local_render;
mod nyaa;
mod net_diag;
mod net_fallback;
mod torrent_clients;
mod media_tools;
mod token_store;
mod upscale;
mod luatools;

use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Mutex, OnceLock};

use tauri::menu::{Menu, MenuItem};
use tauri::tray::TrayIconBuilder;
use tauri::{Emitter, Manager};
use tauri_plugin_global_shortcut::{Code, GlobalShortcutExt, Modifiers, Shortcut, ShortcutState};

const UPDATE_STABLE_URL: &str = "https://github.com/LORD07Sson/project-desktop/releases/latest/download";
const UPDATE_ALPHA_URL: &str = "https://github.com/LORD07Sson/project-desktop/releases/download/alpha-latest";
const SERVER_STABLE_URL: &str = concat!(env!("SERVER_ORIGIN"), "/updates/stable");
const SERVER_ALPHA_URL: &str = concat!(env!("SERVER_ORIGIN"), "/updates/alpha");

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum UpdateSource {
    Github,
    Server,
}

impl UpdateSource {
    fn key(self) -> &'static str {
        match self {
            UpdateSource::Github => "github",
            UpdateSource::Server => "server",
        }
    }
    fn label(self) -> &'static str {
        match self {
            UpdateSource::Github => "GitHub",
            UpdateSource::Server => "сервер",
        }
    }
    fn base(self) -> &'static str {
        let alpha = build_update_channel() == ALPHA_CHANNEL;
        match (self, alpha) {
            (UpdateSource::Github, false) => UPDATE_STABLE_URL,
            (UpdateSource::Github, true) => UPDATE_ALPHA_URL,
            (UpdateSource::Server, false) => SERVER_STABLE_URL,
            (UpdateSource::Server, true) => SERVER_ALPHA_URL,
        }
    }
    fn setup_url(self) -> String {
        let name = if build_update_channel() == ALPHA_CHANNEL { "ProjectDesktop-alpha-Setup.exe" } else { "ProjectDesktop-win-Setup.exe" };
        format!("{}/{name}", self.base())
    }
}

fn update_source_path() -> Option<PathBuf> {
    std::env::var_os("APPDATA").map(|a| PathBuf::from(a).join("com.project.desktop").join("update_source.txt"))
}

fn update_source_pref() -> String {
    let saved = update_source_path().and_then(|p| std::fs::read_to_string(p).ok()).unwrap_or_default();
    match saved.trim() {
        "github" | "server" => saved.trim().to_string(),
        _ => "auto".to_string(),
    }
}

fn last_good_source() -> &'static Mutex<Option<UpdateSource>> {
    static LAST: OnceLock<Mutex<Option<UpdateSource>>> = OnceLock::new();
    LAST.get_or_init(|| Mutex::new(None))
}

fn update_sources() -> Vec<UpdateSource> {
    match update_source_pref().as_str() {
        "github" => vec![UpdateSource::Github],
        "server" => vec![UpdateSource::Server],
        _ => match *last_good_source().lock().unwrap() {
            Some(UpdateSource::Server) => vec![UpdateSource::Server, UpdateSource::Github],
            _ => vec![UpdateSource::Github, UpdateSource::Server],
        },
    }
}

#[tauri::command]
fn get_update_source() -> String {
    update_source_pref()
}

#[tauri::command]
fn set_update_source(source: String) -> Result<(), String> {
    if !matches!(source.as_str(), "auto" | "github" | "server") {
        return Err("Источник: auto, github или server.".into());
    }
    let path = update_source_path().ok_or("Не найдена папка данных программы")?;
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    std::fs::write(&path, &source).map_err(|e| e.to_string())?;
    *update_check_cache().lock().unwrap() = None;
    *last_good_source().lock().unwrap() = None;
    Ok(())
}

const ALPHA_CHANNEL: &str = "alpha";
fn build_update_channel() -> &'static str {
    option_env!("PROJECT_UPDATE_CHANNEL").unwrap_or("stable")
}

#[tauri::command]
fn get_update_channel() -> String {
    build_update_channel().to_string()
}

#[tauri::command]
fn set_update_channel(channel: String) -> Result<(), String> {
    if channel != build_update_channel() {
        return Err("Канал обновлений закреплён за этой сборкой.".to_string());
    }
    Ok(())
}

fn velopack_update_manager(app: &tauri::AppHandle) -> Result<velopack::UpdateManager, String> {
    velopack_update_manager_for(app, UpdateSource::Github)
}

fn velopack_update_manager_for(app: &tauri::AppHandle, from: UpdateSource) -> Result<velopack::UpdateManager, String> {
    let is_alpha = build_update_channel() == ALPHA_CHANNEL;
    let source = velopack::sources::HttpSource::new(from.base());
    let on_prerelease = !app.package_info().version.pre.is_empty();
    let options = velopack::UpdateOptions {
        AllowVersionDowngrade: !is_alpha && on_prerelease,
        ExplicitChannel: if is_alpha { Some(ALPHA_CHANNEL.to_string()) } else { None },
        ..Default::default()
    };
    velopack::UpdateManager::new(source, Some(options), None).map_err(|e| e.to_string())
}

#[derive(serde::Serialize, Clone)]
struct UpdateInfoOut {
    version: String,
    notes: String,
    source: String,
}

fn friendly_update_error(e: impl std::fmt::Display) -> String {
    let text = e.to_string();
    if text.contains("403") {
        "Превышен лимит запросов к GitHub (возможно, IP делите с кем-то ещё, или само \
         приложение проверяло обновления несколько раз за последние минуты). \
         Попробуйте проверить вручную позже."
            .to_string()
    } else {
        text
    }
}

const UPDATE_CHECK_CACHE_TTL: std::time::Duration = std::time::Duration::from_secs(5 * 60);

struct CachedUpdateCheck {
    at: std::time::Instant,
    channel: String,
    result: Result<Option<UpdateInfoOut>, String>,
}

fn is_transient_update_error(text: &str) -> bool {
    let text = text.to_ascii_lowercase();
    [
        "404",
        "502",
        "503",
        "504",
        "timed out",
        "timeout",
        "network error",
        "peer disconnected",
        "connection reset",
        "connection closed",
        "connection aborted",
        "broken pipe",
        "unexpected eof",
        "temporarily unavailable",
    ]
    .iter()
    .any(|marker| text.contains(marker))
}

fn update_retry_reason(text: &str, from: UpdateSource) -> String {
    let text = text.to_ascii_lowercase();
    let who = from.label();
    if text.contains("404") || text.contains("502") || text.contains("503") || text.contains("504") {
        format!("{who} временно не отдаёт релиз")
    } else if text.contains("peer disconnected")
        || text.contains("connection reset")
        || text.contains("connection closed")
        || text.contains("connection aborted")
        || text.contains("broken pipe")
        || text.contains("unexpected eof")
    {
        format!("Соединение с {who} прервалось")
    } else {
        format!("Временная ошибка сети ({who})")
    }
}

fn describe_update_error(text: &str, from: UpdateSource) -> String {
    if is_transient_update_error(text) {
        format!(
            "{} после нескольких попыток. Проверьте интернет или выберите другой источник обновлений (Настройки → Обновления). Исходная ошибка: {text}",
            update_retry_reason(text, from)
        )
    } else {
        text.to_string()
    }
}

fn retries_for(index: usize, total: usize) -> u32 {
    if index + 1 < total { 1 } else { UPDATE_RETRIES }
}

const UPDATE_RETRIES: u32 = 6;

fn update_retry_pause(attempt: u32) {
    std::thread::sleep(std::time::Duration::from_secs(5 * attempt as u64));
}

fn update_check_cache() -> &'static Mutex<Option<CachedUpdateCheck>> {
    static CACHE: OnceLock<Mutex<Option<CachedUpdateCheck>>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(None))
}

fn check_for_update_cached(app: &tauri::AppHandle, force: bool) -> Result<Option<UpdateInfoOut>, String> {
    let channel = build_update_channel().to_string();
    let cache = update_check_cache();
    if !force {
        if let Some(cached) = cache.lock().unwrap().as_ref() {
            let ttl = if matches!(cached.result, Ok(None)) { std::time::Duration::from_secs(60) } else { UPDATE_CHECK_CACHE_TTL };
            if cached.channel == channel && cached.at.elapsed() < ttl {
                return cached.result.clone();
            }
        }
    }

    let sources = update_sources();
    let mut errors = Vec::new();
    let mut result = Err(String::new());
    for (index, from) in sources.iter().copied().enumerate() {
        let retries = retries_for(index, sources.len());
        let um = match velopack_update_manager_for(app, from) {
            Ok(um) => um,
            Err(e) => {
                errors.push(format!("{}: {e}", from.label()));
                continue;
            }
        };
        let mut attempt = 0;
        let one = loop {
            let one = match um.check_for_updates().map_err(friendly_update_error) {
                Ok(velopack::UpdateCheck::UpdateAvailable(info)) => Ok(Some(UpdateInfoOut {
                    version: info.TargetFullRelease.Version.clone(),
                    notes: info.TargetFullRelease.NotesMarkdown.clone(),
                    source: from.key().to_string(),
                })),
                Ok(_) => Ok(None),
                Err(e) => Err(e),
            };
            match &one {
                Err(e) if is_transient_update_error(e) && attempt < retries => {
                    attempt += 1;
                    log::info!("check_for_update ({}): фид недоступен ({e}), повтор {attempt}/{retries}", from.key());
                    update_retry_pause(attempt);
                }
                _ => break one,
            }
        };
        match one {
            Ok(Some(found)) => {
                *last_good_source().lock().unwrap() = Some(from);
                result = Ok(Some(found));
                break;
            }
            Ok(None) => {
                if result.is_err() {
                    result = Ok(None);
                }
            }
            Err(e) => {
                log::info!("check_for_update: {} не ответил ({e}) — пробую следующий источник", from.key());
                errors.push(format!("{}: {e}", from.label()));
            }
        }
    }
    if result.is_err() {
        result = Err(errors.join("; "));
    }
    if result.is_ok() {
        *cache.lock().unwrap() = Some(CachedUpdateCheck { at: std::time::Instant::now(), channel, result: result.clone() });
    }
    result
}

#[tauri::command(async)]
fn check_for_update(app: tauri::AppHandle, force: Option<bool>) -> Result<Option<UpdateInfoOut>, String> {
    log_result("check_for_update", check_for_update_cached(&app, force.unwrap_or(false)))
}

static UPDATE_DOWNLOADING: AtomicBool = AtomicBool::new(false);

struct UpdateDownloadGuard;

impl UpdateDownloadGuard {
    fn acquire() -> Result<Self, String> {
        if UPDATE_DOWNLOADING.swap(true, Ordering::SeqCst) {
            return Err("Обновление уже скачивается — подождите, приложение перезапустится само.".into());
        }
        Ok(Self)
    }
}

impl Drop for UpdateDownloadGuard {
    fn drop(&mut self) {
        UPDATE_DOWNLOADING.store(false, Ordering::SeqCst);
    }
}

const DEFAULT_DEBUG_PORT: u16 = 9222;

fn debug_flag_path() -> Option<PathBuf> {
    std::env::var_os("APPDATA").map(|a| PathBuf::from(a).join("com.project.desktop").join("debug_port.txt"))
}

fn debug_port_flag() -> Option<u16> {
    let text = std::fs::read_to_string(debug_flag_path()?).ok()?;
    let port = text.trim().parse::<u16>().unwrap_or(DEFAULT_DEBUG_PORT);
    (port >= 1024).then_some(port)
}

#[derive(serde::Serialize)]
struct DebugPortStatus {
    enabled: bool,
    active: Option<u16>,
    port: u16,
}

#[tauri::command]
fn debug_port_status() -> DebugPortStatus {
    let active = std::env::var("WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS").ok().and_then(|v| {
        v.split_whitespace().find_map(|a| a.strip_prefix("--remote-debugging-port=").and_then(|p| p.parse::<u16>().ok()))
    });
    let flag = debug_port_flag();
    DebugPortStatus { enabled: flag.is_some(), active, port: flag.unwrap_or(DEFAULT_DEBUG_PORT) }
}

#[tauri::command]
fn debug_port_set(enabled: bool) -> Result<(), String> {
    let path = debug_flag_path().ok_or("Не найдена папка данных программы")?;
    if enabled {
        if let Some(dir) = path.parent() {
            std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
        }
        std::fs::write(&path, DEFAULT_DEBUG_PORT.to_string()).map_err(|e| e.to_string())
    } else {
        match std::fs::remove_file(&path) {
            Ok(()) => Ok(()),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(e) => Err(e.to_string()),
        }
    }
}

#[tauri::command]
fn restart_app(app: tauri::AppHandle) -> Result<(), String> {
    use std::os::windows::process::CommandExt;
    let exe = std::env::current_exe().map_err(|e| e.to_string())?;
    let script = format!("Start-Sleep -Seconds 2; Start-Process -FilePath '{}'", antivirus::ps_quote(&exe.to_string_lossy()));
    std::process::Command::new("powershell")
        .args(["-NoProfile", "-WindowStyle", "Hidden", "-Command", &script])
        .creation_flags(0x0800_0000)
        .spawn()
        .map_err(|e| e.to_string())?;
    app.exit(0);
    Ok(())
}

#[tauri::command]
fn update_failure(app: tauri::AppHandle) -> Option<String> {
    let path = app.path().app_data_dir().ok()?.join("update_pending.txt");
    let target = std::fs::read_to_string(&path).ok()?;
    let _ = std::fs::remove_file(&path);
    let target = target.trim().to_string();
    let current = velopack_update_manager(&app).ok()?.get_current_version_as_string();
    if current == target {
        return None;
    }
    log::error!("update_failure: ставили {target}, но запущена {current}");
    Some(format!("Обновление до {target} не установилось: Windows не дала заменить файлы программы. Закройте программу полностью (трей → Выход) и обновитесь ещё раз. Не помогает — «Настройки → Обновления → Переустановить начисто»."))
}

#[tauri::command(async)]
fn download_and_apply_update(app: tauri::AppHandle) -> Result<(), String> {
    log_result("download_and_apply_update", (|| {
        let _guard = UpdateDownloadGuard::acquire()?;
        let sources = update_sources();
        let mut errors = Vec::new();
        let mut picked = None;
        'sources: for (index, from) in sources.iter().copied().enumerate() {
            let retries = retries_for(index, sources.len());
            let _ = app.emit("update-source", from.label());
            let um = match velopack_update_manager_for(&app, from) {
                Ok(um) => um,
                Err(e) => {
                    errors.push(format!("{}: {e}", from.label()));
                    continue;
                }
            };
            let mut attempt = 0;
            loop {
                let info = match um.check_for_updates().map_err(friendly_update_error) {
                    Ok(velopack::UpdateCheck::UpdateAvailable(info)) => *info,
                    Ok(_) => {
                        errors.push(format!("{}: новой версии там пока нет", from.label()));
                        continue 'sources;
                    }
                    Err(e) if is_transient_update_error(&e) && attempt < retries => {
                        attempt += 1;
                        log::info!("download_and_apply_update ({}): фид недоступен ({e}), повтор {attempt}/{retries}", from.key());
                        let _ = app.emit("update-retry", serde_json::json!({ "attempt": attempt, "of": retries, "reason": update_retry_reason(&e, from) }));
                        update_retry_pause(attempt);
                        continue;
                    }
                    Err(e) => {
                        errors.push(describe_update_error(&e, from));
                        continue 'sources;
                    }
                };
                log::info!("download_and_apply_update: качаем {} ({})", info.TargetFullRelease.Version, from.key());

                let (tx, rx) = std::sync::mpsc::channel::<i16>();
                let progress_app = app.clone();
                std::thread::spawn(move || {
                    for pct in rx {
                        let _ = progress_app.emit("update-progress", pct);
                    }
                });

                if let Err(e) = um.download_updates(&info, Some(tx)) {
                    let text = e.to_string();
                    if is_transient_update_error(&text) && attempt < retries {
                        attempt += 1;
                        log::info!("download_and_apply_update ({}): пакет недоступен ({text}), повтор {attempt}/{retries}", from.key());
                        let _ = app.emit("update-retry", serde_json::json!({ "attempt": attempt, "of": retries, "reason": update_retry_reason(&text, from) }));
                        update_retry_pause(attempt);
                        continue;
                    }
                    errors.push(describe_update_error(&text, from));
                    continue 'sources;
                }
                *last_good_source().lock().unwrap() = Some(from);
                picked = Some((um, info));
                break 'sources;
            }
        }
        let Some((um, info)) = picked else {
            return Err(errors.join("\n"));
        };
        release_program_files(&app);
        um.wait_exit_then_apply_updates(&info.TargetFullRelease, false, true, Vec::<String>::new())
            .map_err(|e| e.to_string())?;
        if let Ok(dir) = app.path().app_data_dir() {
            let _ = std::fs::create_dir_all(&dir);
            let _ = std::fs::write(dir.join("update_pending.txt"), info.TargetFullRelease.Version.to_string());
        }
        log::info!("download_and_apply_update: Update.exe запущен, выходим для установки");
        app.exit(0);
        Ok(())
    })())
}

#[tauri::command]
async fn reinstall_app(app: tauri::AppHandle) -> Result<(), String> {
    use std::os::windows::process::CommandExt;
    let _guard = UpdateDownloadGuard::acquire()?;
    let urls: Vec<(String, String)> = update_sources().into_iter().map(|s| (s.label().to_string(), s.setup_url())).collect();
    let setup = installs::download_setup(&app, &urls).await.map_err(|e| { log::error!("[reinstall_app] {e}"); e })?;
    let script = format!("Start-Sleep -Seconds 3; Start-Process -FilePath '{}'", antivirus::ps_quote(&setup.to_string_lossy()));
    std::process::Command::new("powershell")
        .args(["-NoProfile", "-WindowStyle", "Hidden", "-Command", &script])
        .creation_flags(0x0800_0000)
        .spawn()
        .map_err(|e| e.to_string())?;
    log::info!("reinstall_app: установщик {} запустится после выхода", setup.display());
    release_program_files(&app);
    app.exit(0);
    Ok(())
}

static HANDING_OFF_UPDATE: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

fn release_program_files(app: &tauri::AppHandle) {
    HANDING_OFF_UPDATE.store(true, std::sync::atomic::Ordering::SeqCst);
    for (_, window) in app.webview_windows() {
        let _ = window.destroy();
    }
    let me = sysinfo::Pid::from_u32(std::process::id());
    let started = std::time::Instant::now();
    let mut sys = match sysinfo::System::new() {
        Ok(s) => s,
        Err(e) => {
            log::warn!("release_program_files: sysinfo недоступен ({e:?}), не ждём дочерние процессы");
            return;
        }
    };
    loop {
        sys.refresh_processes(sysinfo::ProcessesToUpdate::All, true);
        let mut family = vec![me];
        let mut i = 0;
        while i < family.len() {
            let parent = family[i];
            family.extend(sys.processes().iter().filter(|(_, p)| p.parent() == Some(parent)).map(|(pid, _)| *pid));
            i += 1;
        }
        let left = family.len() - 1;
        if left == 0 {
            log::info!("release_program_files: дочерние процессы завершились за {:?}", started.elapsed());
            return;
        }
        if started.elapsed() > std::time::Duration::from_secs(10) {
            log::warn!("release_program_files: за 10 с не завершились {left} дочерних процессов — завершаем их");
            for pid in &family[1..] {
                if let Some(p) = sys.process(*pid) {
                    p.kill();
                }
            }
            std::thread::sleep(std::time::Duration::from_millis(500));
            return;
        }
        std::thread::sleep(std::time::Duration::from_millis(200));
    }
}

fn log_result<T>(command: &str, result: Result<T, String>) -> Result<T, String> {
    if let Err(e) = &result {
        log::error!("[{command}] {e}");
    }
    result
}

#[tauri::command(async)]
fn qc_analyze(app: tauri::AppHandle, path: String) -> Result<audio_qc::QcReport, String> {
    log_result("qc_analyze", (|| {
        let path = app.state::<file_scope::FileScope>().check_read(&path)?;
        audio_qc::analyze(&path.to_string_lossy())
    })())
}

#[tauri::command(async)]
fn generate_waveform(app: tauri::AppHandle, path: String, buckets: u32) -> Result<audio_qc::WaveformData, String> {
    log_result("generate_waveform", (|| {
        let path = app.state::<file_scope::FileScope>().check_read(&path)?;
        audio_qc::generate_waveform(&path.to_string_lossy(), buckets)
    })())
}

#[tauri::command(async)]
fn export_audio_clip(
    app: tauri::AppHandle,
    path: String,
    start: f64,
    end: f64,
    save_path: String,
) -> Result<(), String> {
    log_result("export_audio_clip", (|| {
        let scope = app.state::<file_scope::FileScope>();
        let path = scope.check_read(&path)?;
        let save_path = scope.check_write(&save_path)?;
        file_scope::refuse_input_as_output(&path, &save_path)?;
        audio_qc::export_clip(&path.to_string_lossy(), start, end, &save_path.to_string_lossy())
    })())
}

fn progress_to_webview(app: &tauri::AppHandle) -> impl Fn(f64, &str) + Sync + '_ {
    move |fraction, label| {
        let _ = app.emit(
            "mediatool-progress",
            serde_json::json!({ "fraction": fraction, "label": label }),
        );
    }
}

#[tauri::command]
fn board_layout(
    columns: Vec<board::BoardColumnIn>,
    view: board::BoardView,
) -> board::BoardLayout {
    board::layout(columns, &view)
}

#[tauri::command(async)]
fn pick_input_files(
    app: tauri::AppHandle,
    filters: Vec<file_scope::PickFilter>,
    multiple: bool,
) -> Vec<String> {
    file_scope::pick_input_files(&app, filters, multiple)
}

#[tauri::command(async)]
fn pick_output_file(
    app: tauri::AppHandle,
    default_name: Option<String>,
    filters: Vec<file_scope::PickFilter>,
) -> Option<String> {
    file_scope::pick_output_file(&app, default_name, filters)
}

#[tauri::command(async)]
fn write_bytes_file(app: tauri::AppHandle, path: String, bytes: Vec<u8>) -> Result<(), String> {
    if bytes.len() > 2 * 1024 * 1024 {
        return Err("Файл слишком большой.".into());
    }
    let path = app.state::<file_scope::FileScope>().check_write(&path)?;
    std::fs::write(path, bytes).map_err(|e| e.to_string())
}

#[tauri::command(async)]
fn write_text_file(app: tauri::AppHandle, path: String, content: String) -> Result<(), String> {
    if content.len() > 4 * 1024 * 1024 {
        return Err("Файл слишком большой.".into());
    }
    let path = app.state::<file_scope::FileScope>().check_write(&path)?;
    std::fs::write(path, content).map_err(|e| e.to_string())
}

#[tauri::command(async)]
fn pick_output_dir(app: tauri::AppHandle) -> Option<String> {
    file_scope::pick_output_dir(&app)
}

#[tauri::command(async)]
fn mt_tool_status() -> media_tools::ToolStatus {
    media_tools::tool_status()
}

#[tauri::command(async)]
fn mt_probe_media(app: tauri::AppHandle, path: String) -> Result<media_tools::MediaInfo, String> {
    log_result("mt_probe_media", (|| {
        let path = app.state::<file_scope::FileScope>().check_read(&path)?;
        media_tools::probe_media(&path.to_string_lossy())
    })())
}

#[tauri::command]
fn mt_register_media_file(app: tauri::AppHandle, path: String) -> Result<(), String> {
    log_result("mt_register_media_file", (|| {
        let path = app.state::<file_scope::FileScope>().check_read(&path)?;
        media_tools::register_media_file(&app, &path.to_string_lossy())
    })())
}

#[tauri::command(async)]
fn mt_transcode_media(
    app: tauri::AppHandle,
    path: String,
    out_path: String,
    opts: media_tools::TranscodeOpts,
) -> Result<(), String> {
    log_result("mt_transcode_media", (|| {
        let scope = app.state::<file_scope::FileScope>();
        let path = scope.check_read(&path)?;
        let out_path = scope.check_write(&out_path)?;
        file_scope::refuse_input_as_output(&path, &out_path)?;
        let sink = progress_to_webview(&app);
        media_tools::transcode_media(&media_tools::Progress(&sink), &path.to_string_lossy(), &out_path.to_string_lossy(), &opts)
    })())
}

#[tauri::command(async)]
fn mt_extract_audio(
    app: tauri::AppHandle,
    path: String,
    out_path: String,
    opts: media_tools::ExtractAudioOpts,
) -> Result<(), String> {
    log_result("mt_extract_audio", (|| {
        let scope = app.state::<file_scope::FileScope>();
        let path = scope.check_read(&path)?;
        let out_path = scope.check_write(&out_path)?;
        file_scope::refuse_input_as_output(&path, &out_path)?;
        let sink = progress_to_webview(&app);
        media_tools::extract_audio(&media_tools::Progress(&sink), &path.to_string_lossy(), &out_path.to_string_lossy(), &opts)
    })())
}

#[tauri::command(async)]
fn mt_concat_media(app: tauri::AppHandle, paths: Vec<String>, out_path: String) -> Result<String, String> {
    log_result("mt_concat_media", (|| {
        let scope = app.state::<file_scope::FileScope>();
        let checked: Vec<String> = paths
            .iter()
            .map(|p| scope.check_read(p).map(|p| p.to_string_lossy().into_owned()))
            .collect::<Result<_, _>>()?;
        let out_path = scope.check_write(&out_path)?;
        for p in &checked {
            file_scope::refuse_input_as_output(Path::new(p), &out_path)?;
        }
        let sink = progress_to_webview(&app);
        media_tools::concat_media(&media_tools::Progress(&sink), &checked, &out_path.to_string_lossy())
    })())
}

#[tauri::command(async)]
fn mt_mux_media(app: tauri::AppHandle, tracks: Vec<media_tools::MuxTrack>, out_path: String) -> Result<(), String> {
    log_result("mt_mux_media", (|| {
        let scope = app.state::<file_scope::FileScope>();
        let mut checked = Vec::with_capacity(tracks.len());
        let out_path = scope.check_write(&out_path)?;
        for t in tracks {
            let p = scope.check_read(&t.path)?;
            file_scope::refuse_input_as_output(&p, &out_path)?;
            checked.push(media_tools::MuxTrack { path: p.to_string_lossy().into_owned(), ..t });
        }
        media_tools::mux_media(&checked, &out_path.to_string_lossy())
    })())
}

#[tauri::command(async)]
fn mt_dub_audio(
    app: tauri::AppHandle,
    video: String,
    dub: String,
    out_path: String,
    opts: media_tools::DubOpts,
) -> Result<(), String> {
    log_result("mt_dub_audio", (|| {
        let scope = app.state::<file_scope::FileScope>();
        let video = scope.check_read(&video)?;
        let dub = scope.check_read(&dub)?;
        let out_path = scope.check_write(&out_path)?;
        file_scope::refuse_input_as_output(&video, &out_path)?;
        file_scope::refuse_input_as_output(&dub, &out_path)?;
        let sink = progress_to_webview(&app);
        media_tools::dub_audio(
            &media_tools::Progress(&sink),
            &video.to_string_lossy(),
            &dub.to_string_lossy(),
            &out_path.to_string_lossy(),
            &opts,
        )
    })())
}

#[tauri::command(async)]
fn mt_change_speed(
    app: tauri::AppHandle,
    path: String,
    out_path: String,
    speed: f64,
    keep_pitch: bool,
) -> Result<(), String> {
    log_result("mt_change_speed", (|| {
        let scope = app.state::<file_scope::FileScope>();
        let path = scope.check_read(&path)?;
        let out_path = scope.check_write(&out_path)?;
        file_scope::refuse_input_as_output(&path, &out_path)?;
        let sink = progress_to_webview(&app);
        media_tools::change_speed(
            &media_tools::Progress(&sink),
            &path.to_string_lossy(),
            &out_path.to_string_lossy(),
            speed,
            keep_pitch,
        )
    })())
}

#[tauri::command(async)]
fn mt_extract_frames(
    app: tauri::AppHandle,
    path: String,
    out_path: String,
    opts: media_tools::FrameOpts,
) -> Result<(), String> {
    log_result("mt_extract_frames", (|| {
        let scope = app.state::<file_scope::FileScope>();
        let path = scope.check_read(&path)?;
        let out_path = scope.check_write(&out_path)?;
        file_scope::refuse_input_as_output(&path, &out_path)?;
        let sink = progress_to_webview(&app);
        media_tools::extract_frames(
            &media_tools::Progress(&sink),
            &path.to_string_lossy(),
            &out_path.to_string_lossy(),
            &opts,
        )
    })())
}

#[tauri::command(async)]
fn mt_make_gif(
    app: tauri::AppHandle,
    path: String,
    out_path: String,
    start: f64,
    duration: f64,
    fps: u32,
    width: u32,
) -> Result<(), String> {
    log_result("mt_make_gif", (|| {
        let scope = app.state::<file_scope::FileScope>();
        let path = scope.check_read(&path)?;
        let out_path = scope.check_write(&out_path)?;
        file_scope::refuse_input_as_output(&path, &out_path)?;
        let sink = progress_to_webview(&app);
        media_tools::make_gif(
            &media_tools::Progress(&sink),
            &path.to_string_lossy(),
            &out_path.to_string_lossy(),
            start,
            duration,
            fps,
            width,
        )
    })())
}

#[tauri::command(async)]
fn mt_burn_subtitles(
    app: tauri::AppHandle,
    video: String,
    subs: String,
    out_path: String,
    font_size: u32,
) -> Result<(), String> {
    log_result("mt_burn_subtitles", (|| {
        let scope = app.state::<file_scope::FileScope>();
        let video = scope.check_read(&video)?;
        let subs = scope.check_read(&subs)?;
        let out_path = scope.check_write(&out_path)?;
        file_scope::refuse_input_as_output(&video, &out_path)?;
        let sink = progress_to_webview(&app);
        media_tools::burn_subtitles(
            &media_tools::Progress(&sink),
            &video.to_string_lossy(),
            &subs.to_string_lossy(),
            &out_path.to_string_lossy(),
            font_size,
        )
    })())
}

#[tauri::command(async)]
fn mt_extract_subtitles(
    app: tauri::AppHandle,
    path: String,
    out_path: String,
    track: u32,
) -> Result<(), String> {
    log_result("mt_extract_subtitles", (|| {
        let scope = app.state::<file_scope::FileScope>();
        let path = scope.check_read(&path)?;
        let out_path = scope.check_write(&out_path)?;
        file_scope::refuse_input_as_output(&path, &out_path)?;
        let sink = progress_to_webview(&app);
        media_tools::extract_subtitles(
            &media_tools::Progress(&sink),
            &path.to_string_lossy(),
            &out_path.to_string_lossy(),
            track,
        )
    })())
}

#[tauri::command]
async fn upscale_image(
    app: tauri::AppHandle,
    bytes: Vec<u8>,
    model: String,
    scale: Option<u32>,
    width: Option<u32>,
) -> Result<tauri::ipc::Response, String> {
    let size = upscale::Size::from(scale, width)?;
    upscale::upscale(&app, http(), bytes, &model, size).await.map(tauri::ipc::Response::new)
}

#[tauri::command(async)]
fn upscale_read(app: tauri::AppHandle, path: String) -> Result<tauri::ipc::Response, String> {
    upscale::read_input(&app, &path).map(tauri::ipc::Response::new)
}

#[tauri::command(async)]
fn upscale_models() -> Vec<String> {
    upscale::list_custom()
}

#[tauri::command(async)]
fn upscale_model_add(app: tauri::AppHandle, paths: Vec<String>) -> Result<Vec<String>, String> {
    upscale::add_custom(&app, &paths)
}

#[tauri::command(async)]
fn upscale_model_remove(name: String) -> Result<Vec<String>, String> {
    upscale::remove_custom(&name)
}

#[tauri::command(async)]
fn upscale_storage() -> upscale::Storage {
    upscale::storage()
}

#[tauri::command(async)]
fn upscale_clear() -> Result<upscale::Storage, String> {
    upscale::clear()
}

#[tauri::command(async)]
fn upscale_save(app: tauri::AppHandle, path: String) -> Result<(), String> {
    upscale::save(&app, &path)
}

#[tauri::command]
async fn local_render_prepare(app: tauri::AppHandle) -> local_render::ToolsStatus {
    local_render::prepare(&app, http()).await
}

#[tauri::command(async)]
fn local_render_encoders() -> local_render::EncoderStatus {
    local_render::encoder_status()
}

#[tauri::command(async)]
fn net_diagnose() -> net_diag::NetDiag {
    let host = API_BASE.trim_start_matches("https://").split(['/', ':']).next().unwrap_or("");
    net_diag::diagnose(host)
}

#[tauri::command]
async fn api_fallback(
    method: String,
    path: String,
    headers: std::collections::HashMap<String, String>,
    body: Option<String>,
    write: bool,
) -> Result<net_fallback::FallbackResponse, String> {
    let result = net_fallback::request(API_BASE, &method, &path, headers, body, write).await;
    if let Err(e) = &result {
        log::info!("api_fallback {method} {path}: {e}");
    } else {
        log::info!("api_fallback {method} {path}: ok via doh {:?}", net_fallback::cached_ip());
    }
    result
}

#[derive(serde::Serialize)]
struct FastResponse {
    status: u16,
    body: String,
}

#[tauri::command]
async fn api_get_fast(path: String, headers: std::collections::HashMap<String, String>) -> Result<FastResponse, String> {
    if !path.starts_with("/parser/access/") || path.contains("..") || path.contains('#') || path.contains('\\') {
        return Err("path not allowed".into());
    }
    let mut req = http().get(format!("{API_BASE}{path}")).timeout(std::time::Duration::from_secs(60));
    for (name, value) in headers {
        if matches!(name.as_str(), "X-Init-Data" | "X-App-Version" | "X-Preview-Role") {
            req = req.header(name, value);
        }
    }
    let resp = req.send().await.map_err(|e| e.to_string())?;
    let status = resp.status().as_u16();
    let body = resp.text().await.map_err(|e| e.to_string())?;
    Ok(FastResponse { status, body })
}

#[tauri::command(async)]
fn local_render_probe(app: tauri::AppHandle, path: String) -> Result<local_render::LocalVideoInfo, String> {
    let result = (|| {
        let p = app.state::<file_scope::FileScope>().check_read(&path)?;
        local_render::probe_local_video(&p)
    })();
    log_result("local_render_probe", result)
}

#[tauri::command]
async fn local_render_run(
    app: tauri::AppHandle,
    plan: local_render::Plan,
    init_data: String,
    local_video: Option<String>,
) -> Result<local_render::RenderResult, String> {
    let local_video = match local_video {
        Some(p) => Some(app.state::<file_scope::FileScope>().check_read(&p)?),
        None => None,
    };
    let result = local_render::run(&app, http(), API_BASE, plan, &init_data, local_video).await;
    if let Ok(done) = &result {
        app.state::<file_scope::FileScope>().allow_read(Path::new(&done.path));
    }
    log_result("local_render_run", result)
}

#[tauri::command]
async fn local_render_upload(app: tauri::AppHandle, public_id: String, path: String, init_data: String) -> Result<(), String> {
    let result = async {
        let allowed = app.state::<file_scope::FileScope>().check_read(&path)?;
        local_render::upload_final(http(), API_BASE, &public_id, &allowed.to_string_lossy(), &init_data).await
    }
    .await;
    log_result("local_render_upload", result)
}

#[tauri::command(async)]
fn local_render_cancel() -> Result<(), String> {
    local_render::request_cancel();
    let _ = media_tools::cancel_current_job();
    Ok(())
}

#[tauri::command(async)]
fn local_render_save_copy(app: tauri::AppHandle, path: String, dir: String, name: String) -> Result<String, String> {
    let result = (|| {
        let scope = app.state::<file_scope::FileScope>();
        let src = scope.check_read(&path)?;
        let dir = scope.check_write(&dir)?;
        let base = Path::new(&name).file_name().and_then(|n| n.to_str()).filter(|n| !n.is_empty()).unwrap_or("render.mp4");
        let (stem, ext) = match base.rsplit_once('.') {
            Some((s, e)) if !s.is_empty() => (s.to_string(), format!(".{e}")),
            _ => (base.to_string(), String::new()),
        };
        let mut target = dir.join(base);
        let mut n = 2;
        while target.exists() {
            target = dir.join(format!("{stem} ({n}){ext}"));
            n += 1;
        }
        std::fs::copy(&src, &target).map_err(|e| format!("Не удалось сохранить копию: {e}"))?;
        Ok(target.to_string_lossy().into_owned())
    })();
    log_result("local_render_save_copy", result)
}

#[tauri::command(async)]
fn local_render_cleanup(public_id: String) -> Result<(), String> {
    log_result("local_render_cleanup", local_render::cleanup(&public_id))
}

#[tauri::command(async)]
fn mt_cancel() -> Result<(), String> {
    media_tools::cancel_current_job()
}

#[tauri::command(async)]
fn open_log_folder(app: tauri::AppHandle) -> Result<(), String> {
    use tauri_plugin_opener::OpenerExt;
    let dir = app.path().app_log_dir().map_err(|e| e.to_string())?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    app.opener().reveal_item_in_dir(&dir).map_err(|e| e.to_string())
}

#[tauri::command(async)]
fn reveal_in_folder(app: tauri::AppHandle, path: String) -> Result<(), String> {
    use tauri_plugin_opener::OpenerExt;
    let p = std::path::PathBuf::from(&path);
    if !p.exists() {
        return Err("Файла уже нет на диске.".into());
    }
    app.opener().reveal_item_in_dir(&p).map_err(|e| e.to_string())
}

#[tauri::command(async)]
fn token_save(token: String) -> Result<(), String> {
    log_result("token_save", token_store::save(&token))
}

#[tauri::command(async)]
fn token_load() -> Option<String> {
    token_store::load()
}

#[tauri::command(async)]
fn token_clear() -> Result<(), String> {
    log_result("token_clear", token_store::clear())
}

#[tauri::command]
fn set_window_progress(app: tauri::AppHandle, progress: Option<u64>) -> Result<(), String> {
    let win = app
        .get_webview_window("main")
        .ok_or("окно main не найдено")?;
    let status = if progress.is_some() {
        tauri::window::ProgressBarStatus::Normal
    } else {
        tauri::window::ProgressBarStatus::None
    };
    win.set_progress_bar(tauri::window::ProgressBarState {
        status: Some(status),
        progress,
    })
    .map_err(|e| e.to_string())
}

#[tauri::command]
async fn set_autostart(app: tauri::AppHandle, enabled: bool) -> Result<(), String> {
    use tauri_plugin_autostart::ManagerExt;
    let mgr = app.autolaunch();
    let result = if enabled { mgr.enable() } else { mgr.disable() }.map_err(|e| e.to_string());
    log_result("set_autostart", result)
}

#[tauri::command]
async fn is_autostart(app: tauri::AppHandle) -> Result<bool, String> {
    use tauri_plugin_autostart::ManagerExt;
    app.autolaunch().is_enabled().map_err(|e| e.to_string())
}

const API_BASE: &str = concat!(env!("SERVER_ORIGIN"), "/api");

fn http() -> &'static reqwest::Client {
    static HTTP: OnceLock<reqwest::Client> = OnceLock::new();
    HTTP.get_or_init(reqwest::Client::new)
}

#[derive(Default)]
struct DroppedFiles(Mutex<HashSet<PathBuf>>);

impl DroppedFiles {
    fn remember(&self, paths: &[PathBuf]) {
        if let Ok(mut set) = self.0.lock() {
            set.clear();
            for p in paths {
                set.insert(p.canonicalize().unwrap_or_else(|_| p.clone()));
            }
        }
    }

    fn contains(&self, path: &Path) -> bool {
        let canonical = path.canonicalize().unwrap_or_else(|_| path.to_path_buf());
        self.0
            .lock()
            .map(|set| set.contains(&canonical))
            .unwrap_or(false)
    }
}

const ALLOWED_UPLOAD_EXT: &[&str] = &[
    "wav", "wave", "w64", "mp3", "mp2", "flac", "m4a", "m4b", "aac", "ogg", "oga", "opus", "wma", "aiff",
    "aif", "aifc", "ac3", "eac3", "dts", "mka", "ape", "wv", "amr", "caf", "au", "tta", "weba",
    "mp4", "mkv", "mov", "avi", "webm", "m4v", "ts", "m2ts", "mts", "mpg", "mpeg", "wmv", "flv", "3gp", "ogv",
    "png", "jpg", "jpeg", "webp", "pdf", "doc", "docx", "ppt", "pptx", "zip",
];

const MAX_UPLOAD_BYTES: u64 = 2000 * 1024 * 1024;
const MAX_PARSER_BYTES: u64 = 25 * 1024 * 1024 * 1024;

fn checked_upload_path(
    dropped: &DroppedFiles,
    scope: &file_scope::FileScope,
    file_path: &str,
) -> Result<PathBuf, String> {
    let path = PathBuf::from(file_path);
    if !dropped.contains(&path) && scope.check_read(file_path).is_err() {
        return Err("Этот файл не выбирали в приложении — загрузка отклонена.".into());
    }
    let ext = path
        .extension()
        .map(|e| e.to_string_lossy().to_lowercase())
        .unwrap_or_default();
    if !ALLOWED_UPLOAD_EXT.contains(&ext.as_str()) {
        return Err(format!("Формат файла не поддерживается: .{ext}"));
    }
    let size = std::fs::metadata(&path)
        .map_err(|e| format!("Не удалось прочитать файл: {e}"))?
        .len();
    if size > MAX_UPLOAD_BYTES {
        return Err(format!(
            "Файл слишком большой ({} МБ) — лимит {} МБ.",
            size / 1024 / 1024,
            MAX_UPLOAD_BYTES / 1024 / 1024
        ));
    }
    Ok(path)
}

#[tauri::command]
async fn upload_report_file(
    app: tauri::AppHandle,
    report_id: String,
    file_path: String,
    init_data: String,
) -> Result<serde_json::Value, String> {
    let result = async {
        let path = checked_upload_path(
            &app.state::<DroppedFiles>(),
            &app.state::<file_scope::FileScope>(),
            &file_path,
        )?;
        let file_name = path
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_else(|| "file".to_string());

        let bytes = std::fs::read(&path).map_err(|e| format!("Не удалось прочитать файл: {e}"))?;

        let part = reqwest::multipart::Part::bytes(bytes).file_name(file_name);
        let form = reqwest::multipart::Form::new().part("file", part);

        let resp = http()
            .post(format!("{API_BASE}/report/{report_id}/files/upload"))
            .header("X-Init-Data", init_data)
            .multipart(form)
            .send()
            .await
            .map_err(|e| format!("Не удалось отправить файл: {e}"))?;

        if !resp.status().is_success() {
            return Err(error_detail(resp, "сервер отклонил файл").await);
        }

        resp.json::<serde_json::Value>()
            .await
            .map_err(|e| format!("Некорректный ответ сервера: {e}"))
    }
    .await;
    log_result("upload_report_file", result)
}

#[tauri::command]
async fn download_report_file(
    app: tauri::AppHandle,
    report_id: String,
    file_id: String,
    init_data: String,
    save_path: String,
    job: Option<String>,
) -> Result<(), String> {
    let result = async {
        let save_path = app.state::<file_scope::FileScope>().check_write(&save_path)?;
        let mut attempt = 0u32;
        let resp = loop {
            let sent = http()
                .get(format!("{API_BASE}/report/{report_id}/files/{file_id}/download"))
                .header("X-Init-Data", init_data.clone())
                .send()
                .await;
            match sent {
                Ok(r) if r.status().is_success() => break r,
                Ok(r) if matches!(r.status().as_u16(), 502 | 503 | 504) && attempt < 3 => {}
                Ok(r) => return Err(error_detail(r, "сервер отказал в скачивании").await),
                Err(_) if attempt < 3 => {}
                Err(e) => return Err(format!("Не удалось скачать файл: {e}")),
            }
            attempt += 1;
            tokio::time::sleep(std::time::Duration::from_secs(5 * attempt as u64)).await;
        };

        save_response_to_file(resp, &save_path, job.map(|j| (app.clone(), j)), MAX_UPLOAD_BYTES).await
    }
    .await;
    log_result("download_report_file", result)
}

fn allowed_attachment_path(api_path: &str) -> bool {
    let ok_chars = api_path
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || matches!(c, '/' | '-' | '_' | ':'));
    let parts: Vec<&str> = api_path.split('/').collect();
    let numeric = |s: &str| !s.is_empty() && s.chars().all(|c| c.is_ascii_digit());
    let shape = match parts.as_slice() {
        ["chats", _key, "messages", id, "file"] => numeric(id),
        ["kodik", "dump", key] => !key.is_empty() && key.len() <= 60,
        ["parser", "download", id, "file"] => id.len() == 32 && id.chars().all(|c| c.is_ascii_hexdigit()),
        ["report", _pid, "notes", id, "file"] => numeric(id),
        ["tickets", t, "posts", id, "file"] => numeric(t) && numeric(id),
        ["report", _pid, "raws", kind, "file"] => matches!(*kind, "voice" | "mix" | "subs"),
        ["report", _pid, "raws", "files", id, "file"] => numeric(id),
        ["report", _pid, "raws", "legacy", kind, character_id, "file"] => {
            matches!(*kind, "voice" | "mix" | "subs") && numeric(character_id)
        }
        _ => false,
    };
    ok_chars && !api_path.contains("..") && shape
}

#[tauri::command]
async fn download_api_file(
    app: tauri::AppHandle,
    api_path: String,
    init_data: String,
    save_path: String,
    job: Option<String>,
) -> Result<(), String> {
    let result = async {
        if !allowed_attachment_path(&api_path) {
            return Err("Этот адрес скачивать нельзя.".to_string());
        }
        let save_path = app.state::<file_scope::FileScope>().check_write(&save_path)?;
        let mut attempt = 0u32;
        let resp = loop {
            let sent = http()
                .get(format!("{API_BASE}/{api_path}"))
                .header("X-Init-Data", init_data.clone())
                .send()
                .await;
            match sent {
                Ok(r) if r.status().is_success() => break r,
                Ok(r) if matches!(r.status().as_u16(), 502 | 503 | 504) && attempt < 3 => {}
                Ok(r) => return Err(error_detail(r, "сервер отказал в скачивании").await),
                Err(_) if attempt < 3 => {}
                Err(e) => return Err(format!("Не удалось скачать файл: {e}")),
            }
            attempt += 1;
            tokio::time::sleep(std::time::Duration::from_secs(5 * attempt as u64)).await;
        };
        let max = if api_path.trim_start_matches('/').starts_with("parser/") { MAX_PARSER_BYTES } else { MAX_UPLOAD_BYTES };
        save_response_to_file(resp, &save_path, job.map(|j| (app.clone(), j)), max).await
    }
    .await;
    log_result("download_api_file", result)
}

async fn save_response_to_file(
    mut resp: reqwest::Response,
    save_path: &std::path::Path,
    progress: Option<(tauri::AppHandle, String)>,
    max: u64,
) -> Result<(), String> {
    use std::io::Write;
    let declared = resp.content_length().unwrap_or(0);
    let mut last_emit = std::time::Instant::now() - std::time::Duration::from_secs(1);
    let emit = |done: u64, force: bool, last: &mut std::time::Instant| {
        if let Some((app, job)) = &progress {
            if force || last.elapsed() >= std::time::Duration::from_millis(150) {
                *last = std::time::Instant::now();
                let _ = app.emit("download-progress", serde_json::json!({ "job": job, "done": done, "total": declared }));
            }
        }
    };
    if let Some(len) = resp.content_length() {
        if len > max {
            return Err(format!("Файл слишком большой ({} МБ).", len / 1024 / 1024));
        }
    }
    let mut out = std::fs::File::create(save_path).map_err(|e| format!("Не удалось сохранить файл: {e}"))?;
    let mut total: u64 = 0;
    let result: Result<(), String> = async {
        while let Some(chunk) = resp
            .chunk()
            .await
            .map_err(|e| format!("Обрыв при скачивании: {e}"))?
        {
            total += chunk.len() as u64;
            if total > max {
                return Err("Файл слишком большой.".into());
            }
            out.write_all(&chunk).map_err(|e| format!("Не удалось сохранить файл: {e}"))?;
            emit(total, false, &mut last_emit);
        }
        emit(total, true, &mut last_emit);
        out.flush().map_err(|e| format!("Не удалось сохранить файл: {e}"))
    }
    .await;
    if result.is_err() {
        drop(out);
        let _ = std::fs::remove_file(save_path);
    }
    result
}

async fn error_detail(resp: reqwest::Response, fallback: &str) -> String {
    resp.json::<serde_json::Value>()
        .await
        .ok()
        .and_then(|v| v.get("detail").and_then(|d| d.as_str()).map(str::to_string))
        .unwrap_or_else(|| fallback.to_string())
}

#[cfg(windows)]
fn apply_windows_11_chrome(win: &tauri::WebviewWindow) {
    use windows::Win32::Graphics::Dwm::{
        DwmSetWindowAttribute, DWMWA_BORDER_COLOR, DWMWA_WINDOW_CORNER_PREFERENCE, DWMWCP_ROUND,
    };
    let Ok(hwnd) = win.hwnd() else {
        log::warn!("apply_windows_11_chrome: у окна нет HWND");
        return;
    };
    unsafe {
        let corner = DWMWCP_ROUND;
        let _ = DwmSetWindowAttribute(
            hwnd,
            DWMWA_WINDOW_CORNER_PREFERENCE,
            std::ptr::addr_of!(corner).cast(),
            std::mem::size_of_val(&corner) as u32,
        );
        let border: u32 = 0x002e_2638;
        let _ = DwmSetWindowAttribute(
            hwnd,
            DWMWA_BORDER_COLOR,
            std::ptr::addr_of!(border).cast(),
            std::mem::size_of_val(&border) as u32,
        );
    }
}

fn disable_browser_accelerator_keys(win: &tauri::WebviewWindow) {
    use webview2_com::Microsoft::Web::WebView2::Win32::ICoreWebView2Settings3;
    use windows::core::Interface;
    let result = win.with_webview(|webview| {
        let apply = || -> windows::core::Result<()> {
            let controller = webview.controller();
            let core = unsafe { controller.CoreWebView2() }?;
            let settings = unsafe { core.Settings() }?;
            let settings3: ICoreWebView2Settings3 = settings.cast()?;
            unsafe { settings3.SetAreBrowserAcceleratorKeysEnabled(false) }
        };
        if let Err(e) = apply() {
            log::warn!("не удалось отключить браузерные accelerator keys WebView2 (Ctrl+K и другие горячие клавиши могут не доходить до страницы): {e}");
        }
    });
    if let Err(e) = result {
        log::warn!("disable_browser_accelerator_keys: with_webview не выполнился: {e}");
    }
}

fn drop_installed_package() {
    use velopack::locator::{auto_locate_app_manifest, find_local_full_packages, LocationContext};
    let Ok(locator) = auto_locate_app_manifest(LocationContext::FromCurrentExe) else { return };
    let current = locator.get_manifest_version();
    installs::drop_partial_packages(&locator.get_packages_dir());
    for (path, manifest) in find_local_full_packages(&locator.get_packages_dir()) {
        if manifest.version > current {
            continue;
        }
        match std::fs::remove_file(&path) {
            Ok(()) => log::info!("Удалён пакет установленной версии: {}", path.display()),
            Err(e) => log::warn!("Не удалось удалить {}: {e}", path.display()),
        }
    }
}

fn toggle_main_window(app: &tauri::AppHandle) {
    if let Some(win) = app.get_webview_window("main") {
        let visible = win.is_visible().unwrap_or(false);
        if visible {
            let _ = win.hide();
        } else {
            let _ = win.show();
            let _ = win.unminimize();
            let _ = win.set_focus();
        }
    }
}

fn main() {
    velopack::VelopackApp::build().run();

    let _ = std::env::set_current_dir(std::env::temp_dir());

    let mut webview_args = String::from("--force_high_performance_gpu");
    if let Some(port) = debug_port_flag() {
        webview_args.push_str(&format!(" --remote-debugging-port={port} --remote-allow-origins=http://127.0.0.1:{port}"));
    }
    std::env::set_var("WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS", &webview_args);

    let cli_args: Vec<String> = std::env::args().collect();
    if cli_args.iter().any(|a| a == "--av-scan") {
        std::process::exit(antivirus::headless(&cli_args));
    }

    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            if let Some(win) = app.get_webview_window("main") {
                let _ = win.show();
                let _ = win.unminimize();
                let _ = win.set_focus();
            }
        }))
        .plugin(
            tauri_plugin_log::Builder::new()
                .target(tauri_plugin_log::Target::new(
                    tauri_plugin_log::TargetKind::LogDir { file_name: Some("project-dub".into()) },
                ))
                .target(tauri_plugin_log::Target::new(tauri_plugin_log::TargetKind::Stdout))
                .target(tauri_plugin_log::Target::new(tauri_plugin_log::TargetKind::Webview))
                .max_file_size(5_000_000)
                .rotation_strategy(tauri_plugin_log::RotationStrategy::KeepSome(3))
                .level(log::LevelFilter::Error)
                .level_for("project_desktop", log::LevelFilter::Error)
                .level_for("project_desktop::media_tools", log::LevelFilter::Info)
                .level_for("project_desktop::local_render", log::LevelFilter::Info)
                .build(),
        )
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_store::Builder::default().build())
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            None,
        ))
        .plugin(tauri_plugin_global_shortcut::Builder::new().with_handler(|app, shortcut, event| {
            if event.state() == ShortcutState::Pressed {
                let toggle = Shortcut::new(Some(Modifiers::CONTROL | Modifiers::SHIFT), Code::KeyP);
                if shortcut == &toggle {
                    toggle_main_window(app);
                }
            }
        }).build())
        .manage(DroppedFiles::default())
        .manage(file_scope::FileScope::default())
        .invoke_handler(tauri::generate_handler![
            desktop_notify::notify_desktop,
            api_fallback,
            api_get_fast,
            local_render_prepare,
            upscale_image,
            upscale_read,
            upscale_models,
            upscale_model_add,
            upscale_model_remove,
            upscale_storage,
            upscale_clear,
            upscale_save,
            local_render_encoders,
            local_render_run,
            local_render_upload,
            local_render_cancel,
            local_render_cleanup,
            local_render_save_copy,
            antivirus::av_scan,
            antivirus::av_cancel,
            antivirus::av_status,
            antivirus::av_update_signatures,
            antivirus::av_quarantine,
            antivirus::av_quarantine_list,
            antivirus::av_quarantine_restore,
            antivirus::av_quarantine_delete,
            antivirus::av_exclude,
            antivirus::av_exclusions,
            antivirus::av_exclusion_remove,
            antivirus::av_kill,
            antivirus::av_remove_autorun,
            antivirus::av_remove_defender_exclusion,
            antivirus::av_defender,
            behavior::bh_status,
            behavior::bh_set_enabled,
            behavior::bh_alerts,
            behavior::bh_dismiss,
            behavior::bh_trust,
            behavior::bh_untrust,
            behavior::bh_set,
            antivirus::av_history,
            qc_analyze,
            generate_waveform,
            export_audio_clip,
            set_window_progress,
            token_save,
            token_load,
            token_clear,
            set_autostart,
            is_autostart,
            check_for_update,
            download_and_apply_update,
            update_failure,
            debug_port_status,
            debug_port_set,
            restart_app,
            upload_report_file,
            download_api_file,
            download_report_file,
            get_update_channel,
            set_update_channel,
            get_update_source,
            set_update_source,
            reinstall_app,
            installs::find_installs,
            installs::remove_install,
            board_layout,
            pick_input_files,
            pick_output_file,
            pick_output_dir,
            mt_cancel,
            mt_dub_audio,
            mt_change_speed,
            mt_extract_frames,
            mt_make_gif,
            mt_burn_subtitles,
            mt_extract_subtitles,
            write_text_file,
            write_bytes_file,
            nyaa::nyaa_rss,
            nyaa::nyaa_view,
            nyaa::fetch_image,
            nyaa::net_check,
            nyaa::meta_get,
            nyaa::anilist_query,
            nyaa::open_magnet,
            library::library_pick,
            library::library_rescan,
            library::library_clear,
            torrent_clients::tc_save,
            torrent_clients::tc_load,
            torrent_clients::tc_clear,
            torrent_clients::tc_test,
            torrent_clients::tc_add,
            torrent_clients::tc_progress,
            local_render_probe,
            net_diagnose,
            nyaa::nyaa_save_torrent,
            mt_tool_status,
            mt_probe_media,
            mt_register_media_file,
            mt_transcode_media,
            mt_extract_audio,
            mt_concat_media,
            mt_mux_media,
            open_log_folder,
            reveal_in_folder,
            luatools::lt_steam_info,
            luatools::lt_list_installed,
            luatools::lt_read_lua,
            luatools::lt_write_lua,
            luatools::lt_install_file,
            luatools::lt_remove_lua,
            luatools::lt_download,
            luatools::lt_cache_get,
            luatools::lt_cache_put,
            luatools::lt_plugin_status,
            luatools::lt_restart_steam,
            luatools::lt_list_manifests,
            luatools::lt_backup_export,
            luatools::lt_game_install_path,
            luatools::lt_apply_fix,
            luatools::lt_revert_fix,
            luatools::lt_has_fix_backup,
            luatools::lt_list_variants,
            luatools::lt_save_variant,
            luatools::lt_load_variant,
            luatools::lt_delete_variant,
            luatools::lt_install_mode,
            luatools::lt_cloud_redirect_state,
            luatools::lt_cloud_redirect_toggle,
            luatools::lt_ost_config_read,
            luatools::lt_ost_config_write,
            luatools::lt_check_mode_update,
            luatools::lt_hardware_appids,
            luatools::lt_applist_mirror,
            luatools::lt_doh_resolve,
            luatools::lt_depot_downloader_info,
            luatools::lt_depot_downloader_install,
            luatools::lt_depot_downloader_run,
            luatools::lt_fetch_missing_manifests,
            luatools::lt_get_launch_options,
            luatools::lt_set_launch_options,
            luatools::lt_tool_info,
            luatools::lt_tool_latest,
            luatools::lt_tool_install,
            luatools::lt_tool_launch,
            luatools::lt_find_game_exes,
            luatools::lt_hubcap_status,
            luatools::lt_store_button_state,
            luatools::lt_store_button_set,
            luatools::lt_store_status,
            luatools::lt_open_in_steam,
            luatools::lt_hubcap_validate,
            luatools::lt_hubcap_fetch,
            luatools::lt_mfg_api,
            luatools::lt_mfg_ping,
            luatools::lt_oauth_login,
            luatools::lt_http,
            luatools::lt_rename_variant,
            luatools::lt_game_stats,
            luatools::lt_get_playtime,
            luatools::lt_set_playtime,
            luatools::lt_cef_targets,
            luatools::lt_cef_dismiss_loaded_apps,
            luatools::lt_dpapi_encrypt,
            luatools::lt_dpapi_decrypt,
            luatools::lt_redeem_code,
            luatools::lt_config_get,
            luatools::lt_config_set,
            luatools::lt_list_autoupdate_appids,
            luatools::lt_uninstall_mode,
            luatools::lt_vault_history,
            luatools::lt_vault_restore,
            luatools::lt_launch_game,
            luatools::lt_steamless_info,
            luatools::lt_steamless_install,
            luatools::lt_steamless_run,
            luatools::lt_kernelua_validate,
            luatools::lt_kernelua_fetch,
            luatools::lt_kernelua_status,
            luatools::lt_gamelist_sync,
            luatools::lt_gamelist_read,
            luatools::lt_gamelist_dlc_read,
            luatools::lt_gamelist_read_kind,
            luatools::lt_steam_update_blocked,
            luatools::lt_steam_update_set_blocked,
            luatools::lt_smokeapi_install,
            luatools::lt_smokeapi_uninstall,
            luatools::lt_smokeapi_status,
            luatools::lt_creamapi_install,
            luatools::lt_save_backup_create,
            luatools::lt_save_backup_list,
            luatools::lt_save_backup_restore,
            luatools::lt_scan_library,
            luatools::lt_open_onlinefix,
            luatools::lt_config_export,
            luatools::lt_config_import,
            luatools::lt_recent_files,
            luatools::lt_recent_files_add,
            luatools::lt_recent_files_clear,
            luatools::lt_check_stale_manifests,
            luatools::lt_context_menu_install,
            luatools::lt_context_menu_uninstall,
            luatools::lt_context_menu_status,
            luatools::lt_list_profiles,
            luatools::lt_save_profile,
            luatools::lt_load_profile,
            luatools::lt_delete_profile,
            luatools::lt_merge_profile,
        ])
        .setup(|app| {
            log::info!("Project Desktop {} запускается", app.package_info().version);

            behavior::start_if_enabled(app.handle().clone());

            std::thread::spawn(drop_installed_package);
            std::thread::spawn(installs::repair_dead_shortcuts);

            #[cfg(windows)]
            desktop_notify::register();

            let toggle = Shortcut::new(Some(Modifiers::CONTROL | Modifiers::SHIFT), Code::KeyP);
            if let Err(e) = app.global_shortcut().register(toggle) {
                log::warn!("Не удалось зарегистрировать Ctrl+Shift+P (занята другим приложением?): {e}");
            }

            let show_i = MenuItem::with_id(app, "show", "Открыть", true, None::<&str>)?;
            let quit_i = MenuItem::with_id(app, "quit", "Выход", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&show_i, &quit_i])?;

            let mut tray = TrayIconBuilder::new()
                .menu(&menu)
                .show_menu_on_left_click(false)
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "show" => {
                        if let Some(win) = app.get_webview_window("main") {
                            let _ = win.show();
                            let _ = win.unminimize();
                            let _ = win.set_focus();
                        }
                    }
                    "quit" => {
                        app.exit(0);
                    }
                    _ => {}
                })
                .on_tray_icon_event(|tray, event| {
                    if let tauri::tray::TrayIconEvent::Click {
                        button: tauri::tray::MouseButton::Left,
                        button_state: tauri::tray::MouseButtonState::Up,
                        ..
                    } = event
                    {
                        toggle_main_window(tray.app_handle());
                    }
                });
            if let Some(icon) = app.default_window_icon().cloned() {
                tray = tray.icon(icon);
            }
            let _tray = tray.build(app)?;

            let win = app
                .get_webview_window("main")
                .ok_or("окно main не найдено — проверьте tauri.conf.json")?;
            #[cfg(windows)]
            apply_windows_11_chrome(&win);
            #[cfg(windows)]
            disable_browser_accelerator_keys(&win);
            let win_clone = win.clone();
            let handle = app.handle().clone();
            win.on_window_event(move |event| match event {
                tauri::WindowEvent::CloseRequested { api, .. } => {
                    api.prevent_close();
                    let _ = win_clone.hide();
                }
                tauri::WindowEvent::DragDrop(tauri::DragDropEvent::Drop { paths, .. }) => {
                    handle.state::<DroppedFiles>().remember(paths);
                    let scope = handle.state::<file_scope::FileScope>();
                    for p in paths {
                        scope.allow_read(p);
                    }
                }
                _ => {}
            });

            Ok(())
        })
        .build({
            let mut ctx = tauri::generate_context!();
            let args = format!(
                "--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection --autoplay-policy=no-user-gesture-required {webview_args}"
            );
            for w in ctx.config_mut().app.windows.iter_mut() {
                w.additional_browser_args = Some(args.clone());
            }
            ctx
        })
        .expect("error while running tauri application")
        .run(|_, event| {
            if let tauri::RunEvent::ExitRequested { code: None, api, .. } = event {
                if HANDING_OFF_UPDATE.load(std::sync::atomic::Ordering::SeqCst) {
                    api.prevent_exit();
                }
            }
        });
}
