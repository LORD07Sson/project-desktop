// Project Desktop — Tauri-бэкенд.
//
// Фронтенд (dist/) — обычный HTML/CSS/JS, ходит напрямую в тот же REST API,
// что и мини-апп (`miniapp/server.py`), через fetch(). Rust-часть отвечает
// только за то, что веб-странице недоступно: нативное хранилище токена,
// локальный QC звука через ffmpeg, трей, глобальные горячие клавиши,
// автозапуск и системные уведомления.

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
mod steam_session;
mod net_diag;
mod torrent_clients;
mod media_tools;
mod token_store;
mod upscale;

use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Mutex, OnceLock};

use tauri::menu::{Menu, MenuItem};
use tauri::tray::TrayIconBuilder;
use tauri::{Emitter, Manager};
use tauri_plugin_global_shortcut::{Code, GlobalShortcutExt, Modifiers, Shortcut, ShortcutState};

// Обновления — по прямым ссылкам на файлы релизов GitHub, а не через
// GitHub API: у ссылок вида /releases/latest/download/<файл> нет лимита
// 60 запросов в час, ради которого раньше в бинарник вшивался токен
// (его было видно любому, кто скачал exe). Velopack HttpSource читает
// <база>/releases.<канал>.json и качает пакет из той же папки — в каждом
// релизе лежат и фид, и полный пакет этой версии.
const UPDATE_STABLE_URL: &str = "https://github.com/LORD07Sson/project-desktop/releases/latest/download";
const UPDATE_ALPHA_URL: &str = "https://github.com/LORD07Sson/project-desktop/releases/download/alpha-latest";
// Зеркало тех же файлов на нашем сервере (voice_report_bot/desktop_updates.py): у части людей GitHub не открывается.
const SERVER_STABLE_URL: &str = concat!(env!("SERVER_ORIGIN"), "/updates/stable");
const SERVER_ALPHA_URL: &str = concat!(env!("SERVER_ORIGIN"), "/updates/alpha");

/// Откуда брать обновления. «Авто» — GitHub, а если он не отвечает — сервер (и в следующий раз сначала тот,
/// что сработал). Выбор человека хранится в %APPDATA%\com.project.desktop\update_source.txt.
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

/// Источники по порядку попыток.
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
    *update_check_cache().lock().unwrap() = None; // прежний ответ был от другого источника
    *last_good_source().lock().unwrap() = None;
    Ok(())
}

// Канал задаётся типом сборки в workflow, а не пользовательской настройкой.
// Это не даёт стабильному клиенту начать получать alpha-релизы из-за старого
// значения update_channel в общем локальном settings.json.
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
    // Альфа публикуется отдельным pre-release с постоянным тегом
    // alpha-latest (build-alpha.yml), стабильная — обычными релизами; на нашем сервере — та же раскладка.
    let source = velopack::sources::HttpSource::new(from.base());
    // Стабильная prerelease-сборка может принять stable-версию ниже по номеру.
    // Alpha при этом всё равно остаётся закреплена за alpha-фидом: выбор
    // stable здесь не меняет ни источник, ни канал обновлений.
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
    /// Откуда пришло: "github" или "server".
    source: String,
}

// 403/429 от GitHub возможны и на прямых ссылках (временные ограничения
// с одного IP). Клиент сам даёт несколько запросов за сессию:
// автопроверка на старте + Настройки на альфа-канале + ручная кнопка —
// check_for_update_cached ниже схлопывает их в один на короткое окно.
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

// TTL короче, чем троттлинг автопроверки на JS-стороне (maybeAutoCheckUpdates,
// 4 часа) — этот кэш не заменяет его, а закрывает случаи ВНУТРИ одной
// короткой сессии (открыли Настройки, посмотрели на коммит, закрыли,
// нажали «Проверить» — три вызова за секунды одного и того же вопроса
// "есть ли обновление").
const UPDATE_CHECK_CACHE_TTL: std::time::Duration = std::time::Duration::from_secs(5 * 60);

struct CachedUpdateCheck {
    at: std::time::Instant,
    channel: String,
    result: Result<Option<UpdateInfoOut>, String>,
}

// Альфа-релиз alpha-latest на каждую сборку удаляется и публикуется заново — на минуту фид и пакет дают 404, а клиент,
// успевший увидеть старый фид, получает 404 на скачивании. Это временный сбой: ждём и пробуем снова с новым фидом.
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

/// Сколько повторов давать источнику: если за ним есть запасной — один (не держим человека две минуты на мёртвом
/// GitHub), последнему — все.
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

