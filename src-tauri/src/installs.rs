//! Копии программы на компьютере и «починка» установки.
//!
//! Что ломалось у людей:
//!  * после обновлений рядом оставались старые копии (портативная папка на рабочем столе, распакованный zip в
//!    «Загрузках», прежняя установка) — запускали не ту, ярлык «Пуска» указывал на старую (desktop_notify пересоздаёт
//!    его на exe последнего запуска), и было непонятно, где настоящая программа;
//!  * установка в %LOCALAPPDATA% «зависала»: недокачанный пакет (*.partial) или полузаменённая папка — обновление
//!    больше не ставилось;
//!  * папку переносили вручную, и программа после этого не обновлялась.
//! Поэтому: `find_installs` находит все копии (по Update.exe + current\project-desktop.exe) с версией и каналом,
//! `remove_install` убирает выбранную старую (и её ярлыки), `reinstall_app` скачивает установщик (GitHub или наш
//! сервер — тот же выбор источника, что у обновлений) и ставит программу начисто в обычное место.

use std::path::{Path, PathBuf};
use std::sync::Mutex;

use serde::Serialize;
use tauri::Emitter;

const MAIN_EXE: &str = "project-desktop.exe";
/// Сколько уровней папок под каждой точкой поиска смотреть: «Рабочий стол\Project\ProjectDesktop» — это 2.
const SCAN_DEPTH: usize = 3;
const SKIP_DIRS: &[&str] = &[
    "windows", "program files", "program files (x86)", "programdata", "$recycle.bin", "system volume information",
    "appdata", "node_modules", ".git", "target", "$windows.~bt", "$windows.~ws", "recovery", "perflogs",
];

#[derive(Serialize, Clone)]
pub struct InstallInfo {
    pub path: String,
    pub version: String,
    pub channel: String,
    pub portable: bool,
    /// Это та копия, что запущена сейчас.
    pub current: bool,
    /// Обычная установка (%LOCALAPPDATA%\ProjectDesktop), а не папка, разложенная руками.
    pub standard: bool,
}

fn last_scan() -> &'static Mutex<Vec<PathBuf>> {
    static SCAN: std::sync::OnceLock<Mutex<Vec<PathBuf>>> = std::sync::OnceLock::new();
    SCAN.get_or_init(|| Mutex::new(Vec::new()))
}

/// Корень запущенной копии (папка с Update.exe), если программа стоит через Velopack.
pub fn current_root() -> Option<PathBuf> {
    let exe = std::env::current_exe().ok()?;
    let root = exe.parent()?.parent()?.to_path_buf();
    is_install(&root).then_some(root)
}

pub fn standard_root() -> Option<PathBuf> {
    std::env::var_os("LOCALAPPDATA").map(|d| PathBuf::from(d).join("ProjectDesktop"))
}

fn is_install(dir: &Path) -> bool {
    dir.join("Update.exe").is_file() && dir.join("current").join(MAIN_EXE).is_file()
}

fn manifest_field(xml: &str, tag: &str) -> String {
    let open = format!("<{tag}>");
    let close = format!("</{tag}>");
    xml.find(&open)
        .and_then(|i| xml[i + open.len()..].find(&close).map(|j| xml[i + open.len()..i + open.len() + j].trim().to_string()))
        .unwrap_or_default()
}

fn same_path(a: &Path, b: &Path) -> bool {
    match (std::fs::canonicalize(a), std::fs::canonicalize(b)) {
        (Ok(x), Ok(y)) => x == y,
        _ => a.to_string_lossy().eq_ignore_ascii_case(&b.to_string_lossy()),
    }
}

fn describe(dir: &Path, current: Option<&Path>) -> InstallInfo {
    let xml = std::fs::read_to_string(dir.join("current").join("sq.version")).unwrap_or_default();
    let version = manifest_field(&xml, "version");
    let channel = manifest_field(&xml, "channel");
    InstallInfo {
        path: dir.to_string_lossy().to_string(),
        version: if version.is_empty() { "?".into() } else { version },
        channel: if channel.is_empty() { "win".into() } else { channel },
        portable: dir.join(".portable").exists(),
        current: current.map(|c| same_path(c, dir)).unwrap_or(false),
        standard: standard_root().map(|s| same_path(&s, dir)).unwrap_or(false),
    }
}

fn walk(dir: &Path, depth: usize, found: &mut Vec<PathBuf>) {
    if is_install(dir) {
        found.push(dir.to_path_buf());
        return; // внутри установки других копий нет
    }
    if depth == 0 {
        return;
    }
    let Ok(entries) = std::fs::read_dir(dir) else { return };
    for entry in entries.flatten() {
        let Ok(kind) = entry.file_type() else { continue };
        if !kind.is_dir() || kind.is_symlink() {
            continue;
        }
        let name = entry.file_name().to_string_lossy().to_lowercase();
        if SKIP_DIRS.contains(&name.as_str()) || name.starts_with('.') {
            continue;
        }
        walk(&entry.path(), depth - 1, found);
    }
}