// Канал входит в ключ кэша, чтобы результаты разных типов сборки
// не смешивались при локальном тестировании.
// force — ручная кнопка «Проверить обновления»: всегда свежий запрос к GitHub. Раньше и она брала ответ из кэша, и
// если за пять минут до этого автопроверка видела «нового нет», только что вышедшая альфа не находилась.
fn check_for_update_cached(app: &tauri::AppHandle, force: bool) -> Result<Option<UpdateInfoOut>, String> {
    let channel = build_update_channel().to_string();
    let cache = update_check_cache();
    if !force {
        if let Some(cached) = cache.lock().unwrap().as_ref() {
            // «Нового нет» держим минуту, а не весь TTL: иначе только что вышедшая сборка ещё пять минут не видна
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
            // «Нового нет» — спрашиваем и следующий источник: GitHub отдаёт фид через кэш и несколько минут после
            // сборки отвечает по-старому, а зеркало на сервере уже могло подтянуть новую версию (и наоборот)
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
    // Ошибку не запоминаем: иначе следующая проверка в течение пяти минут снова покажет тот же сбой.
    if result.is_ok() {
        *cache.lock().unwrap() = Some(CachedUpdateCheck { at: std::time::Instant::now(), channel, result: result.clone() });
    }
    result
}

// (async) у синхронной функции — это НЕ косметика: команда без async
// выполняется прямо в главном потоке приложения и подвешивает окно на
// всё время работы. Тут внутри сетевой запрос к GitHub, так что без
// этого атрибута «Проверить обновления» морозило интерфейс.
#[tauri::command(async)]
fn check_for_update(app: tauri::AppHandle, force: Option<bool>) -> Result<Option<UpdateInfoOut>, String> {
    log_result("check_for_update", check_for_update_cached(&app, force.unwrap_or(false)))
}

static UPDATE_DOWNLOADING: AtomicBool = AtomicBool::new(false);

/// Флаг «обновление уже качается», снимается при любом выходе из команды.
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

// ---------- Доступ для ИИ-агента (MCP, отладочный порт WebView2) ----------

const DEFAULT_DEBUG_PORT: u16 = 9222;

/// Файл-флаг лежит в %APPDATA%\com.project.desktop — там же, где app_data_dir, но доступен до создания приложения.
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
    /// Включено ли в настройках (вступит в силу после перезапуска).
    enabled: bool,
    /// Порт, который открыт прямо сейчас в этом запуске.
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

/// Перезапуск: новый экземпляр стартует через пару секунд, когда этот уже вышел (иначе single-instance
/// принял бы новый запуск за второй экземпляр и закрыл его).
#[tauri::command]
fn restart_app(app: tauri::AppHandle) -> Result<(), String> {
    use std::os::windows::process::CommandExt;
    let exe = std::env::current_exe().map_err(|e| e.to_string())?;
    let script = format!("Start-Sleep -Seconds 2; Start-Process -FilePath '{}'", antivirus::ps_quote(&exe.to_string_lossy()));
    std::process::Command::new("powershell")
        .args(["-NoProfile", "-WindowStyle", "Hidden", "-Command", &script])
        .creation_flags(0x0800_0000) // CREATE_NO_WINDOW
        .spawn()
        .map_err(|e| e.to_string())?;
    app.exit(0);
    Ok(())
}

/// После запуска: если перед выходом мы ставили обновление, а версия не сменилась — установка не удалась
/// (Update.exe не смог заменить файлы). Возвращает текст для пользователя один раз и стирает отметку.
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

/// Качает и сразу ставит обновление, перезапуская приложение —
/// `apply_updates_and_restart` завершает текущий процесс сам, эта
/// команда наружу успевает вернуться только в случае ошибки.
/// Прогресс скачивания (0..100) шлётся в JS событием "update-progress",
/// чтобы прогресс-бар в диалоге обновления не стоял на месте на большом
/// файле (сейчас ffmpeg внутри — установщик тяжёлый).
///
/// (async) обязателен: без него скачивание идёт в главном потоке, и
/// события "update-progress" из фонового потока не могут быть
/// доставлены в webview до конца команды — прогресс-бар стоял бы на
/// нуле и прыгал сразу в 100%, ровно то, что этот код и должен чинить.
#[tauri::command(async)]
fn download_and_apply_update(app: tauri::AppHandle) -> Result<(), String> {
    log_result("download_and_apply_update", (|| {
        // Одна закачка за раз. Две одновременные (автообновление при старте
        // + кнопка «Обновить», или двойной клик) пишут в один и тот же
        // `.partial` пакет, и вторая падает с «файл занят другим процессом»
        // (os error 32), а первая тем временем спокойно докачивается.
        let _guard = UpdateDownloadGuard::acquire()?;
        // Источники по очереди: GitHub не отдал фид или оборвал пакет — тот же пакет берём с сервера.
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
                    // В этом источнике новой версии ещё нет (кэш GitHub, зеркало не успело) — пробуем следующий
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
        // apply_updates_and_restart сама завершает процесс — строка ниже
        // в норме никогда не выполняется до конца, но если она вообще
        // вернула управление, это уже само по себе ошибка на стороне ОС.
        // Раньше тут был apply_updates_and_restart — он завершает процесс жёстким exit(0), без штатного
        // закрытия окна. Дочерние процессы WebView2 после этого висели ещё секунды и держали папку
        // `current`, а Update.exe не мог её переименовать («файл занят», 10 повторов и отказ): версия
        // оставалась старой. Теперь Update.exe запускается и ждёт, а мы выходим штатно, закрывая webview.
        // Сначала закрываем окна и ждём, пока завершатся процессы WebView2 программы: их рабочая папка — `current`,
        // и пока они живы, Windows не даёт Update.exe её переименовать («Access is denied», 10 повторов и отказ —
        // версия остаётся старой). Update.exe к тому же не всегда может дождаться нашего процесса сам.
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

/// «Переустановить начисто»: зависшая установка, перенесённая руками папка, портативная копия — скачиваем установщик
/// (источники — как у обновлений) и ставим программу в обычное место. Setup.exe запускается, когда мы уже вышли:
/// иначе он не заменит файлы запущенной программы. Старые копии потом видны в «Копии программы» — их можно убрать.
#[tauri::command]
async fn reinstall_app(app: tauri::AppHandle) -> Result<(), String> {
    use std::os::windows::process::CommandExt;
    let _guard = UpdateDownloadGuard::acquire()?;
    let urls: Vec<(String, String)> = update_sources().into_iter().map(|s| (s.label().to_string(), s.setup_url())).collect();
    let setup = installs::download_setup(&app, &urls).await.map_err(|e| { log::error!("[reinstall_app] {e}"); e })?;
    let script = format!("Start-Sleep -Seconds 3; Start-Process -FilePath '{}'", antivirus::ps_quote(&setup.to_string_lossy()));
    std::process::Command::new("powershell")
        .args(["-NoProfile", "-WindowStyle", "Hidden", "-Command", &script])
        .creation_flags(0x0800_0000) // CREATE_NO_WINDOW
        .spawn()
        .map_err(|e| e.to_string())?;
    log::info!("reinstall_app: установщик {} запустится после выхода", setup.display());
    release_program_files(&app);
    app.exit(0);
    Ok(())
}

/// Перед установкой: закрыть окна и дождаться (до 10 с), пока завершатся все дочерние процессы программы —
/// WebView2 и запущенные ffmpeg/ffprobe держат папку программы (рабочая папка, сами exe), и установщик не может её заменить.
// Пока идёт передача установщику, закрытие последнего окна не должно завершать программу: Tauri по умолчанию
// выходит, когда окон не осталось, и процесс умирал раньше, чем успевал запустить Update.exe — окно пропадало, обновления не было.
static HANDING_OFF_UPDATE: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

fn release_program_files(app: &tauri::AppHandle) {
    HANDING_OFF_UPDATE.store(true, std::sync::atomic::Ordering::SeqCst);
    for (_, window) in app.webview_windows() {
        let _ = window.destroy();
    }
    let me = sysinfo::Pid::from_u32(std::process::id());
    let started = std::time::Instant::now();
    let mut sys = sysinfo::System::new();
    loop {
        sys.refresh_processes(sysinfo::ProcessesToUpdate::All, true);
        // Потомки нашего процесса на любую глубину (браузерный процесс WebView2 → его рендеры и GPU)
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

// Логирует Err любой команды с её именем перед тем, как отдать наружу —
// единая точка диагностики по всем tauri::command в этом файле, вместо
// разметки логов внутри каждого модуля (audio_qc/media_tools/mpv_embed)
// отдельно: тот же приём, что toast() на JS-стороне (см. api.js) для
// error-тостов. Успешный путь намеренно не логируется здесь — иначе
// файл раздувался бы шумом на каждый клик, а не только там, где
// реально что-то пошло не так.
fn log_result<T>(command: &str, result: Result<T, String>) -> Result<T, String> {
    if let Err(e) = &result {
        log::error!("[{command}] {e}");
    }
    result
}

// ffmpeg на большом файле работает секундами — в главном потоке это
// замороженное окно на всё время анализа.
//
// Путь больше не берётся на веру: file_scope.rs проверяет, что этот
// файл пользователь действительно выбрал сам (нативный диалог или
// перетаскивание в окно). Без проверки любой XSS в webview мог бы
// прочитать/перезаписать произвольный файл на диске — см. шапку
// file_scope.rs.
#[tauri::command(async)]
fn qc_analyze(app: tauri::AppHandle, path: String) -> Result<audio_qc::QcReport, String> {
    log_result("qc_analyze", (|| {
        let path = app.state::<file_scope::FileScope>().check_read(&path)?;
        audio_qc::analyze(&path.to_string_lossy())
    })())
}

// Тоже через ffmpeg (полное декодирование в PCM) — на большом файле
// секунды, поэтому (async) по той же причине, что и у qc_analyze выше.
#[tauri::command(async)]
fn generate_waveform(app: tauri::AppHandle, path: String, buckets: u32) -> Result<audio_qc::WaveformData, String> {
    log_result("generate_waveform", (|| {
        let path = app.state::<file_scope::FileScope>().check_read(&path)?;
        audio_qc::generate_waveform(&path.to_string_lossy(), buckets)
    })())
}

// Запускает ffmpeg-субпроцесс и пишет файл на диск — блокирующее.
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

/// Прогресс длинных операций ffmpeg уезжает в вебвью событием
/// `mediatool-progress` — сам media_tools.rs про окно приложения ничего
/// не знает (см. media_tools::Progress), поэтому мост живёт здесь.
fn progress_to_webview(app: &tauri::AppHandle) -> impl Fn(f64, &str) + Sync + '_ {
    move |fraction, label| {
        let _ = app.emit(
            "mediatool-progress",
            serde_json::json!({ "fraction": fraction, "label": label }),
        );
    }
}

/// Раскладка доски: сортировка по срочности, метрики колонок, поиск.
/// Считается в Rust не ради скорости (на сотне карточек её и не
/// заметить), а ради того, что это чистая функция без DOM — её целиком
/// покрывают тесты в board.rs, чего про обработчики рендера сказать
/// нельзя. Сегодняшнюю дату присылает фронтенд: часовой пояс студии
/// знает он, а не процесс.
#[tauri::command]
fn board_layout(
    columns: Vec<board::BoardColumnIn>,
    view: board::BoardView,
) -> board::BoardLayout {
    board::layout(columns, &view)
}

// ---------- нативные диалоги выбора файлов (file_scope.rs) ----------
// Раньше диалоги открывал JS (@tauri-apps/plugin-dialog) и присылал
// бэкенду готовый путь — то есть путь приходил из вебвью и ничем не
// отличался от произвольной строки. Теперь диалог открывает Rust: путь
// становится известен ему раньше, чем JS, и сразу попадает в скоуп.

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

// Запись небольшого текстового файла (проект Reaper и т.п.) — только по
// пути, который пользователь сам выбрал в диалоге сохранения.
// Запись небольшого бинарного файла (.torrent, пришедший через сервер) — по тому же
// правилу: только в путь, выбранный в диалоге сохранения, и не больше 2 МБ.
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

// ---------- «Инструменты ffmpeg» (media_tools.rs) ----------

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

// Не (async): сам вызов — просто регистрация пути в скоупе asset-протокола
// (запись в память), никакого ffmpeg-субпроцесса здесь нет.
//
// Проверка скоупа тут самая важная во всём файле: allow_file() открывает
// вебвью чтение файла ПО HTTP-подобному asset://-адресу, то есть без
// неё одна строка из XSS давала бы чтение любого файла на диске.
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

// ---------- новые операции: дубляж, скорость, кадры, GIF, субтитры ----------
// Все по одному образцу: скоуп проверяет входы и выход, отказ писать
// поверх исходника, прогресс уезжает в вебвью тем же событием.

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

// ---------- «Собрать финал у себя» (local_render.rs): рендер на видеокарте ПК по плану сервера ----------

// ---------- Апскейл картинок (upscale.rs) ----------

/// Увеличивает картинку ×4 нейросетью (при первом вызове докачивает движок и модель). PNG уходит сырым ответом — без JSON.
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

/// Своя картинка для апскейла — файл из диалога выбора; байты уходят сырым ответом.
#[tauri::command(async)]
fn upscale_read(app: tauri::AppHandle, path: String) -> Result<tauri::ipc::Response, String> {
    upscale::read_input(&app, &path).map(tauri::ipc::Response::new)
}

/// Свои модели апскейла (ncnn): список, добавление из выбранных файлов, удаление.
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

/// Сколько места занимает апскейл и очистка (движок и скачанные модели; свои модели остаются).
#[tauri::command(async)]
fn upscale_storage() -> upscale::Storage {
    upscale::storage()
}

#[tauri::command(async)]
fn upscale_clear() -> Result<upscale::Storage, String> {
    upscale::clear()
}

/// Сохраняет последний результат апскейла — только в путь из диалога сохранения.
#[tauri::command(async)]
fn upscale_save(app: tauri::AppHandle, path: String) -> Result<(), String> {
    upscale::save(&app, &path)
}

/// Автопроверка инструментов: ffmpeg (докачивает из релиза на GitHub, если нет), видеокарта и кодировщики.
#[tauri::command]
async fn local_render_prepare(app: tauri::AppHandle) -> local_render::ToolsStatus {
    local_render::prepare(&app, http()).await
}

/// Какие кодировщики реально работают на этом компьютере (NVENC — видеокарта NVIDIA).
#[tauri::command(async)]
fn local_render_encoders() -> local_render::EncoderStatus {
    local_render::encoder_status()
}

/// Выполняет план сборки: скачивает файлы, рендерит, возвращает путь к готовому файлу. Путь сразу попадает в скоуп
/// чтения, чтобы существующая `upload_report_file` могла его загрузить в отчёт.
/// Проверка DNS для «Карты работы»: разрешается ли адрес нашего сервера, какие DNS настроены и чьи. Только наш сервер.
#[tauri::command(async)]
fn net_diagnose() -> net_diag::NetDiag {
    let host = API_BASE.trim_start_matches("https://").split(['/', ':']).next().unwrap_or("");
    net_diag::diagnose(host)
}

/// Параметры видео, лежащего на этом компьютере, для плана сборки (читается только выбранный пользователем файл).
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

/// Загрузка готового файла на сервер (дальше им занимается бот). Путь должен быть тем, что вернул local_render_run.
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
    // Если идёт ffmpeg — останавливаем и его; «нечего отменять» здесь не ошибка (мог идти этап скачивания).
    let _ = media_tools::cancel_current_job();
    Ok(())
}

/// Копия готового рендера в папку, которую пользователь выбрал в диалоге (pick_output_dir). Исходник читается только
/// по пути, который вернул local_render_run; имя берём без каталогов, существующий файл не затираем — добавляем (2), (3)…
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

/// Прервать текущую операцию ffmpeg («Отмена» в панели инструментов).
/// До неё единственным способом остановить сорокаминутный транскод было
/// закрыть приложение — и даже это оставляло процесс ffmpeg дожёвывать
/// файл в фоне.
#[tauri::command(async)]
fn mt_cancel() -> Result<(), String> {
    media_tools::cancel_current_job()
}

// Открыть папку с файловыми логами (tauri-plugin-log, см. run()) —
// кнопка в настройках, чтобы при жалобе пользователь мог просто
// прислать файл, а не пересказывать своими словами, что было на экране.
// app_log_dir() — тот же путь, что резолвит сам плагин под капотом
// (TargetKind::LogDir), так что открывается ровно та папка, куда
// реально пишутся логи, без риска разъехаться с ним. reveal_item_in_dir
// (а не shell::open, который у tauri 2 к тому же deprecated в пользу
// этого же opener) открывает родителя и подсвечивает саму папку logs —
// этого достаточно, чтобы её найти и зайти внутрь.
#[tauri::command(async)]
fn open_log_folder(app: tauri::AppHandle) -> Result<(), String> {
    use tauri_plugin_opener::OpenerExt;
    let dir = app.path().app_log_dir().map_err(|e| e.to_string())?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    app.opener().reveal_item_in_dir(&dir).map_err(|e| e.to_string())
}

/// «Показать в папке»: открывает проводник и выделяет сам файл (через opener, а не shell:open, у которого скоуп
/// на пути в папки не рассчитан). Работает только для существующего файла.
#[tauri::command(async)]
fn reveal_in_folder(app: tauri::AppHandle, path: String) -> Result<(), String> {
    use tauri_plugin_opener::OpenerExt;
    let p = std::path::PathBuf::from(&path);
    if !p.exists() {
        return Err("Файла уже нет на диске.".into());
    }
    app.opener().reveal_item_in_dir(&p).map_err(|e| e.to_string())
}

// Обращение к хранилищу учётных данных ОС тоже блокирующее (на Linux —
// синхронный вызов Secret Service по D-Bus).
#[tauri::command(async)]
fn token_save(token: String) -> Result<(), String> {
    // log_result безопасен и здесь: он логирует только текст Err (общая
    // ошибка хранилища ОС), сам токен никогда не попадает в лог ни на
    // успешном, ни на неудачном пути.
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

// «Расширенные возможности Steam» (steam_session.rs): вход по QR, токен только в хранилище ОС на этом компьютере,
// страница получает статус и ответы разрешённых методов чтения, но не сами токены.
#[tauri::command(async)]
async fn steam_qr_begin() -> Result<steam_session::QrStart, String> {
    log_result("steam_qr_begin", steam_session::begin_qr().await)
}

#[tauri::command(async)]
async fn steam_qr_poll(client_id: String, request_id: String) -> Result<steam_session::QrPoll, String> {
    log_result("steam_qr_poll", steam_session::poll_qr(client_id, request_id).await)
}

#[tauri::command(async)]
async fn steam_session_status() -> steam_session::Status {
    steam_session::status().await
}

#[tauri::command(async)]
async fn steam_sign_out() -> Result<(), String> {
    log_result("steam_sign_out", steam_session::sign_out().await)
}

#[tauri::command(async)]
async fn steam_api(interface: String, method: String, params: String) -> Result<String, String> {
    log_result("steam_api", steam_session::api(&interface, &method, &params).await)
}

// Прогресс пакетного QC (runQcBatch в qc.js) — на иконке в панели
// задач, а не только полоской внутри окна: у студии окно приложения
// часто свёрнуто в трей во время долгого прогона по папке с
// десятком дорожек, а таскбар виден всегда. progress=None гасит
// индикатор — вызывается и по завершении прогона, и если шторку
// закрыли посреди работы (иначе полоска осталась бы висеть на
// иконке до следующего вызова, вводя в заблуждение).
// Не (async): сам вызов — дешёвая нативная операция (Windows: одно
// COM-обращение к ITaskbarList3), в отличие от ffmpeg-субпроцессов
// или сетевых запросов выше блокировать интерфейс ей нечем.
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

// Адрес сервера — из server.json в корне репозитория (build.rs передаёт его как SERVER_ORIGIN), тот же файл читает
// интерфейс (src/app/api.js). Сменить: npm run set-server -- https://новый.домен.
const API_BASE: &str = concat!(env!("SERVER_ORIGIN"), "/api");

// Один клиент на всё приложение — у reqwest::Client внутри пул
// соединений и TLS-сессии, создавать его на каждый запрос значит
// каждый раз заново поднимать TLS-хендшейк.
fn http() -> &'static reqwest::Client {
    static HTTP: OnceLock<reqwest::Client> = OnceLock::new();
    HTTP.get_or_init(reqwest::Client::new)
}

/// Пути файлов, которые пользователь СВОИМИ РУКАМИ перетащил в окно.
/// `upload_report_file` ниже читает файл с диска по пути, пришедшему из
/// JS, — без этого списка любой XSS в webview превращался бы в примитив
/// «прочитать произвольный файл пользователя и отправить его на сервер»
/// (ровно то, от чего обычно защищает capability-скоуп tauri-plugin-fs).
/// Rust слушает то же самое нативное событие drag&drop, что и JS-сторона
/// (см. src/app/file-drop.js), поэтому список наполняется сам.
#[derive(Default)]
struct DroppedFiles(Mutex<HashSet<PathBuf>>);

impl DroppedFiles {
    fn remember(&self, paths: &[PathBuf]) {
        if let Ok(mut set) = self.0.lock() {
            // Держим только последний дроп — старые пути незачем
            // оставлять доступными на всю жизнь процесса.
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

// Тот же список, что ALLOWED_EXT в src/app/file-drop.js — держать в
// синхроне руками. Проверка дублируется намеренно: JS-сторону можно
// обойти, Rust-сторону — нет.
const ALLOWED_UPLOAD_EXT: &[&str] = &[
    // звук (AUDIO_EXTENSIONS в src/app/media-formats.js)
    "wav", "wave", "w64", "mp3", "mp2", "flac", "m4a", "m4b", "aac", "ogg", "oga", "opus", "wma", "aiff",
    "aif", "aifc", "ac3", "eac3", "dts", "mka", "ape", "wv", "amr", "caf", "au", "tta", "weba",
    // видео (VIDEO_EXTENSIONS)
    "mp4", "mkv", "mov", "avi", "webm", "m4v", "ts", "m2ts", "mts", "mpg", "mpeg", "wmv", "flv", "3gp", "ogv",
    // картинки и документы
    "png", "jpg", "jpeg", "webp", "pdf", "doc", "docx", "ppt", "pptx", "zip",
];

// Гигабайтный файл, целиком загруженный в память, уронил бы приложение
// раньше, чем сервер успел бы его отклонить.
// Потолок локального Bot API на сервере — 2000 МБ (сервер и nginx пропускают
// файл потоком, см. _spooled в miniapp/server.py).
const MAX_UPLOAD_BYTES: u64 = 2000 * 1024 * 1024;

// Файл разрешён к загрузке, если пользователь сам его указал ЛЮБЫМ
// из двух способов — перетащил в окно (DroppedFiles) или выбрал в
// нативном диалоге (FileScope.readable, тот же скоуп, что уже даёт
// mt_register_media_file и остальным ffmpeg-командам). Раньше
// upload_report_file понимал только drag-drop — кнопка «Выбрать файл»
// (если такая появится в интерфейсе) молча отклонялась бы с той же
// ошибкой, хотя источник доверия ровно тот же: явный выбор
// пользователя, а не путь, подставленный из вебвью.
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

/// Файл, перетащенный из проводника (см. src/app/file-drop.js,
/// onDragDropEvent отдаёт только путь на диске, не байты) — читаем его
/// здесь, в Rust, и сами шлём multipart-запросом на
/// /api/report/{id}/files/upload, а не через JS/fetch: так не нужен
/// tauri-plugin-fs со capability-скоупом на произвольный путь на диске.
/// Скоуп при этом никуда не девается — он просто свой (см. DroppedFiles
/// выше): читаем только то, что пользователь сам перетащил в окно.
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

        // std::fs::read (блокирующий), не tokio::fs — не тащим отдельно
        // зависимость на tokio ради одного чтения файла.
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

/// Скачивание вложения отчёта. Раньше это была обычная ссылка
/// `<a href="...?init_data=ТОКЕН" target="_blank">` в карточке отчёта:
/// во-первых, target="_blank" внутри webview никакого окна не открывает
/// (кнопка просто не работала), во-вторых, токен `dsk_...` уезжал в
/// строку URL — то есть в логи сервера и в историю внешнего браузера.
/// Теперь запрос идёт отсюда, токен — заголовком, а путь сохранения
/// пользователь выбирает нативным диалогом (plugin-dialog на JS-стороне).
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
        // Путь сохранения приходит из вебвью. Без этой проверки XSS мог
        // бы положить файл с содержимым от сервера куда угодно — в папку
        // автозагрузки, поверх чужого документа и т.п.
        let save_path = app.state::<file_scope::FileScope>().check_write(&save_path)?;
        // Файла может не быть в кэше сервера (ушёл в архив Telegram): сервер достаёт его оттуда, и пока это идёт,
        // отвечает 502–504 или рвёт соединение. Это временно — повторяем, а не сдаёмся с первой попытки.
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

        save_response_to_file(resp, &save_path, job.map(|j| (app.clone(), j))).await
    }
    .await;
    log_result("download_report_file", result)
}

/// Какие адреса API можно скачать через download_api_file: только ручки
/// вложений (сообщения, заметки, тикеты, равки серии). Путь приходит из
/// вебвью — без этой проверки им можно было бы вытянуть любой ответ API
/// с токеном пользователя в заголовке.
fn allowed_attachment_path(api_path: &str) -> bool {
    let ok_chars = api_path
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || matches!(c, '/' | '-' | '_' | ':'));
    let parts: Vec<&str> = api_path.split('/').collect();
    let numeric = |s: &str| !s.is_empty() && s.chars().all(|c| c.is_ascii_digit());
    let shape = match parts.as_slice() {
        ["chats", _key, "messages", id, "file"] => numeric(id),
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

/// Скачивание вложения (сообщения, заметки, тикеты, равки) в выбранный
/// пользователем файл — тот же приём, что download_report_file: токен
/// заголовком, путь сохранения проверяет FileScope.
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
        // Сервер может доставать файл из архива Telegram — пока это идёт, он отвечает 502–504: повторяем.
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
        save_response_to_file(resp, &save_path, job.map(|j| (app.clone(), j))).await
    }
    .await;
    log_result("download_api_file", result)
}

/// Ответ сервера — в файл кусками, а не целиком в память: файлы бывают
/// до 2 ГБ. Предел MAX_UPLOAD_BYTES проверяется и по заявленному размеру,
/// и по фактически прочитанному (Content-Length может врать или его нет —
/// иначе бесконечный поток забил бы диск). Недокачанный файл удаляется.
async fn save_response_to_file(
    mut resp: reqwest::Response,
    save_path: &std::path::Path,
    progress: Option<(tauri::AppHandle, String)>,
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
        if len > MAX_UPLOAD_BYTES {
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
            if total > MAX_UPLOAD_BYTES {
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

/// Текст ошибки из тела ответа сервера ({"detail": "..."}), если он там
/// есть — иначе переданная заглушка.
async fn error_detail(resp: reqwest::Response, fallback: &str) -> String {
    resp.json::<serde_json::Value>()
        .await
        .ok()
        .and_then(|v| v.get("detail").and_then(|d| d.as_str()).map(str::to_string))
        .unwrap_or_else(|| fallback.to_string())
}

/// Скругление углов и цвет рамки окна — Windows 11 (build 22000+).
/// Системный заголовок у окна выключен (tauri.conf.json:
/// decorations:false, полосу рисует сам фронтенд, см. window-chrome.js),
/// поэтому единственное, что осталось от системного оформления, — тонкая
/// рамка, которую рисует DWM. По умолчанию она серая и к палитре
/// приложения отношения не имеет.
///
/// На Windows 10 обоих атрибутов не существует, вызов вернёт E_INVALIDARG
/// — намеренно игнорируем: окно просто останется с прямыми углами и
/// рамкой по умолчанию, как было.
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
        // COLORREF — 0x00BBGGRR, не привычный #RRGGBB: это --line из
        // styles.css (#38262e) с переставленными байтами.
        let border: u32 = 0x002e_2638;
        let _ = DwmSetWindowAttribute(
            hwnd,
            DWMWA_BORDER_COLOR,
            std::ptr::addr_of!(border).cast(),
            std::mem::size_of_val(&border) as u32,
        );
    }
}

/// WebView2 по умолчанию сам перехватывает часть «браузерных» горячих
/// клавиш (Ctrl+F/Ctrl+P/Ctrl+K и т.п. — то же, что в обычном Edge) ДО
/// того, как они доходят до keydown-слушателя страницы. У нас Ctrl+K —
/// это command-palette.js (document.addEventListener("keydown", ...)),
/// и в реальном приложении на Windows он никогда не срабатывал, хотя в
/// headless Playwright-тестах на Linux (не настоящий WebView2 — синтетика
/// диспетчерит события прямо в DOM, минуя браузерный слой) всё было
/// зелёным. AreBrowserAcceleratorKeysEnabled=false отдаёт эти комбинации
/// странице как обычные keydown.
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

/// Удаляет из `packages/` полный пакет (.nupkg, ~170 МБ) уже
/// установленной версии. Velopack после обновления сам чистит пакеты
/// старых версий, но пакет текущей оставляет — он нужен только чтобы
/// собирать дельта-обновления, а мы их не публикуем (в релизах только
/// full). Без этого рядом с `current/` всегда лежит его сжатая копия.
/// Скачанное, но ещё не применённое обновление (версия выше текущей)
/// не трогаем. Не установлено через Velopack (запуск из target/) —
/// ничего не делаем.
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
    // Должен быть самой первой инструкцией в main() — Velopack иногда
    // перезапускает/завершает процесс сам для служебных операций
    // (первичная установка, применение обновления и т.п.), до того как
    // остальной код приложения вообще успеет пойти.
    velopack::VelopackApp::build().run();

    // Рабочая папка по умолчанию — `current` рядом с exe (так нас запускает Velopack), и каждый дочерний процесс
    // (WebView2, ffmpeg) наследует её и «прижимает» папку: Update.exe потом не может её переименовать и обновление
    // не ставится. Переносим рабочую папку во временную — ffmpeg рядом с exe находится и так (папка exe ищется первой).
    let _ = std::env::set_current_dir(std::env::temp_dir());

    // Доступ для ИИ-агента (MCP): включается в Настройки → «Доступ для ИИ» и действует со следующего запуска.
    // Порт слушает только 127.0.0.1; без флага-файла переменная не выставляется и порт закрыт.
    if let Some(port) = debug_port_flag() {
        // Единственный поток на этом этапе — других потоков, читающих окружение, ещё нет.
        std::env::set_var("WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS", format!("--remote-debugging-port={port} --remote-allow-origins=*"));
    }

    // Отдельный процесс антивируса с правами администратора: проверка закрытых папок без окна (см. antivirus::headless).
    let cli_args: Vec<String> = std::env::args().collect();
    if cli_args.iter().any(|a| a == "--av-scan") {
        std::process::exit(antivirus::headless(&cli_args));
    }

    tauri::Builder::default()
        // Второй запуск (ярлык, автозапуск + ручной старт и т.п.) не должен
        // плодить второй процесс — вместо этого просто разворачиваем уже
        // работающее окно. Должен регистрироваться самым первым плагином.
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            if let Some(win) = app.get_webview_window("main") {
                let _ = win.show();
                let _ = win.unminimize();
                let _ = win.set_focus();
            }
        }))
        // Файловые логи с ротацией — единая точка диагностики вместо
        // разрозненных toast/eprintln!, после которых при жалобе из
        // реальной студии оставалось только гадать (см. историю с mpv-
        // плеером: ни toast, ни процесса, а eprintln! в --release без
        // консоли уходил в никуда — оба факта стали видны только после
        // добавления этого плагина). Webview-таргет зеркалит и то, что
        // шлёт console.* из JS (media-tools.js и т.д.), в тот же файл —
        // не только в devtools-консоль, которую пользователь не откроет
        // сам. Error по умолчанию; Info включён только для модулей FFmpeg,
        // чтобы видеть этап и последний подтверждённый прогресс без шума
        // сторонних библиотек. Максимум 5 МБ на файл, храним
        // 3 последних ротации, остального обычно достаточно, чтобы
        // покрыть один сеанс работы студии.
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
        // reveal_item_in_dir для open_log_folder (кнопка «Открыть логи»
        // в настройках) — не тот же плагин, что shell:allow-open,
        // который open_log_folder раньше использовал через deprecated
        // Shell::open.
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
            steam_qr_begin,
            steam_qr_poll,
            steam_session_status,
            steam_sign_out,
            steam_api,
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
        ])
        .setup(|app| {
            // Первая строка в файловом логе за сеанс — якорь, от которого
            // считать всё остальное при разборе присланного лога (версия
            // сборки — иначе непонятно, к какому коммиту относится баг-
            // репорт присланного файла).
            log::info!("Project Desktop {} запускается", app.package_info().version);

            // Поведенческая защита (если включена): фоновый монитор процессов и файловой активности.
            behavior::start_if_enabled(app.handle().clone());

            // Пакет уже установленной версии в packages/ больше не нужен.
            std::thread::spawn(drop_installed_package);

            // Тосты от имени «Project Desktop», а не «Windows PowerShell».
            #[cfg(windows)]
            desktop_notify::register();

            // Глобальная горячая клавиша — свернуть/показать окно из любого
            // места (Ctrl+Shift+P). Не через `?`: если комбинацию уже занял
            // кто-то другой в системе, ошибка отсюда уронила бы весь запуск
            // приложения — из-за необязательной горячей клавиши.
            let toggle = Shortcut::new(Some(Modifiers::CONTROL | Modifiers::SHIFT), Code::KeyP);
            if let Err(e) = app.global_shortcut().register(toggle) {
                log::warn!("Не удалось зарегистрировать Ctrl+Shift+P (занята другим приложением?): {e}");
            }

            // Иконка в трее с меню — открыть/скрыть окно и выйти по-настоящему.
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
            // Без unwrap(): иконки может не оказаться (собрали без
            // bundle.icon) — трей тогда просто будет с иконкой по
            // умолчанию, а не паника на старте.
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
                // Крестик у окна — сворачиваем в трей вместо закрытия (опрос
                // уведомлений на JS-стороне продолжает идти, пока процесс жив).
                tauri::WindowEvent::CloseRequested { api, .. } => {
                    api.prevent_close();
                    let _ = win_clone.hide();
                }
                // Тот же дроп, который обрабатывает JS (file-drop.js), —
                // запоминаем пути, чтобы upload_report_file знал, какие
                // файлы пользователь реально разрешил трогать.
                tauri::WindowEvent::DragDrop(tauri::DragDropEvent::Drop { paths, .. }) => {
                    handle.state::<DroppedFiles>().remember(paths);
                    // Перетащенный файл — такой же явный выбор пользователя,
                    // как выбранный в диалоге: QC звука умеет запускаться
                    // прямо по дропу (file-drop.js), а qc_analyze теперь
                    // сверяется со скоупом (file_scope.rs).
                    let scope = handle.state::<file_scope::FileScope>();
                    for p in paths {
                        scope.allow_read(p);
                    }
                }
                _ => {}
            });

            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while running tauri application")
        .run(|_, event| {
            // Выход «окон не осталось» (code: None) во время передачи установщику держим; явный app.exit(0) проходит.
            if let tauri::RunEvent::ExitRequested { code: None, api, .. } = event {
                if HANDING_OFF_UPDATE.load(std::sync::atomic::Ordering::SeqCst) {
                    api.prevent_exit();
                }
            }
        });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn friendly_update_error_explains_github_rate_limit() {
        let msg = friendly_update_error("Http error: http status: 403");
        assert!(msg.contains("лимит"), "должно объяснять причину, получили: {msg}");
        assert!(!msg.contains("403"), "пользователю не нужен голый код ответа: {msg}");
    }

    #[test]
    fn friendly_update_error_passes_through_other_errors() {
        let msg = friendly_update_error("Нет связи с сервером: connection refused");
        assert_eq!(msg, "Нет связи с сервером: connection refused");
    }

    #[test]
    fn attachment_paths_only_whitelisted() {
        assert!(allowed_attachment_path("chats/general/messages/12/file"));
        assert!(allowed_attachment_path("chats/dm:1:2/messages/3/file"));
        assert!(allowed_attachment_path("report/R-000012/notes/4/file"));
        assert!(allowed_attachment_path("tickets/5/posts/6/file"));
        assert!(allowed_attachment_path("report/R-000012/raws/voice/file"));
        // чужие ручки API, обход пути, мусор в id
        assert!(!allowed_attachment_path("admin/access"));
        assert!(!allowed_attachment_path("report/R-1/raws/other/file"));
        assert!(!allowed_attachment_path("chats/general/messages/x/file"));
        assert!(!allowed_attachment_path("chats/../admin/messages/1/file"));
        assert!(!allowed_attachment_path("chats/general/messages/1/file?x=1"));
        assert!(!allowed_attachment_path("/chats/general/messages/1/file"));
    }
}