/// Где искать: обычное место установки, папки пользователя и корни дисков (копию часто кладут в D:\Программы\…).
fn search_roots() -> Vec<PathBuf> {
    let mut roots = Vec::new();
    if let Some(profile) = std::env::var_os("USERPROFILE").map(PathBuf::from) {
        roots.push(profile.clone());
        for sub in ["Desktop", "Downloads", "Documents", "OneDrive", r"OneDrive\Desktop", r"OneDrive\Рабочий стол"] {
            roots.push(profile.join(sub));
        }
    }
    for letter in b'C'..=b'Z' {
        let root = PathBuf::from(format!("{}:\\", letter as char));
        if is_fixed_drive(&root) {
            roots.push(root);
        }
    }
    roots
}

/// Только локальные диски: сетевой или пустой картридер может подвесить поиск на минуты.
#[cfg(windows)]
fn is_fixed_drive(root: &Path) -> bool {
    use windows::core::HSTRING;
    use windows::Win32::Storage::FileSystem::GetDriveTypeW;
    const DRIVE_FIXED: u32 = 3;
    unsafe { GetDriveTypeW(&HSTRING::from(root.as_os_str())) == DRIVE_FIXED }
}

#[cfg(not(windows))]
fn is_fixed_drive(root: &Path) -> bool {
    root.is_dir()
}

#[tauri::command(async)]
pub fn find_installs() -> Vec<InstallInfo> {
    let current = current_root();
    let mut found = Vec::new();
    if let Some(standard) = standard_root() {
        if is_install(&standard) {
            found.push(standard);
        }
    }
    if let Some(c) = &current {
        found.push(c.clone());
    }
    for root in search_roots() {
        walk(&root, SCAN_DEPTH, &mut found);
    }
    let mut unique: Vec<PathBuf> = Vec::new();
    for dir in found {
        if !unique.iter().any(|d| same_path(d, &dir)) {
            unique.push(dir);
        }
    }
    *last_scan().lock().unwrap() = unique.clone();
    let mut out: Vec<InstallInfo> = unique.iter().map(|d| describe(d, current.as_deref())).collect();
    out.sort_by(|a, b| b.current.cmp(&a.current).then(b.standard.cmp(&a.standard)).then(a.path.cmp(&b.path)));
    out
}

/// Цель ярлыка .lnk (через IShellLinkW) — чтобы убрать ярлыки, ведущие в удалённую копию.
#[cfg(windows)]
fn lnk_target(lnk: &Path) -> Option<PathBuf> {
    use windows::core::{Interface, HSTRING};
    use windows::Win32::System::Com::{CoCreateInstance, CoInitializeEx, IPersistFile, CLSCTX_INPROC_SERVER, COINIT_APARTMENTTHREADED, STGM_READ};
    use windows::Win32::UI::Shell::{IShellLinkW, ShellLink, SLGP_RAWPATH};

    unsafe {
        let _ = CoInitializeEx(None, COINIT_APARTMENTTHREADED);
        let link: IShellLinkW = CoCreateInstance(&ShellLink, None, CLSCTX_INPROC_SERVER).ok()?;
        link.cast::<IPersistFile>().ok()?.Load(&HSTRING::from(lnk.as_os_str()), STGM_READ).ok()?;
        let mut buf = [0u16; 1024];
        link.GetPath(&mut buf, std::ptr::null_mut(), SLGP_RAWPATH.0 as u32).ok()?;
        let len = buf.iter().position(|&c| c == 0).unwrap_or(buf.len());
        let text = String::from_utf16_lossy(&buf[..len]);
        (!text.is_empty()).then(|| PathBuf::from(text))
    }
}

#[cfg(not(windows))]
fn lnk_target(_lnk: &Path) -> Option<PathBuf> {
    None
}

fn shortcut_dirs() -> Vec<PathBuf> {
    let mut dirs = Vec::new();
    if let Some(profile) = std::env::var_os("USERPROFILE").map(PathBuf::from) {
        dirs.push(profile.join("Desktop"));
        dirs.push(profile.join(r"OneDrive\Desktop"));
        dirs.push(profile.join(r"OneDrive\Рабочий стол"));
    }
    if let Some(appdata) = std::env::var_os("APPDATA").map(PathBuf::from) {
        dirs.push(appdata.join(r"Microsoft\Windows\Start Menu"));
        dirs.push(appdata.join(r"Microsoft\Windows\Start Menu\Programs"));
    }
    dirs
}

/// Ярлыки «Project Desktop», ведущие внутрь dir. Возвращает, сколько убрано.
fn remove_shortcuts_into(dir: &Path) -> usize {
    let prefix = dir.to_string_lossy().to_lowercase();
    let mut removed = 0;
    for folder in shortcut_dirs() {
        let Ok(entries) = std::fs::read_dir(&folder) else { continue };
        for entry in entries.flatten() {
            let path = entry.path();
            if !path.extension().map(|e| e.eq_ignore_ascii_case("lnk")).unwrap_or(false) {
                continue;
            }
            let Some(target) = lnk_target(&path) else { continue };
            if target.to_string_lossy().to_lowercase().starts_with(&prefix) && std::fs::remove_file(&path).is_ok() {
                removed += 1;
            }
        }
    }
    removed
}

/// Убирает копию программы. Только из последнего поиска (find_installs) и никогда — запущенную.
/// Папку сначала переименовываем: если та копия сейчас открыта, Windows не даст — и мы ничего не испортим.
#[tauri::command(async)]
pub fn remove_install(path: String) -> Result<usize, String> {
    let dir = PathBuf::from(&path);
    if !last_scan().lock().unwrap().iter().any(|d| same_path(d, &dir)) {
        return Err("Эта папка не из списка найденных копий — обновите список.".into());
    }
    if current_root().map(|c| same_path(&c, &dir)).unwrap_or(false) {
        return Err("Это копия, которая запущена сейчас, — её не удалить изнутри.".into());
    }
    if !is_install(&dir) {
        return Err("В папке уже нет программы.".into());
    }
    let parked = dir.with_file_name(format!(
        "{}.removing-{}",
        dir.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_else(|| "ProjectDesktop".into()),
        std::process::id()
    ));
    std::fs::rename(&dir, &parked)
        .map_err(|e| format!("Папка занята — закройте ту копию программы (трей → Выход) и повторите. ({e})"))?;
    let shortcuts = remove_shortcuts_into(&dir);
    std::fs::remove_dir_all(&parked).map_err(|e| format!("Копия отключена, но удалена не до конца: {e}"))?;
    log::info!("Удалена старая копия программы: {} (ярлыков убрано: {shortcuts})", dir.display());
    last_scan().lock().unwrap().retain(|d| !same_path(d, &dir));
    Ok(shortcuts)
}

/// Недокачанные пакеты обновления (*.partial) мешают следующей закачке — убираем их при каждом запуске
/// (в этот момент закачка точно не идёт).
pub fn drop_partial_packages(packages_dir: &Path) {
    let Ok(entries) = std::fs::read_dir(packages_dir) else { return };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().map(|e| e.eq_ignore_ascii_case("partial")).unwrap_or(false) {
            match std::fs::remove_file(&path) {
                Ok(()) => log::info!("Удалён недокачанный пакет обновления: {}", path.display()),
                Err(e) => log::warn!("Не удалось удалить {}: {e}", path.display()),
            }
        }
    }
}

/// Скачивает установщик и ставит программу начисто в обычное место (%LOCALAPPDATA%\ProjectDesktop): Setup.exe
/// Velopack ставит поверх зависшей установки, создаёт ярлыки и запускает программу. Прогресс — "update-progress".
pub async fn download_setup(app: &tauri::AppHandle, urls: &[(String, String)]) -> Result<PathBuf, String> {
    let client = reqwest::Client::builder()
        .connect_timeout(std::time::Duration::from_secs(20))
        .user_agent("ProjectDesktop updater")
        .build()
        .map_err(|e| e.to_string())?;
    let target = std::env::temp_dir().join(format!("ProjectDesktop-Setup-{}.exe", std::process::id()));
    let mut errors = Vec::new();
    for (label, url) in urls {
        let _ = app.emit("update-source", label.clone());
        match fetch(&client, url, &target, app).await {
            Ok(()) => return Ok(target),
            Err(e) => {
                log::warn!("reinstall: {label}: {e}");
                errors.push(format!("{label}: {e}"));
            }
        }
    }
    Err(format!("Установщик не скачался ({}).", errors.join("; ")))
}

async fn fetch(client: &reqwest::Client, url: &str, target: &Path, app: &tauri::AppHandle) -> Result<(), String> {
    use std::io::Write;
    let mut response = client.get(url).send().await.map_err(|e| e.to_string())?;
    if !response.status().is_success() {
        return Err(format!("ответ {}", response.status()));
    }
    let total = response.content_length().unwrap_or(0);
    let mut file = std::fs::File::create(target).map_err(|e| e.to_string())?;
    let mut got: u64 = 0;
    let mut last_pct = -1i16;
    while let Some(chunk) = response.chunk().await.map_err(|e| e.to_string())? {
        file.write_all(&chunk).map_err(|e| e.to_string())?;
        got += chunk.len() as u64;
        if total > 0 {
            let pct = (got * 100 / total) as i16;
            if pct != last_pct {
                last_pct = pct;
                let _ = app.emit("update-progress", pct);
            }
        }
    }
    if total > 0 && got != total {
        return Err(format!("скачано {got} из {total} байт"));
    }
    Ok(())
}
