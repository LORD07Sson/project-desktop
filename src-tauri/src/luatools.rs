// LuaTools интеграция: нахождение Steam, парсинг/установка lua-файлов,
// скачивание манифестов через lua.tools API.

use std::io::{Read, Write};
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use tauri::Emitter;

// ── Steam detection ─────────────────────────────────────────────────

fn steam_path_from_registry() -> Option<String> {
    use std::sync::Mutex;
    use std::time::{Duration, Instant};
    static CACHE: Mutex<Option<(Instant, Option<String>)>> = Mutex::new(None);
    if let Ok(g) = CACHE.lock() {
        if let Some((at, v)) = g.as_ref() {
            if at.elapsed() < Duration::from_secs(30) { return v.clone(); }
        }
    }
    let v = steam_path_from_registry_uncached();
    if let Ok(mut g) = CACHE.lock() { *g = Some((Instant::now(), v.clone())); }
    v
}

fn steam_path_from_registry_uncached() -> Option<String> {
    #[cfg(windows)]
    {
        use windows::Win32::System::Registry::*;

        let locations: &[(HKEY, &str, &str)] = &[
            (HKEY_CURRENT_USER, r"SOFTWARE\Valve\Steam", "SteamPath"),
            (HKEY_LOCAL_MACHINE, r"SOFTWARE\WOW6432Node\Valve\Steam", "InstallPath"),
            (HKEY_LOCAL_MACHINE, r"SOFTWARE\Valve\Steam", "InstallPath"),
        ];

        for &(root, sub, val_name) in locations {
            let sub_w: Vec<u16> = sub.encode_utf16().chain(std::iter::once(0)).collect();
            let val_w: Vec<u16> = val_name.encode_utf16().chain(std::iter::once(0)).collect();
            let mut key = HKEY::default();
            let status = unsafe {
                RegOpenKeyExW(root, windows::core::PCWSTR(sub_w.as_ptr()), Some(0), KEY_READ, &mut key)
            };
            if status.is_err() {
                continue;
            }
            let mut buf = [0u16; 1024];
            let mut size = (buf.len() * 2) as u32;
            let mut kind = REG_VALUE_TYPE(0);
            let read = unsafe {
                RegQueryValueExW(
                    key,
                    windows::core::PCWSTR(val_w.as_ptr()),
                    None,
                    Some(&mut kind),
                    Some(buf.as_mut_ptr() as *mut u8),
                    Some(&mut size),
                )
            };
            unsafe { let _ = RegCloseKey(key); }
            if read.is_ok() && kind == REG_SZ {
                let len = (size as usize / 2).saturating_sub(1);
                let raw = String::from_utf16_lossy(&buf[..len]);
                let normalized = raw.trim().replace('/', "\\");
                let exe = PathBuf::from(&normalized).join("steam.exe");
                if exe.exists() {
                    return Some(normalized);
                }
            }
        }
    }
    None
}

#[derive(Serialize)]
pub struct SteamInfo {
    pub path: Option<String>,
    pub stplugin_dir: Option<String>,
    pub depotcache_dir: Option<String>,
    pub running: bool,
}

fn stplugin_dir(steam: &str) -> PathBuf {
    PathBuf::from(steam).join("config").join("stplug-in")
}

// Genuine Windows system DLLs of these names are usually well over 2 MB;
// a hijack DLL dropped next to steam.exe is typically 50–300 KB.
// This heuristic avoids flagging Steam's own distribution DLLs as "unlocker installed".
fn is_small_hijack_dll(p: &Path) -> bool {
    std::fs::metadata(p).map(|m| m.len() < 2_000_000).unwrap_or(false)
}

fn depotcache_dir(steam: &str) -> PathBuf {
    PathBuf::from(steam).join("depotcache")
}

#[tauri::command]
pub fn lt_steam_info() -> SteamInfo {
    let path = steam_path_from_registry();
    let running = is_steam_running();
    SteamInfo {
        stplugin_dir: path.as_ref().map(|p| stplugin_dir(p).to_string_lossy().into_owned()),
        depotcache_dir: path.as_ref().map(|p| depotcache_dir(p).to_string_lossy().into_owned()),
        path,
        running,
    }
}

fn is_steam_running() -> bool {
    #[cfg(windows)]
    {
        use std::process::Command;
        Command::new("tasklist")
            .args(["/FI", "IMAGENAME eq steam.exe", "/NH"])
            .output()
            .map(|o| String::from_utf8_lossy(&o.stdout).contains("steam.exe"))
            .unwrap_or(false)
    }
    #[cfg(not(windows))]
    {
        false
    }
}

// ── Installed lua listing ───────────────────────────────────────────

#[derive(Serialize)]
pub struct InstalledLua {
    pub app_id: u64,
    pub path: String,
    pub modified: u64,
}

#[tauri::command]
pub fn lt_list_installed() -> Result<Vec<InstalledLua>, String> {
    let steam = steam_path_from_registry().ok_or("Steam не найден")?;
    let dir = stplugin_dir(&steam);
    if !dir.exists() {
        return Ok(vec![]);
    }
    let mut result = vec![];
    for entry in std::fs::read_dir(&dir).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        let name = entry.file_name();
        let name_str = name.to_string_lossy();
        if !name_str.ends_with(".lua") {
            continue;
        }
        let stem = name_str.trim_end_matches(".lua");
        if let Ok(app_id) = stem.parse::<u64>() {
            let modified = entry
                .metadata()
                .and_then(|m| m.modified())
                .ok()
                .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                .map(|d| d.as_secs())
                .unwrap_or(0);
            result.push(InstalledLua {
                app_id,
                path: entry.path().to_string_lossy().into_owned(),
                modified,
            });
        }
    }
    result.sort_by(|a, b| b.modified.cmp(&a.modified));
    Ok(result)
}

// ── Read lua contents ───────────────────────────────────────────────

#[tauri::command]
pub fn lt_read_lua(app_id: u64) -> Result<String, String> {
    let steam = steam_path_from_registry().ok_or("Steam не найден")?;
    let path = stplugin_dir(&steam).join(format!("{app_id}.lua"));
    std::fs::read_to_string(&path).map_err(|e| format!("{path:?}: {e}"))
}

// ── Install lua/manifest from downloaded data ───────────────────────

#[derive(Serialize)]
pub struct InstallResult {
    pub lua_installed: bool,
    pub manifest_count: u32,
    pub failed: Vec<String>,
}

#[tauri::command]
pub fn lt_install_file(path: String, app_id: u64, auto_update: bool) -> Result<InstallResult, String> {
    let steam = steam_path_from_registry().ok_or("Steam не найден")?;
    let ext = Path::new(&path)
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_lowercase();
    match ext.as_str() {
        "lua" => {
            let id = if app_id != 0 { app_id } else { app_id_from_name(&path).ok_or("Не удалось определить AppID: назовите файл <AppID>.lua")? };
            install_lua(&steam, &path, id, auto_update)
        }
        "manifest" => install_manifest(&steam, &path),
        "zip" => install_zip(&steam, &path, app_id, auto_update),
        _ => Err(format!("Неизвестный тип файла: .{ext}")),
    }
}

/// `C:\x\12345.lua` / `dir/12345.lua` → 12345.
fn app_id_from_name(path: &str) -> Option<u64> {
    let fname = path.rsplit(['/', '\\']).next()?;
    let stem = fname.split('.').next()?;
    stem.parse::<u64>().ok().filter(|&id| id != 0)
}

/// Активная (не закомментированная) строка `setManifestid` — без учёта регистра.
fn has_active_pin(lua: &str) -> bool {
    lua.lines().any(|l| {
        let t = l.trim_start();
        !t.starts_with("--") && t.to_lowercase().contains("setmanifestid")
    })
}

fn comment_out_manifest_pins(lua: &str) -> String {
    lua.lines()
        .map(|line| {
            let trimmed = line.trim_start();
            if trimmed.starts_with("--") {
                return line.to_string();
            }
            if trimmed.to_lowercase().contains("setmanifestid") {
                let indent_len = line.len() - trimmed.len();
                format!("{}-- {}", &line[..indent_len], trimmed)
            } else {
                line.to_string()
            }
        })
        .collect::<Vec<_>>()
        .join("\n")
}

fn install_lua(steam: &str, src: &str, app_id: u64, auto_update: bool) -> Result<InstallResult, String> {
    let dir = stplugin_dir(steam);
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let dest = dir.join(format!("{app_id}.lua"));
    vault_capture(steam, app_id, "auto");
    let content = std::fs::read_to_string(src).map_err(|e| e.to_string())?;
    let final_content = if auto_update { comment_out_manifest_pins(&content) } else { content };
    std::fs::write(&dest, &final_content).map_err(|e| e.to_string())?;
    stamp_now(&dest);
    Ok(InstallResult { lua_installed: true, manifest_count: 0, failed: vec![] })
}

fn install_manifest(steam: &str, src: &str) -> Result<InstallResult, String> {
    let dir = depotcache_dir(steam);
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let name = Path::new(src).file_name().ok_or("Нет имени файла")?.to_string_lossy().into_owned();
    let dest = dir.join(&name);
    if !dest.exists() {
        std::fs::copy(src, &dest).map_err(|e| e.to_string())?;
        stamp_now(&dest);
    }
    Ok(InstallResult { lua_installed: false, manifest_count: 1, failed: vec![] })
}

fn install_zip(steam: &str, zip_path: &str, app_id: u64, auto_update: bool) -> Result<InstallResult, String> {
    let file = std::fs::File::open(zip_path).map_err(|e| e.to_string())?;
    let mut archive = zip::ZipArchive::new(file).map_err(|e| e.to_string())?;

    let plug_dir = stplugin_dir(steam);
    let depot_dir = depotcache_dir(steam);
    std::fs::create_dir_all(&plug_dir).map_err(|e| e.to_string())?;
    std::fs::create_dir_all(&depot_dir).map_err(|e| e.to_string())?;

    let mut lua_installed = false;
    let mut manifest_count = 0u32;
    let mut failed = vec![];

    for i in 0..archive.len() {
        let mut entry = match archive.by_index(i) {
            Ok(e) => e,
            Err(_) => continue,
        };
        let name = entry.name().to_string();
        let lower = name.to_lowercase();

        if lower.ends_with(".lua") {
            // AppID берём из аргумента, иначе из имени файла (`<appid>.lua`).
            let lua_id = if app_id != 0 { app_id } else { app_id_from_name(&name).unwrap_or(0) };
            if lua_id == 0 { failed.push(format!("{name}: не удалось определить AppID")); continue; }
            let tmp = std::env::temp_dir().join(format!("lt_{}.lua", lua_id));
            match extract_entry(&mut entry, &tmp) {
                Ok(()) => {
                    match install_lua(steam, &tmp.to_string_lossy(), lua_id, auto_update) {
                        Ok(_) => lua_installed = true,
                        Err(_) => failed.push(name),
                    }
                    let _ = std::fs::remove_file(&tmp);
                }
                Err(_) => failed.push(name),
            }
        } else if lower.ends_with(".manifest") {
            let fname = match zip_entry_dest(Path::new(""), &entry).and_then(|(p, _)| p.file_name().map(|f| f.to_owned())) {
                Some(f) => f,
                None => { failed.push(name); continue; }
            };
            let dest = depot_dir.join(&fname);
            if dest.exists() {
                manifest_count += 1;
                continue;
            }
            match extract_entry(&mut entry, &dest) {
                Ok(()) => {
                    stamp_now(&dest);
                    manifest_count += 1;
                }
                Err(_) => failed.push(name),
            }
        }
    }

    Ok(InstallResult { lua_installed, manifest_count, failed })
}

fn extract_entry(entry: &mut zip::read::ZipFile<'_, impl std::io::Read>, dest: &Path) -> Result<(), String> {
    let mut buf = Vec::new();
    entry.read_to_end(&mut buf).map_err(|e| e.to_string())?;
    if let Some(parent) = dest.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let mut f = std::fs::File::create(dest).map_err(|e| e.to_string())?;
    f.write_all(&buf).map_err(|e| e.to_string())?;
    Ok(())
}

/// Путь записи zip-элемента внутри `base`: отбрасывает абсолютные пути и `..`
/// (zip-slip), чтобы архив не мог писать за пределы целевой папки.
fn zip_entry_dest<R: std::io::Read>(base: &Path, entry: &zip::read::ZipFile<'_, R>) -> Option<(PathBuf, String)> {
    let rel = entry.enclosed_name()?;
    if rel.as_os_str().is_empty() { return None; }
    let rel_str = rel.to_string_lossy().replace('\\', "/");
    Some((base.join(&rel), rel_str))
}

fn stamp_now(path: &Path) {
    let _ = filetime::set_file_mtime(path, filetime::FileTime::now());
}

// ── Remove installed lua ────────────────────────────────────────────

#[tauri::command]
pub fn lt_remove_lua(app_id: u64) -> Result<(), String> {
    let steam = steam_path_from_registry().ok_or("Steam не найден")?;
    let path = stplugin_dir(&steam).join(format!("{app_id}.lua"));
    if path.exists() {
        vault_capture(&steam, app_id, "before-remove");
        std::fs::remove_file(&path).map_err(|e| e.to_string())?;
    }
    Ok(())
}

// ── Write lua contents ─────────────────────────────────────────────

#[tauri::command]
pub fn lt_write_lua(app_id: u64, content: String) -> Result<(), String> {
    let steam = steam_path_from_registry().ok_or("Steam не найден")?;
    let dir = stplugin_dir(&steam);
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let dest = dir.join(format!("{app_id}.lua"));
    vault_capture(&steam, app_id, "before-edit");
    std::fs::write(&dest, &content).map_err(|e| e.to_string())?;
    stamp_now(&dest);
    Ok(())
}

// ── Plugin status ──────────────────────────────────────────────────

#[derive(Serialize)]
pub struct PluginStatus {
    pub installed: bool,
    pub version: Option<String>,
    pub dll_path: Option<String>,
    pub mode: Option<String>,
}

#[tauri::command]
pub fn lt_plugin_status() -> PluginStatus {
    let steam = match steam_path_from_registry() {
        Some(p) => p,
        None => return PluginStatus { installed: false, version: None, dll_path: None, mode: None },
    };
    // Prefer our own manifest written by extract_unlocker_zip — authoritative source.
    if let Some(mf) = read_mode_manifest(&steam) {
        let files = mf["files"].as_array().cloned().unwrap_or_default();
        let any_exists = files.iter().any(|v| v.as_str().map(|p| Path::new(p).exists()).unwrap_or(false));
        if any_exists {
            let dll_path = files.iter().find_map(|v| v.as_str().filter(|p| Path::new(p).exists()).map(String::from));
            let all_exist = files.iter().all(|v| v.as_str().map(|p| Path::new(p).exists()).unwrap_or(false));
            // OpenSteamTool/BST need their payload DLL next to the loaders — older
            // versions of this app installed only dwmapi.dll, which loads nothing.
            let is_ost = matches!(mf["mode"].as_str(), Some("BetterSteamTools") | Some("stplug-in"));
            let has_payload = !is_ost || ["OpenSteamTool.dll", "BetterSteamTools.dll"].iter()
                .any(|n| PathBuf::from(&steam).join(n).exists())
                || stplugin_dir(&steam).join("stplug-in.dll").exists();
            let complete = all_exist && has_payload;
            let mode = mf["mode"].as_str().map(|m| if complete { m.to_string() } else { format!("{m} (неполная установка — переустановите)") });
            return PluginStatus {
                installed: complete,
                version: mf["version"].as_str().map(String::from),
                dll_path,
                mode,
            };
        }
    }
    // Fallback: heuristic detection for pre-manifest or externally-installed plugins.
    let sp = stplugin_dir(&steam);
    let stplug_dll = sp.join("stplug-in.dll");
    let stplug_dll64 = sp.join("stplug-in64.dll");
    let bst_dll = ["BetterSteamTools.dll", "OpenSteamTool.dll"].iter()
        .map(|n| PathBuf::from(&steam).join(n)).find(|p| p.exists())
        .unwrap_or_else(|| PathBuf::from(&steam).join("BetterSteamTools.dll"));
    let hijack_candidates = ["user32.dll", "dwmapi.dll", "xinput1_4.dll", "version.dll", "winmm.dll"];
    let hijack_dll = hijack_candidates.iter()
        .map(|n| PathBuf::from(&steam).join(n))
        .find(|p| p.exists() && is_small_hijack_dll(p));
    let mode = if bst_dll.exists() { Some("BetterSteamTools".into()) }
        else if stplug_dll.exists() || stplug_dll64.exists() { Some("stplug-in".into()) }
        else if hijack_dll.is_some() { Some("unlocker (внешний)".into()) }
        else { None };
    let installed = mode.is_some();
    let dll_path = if bst_dll.exists() { Some(bst_dll.to_string_lossy().into_owned()) }
        else if stplug_dll.exists() { Some(stplug_dll.to_string_lossy().into_owned()) }
        else if stplug_dll64.exists() { Some(stplug_dll64.to_string_lossy().into_owned()) }
        else { hijack_dll.as_ref().map(|p| p.to_string_lossy().into_owned()) };
    // No real version for externally-installed DLLs — show the file date instead.
    let version = dll_path.as_ref().and_then(|p| {
        let modified = std::fs::metadata(p).ok()?.modified().ok()?;
        let secs = modified.duration_since(std::time::UNIX_EPOCH).ok()?.as_secs() as i64;
        let (y, m, d) = civil_from_days(secs.div_euclid(86400));
        Some(format!("от {d:02}.{m:02}.{y}"))
    });
    PluginStatus { installed, version, dll_path, mode }
}

/// Days since 1970-01-01 → (year, month, day), proleptic Gregorian (H. Hinnant).
fn civil_from_days(z: i64) -> (i64, u32, u32) {
    let z = z + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let m = (if mp < 10 { mp + 3 } else { mp - 9 }) as u32;
    let y = yoe + era * 400 + if m <= 2 { 1 } else { 0 };
    (y, m, d)
}

// ── Restart Steam ──────────────────────────────────────────────────

#[tauri::command]
pub async fn lt_restart_steam() -> Result<(), String> {
    #[cfg(windows)]
    {
        let steam = steam_path_from_registry().ok_or("Steam не найден")?;
        let exe = PathBuf::from(&steam).join("steam.exe");
        if !exe.exists() {
            return Err("steam.exe не найден".into());
        }
        stop_steam().await;
        start_steam(&steam);
        Ok(())
    }
    #[cfg(not(windows))]
    Err("Поддерживается только Windows".into())
}

// ── List manifest files ────────────────────────────────────────────

#[derive(Serialize)]
pub struct ManifestFile {
    pub name: String,
    pub depot_id: u64,
    pub size: u64,
    pub modified: u64,
}

#[tauri::command]
pub fn lt_list_manifests() -> Result<Vec<ManifestFile>, String> {
    let steam = steam_path_from_registry().ok_or("Steam не найден")?;
    let dir = depotcache_dir(&steam);
    if !dir.exists() { return Ok(vec![]); }
    let mut result = vec![];
    for entry in std::fs::read_dir(&dir).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        let name = entry.file_name().to_string_lossy().into_owned();
        if !name.ends_with(".manifest") { continue; }
        let parts: Vec<&str> = name.trim_end_matches(".manifest").split('_').collect();
        let depot_id = parts.first().and_then(|s| s.parse().ok()).unwrap_or(0);
        let meta = entry.metadata().ok();
        let size = meta.as_ref().map(|m| m.len()).unwrap_or(0);
        let modified = meta.and_then(|m| m.modified().ok())
            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|d| d.as_secs())
            .unwrap_or(0);
        result.push(ManifestFile { name, depot_id, size, modified });
    }
    result.sort_by(|a, b| b.modified.cmp(&a.modified));
    Ok(result)
}

// ── Game install path from Steam libraryfolders.vdf ────────────────

fn steam_library_folders(steam: &str) -> Vec<String> {
    let vdf = PathBuf::from(steam).join("steamapps").join("libraryfolders.vdf");
    let content = match std::fs::read_to_string(&vdf) {
        Ok(c) => c,
        Err(_) => return vec![steam.to_string()],
    };
    let mut folders = vec![steam.to_string()];
    for line in content.lines() {
        let trimmed = line.trim();
        if trimmed.starts_with("\"path\"") {
            if let Some(val) = trimmed.split('"').nth(3) {
                let p = val.replace("\\\\", "\\");
                if !folders.iter().any(|f| f.eq_ignore_ascii_case(&p)) {
                    folders.push(p);
                }
            }
        }
    }
    folders
}

#[derive(Serialize)]
pub struct GameInstallInfo {
    pub installed: bool,
    pub path: Option<String>,
    pub size_on_disk: u64,
}

#[tauri::command]
pub fn lt_game_install_path(app_id: u64) -> GameInstallInfo {
    let steam = match steam_path_from_registry() {
        Some(p) => p,
        None => return GameInstallInfo { installed: false, path: None, size_on_disk: 0 },
    };
    for lib in steam_library_folders(&steam) {
        let acf = PathBuf::from(&lib).join("steamapps").join(format!("appmanifest_{app_id}.acf"));
        if !acf.exists() { continue; }
        let content = match std::fs::read_to_string(&acf) { Ok(c) => c, Err(_) => continue };
        let mut install_dir = None;
        let mut size = 0u64;
        for line in content.lines() {
            let t = line.trim();
            if t.starts_with("\"installdir\"") {
                install_dir = t.split('"').nth(3).map(|s| s.to_string());
            }
            if t.starts_with("\"SizeOnDisk\"") {
                size = t.split('"').nth(3).and_then(|s| s.parse().ok()).unwrap_or(0);
            }
        }
        if let Some(dir) = install_dir {
            let full = PathBuf::from(&lib).join("steamapps").join("common").join(&dir);
            if full.exists() {
                return GameInstallInfo { installed: true, path: Some(full.to_string_lossy().into_owned()), size_on_disk: size };
            }
        }
    }
    GameInstallInfo { installed: false, path: None, size_on_disk: 0 }
}

// ── Apply / revert Denuvo fix ──────────────────────────────────────

fn fix_backup_dir(steam: &str, app_id: u64) -> PathBuf {
    PathBuf::from(steam).join("config").join("stplug-in").join("fix_backups").join(app_id.to_string())
}

#[derive(Serialize)]
pub struct FixApplyResult {
    pub files_extracted: u32,
    pub backup_created: bool,
}

#[tauri::command]
pub fn lt_apply_fix(app_id: u64, zip_path: String) -> Result<FixApplyResult, String> {
    let steam = steam_path_from_registry().ok_or("Steam не найден")?;
    let game = lt_game_install_path(app_id);
    let game_path = game.path.ok_or("Игра не установлена")?;

    let backup_dir = fix_backup_dir(&steam, app_id);
    std::fs::create_dir_all(&backup_dir).map_err(|e| e.to_string())?;
    let manifest_path = backup_dir.join("_manifest.txt");

    // Повторное применение: файлы, уже записанные прошлым фиксом, остаются в
    // манифесте, а их бэкап (оригинал) НЕ перезаписывается пропатченной копией.
    let mut manifest: Vec<String> = std::fs::read_to_string(&manifest_path)
        .map(|s| s.lines().map(|l| l.trim().to_string()).filter(|l| !l.is_empty()).collect())
        .unwrap_or_default();

    let file = std::fs::File::open(&zip_path).map_err(|e| e.to_string())?;
    let mut archive = zip::ZipArchive::new(file).map_err(|e| e.to_string())?;
    let game_root = PathBuf::from(&game_path);

    let mut extracted = 0u32;
    let mut backed_up = false;
    let mut errors: Vec<String> = Vec::new();

    for i in 0..archive.len() {
        let mut entry = match archive.by_index(i) { Ok(e) => e, Err(e) => { errors.push(e.to_string()); continue } };
        if entry.is_dir() { continue; }
        let Some((dest, name)) = zip_entry_dest(&game_root, &entry) else {
            errors.push(format!("{}: недопустимый путь", entry.name()));
            continue;
        };
        let already_tracked = manifest.iter().any(|m| m == &name);
        let bak = backup_dir.join(&name);
        if dest.exists() && !already_tracked && !bak.exists() {
            if let Some(p) = bak.parent() { std::fs::create_dir_all(p).map_err(|e| e.to_string())?; }
            // Без бэкапа оригинал не трогаем — иначе откат станет невозможен.
            if let Err(e) = std::fs::copy(&dest, &bak) {
                errors.push(format!("{name}: бэкап не создан ({e})"));
                continue;
            }
            backed_up = true;
        }
        if !already_tracked { manifest.push(name.clone()); }
        match extract_entry(&mut entry, &dest) {
            Ok(()) => extracted += 1,
            Err(e) => errors.push(format!("{name}: {e}")),
        }
    }

    std::fs::write(&manifest_path, manifest.join("\n")).map_err(|e| e.to_string())?;

    if !errors.is_empty() {
        return Err(format!("Распаковано {extracted}, ошибки:\n{}", errors.join("\n")));
    }
    Ok(FixApplyResult { files_extracted: extracted, backup_created: backed_up })
}

#[tauri::command]
pub fn lt_revert_fix(app_id: u64) -> Result<u32, String> {
    let steam = steam_path_from_registry().ok_or("Steam не найден")?;
    let game = lt_game_install_path(app_id);
    let game_path = game.path.ok_or("Игра не установлена")?;
    let backup_dir = fix_backup_dir(&steam, app_id);

    let manifest_path = backup_dir.join("_manifest.txt");
    if !manifest_path.exists() { return Err("Нет бэкапа для отката".into()); }

    let manifest = std::fs::read_to_string(&manifest_path).map_err(|e| e.to_string())?;
    let mut reverted = 0u32;
    let mut errors: Vec<String> = Vec::new();

    for line in manifest.lines() {
        let line = line.trim();
        if line.is_empty() { continue; }
        // Манифест лежит на диске — не доверяем ему пути с `..`.
        let rel = Path::new(line);
        if rel.is_absolute() || rel.components().any(|c| !matches!(c, std::path::Component::Normal(_))) {
            errors.push(format!("{line}: недопустимый путь"));
            continue;
        }
        let game_file = PathBuf::from(&game_path).join(rel);
        let backup_file = backup_dir.join(rel);
        let res = if backup_file.exists() {
            std::fs::copy(&backup_file, &game_file).map(|_| ())
        } else if game_file.exists() {
            std::fs::remove_file(&game_file)
        } else { continue };
        match res {
            Ok(()) => reverted += 1,
            Err(e) => errors.push(format!("{line}: {e}")),
        }
    }

    if !errors.is_empty() {
        // Бэкап не удаляем — откат можно повторить (например, после закрытия игры).
        return Err(format!("Откачено {reverted}, ошибки:\n{}", errors.join("\n")));
    }
    let _ = std::fs::remove_dir_all(&backup_dir);
    Ok(reverted)
}

#[tauri::command]
pub fn lt_has_fix_backup(app_id: u64) -> bool {
    let steam = match steam_path_from_registry() { Some(p) => p, None => return false };
    fix_backup_dir(&steam, app_id).join("_manifest.txt").exists()
}

// ── Lua variants (presets/builds) ──────────────────────────────────

fn variants_dir(steam: &str, app_id: u64) -> PathBuf {
    PathBuf::from(steam).join("config").join("stplug-in").join("variants").join(app_id.to_string())
}

#[derive(Serialize)]
pub struct LuaVariant {
    pub name: String,
    pub hash: String,
    pub modified: u64,
    pub depot_count: u32,
    pub dlc_count: u32,
    pub is_pinned: bool,
}

fn short_hash(content: &str) -> String {
    use std::collections::hash_map::DefaultHasher;
    use std::hash::{Hash, Hasher};
    let mut h = DefaultHasher::new();
    content.hash(&mut h);
    format!("{:08x}", h.finish() & 0xFFFFFFFF)
}

fn count_lua_stats(content: &str) -> (u32, u32, bool) {
    let mut depots = 0u32;
    let mut dlcs = 0u32;
    let mut pinned = false;
    let mut first = true;
    for line in content.lines() {
        let t = line.trim();
        if t.starts_with("--") { continue; }
        let lower = t.to_lowercase();
        if lower.contains("addappid") {
            if first { first = false; continue; }
            if t.contains('"') { depots += 1; } else { dlcs += 1; }
        }
        if lower.contains("setmanifestid") && !t.starts_with("--") {
            pinned = true;
        }
    }
    (depots, dlcs, pinned)
}

#[tauri::command]
pub fn lt_list_variants(app_id: u64) -> Result<Vec<LuaVariant>, String> {
    let steam = steam_path_from_registry().ok_or("Steam не найден")?;
    let dir = variants_dir(&steam, app_id);
    if !dir.exists() { return Ok(vec![]); }
    let mut result = vec![];
    for entry in std::fs::read_dir(&dir).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        let fname = entry.file_name().to_string_lossy().into_owned();
        if !fname.ends_with(".lua") { continue; }
        let name = fname.trim_end_matches(".lua").to_string();
        let content = std::fs::read_to_string(entry.path()).unwrap_or_default();
        let hash = short_hash(&content);
        let (dc, dlc, pinned) = count_lua_stats(&content);
        let modified = entry.metadata().ok()
            .and_then(|m| m.modified().ok())
            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|d| d.as_secs()).unwrap_or(0);
        result.push(LuaVariant { name, hash, modified, depot_count: dc, dlc_count: dlc, is_pinned: pinned });
    }
    result.sort_by(|a, b| b.modified.cmp(&a.modified));
    Ok(result)
}

#[tauri::command]
pub fn lt_save_variant(app_id: u64, name: String) -> Result<(), String> {
    let steam = steam_path_from_registry().ok_or("Steam не найден")?;
    let lua_path = stplugin_dir(&steam).join(format!("{app_id}.lua"));
    if !lua_path.exists() { return Err("Lua-файл не найден".into()); }
    let dir = variants_dir(&steam, app_id);
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let safe_name: String = name.chars().map(|c| if c.is_alphanumeric() || c == '-' || c == '_' { c } else { '_' }).collect();
    let dest = dir.join(format!("{safe_name}.lua"));
    std::fs::copy(&lua_path, &dest).map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn lt_load_variant(app_id: u64, name: String) -> Result<(), String> {
    let steam = steam_path_from_registry().ok_or("Steam не найден")?;
    let safe_name: String = name.chars().map(|c| if c.is_alphanumeric() || c == '-' || c == '_' { c } else { '_' }).collect();
    let variant_path = variants_dir(&steam, app_id).join(format!("{safe_name}.lua"));
    if !variant_path.exists() { return Err("Вариант не найден".into()); }
    let dest = stplugin_dir(&steam).join(format!("{app_id}.lua"));
    vault_capture(&steam, app_id, "before-variant");
    std::fs::copy(&variant_path, &dest).map_err(|e| e.to_string())?;
    stamp_now(&dest);
    Ok(())
}

#[tauri::command]
pub fn lt_delete_variant(app_id: u64, name: String) -> Result<(), String> {
    let steam = steam_path_from_registry().ok_or("Steam не найден")?;
    let safe_name: String = name.chars().map(|c| if c.is_alphanumeric() || c == '-' || c == '_' { c } else { '_' }).collect();
    let path = variants_dir(&steam, app_id).join(format!("{safe_name}.lua"));
    if path.exists() { std::fs::remove_file(&path).map_err(|e| e.to_string())?; }
    Ok(())
}

// ── LuaVault — version history with auto-capture ─────────────────

fn vault_dir(steam: &str, app_id: u64) -> PathBuf {
    PathBuf::from(steam).join("config").join("stplug-in").join("vault").join(app_id.to_string())
}

fn sha256_hex(data: &[u8]) -> String {
    use sha2::{Sha256, Digest};
    let hash = Sha256::digest(data);
    hash.iter().map(|b| format!("{b:02x}")).collect()
}

#[derive(Serialize, Deserialize, Clone)]
pub struct VaultEntry {
    pub hash: String,
    pub timestamp: u64,
    pub source: String,
    pub depot_count: u32,
    pub dlc_count: u32,
    pub is_pinned: bool,
}

fn vault_index_path(steam: &str, app_id: u64) -> PathBuf {
    vault_dir(steam, app_id).join("vault_index.json")
}

fn read_vault_index(steam: &str, app_id: u64) -> Vec<VaultEntry> {
    let p = vault_index_path(steam, app_id);
    std::fs::read_to_string(&p).ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

fn write_vault_index(steam: &str, app_id: u64, entries: &[VaultEntry]) -> Result<(), String> {
    let dir = vault_dir(steam, app_id);
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let json = serde_json::to_string_pretty(entries).map_err(|e| e.to_string())?;
    std::fs::write(vault_index_path(steam, app_id), json).map_err(|e| e.to_string())
}

fn vault_capture(steam: &str, app_id: u64, source: &str) {
    let lua_path = stplugin_dir(steam).join(format!("{app_id}.lua"));
    let content = match std::fs::read(&lua_path) {
        Ok(c) => c,
        Err(_) => return,
    };
    let hash = sha256_hex(&content);
    let mut index = read_vault_index(steam, app_id);
    if index.iter().any(|e| e.hash == hash) { return; }
    let dir = vault_dir(steam, app_id);
    let _ = std::fs::create_dir_all(&dir);
    let dest = dir.join(format!("{hash}.lua"));
    let _ = std::fs::write(&dest, &content);
    let text = String::from_utf8_lossy(&content);
    let (dc, dlc, pinned) = count_lua_stats(&text);
    let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0);
    index.insert(0, VaultEntry { hash, timestamp: now, source: source.to_string(), depot_count: dc, dlc_count: dlc, is_pinned: pinned });
    if index.len() > 50 {
        let removed: Vec<_> = index.drain(50..).collect();
        for r in &removed {
            let _ = std::fs::remove_file(dir.join(format!("{}.lua", r.hash)));
        }
    }
    let _ = write_vault_index(steam, app_id, &index);
}

#[tauri::command]
pub fn lt_vault_history(app_id: u64) -> Result<Vec<VaultEntry>, String> {
    let steam = steam_path_from_registry().ok_or("Steam не найден")?;
    Ok(read_vault_index(&steam, app_id))
}

#[tauri::command]
pub fn lt_vault_restore(app_id: u64, hash: String) -> Result<(), String> {
    let steam = steam_path_from_registry().ok_or("Steam не найден")?;
    let src = vault_dir(&steam, app_id).join(format!("{hash}.lua"));
    if !src.exists() { return Err("Файл версии не найден в хранилище".into()); }
    vault_capture(&steam, app_id, "before-restore");
    let dest = stplugin_dir(&steam).join(format!("{app_id}.lua"));
    std::fs::copy(&src, &dest).map_err(|e| e.to_string())?;
    stamp_now(&dest);
    Ok(())
}

// ── Install unlocker mode (BST/OST from GitHub) ───────────────────

#[tauri::command]
pub async fn lt_install_mode(mode: String) -> Result<String, String> {
    let steam = steam_path_from_registry().ok_or("Steam не найден")?;

    if !matches!(mode.as_str(), "bst" | "ost" | "ltsp" | "custom") {
        return Err(format!("Неизвестный режим: {mode}"));
    }
    let was_running = stop_steam().await;

    let client = lt_client_builder()
        .timeout(std::time::Duration::from_secs(120))
        .build().map_err(|e| e.to_string())?;

    let res = match mode.as_str() {
        "bst" => install_bst(&client, &steam).await,
        "ost" => install_ost(&client, &steam).await,
        "ltsp" => install_ltsp(&client, &steam).await,
        _ => {
            remove_unlocker_dlls(&steam);
            Ok("Custom режим установлен".into())
        }
    };
    // Steam was running before — bring it back regardless of the outcome.
    if was_running { start_steam(&steam); }
    res
}

/// Kills steam.exe if it runs and waits (without blocking the async runtime)
/// until the process is gone. Returns whether Steam was running.
async fn stop_steam() -> bool {
    let running = tauri::async_runtime::spawn_blocking(is_steam_running).await.unwrap_or(false);
    if !running { return false; }
    let _ = tauri::async_runtime::spawn_blocking(|| {
        std::process::Command::new("taskkill").args(["/F", "/IM", "steam.exe"]).output()
    }).await;
    for _ in 0..20 {
        tokio::time::sleep(std::time::Duration::from_millis(250)).await;
        if !tauri::async_runtime::spawn_blocking(is_steam_running).await.unwrap_or(false) { break; }
    }
    true
}

fn start_steam(steam: &str) {
    let exe = PathBuf::from(steam).join("steam.exe");
    if !exe.exists() { return; }
    let mut cmd = std::process::Command::new(exe);
    // The store button talks to Steam's CEF over DevTools, which needs this flag.
    if lt_config_get()["store_button"].as_bool().unwrap_or(false) { cmd.arg("-cef-enable-debugging"); }
    let _ = cmd.spawn();
}

async fn install_ltsp(client: &reqwest::Client, steam: &str) -> Result<String, String> {
    remove_unlocker_dlls(steam);
    let json: serde_json::Value = client.get("https://api.github.com/repos/madoiscool/LTSP/releases/latest")
        .header("User-Agent", "project-desktop").send().await.map_err(|e| e.to_string())?
        .json().await.map_err(|e| e.to_string())?;
    let assets = json["assets"].as_array().ok_or("Нет assets")?;
    let zip_asset = assets.iter()
        .find(|a| a["name"].as_str().map(|n| n.contains("Release") && n.ends_with(".zip")).unwrap_or(false))
        .or_else(|| assets.iter().find(|a| a["name"].as_str().map(|n| n.ends_with(".zip") && !n.contains("Debug")).unwrap_or(false)))
        .ok_or("Zip не найден")?;
    let dl_url = zip_asset["browser_download_url"].as_str().ok_or("Нет URL")?;
    let tag = json["tag_name"].as_str().unwrap_or("unknown");
    let bytes = gh_download(&client, dl_url).await?;
    let tmp = std::env::temp_dir().join("ltsp_release.zip");
    std::fs::write(&tmp, &bytes).map_err(|e| e.to_string())?;
    extract_unlocker_zip(&tmp, steam, "LTSP", tag)?;
    let _ = std::fs::remove_file(&tmp);
    Ok(format!("LTSP {tag} установлен"))
}

fn remove_unlocker_dlls(steam: &str) {
    // If we have a manifest, use it (knows exactly what we put there).
    if let Some(mf) = read_mode_manifest(steam) {
        if let Some(files) = mf["files"].as_array() {
            for v in files {
                if let Some(p) = v.as_str() { let _ = std::fs::remove_file(p); }
            }
        }
        let mp = PathBuf::from(steam).join("config").join("project-desktop").join("mode.json");
        let _ = std::fs::remove_file(&mp);
    }
    // Fallback for installs made before mode.json existed. Generic hijack names
    // (version.dll, winmm.dll…) are only touched when there is clear evidence of
    // an unlocker (its payload DLL) — otherwise they may belong to another tool.
    let steam_pb = PathBuf::from(steam);
    let sp = stplugin_dir(steam);
    let payloads = [steam_pb.join("BetterSteamTools.dll"), steam_pb.join("OpenSteamTool.dll")];
    let unlocker_evidence = payloads.iter().any(|p| p.exists())
        || sp.join("stplug-in.dll").exists()
        || sp.join("stplug-in64.dll").exists();
    for p in &payloads { if p.exists() { let _ = std::fs::remove_file(p); } }
    if unlocker_evidence {
        for name in ["dwmapi.dll", "xinput1_4.dll", "version.dll", "winmm.dll", "user32.dll"] {
            let p = steam_pb.join(name);
            if p.exists() && is_small_hijack_dll(&p) { let _ = std::fs::remove_file(&p); }
        }
    }
    for name in ["stplug-in.dll", "stplug-in64.dll"] {
        let p = sp.join(name);
        if p.exists() { let _ = std::fs::remove_file(&p); }
    }
}

#[tauri::command]
pub async fn lt_uninstall_mode() -> Result<(), String> {
    let steam = steam_path_from_registry().ok_or("Steam не найден")?;
    let was_running = stop_steam().await;
    remove_unlocker_dlls(&steam);
    if was_running { start_steam(&steam); }
    Ok(())
}

async fn install_bst(client: &reqwest::Client, steam: &str) -> Result<String, String> {
    remove_unlocker_dlls(steam);
    let release_url = "https://api.github.com/repos/madoiscool/BetterSteamTools/releases/latest";
    let resp = client.get(release_url)
        .header("User-Agent", "project-desktop")
        .send().await.map_err(|e| e.to_string())?;
    if !resp.status().is_success() { return Err(format!("GitHub API: {}", resp.status())); }
    let json: serde_json::Value = resp.json().await.map_err(|e| e.to_string())?;
    let assets = json["assets"].as_array().ok_or("Нет assets в релизе")?;
    let zip_asset = assets.iter()
        .find(|a| a["name"].as_str().map(|n| n.contains("Release") && n.ends_with(".zip")).unwrap_or(false))
        .or_else(|| assets.iter().find(|a| a["name"].as_str().map(|n| n.ends_with(".zip") && !n.contains("Debug")).unwrap_or(false)))
        .ok_or("Zip не найден в релизе")?;
    let dl_url = zip_asset["browser_download_url"].as_str().ok_or("Нет URL")?;
    let tag = json["tag_name"].as_str().unwrap_or("unknown");

    let bytes = gh_download(&client, dl_url).await?;

    let tmp = std::env::temp_dir().join("bst_release.zip");
    std::fs::write(&tmp, &bytes).map_err(|e| e.to_string())?;

    extract_unlocker_zip(&tmp, steam, "BetterSteamTools", tag)?;
    let _ = std::fs::remove_file(&tmp);
    Ok(format!("BetterSteamTools {tag} установлен"))
}

// Install unlocker DLLs from a release zip:
//   stplug-in*.dll        → <steam>/config/stplug-in/
//   every other *.dll     → <steam>/ under its OWN name. OpenSteamTool/BST ship
//                           dwmapi.dll + xinput1_4.dll (loaders) + OpenSteamTool.dll
//                           (payload) and all three must sit next to steam.exe.
//   <steam>/config/project-desktop/mode.json — manifest of what we installed.
fn extract_unlocker_zip(zip_path: &Path, steam: &str, mode_name: &str, version: &str) -> Result<(), String> {
    let file = std::fs::File::open(zip_path).map_err(|e| e.to_string())?;
    let mut archive = zip::ZipArchive::new(file).map_err(|e| e.to_string())?;
    let steam_pb = PathBuf::from(steam);

    // Pass 1: collect every .dll by basename → bytes
    let mut dlls: Vec<(String, Vec<u8>)> = Vec::new();
    for i in 0..archive.len() {
        let mut entry = match archive.by_index(i) { Ok(e) => e, Err(_) => continue };
        if entry.is_dir() { continue; }
        let name = entry.name().replace('\\', "/");
        let fname = match Path::new(&name).file_name() { Some(f) => f.to_string_lossy().into_owned(), None => continue };
        if !fname.to_lowercase().ends_with(".dll") { continue; }
        let mut buf = Vec::new();
        if std::io::Read::read_to_end(&mut entry, &mut buf).is_err() { continue; }
        dlls.push((fname, buf));
    }
    if dlls.is_empty() { return Err("В архиве нет .dll".into()); }

    let mut installed_files: Vec<String> = Vec::new();

    // Plugin payload (OST): any file named stplug-in*.dll → config/stplug-in/
    let sp_dir = stplugin_dir(steam);
    let _ = std::fs::create_dir_all(&sp_dir);
    for (name, data) in &dlls {
        if name.to_lowercase().starts_with("stplug-in") {
            let dest = sp_dir.join(name);
            std::fs::write(&dest, data).map_err(|e| e.to_string())?;
            installed_files.push(dest.to_string_lossy().into_owned());
        }
    }

    for (name, data) in &dlls {
        if name.to_lowercase().starts_with("stplug-in") { continue; }
        let dest = steam_pb.join(name);
        std::fs::write(&dest, data).map_err(|e| format!("{name}: {e}"))?;
        installed_files.push(dest.to_string_lossy().into_owned());
    }

    // Write our mode.json manifest
    let manifest_dir = steam_pb.join("config").join("project-desktop");
    let _ = std::fs::create_dir_all(&manifest_dir);
    let manifest = serde_json::json!({
        "mode": mode_name,
        "version": version,
        "installed_at": std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0),
        "files": installed_files,
    });
    std::fs::write(manifest_dir.join("mode.json"), serde_json::to_string_pretty(&manifest).unwrap_or_default())
        .map_err(|e| e.to_string())?;
    Ok(())
}

fn read_mode_manifest(steam: &str) -> Option<serde_json::Value> {
    let p = PathBuf::from(steam).join("config").join("project-desktop").join("mode.json");
    let text = std::fs::read_to_string(&p).ok()?;
    serde_json::from_str(&text).ok()
}

async fn install_ost(client: &reqwest::Client, steam: &str) -> Result<String, String> {
    remove_unlocker_dlls(steam);
    let release_url = "https://api.github.com/repos/madoiscool/OST-Nightly/releases/latest";
    let resp = client.get(release_url)
        .header("User-Agent", "project-desktop")
        .send().await.map_err(|e| e.to_string())?;
    if !resp.status().is_success() { return Err(format!("GitHub API: {}", resp.status())); }
    let json: serde_json::Value = resp.json().await.map_err(|e| e.to_string())?;
    let assets = json["assets"].as_array().ok_or("Нет assets")?;
    let zip_asset = assets.iter()
        .find(|a| a["name"].as_str().map(|n| n.contains("Release") && n.ends_with(".zip")).unwrap_or(false))
        .or_else(|| assets.iter().find(|a| a["name"].as_str().map(|n| n.ends_with(".zip")).unwrap_or(false)))
        .ok_or("Zip не найден")?;
    let dl_url = zip_asset["browser_download_url"].as_str().ok_or("Нет URL")?;
    let tag = json["tag_name"].as_str().unwrap_or("unknown");

    let bytes = gh_download(&client, dl_url).await?;

    let tmp = std::env::temp_dir().join("ost_release.zip");
    std::fs::write(&tmp, &bytes).map_err(|e| e.to_string())?;
    extract_unlocker_zip(&tmp, steam, "stplug-in", tag)?;
    let _ = std::fs::remove_file(&tmp);
    Ok(format!("OpenSteamTool (Nightly) {tag} установлен"))
}

// ── CloudRedirect toggle ───────────────────────────────────────────

#[derive(Serialize)]
pub struct CloudRedirectState {
    pub supported: bool,
    pub enabled: bool,
    pub installed: bool,
}

#[tauri::command]
pub fn lt_cloud_redirect_state() -> CloudRedirectState {
    let steam = match steam_path_from_registry() { Some(p) => p, None => return CloudRedirectState { supported: false, enabled: false, installed: false } };
    let toml_path = PathBuf::from(&steam).join("opensteamtool.toml");
    let root = PathBuf::from(&steam);
    // OpenSteamTool/BST have CloudRedirect built into OpenSteamTool.dll
    // (CR_InitCloudSave, `cloud_redirect` key); a separate CloudRedirect.dll
    // is only used by the standalone CloudRedirect project.
    let installed = root.join("CloudRedirect.dll").exists() || root.join("OpenSteamTool.dll").exists();
    let mut enabled = false;
    if toml_path.exists() {
        if let Ok(content) = std::fs::read_to_string(&toml_path) {
            enabled = content.lines()
                .take_while(|l| !l.trim_start().starts_with('['))
                .any(|l| is_toml_key(l, "cloud_redirect")
                    && l.split('=').nth(1).map(|v| v.split('#').next().unwrap_or("").trim() == "true").unwrap_or(false));
        }
    }
    let supported = ["BetterSteamTools.dll", "OpenSteamTool.dll", "dwmapi.dll"].iter().any(|n| root.join(n).exists());
    CloudRedirectState { supported, enabled, installed }
}

#[tauri::command]
pub fn lt_cloud_redirect_toggle(enable: bool) -> Result<(), String> {
    let steam = steam_path_from_registry().ok_or("Steam не найден")?;
    let toml_path = PathBuf::from(&steam).join("opensteamtool.toml");
    let content = std::fs::read_to_string(&toml_path).unwrap_or_default();
    std::fs::write(&toml_path, set_top_level_bool(&content, "cloud_redirect", enable))
        .map_err(|e| e.to_string())
}

/// Is `line` an assignment to exactly `key` (not `key_suffix`)?
fn is_toml_key(line: &str, key: &str) -> bool {
    line.trim_start().strip_prefix(key)
        .map(|rest| rest.trim_start().starts_with('='))
        .unwrap_or(false)
}

/// Sets a top-level (before any `[section]`) boolean key, inserting it above the
/// first section when absent so it never lands inside an unrelated table.
fn set_top_level_bool(content: &str, key: &str, value: bool) -> String {
    let mut lines: Vec<String> = content.lines().map(String::from).collect();
    let top_end = lines.iter().position(|l| l.trim_start().starts_with('[')).unwrap_or(lines.len());
    let assign = format!("{key} = {value}");
    if let Some(i) = lines[..top_end].iter().position(|l| is_toml_key(l, key)) {
        lines[i] = assign;
    } else {
        lines.insert(top_end, assign);
    }
    let mut out = lines.join("\n");
    out.push('\n');
    out
}

// ── opensteamtool.toml full config ─────────────────────────────────

#[tauri::command]
pub fn lt_ost_config_read() -> Result<String, String> {
    let steam = steam_path_from_registry().ok_or("Steam не найден")?;
    let toml_path = PathBuf::from(&steam).join("opensteamtool.toml");
    if !toml_path.exists() {
        return Ok(String::new());
    }
    std::fs::read_to_string(&toml_path).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn lt_ost_config_write(content: String) -> Result<(), String> {
    let steam = steam_path_from_registry().ok_or("Steam не найден")?;
    let toml_path = PathBuf::from(&steam).join("opensteamtool.toml");
    std::fs::write(&toml_path, content.as_bytes()).map_err(|e| e.to_string())
}

// ── Check mode version from GitHub ─────────────────────────────────

#[derive(Serialize)]
pub struct ModeVersionInfo {
    pub mode: String,
    pub latest_tag: Option<String>,
    pub download_url: Option<String>,
}

#[tauri::command]
pub async fn lt_check_mode_update(mode: String) -> Result<ModeVersionInfo, String> {
    let client = lt_client_builder()
        .timeout(std::time::Duration::from_secs(15))
        .build().map_err(|e| e.to_string())?;
    // BST uses a plain-text latest.toml, not GitHub releases
    if mode == "bst" {
        let toml_url = "https://raw.githubusercontent.com/madoiscool/BetterSteamTools/refs/heads/updates/opensteamtool/latest.toml";
        let text = client.get(toml_url).header("User-Agent", "project-desktop")
            .send().await.map_err(|e| e.to_string())?
            .text().await.map_err(|e| e.to_string())?;
        let mut tag = None;
        let mut dl = None;
        for line in text.lines() {
            let t = line.trim();
            if let Some(v) = t.strip_prefix("version") {
                if let Some(val) = v.split('=').nth(1) { tag = Some(val.trim().trim_matches('"').to_string()); }
            } else if let Some(v) = t.strip_prefix("url") {
                if let Some(val) = v.split('=').nth(1) { dl = Some(val.trim().trim_matches('"').to_string()); }
            }
        }
        return Ok(ModeVersionInfo { mode, latest_tag: tag, download_url: dl });
    }
    let repo = match mode.as_str() {
        "ost" => "madoiscool/OST-Nightly",
        "ltsp" => "madoiscool/LTSP",
        _ => return Err("Неизвестный режим".into()),
    };
    let url = format!("https://api.github.com/repos/{repo}/releases/latest");
    let resp = client.get(&url)
        .header("User-Agent", "project-desktop")
        .send().await.map_err(|e| e.to_string())?;
    if !resp.status().is_success() { return Ok(ModeVersionInfo { mode, latest_tag: None, download_url: None }); }
    let json: serde_json::Value = resp.json().await.map_err(|e| e.to_string())?;
    let tag = json["tag_name"].as_str().map(|s| s.to_string());
    let dl = json["assets"].as_array().and_then(|a| a.iter()
        .find(|x| x["name"].as_str().map(|n| n.ends_with(".zip")).unwrap_or(false))
        .and_then(|x| x["browser_download_url"].as_str().map(|s| s.to_string())));
    Ok(ModeVersionInfo { mode, latest_tag: tag, download_url: dl })
}

// ── Кэш загрузок в Telegram (сервер студии: /api/lua-cache) ─────────
// Скачанное с lua.tools один участник отдаёт серверу, бот кладёт файл в тему «lua и другие»; следующий берёт свежую
// копию оттуда и не тратит лимит lua.tools. Любая ошибка кэша = промах: дальше обычная загрузка с lua.tools.

const LUA_CACHE_API: &str = concat!(env!("SERVER_ORIGIN"), "/api/lua-cache");
const LUA_CACHE_MAX_BYTES: u64 = 300 * 1024 * 1024;

fn lua_cache_headers(headers: &std::collections::HashMap<String, String>) -> reqwest::header::HeaderMap {
    let mut map = reqwest::header::HeaderMap::new();
    // Только служебные заголовки клиента (X-Init-Data, X-App-Version, X-Preview…), ничего лишнего.
    for (k, v) in headers {
        if !k.to_ascii_lowercase().starts_with("x-") { continue; }
        if let (Ok(name), Ok(value)) = (reqwest::header::HeaderName::from_bytes(k.as_bytes()), reqwest::header::HeaderValue::from_str(v)) {
            map.insert(name, value);
        }
    }
    map
}

/// Свежая копия из кэша → путь к файлу в `dest_dir`; нет копии или сервер недоступен → None.
#[tauri::command]
pub async fn lt_cache_get(key: String, headers: std::collections::HashMap<String, String>, dest_dir: String) -> Result<Option<String>, String> {
    let client = reqwest::Client::builder().timeout(std::time::Duration::from_secs(600)).build().map_err(|e| e.to_string())?;
    let resp = match client.get(format!("{LUA_CACHE_API}/file")).query(&[("key", &key)]).headers(lua_cache_headers(&headers)).send().await {
        Ok(r) if r.status().is_success() => r,
        _ => return Ok(None),
    };
    let want = resp.headers().get("x-lua-cache-sha256").and_then(|v| v.to_str().ok()).unwrap_or("").to_string();
    let Some(filename) = resp.headers().get("content-disposition").and_then(|v| v.to_str().ok()).and_then(content_disposition_filename) else { return Ok(None) };
    let Ok(bytes) = resp.bytes().await else { return Ok(None) };
    // Битая/обрезанная копия хуже промаха: ставим только при совпавшем хэше.
    if want.is_empty() || sha256_hex(&bytes) != want { return Ok(None); }
    std::fs::create_dir_all(&dest_dir).map_err(|e| e.to_string())?;
    let dest = PathBuf::from(&dest_dir).join(&filename);
    std::fs::write(&dest, &bytes).map_err(|e| e.to_string())?;
    Ok(Some(dest.to_string_lossy().into_owned()))
}

/// Отдаёт скачанный с lua.tools файл в кэш. Сначала сверка хэша: тот же файл не заливается повторно.
#[tauri::command]
pub async fn lt_cache_put(key: String, label: String, path: String, headers: std::collections::HashMap<String, String>) -> Result<bool, String> {
    let meta = std::fs::metadata(&path).map_err(|e| e.to_string())?;
    if meta.len() == 0 || meta.len() > LUA_CACHE_MAX_BYTES { return Ok(false); }
    let read_path = path.clone();
    let bytes = tauri::async_runtime::spawn_blocking(move || std::fs::read(read_path)).await
        .map_err(|e| e.to_string())?.map_err(|e| e.to_string())?;
    let sha = sha256_hex(&bytes);
    let hdrs = lua_cache_headers(&headers);
    let client = reqwest::Client::builder().timeout(std::time::Duration::from_secs(1800)).build().map_err(|e| e.to_string())?;
    let touch: serde_json::Value = client.post(format!("{LUA_CACHE_API}/touch")).headers(hdrs.clone())
        .json(&serde_json::json!({ "key": key, "sha256": sha }))
        .send().await.map_err(|e| e.to_string())?
        .error_for_status().map_err(|e| e.to_string())?
        .json().await.map_err(|e| e.to_string())?;
    if !touch["need_file"].as_bool().unwrap_or(false) { return Ok(touch["stored"].as_bool().unwrap_or(false)); }
    let name = Path::new(&path).file_name().and_then(|n| n.to_str()).unwrap_or("file.zip").to_string();
    let form = reqwest::multipart::Form::new()
        .text("key", key)
        .text("label", label)
        .part("file", reqwest::multipart::Part::bytes(bytes).file_name(name));
    let resp = client.post(format!("{LUA_CACHE_API}/file")).headers(hdrs).multipart(form).send().await.map_err(|e| e.to_string())?;
    if !resp.status().is_success() { return Err(format!("HTTP {}", resp.status().as_u16())); }
    let j: serde_json::Value = resp.json().await.map_err(|e| e.to_string())?;
    Ok(j["stored"].as_bool().unwrap_or(false))
}

// ── Download from lua.tools API (proxied through Tauri for auth) ────

#[derive(Deserialize)]
struct ApiError {
    error: Option<String>,
}

#[tauri::command]
pub async fn lt_download(
    app: tauri::AppHandle,
    url: String,
    token: String,
    dest_dir: String,
) -> Result<String, String> {
    let client = lt_client_builder()
        .timeout(std::time::Duration::from_secs(300))
        .build()
        .map_err(|e| e.to_string())?;

    let resp = client
        .get(&url)
        .header("Authorization", format!("Bearer {token}"))
        .send()
        .await
        .map_err(|e| e.to_string())?;

    if !resp.status().is_success() {
        let status = resp.status().as_u16();
        let body = resp.text().await.unwrap_or_default();
        let msg = serde_json::from_str::<ApiError>(&body)
            .ok()
            .and_then(|e| e.error)
            .unwrap_or_else(|| format!("HTTP {status}"));
        return Err(msg);
    }

    let filename = resp
        .headers()
        .get("content-disposition")
        .and_then(|v| v.to_str().ok())
        .and_then(content_disposition_filename)
        .unwrap_or_else(|| {
            let ts = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis()).unwrap_or(0);
            format!("download_{ts}.zip")
        });

    let total = resp.content_length().unwrap_or(0);
    let dest = PathBuf::from(&dest_dir).join(&filename);
    std::fs::create_dir_all(&dest_dir).map_err(|e| e.to_string())?;

    let mut file = std::fs::File::create(&dest).map_err(|e| e.to_string())?;
    let mut downloaded: u64 = 0;
    let mut stream = resp.bytes_stream();
    use futures_util::StreamExt;
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|e| e.to_string())?;
        std::io::Write::write_all(&mut file, &chunk).map_err(|e| e.to_string())?;
        downloaded += chunk.len() as u64;
        let pct = if total > 0 { (downloaded * 100 / total).min(100) } else { 0 };
        let _ = app.emit("lt-download-progress", serde_json::json!({
            "url": &url, "downloaded": downloaded, "total": total, "percent": pct
        }));
    }

    Ok(dest.to_string_lossy().into_owned())
}

/// Parses `filename*=UTF-8''…` (preferred) or `filename=…` and strips any path,
/// so a server can't make us write outside `dest_dir`.
fn content_disposition_filename(header: &str) -> Option<String> {
    let mut plain = None;
    let mut ext = None;
    for part in header.split(';') {
        let part = part.trim();
        if let Some(v) = part.strip_prefix("filename*=") {
            let v = v.trim_matches('"');
            let enc = v.splitn(3, '\'').nth(2).unwrap_or(v);
            ext = Some(percent_decode(enc));
        } else if let Some(v) = part.strip_prefix("filename=") {
            plain = Some(v.trim_matches('"').to_string());
        }
    }
    let raw = ext.or(plain)?;
    let base = raw.rsplit(['/', '\\']).next().unwrap_or("").trim();
    let clean: String = base.chars()
        .filter(|c| !matches!(c, ':' | '*' | '?' | '"' | '<' | '>' | '|') && !c.is_control())
        .collect();
    let clean = clean.trim_matches('.').trim().to_string();
    (!clean.is_empty()).then_some(clean)
}

fn percent_decode(s: &str) -> String {
    let b = s.as_bytes();
    let mut out = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        if b[i] == b'%' && i + 2 < b.len() + 1 && i + 3 <= b.len() {
            if let Some(v) = s.get(i + 1..i + 3).and_then(|h| u8::from_str_radix(h, 16).ok()) {
                out.push(v);
                i += 3;
                continue;
            }
        }
        out.push(b[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

// ──────────────────────────────────────────────────────────────────
// Hardware AppID filter (jsnli/steamappidlist) — 24h cache
// ──────────────────────────────────────────────────────────────────

fn dirs_cache_dir() -> PathBuf {
    let base = std::env::var("LOCALAPPDATA").unwrap_or_else(|_| std::env::temp_dir().to_string_lossy().into_owned());
    PathBuf::from(base).join("project-desktop").join("lt_cache")
}

#[tauri::command]
pub async fn lt_hardware_appids() -> Result<Vec<u64>, String> {
    let cache_dir = dirs_cache_dir();
    let cache_file = cache_dir.join("hardware_appid.json");
    let max_age = std::time::Duration::from_secs(86400);
    if let Ok(meta) = std::fs::metadata(&cache_file) {
        if let Ok(mtime) = meta.modified() {
            if mtime.elapsed().map(|e| e < max_age).unwrap_or(false) {
                if let Ok(text) = std::fs::read_to_string(&cache_file) {
                    if let Ok(v) = serde_json::from_str::<Vec<u64>>(&text) { return Ok(v); }
                }
            }
        }
    }
    let client = lt_client_builder().timeout(std::time::Duration::from_secs(20))
        .build().map_err(|e| e.to_string())?;
    let text = client.get("https://raw.githubusercontent.com/jsnli/steamappidlist/master/data/hardware_appid.json")
        .header("User-Agent", "project-desktop").send().await.map_err(|e| e.to_string())?
        .text().await.map_err(|e| e.to_string())?;
    let v: Vec<serde_json::Value> = serde_json::from_str(&text).map_err(|e| e.to_string())?;
    let ids: Vec<u64> = v.iter().filter_map(|x| x.get("appid").and_then(|a| a.as_u64()).or_else(|| x.as_u64())).collect();
    let _ = std::fs::create_dir_all(&cache_dir);
    let _ = std::fs::write(&cache_file, serde_json::to_string(&ids).unwrap_or_default());
    Ok(ids)
}

// ──────────────────────────────────────────────────────────────────
// Applist mirror
// ──────────────────────────────────────────────────────────────────

#[tauri::command]
pub async fn lt_applist_mirror() -> Result<String, String> {
    let cache_dir = dirs_cache_dir();
    let cache_file = cache_dir.join("steam-applist.json");
    let max_age = std::time::Duration::from_secs(86400 * 3);
    if let Ok(meta) = std::fs::metadata(&cache_file) {
        if let Ok(mtime) = meta.modified() {
            if mtime.elapsed().map(|e| e < max_age).unwrap_or(false) {
                if let Ok(text) = std::fs::read_to_string(&cache_file) { return Ok(text); }
            }
        }
    }
    let client = lt_client_builder().timeout(std::time::Duration::from_secs(60))
        .build().map_err(|e| e.to_string())?;
    let mut text: Option<String> = None;
    if let Ok(r) = client.get("https://applist.morrenus.xyz/")
        .header("User-Agent", "project-desktop").send().await {
        if r.status().is_success() { text = r.text().await.ok(); }
    }
    if text.is_none() {
        let r = client.get("https://api.steampowered.com/ISteamApps/GetAppList/v2/")
            .header("User-Agent", "project-desktop").send().await
            .map_err(|e| e.to_string())?;
        text = r.text().await.ok();
    }
    let out = text.ok_or("Не удалось загрузить applist")?;
    let _ = std::fs::create_dir_all(&cache_dir);
    let _ = std::fs::write(&cache_file, &out);
    Ok(out)
}

// ──────────────────────────────────────────────────────────────────
// DNS-over-HTTPS resolve (1.1.1.1)
// ──────────────────────────────────────────────────────────────────

// ── DNS-over-HTTPS ─────────────────────────────────────────────────
//
// With "use_doh" on, every client built here resolves names via Cloudflare's
// 1.1.1.1 JSON API (reached by IP, so no DNS needed), falling back to the
// system resolver. Gets around ISP DNS poisoning of lua.tools / GitHub.

struct DohResolver;

async fn doh_lookup(host: &str) -> Result<Vec<std::net::IpAddr>, String> {
    let client = reqwest::Client::builder().timeout(std::time::Duration::from_secs(8)).build().map_err(|e| e.to_string())?;
    let json: serde_json::Value = client.get("https://1.1.1.1/dns-query")
        .query(&[("name", host), ("type", "A")])
        .header("accept", "application/dns-json")
        .send().await.map_err(|e| e.to_string())?
        .json().await.map_err(|e| e.to_string())?;
    let ips: Vec<std::net::IpAddr> = json["Answer"].as_array().map(|a| a.iter()
        .filter_map(|x| x["data"].as_str().and_then(|s| s.parse().ok())).collect()).unwrap_or_default();
    if ips.is_empty() { Err("DoH: пустой ответ".into()) } else { Ok(ips) }
}

impl reqwest::dns::Resolve for DohResolver {
    fn resolve(&self, name: reqwest::dns::Name) -> reqwest::dns::Resolving {
        let host = name.as_str().to_string();
        Box::pin(async move {
            let addrs: Vec<std::net::SocketAddr> = match doh_lookup(&host).await {
                Ok(ips) => ips.into_iter().map(|ip| std::net::SocketAddr::new(ip, 0)).collect(),
                Err(_) => tokio::net::lookup_host((host.as_str(), 0)).await?.collect(),
            };
            let it: reqwest::dns::Addrs = Box::new(addrs.into_iter());
            Ok(it)
        })
    }
}

fn lt_client_builder() -> reqwest::ClientBuilder {
    let b = reqwest::Client::builder();
    if lt_config_get()["use_doh"].as_bool().unwrap_or(false) {
        b.dns_resolver(std::sync::Arc::new(DohResolver))
    } else { b }
}

#[tauri::command]
pub async fn lt_doh_resolve(host: String) -> Result<Vec<String>, String> {
    let client = reqwest::Client::builder().timeout(std::time::Duration::from_secs(10))
        .build().map_err(|e| e.to_string())?;
    let host = host.trim().trim_end_matches('.');
    if host.is_empty() || host.len() > 253
        || !host.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '.') {
        return Err("Некорректное имя хоста".into());
    }
    let json: serde_json::Value = client.get("https://1.1.1.1/dns-query")
        .query(&[("name", host), ("type", "A")])
        .header("accept", "application/dns-json")
        .send().await.map_err(|e| e.to_string())?
        .json().await.map_err(|e| e.to_string())?;
    let ips: Vec<String> = json["Answer"].as_array().map(|a| a.iter()
        .filter_map(|x| x["data"].as_str().map(|s| s.to_string())).collect()).unwrap_or_default();
    Ok(ips)
}

// ──────────────────────────────────────────────────────────────────
// DepotDownloaderMod
// ──────────────────────────────────────────────────────────────────

#[derive(Serialize)]
pub struct DdmInfo {
    pub installed: bool,
    pub exe_path: Option<String>,
    pub latest_tag: Option<String>,
    pub download_url: Option<String>,
}

fn ddm_dir() -> PathBuf {
    let base = std::env::var("LOCALAPPDATA").unwrap_or_else(|_| std::env::temp_dir().to_string_lossy().into_owned());
    PathBuf::from(base).join("project-desktop").join("DepotDownloaderMod")
}

#[tauri::command]
pub async fn lt_depot_downloader_info() -> Result<DdmInfo, String> {
    let dir = ddm_dir();
    let exe = dir.join("DepotDownloaderMod.exe");
    let installed = exe.exists();
    let client = lt_client_builder().timeout(std::time::Duration::from_secs(15))
        .build().map_err(|e| e.to_string())?;
    let json: serde_json::Value = client.get("https://api.github.com/repos/mendy-tools/DepotDownloaderMod/releases/latest")
        .header("User-Agent", "project-desktop").send().await.map_err(|e| e.to_string())?
        .json().await.map_err(|e| e.to_string())?;
    let tag = json["tag_name"].as_str().map(String::from);
    let dl = json["assets"].as_array().and_then(|a| a.iter()
        .find(|x| x["name"].as_str().map(|n| n.ends_with(".zip") && n.to_lowercase().contains("win")).unwrap_or(false))
        .or_else(|| a.iter().find(|x| x["name"].as_str().map(|n| n.ends_with(".zip")).unwrap_or(false)))
        .and_then(|x| x["browser_download_url"].as_str().map(String::from)));
    Ok(DdmInfo { installed, exe_path: installed.then(|| exe.to_string_lossy().into_owned()), latest_tag: tag, download_url: dl })
}

#[tauri::command]
pub async fn lt_depot_downloader_install() -> Result<String, String> {
    let info = lt_depot_downloader_info().await?;
    let url = info.download_url.ok_or("Нет URL для скачивания")?;
    let dir = ddm_dir();
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let client = lt_client_builder().timeout(std::time::Duration::from_secs(300))
        .build().map_err(|e| e.to_string())?;
    let bytes = gh_download(&client, &url).await?;
    let tmp = std::env::temp_dir().join("ddm.zip");
    std::fs::write(&tmp, &bytes).map_err(|e| e.to_string())?;
    let file = std::fs::File::open(&tmp).map_err(|e| e.to_string())?;
    let mut archive = zip::ZipArchive::new(file).map_err(|e| e.to_string())?;
    for i in 0..archive.len() {
        let mut entry = match archive.by_index(i) { Ok(e) => e, Err(_) => continue };
        if entry.is_dir() { continue; }
        let Some((rel, _)) = zip_entry_dest(Path::new(""), &entry) else { continue };
        let Some(fname) = rel.file_name() else { continue };
        let dest = dir.join(fname);
        extract_entry(&mut entry, &dest)?;
    }
    let _ = std::fs::remove_file(&tmp);
    Ok(dir.to_string_lossy().into_owned())
}

/// Downloads one depot. Takes typed IDs instead of a free-form argv so the
/// webview can't run the binary with arbitrary flags. If the depot key is in
/// the installed lua and its manifest is in depotcache, they are passed along.
#[tauri::command]
pub async fn lt_depot_downloader_run(app_id: u64, depot_id: u64) -> Result<String, String> {
    let exe = ddm_dir().join("DepotDownloaderMod.exe");
    if !exe.exists() { return Err("DepotDownloaderMod не установлен".into()); }
    let mut args = vec!["-app".to_string(), app_id.to_string(), "-depot".to_string(), depot_id.to_string()];
    if let Some(steam) = steam_path_from_registry() {
        if let Ok(lua) = std::fs::read_to_string(stplugin_dir(&steam).join(format!("{app_id}.lua"))) {
            if let Some(key) = depot_key_from_lua(&lua, depot_id) {
                let keys = ddm_dir().join(format!("keys_{depot_id}.txt"));
                if std::fs::write(&keys, format!("{depot_id};{key}\n")).is_ok() {
                    args.push("-depotkeys".into());
                    args.push(keys.to_string_lossy().into_owned());
                }
            }
        }
        if let Ok(rd) = std::fs::read_dir(depotcache_dir(&steam)) {
            let prefix = format!("{depot_id}_");
            let newest = rd.flatten()
                .filter(|e| {
                    let n = e.file_name().to_string_lossy().into_owned();
                    n.starts_with(&prefix) && n.ends_with(".manifest")
                })
                .max_by_key(|e| e.metadata().and_then(|m| m.modified()).ok());
            if let Some(m) = newest {
                let name = m.file_name().to_string_lossy().into_owned();
                if let Some(mid) = name.trim_end_matches(".manifest").split('_').nth(1) {
                    args.push("-manifest".into());
                    args.push(mid.to_string());
                    args.push("-manifestfile".into());
                    args.push(m.path().to_string_lossy().into_owned());
                }
            }
        }
    }
    let out = tauri::async_runtime::spawn_blocking(move || std::process::Command::new(&exe).args(&args).output())
        .await.map_err(|e| e.to_string())?.map_err(|e| e.to_string())?;
    let stdout = String::from_utf8_lossy(&out.stdout).into_owned();
    let stderr = String::from_utf8_lossy(&out.stderr).into_owned();
    if !out.status.success() { return Err(format!("{stdout}\n{stderr}")); }
    Ok(stdout)
}

/// Mirrors tried when github.com / objects.githubusercontent.com is blocked or
/// throttled (common in RU/CN). Each takes the full GitHub URL appended.
const GH_MIRRORS: &[&str] = &["https://ghfast.top/", "https://ghproxy.net/", "https://gh.ddlc.top/"];

/// Downloads a GitHub release asset, falling back to mirrors on failure.
async fn gh_download(client: &reqwest::Client, url: &str) -> Result<Vec<u8>, String> {
    let is_gh = reqwest::Url::parse(url).ok()
        .and_then(|u| u.host_str().map(|h| h == "github.com" || h.ends_with(".githubusercontent.com")))
        .unwrap_or(false);
    let mut candidates = vec![url.to_string()];
    if is_gh { candidates.extend(GH_MIRRORS.iter().map(|m| format!("{m}{url}"))); }
    let mut last_err = String::new();
    for c in candidates {
        match client.get(&c).header("User-Agent", "project-desktop").send().await {
            Ok(r) if r.status().is_success() => match r.bytes().await {
                // A mirror's error page is HTML; release assets never are.
                Ok(b) if !b.is_empty() && !b.starts_with(b"<!") && !b.starts_with(b"<html") => return Ok(b.to_vec()),
                Ok(_) => last_err = format!("{c}: пустой или HTML-ответ"),
                Err(e) => last_err = e.to_string(),
            },
            Ok(r) => last_err = format!("HTTP {}", r.status().as_u16()),
            Err(e) => last_err = e.to_string(),
        }
    }
    Err(format!("Не удалось скачать с GitHub и зеркал: {last_err}"))
}

/// `setManifestid(<depot>, "<gid>")` pairs from a lua (commented lines too:
/// the gid is still the manifest Steam will ask for once the pin is restored).
fn manifest_pins(lua: &str) -> Vec<(u64, String)> {
    let mut out = vec![];
    for line in lua.lines() {
        let t = line.trim_start().trim_start_matches('-').trim_start();
        let low = t.to_lowercase();
        let Some(pos) = low.find("setmanifestid(") else { continue };
        let args = &t[pos + "setmanifestid(".len()..];
        let mut parts = args.split(',');
        let depot = parts.next().and_then(|d| d.trim().parse::<u64>().ok());
        let gid = parts.next().map(|g| g.trim().trim_end_matches(')').trim().trim_matches('"').to_string());
        if let (Some(d), Some(g)) = (depot, gid) {
            if !g.is_empty() && g.chars().all(|c| c.is_ascii_digit()) { out.push((d, g)); }
        }
    }
    out
}

#[derive(Serialize)]
pub struct ManifestFetchResult { pub fetched: u32, pub present: u32, pub failed: Vec<String> }

/// Fetches `<depot>_<gid>.manifest` files the installed lua references but
/// depotcache lacks, from `<api_base>/api/givemethemanifestpunk/<depot>/<gid>`.
#[tauri::command]
pub async fn lt_fetch_missing_manifests(app_id: u64, token: String) -> Result<ManifestFetchResult, String> {
    let steam = steam_path_from_registry().ok_or("Steam не найден")?;
    let lua = std::fs::read_to_string(stplugin_dir(&steam).join(format!("{app_id}.lua"))).map_err(|_| "Lua не установлен".to_string())?;
    let dir = depotcache_dir(&steam);
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let base = lt_config_get()["api_base"].as_str().unwrap_or("https://lua.tools").trim_end_matches('/').to_string();
    let client = lt_client_builder().timeout(std::time::Duration::from_secs(60)).build().map_err(|e| e.to_string())?;
    let mut res = ManifestFetchResult { fetched: 0, present: 0, failed: vec![] };
    for (depot, gid) in manifest_pins(&lua) {
        let dest = dir.join(format!("{depot}_{gid}.manifest"));
        if dest.exists() { res.present += 1; continue; }
        let mut req = client.get(format!("{base}/api/givemethemanifestpunk/{depot}/{gid}")).header("User-Agent", "project-desktop");
        if !token.is_empty() { req = req.bearer_auth(&token); }
        match req.send().await {
            Ok(r) if r.status().is_success() => match r.bytes().await {
                Ok(b) if !b.is_empty() && !b.starts_with(b"<") && !b.starts_with(b"{") => {
                    let tmp = dest.with_extension("part");
                    if std::fs::write(&tmp, &b).and_then(|_| std::fs::rename(&tmp, &dest)).is_ok() { res.fetched += 1; }
                    else { res.failed.push(format!("{depot}: запись не удалась")); }
                }
                _ => res.failed.push(format!("{depot}: пустой ответ")),
            },
            Ok(r) => res.failed.push(format!("{depot}: HTTP {}", r.status().as_u16())),
            Err(e) => res.failed.push(format!("{depot}: {e}")),
        }
    }
    Ok(res)
}

/// `addappid(<depot>, 1, "<hexkey>")` → hexkey (active lines only).
fn depot_key_from_lua(lua: &str, depot_id: u64) -> Option<String> {
    let needle = depot_id.to_string();
    for line in lua.lines() {
        let t = line.trim_start();
        if t.starts_with("--") || !t.to_lowercase().starts_with("addappid(") { continue; }
        let Some(open) = t.find('(') else { continue };
        let mut parts = t[open + 1..].split(',');
        if parts.next().map(|p| p.trim()) != Some(needle.as_str()) { continue; }
        let Some(raw) = parts.nth(1) else { continue };
        let key = raw.trim().trim_end_matches(')').trim().trim_matches('"');
        if !key.is_empty() && key.chars().all(|c| c.is_ascii_hexdigit()) { return Some(key.to_string()); }
    }
    None
}

// ── Launch game via Steam ─────────────────────────────────────────

#[tauri::command]
pub fn lt_launch_game(app_id: u64, args: String) -> Result<(), String> {
    let url = if args.is_empty() {
        format!("steam://rungameid/{app_id}")
    } else {
        format!("steam://run/{app_id}//{}/", args.replace(' ', "%20"))
    };
    #[cfg(windows)]
    {
        std::process::Command::new("cmd").args(["/C", "start", "", &url])
            .spawn().map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// Opens the game's store page inside the Steam client.
#[tauri::command]
pub fn lt_open_in_steam(app_id: u64) -> Result<(), String> {
    #[cfg(windows)]
    {
        std::process::Command::new("cmd").args(["/C", "start", "", &format!("steam://store/{app_id}")])
            .spawn().map_err(|e| e.to_string())?;
    }
    Ok(())
}

// ──────────────────────────────────────────────────────────────────
// Steamless — SteamStub DRM removal
// ──────────────────────────────────────────────────────────────────

fn steamless_dir() -> PathBuf {
    let base = std::env::var("LOCALAPPDATA").unwrap_or_else(|_| std::env::temp_dir().to_string_lossy().into_owned());
    PathBuf::from(base).join("project-desktop").join("Steamless")
}

#[derive(Serialize)]
pub struct SteamlessInfo {
    pub installed: bool,
    pub version: Option<String>,
    pub path: Option<String>,
}

#[tauri::command]
pub fn lt_steamless_info() -> SteamlessInfo {
    let dir = steamless_dir();
    let exe = dir.join("Steamless.CLI.exe");
    if exe.exists() {
        let ver = dir.join("version.txt");
        let version = std::fs::read_to_string(&ver).ok().map(|s| s.trim().to_string());
        SteamlessInfo { installed: true, version, path: Some(exe.to_string_lossy().into_owned()) }
    } else {
        SteamlessInfo { installed: false, version: None, path: None }
    }
}

#[tauri::command]
pub async fn lt_steamless_install() -> Result<String, String> {
    let client = lt_client_builder().timeout(std::time::Duration::from_secs(120))
        .build().map_err(|e| e.to_string())?;
    let api_url = "https://api.github.com/repos/atom0s/Steamless/releases/latest";
    let resp = client.get(api_url).header("User-Agent", "project-desktop")
        .send().await.map_err(|e| e.to_string())?;
    if !resp.status().is_success() { return Err("GitHub API error".into()); }
    let release: serde_json::Value = resp.json().await.map_err(|e| e.to_string())?;
    let tag = release["tag_name"].as_str().unwrap_or("unknown").to_string();
    let asset = release["assets"].as_array().ok_or("No assets")?
        .iter().find(|a| a["name"].as_str().map(|n| n.contains("Steamless") && n.ends_with(".zip")).unwrap_or(false))
        .ok_or("Steamless zip not found in release")?;
    let dl_url = asset["browser_download_url"].as_str().ok_or("No download URL")?;
    let bytes = gh_download(&client, dl_url).await?;
    let dir = steamless_dir();
    let _ = std::fs::create_dir_all(&dir);
    let zip_path = dir.join("steamless.zip");
    std::fs::write(&zip_path, &bytes).map_err(|e| e.to_string())?;
    let file = std::fs::File::open(&zip_path).map_err(|e| e.to_string())?;
    let mut archive = zip::ZipArchive::new(file).map_err(|e| e.to_string())?;
    for i in 0..archive.len() {
        let mut entry = archive.by_index(i).map_err(|e| e.to_string())?;
        if entry.is_dir() { continue; }
        let Some((out_path, _)) = zip_entry_dest(&dir, &entry) else { continue };
        if let Some(p) = out_path.parent() { let _ = std::fs::create_dir_all(p); }
        let mut buf = vec![];
        std::io::Read::read_to_end(&mut entry, &mut buf).map_err(|e| e.to_string())?;
        std::fs::write(&out_path, &buf).map_err(|e| e.to_string())?;
    }
    let _ = std::fs::remove_file(&zip_path);
    let _ = std::fs::write(dir.join("version.txt"), &tag);
    Ok(tag)
}

#[tauri::command]
pub fn lt_steamless_run(exe_path: String) -> Result<String, String> {
    let cli = steamless_dir().join("Steamless.CLI.exe");
    if !cli.exists() { return Err("Steamless не установлен".into()); }
    let target = PathBuf::from(&exe_path);
    if !target.exists() { return Err(format!("Файл не найден: {exe_path}")); }
    let bak = target.with_extension("exe.bak");
    if !bak.exists() {
        std::fs::copy(&target, &bak).map_err(|e| e.to_string())?;
    }
    let out = std::process::Command::new(&cli)
        .arg(&exe_path)
        .output().map_err(|e| e.to_string())?;
    let stdout = String::from_utf8_lossy(&out.stdout).into_owned();
    let unpacked = target.with_file_name(format!("{}.unpacked.exe", target.file_stem().unwrap_or_default().to_string_lossy()));
    if unpacked.exists() {
        std::fs::copy(&unpacked, &target).map_err(|e| e.to_string())?;
        let _ = std::fs::remove_file(&unpacked);
        Ok(format!("DRM снят. Бэкап: {}\n{stdout}", bak.display()))
    } else if !out.status.success() {
        Err(format!("Steamless ошибка:\n{stdout}"))
    } else {
        Err(format!("Steamless не создал unpacked файл:\n{stdout}"))
    }
}

// ──────────────────────────────────────────────────────────────────
// KerneLua (kernelos.org) — Discord-auth source
// ──────────────────────────────────────────────────────────────────

const KERNELUA_BASE: &str = "https://kernelos.org/games";

#[tauri::command]
pub async fn lt_kernelua_validate(token: String) -> Result<serde_json::Value, String> {
    let token = token.trim().to_string();
    if token.is_empty() { return Err("Нет токена KerneLua".into()); }
    let client = lt_client_builder().timeout(std::time::Duration::from_secs(15))
        .build().map_err(|e| e.to_string())?;
    let resp = client.get(format!("{KERNELUA_BASE}/v2.php?validate=1"))
        .header("Authorization", format!("Bearer {token}"))
        .header("User-Agent", "project-desktop")
        .send().await.map_err(|e| e.to_string())?;
    if resp.status() == reqwest::StatusCode::UNAUTHORIZED || resp.status() == reqwest::StatusCode::FORBIDDEN {
        return Err("Токен KerneLua истёк или недействителен".into());
    }
    if !resp.status().is_success() { return Err(format!("KerneLua HTTP {}", resp.status())); }
    let text = resp.text().await.map_err(|e| e.to_string())?;
    Ok(serde_json::from_str(&text).unwrap_or(serde_json::json!({"valid": true})))
}

#[tauri::command]
pub async fn lt_kernelua_fetch(app_id: u64, token: String) -> Result<String, String> {
    let token = token.trim().to_string();
    if token.is_empty() { return Err("Нет токена KerneLua".into()); }
    let client = lt_client_builder().timeout(std::time::Duration::from_secs(120))
        .build().map_err(|e| e.to_string())?;
    // Step 1: generate a temporary download link
    let resp = client.get(format!("{KERNELUA_BASE}/v2.php?gen=1&id={app_id}"))
        .header("Authorization", format!("Bearer {token}"))
        .header("User-Agent", "project-desktop")
        .send().await.map_err(|e| e.to_string())?;
    if resp.status() == reqwest::StatusCode::NOT_FOUND { return Err("Нет в KerneLua".into()); }
    if resp.status() == reqwest::StatusCode::UNAUTHORIZED || resp.status() == reqwest::StatusCode::FORBIDDEN {
        return Err("Токен KerneLua истёк".into());
    }
    if resp.status() == reqwest::StatusCode::TOO_MANY_REQUESTS { return Err("KerneLua: слишком много запросов".into()); }
    if !resp.status().is_success() { return Err(format!("KerneLua HTTP {}", resp.status())); }
    let json: serde_json::Value = resp.json().await.map_err(|e| e.to_string())?;
    let rel_url = json["url"].as_str().ok_or("KerneLua: нет ссылки на скачивание")?;
    if !rel_url.starts_with("/games/") { return Err("KerneLua: некорректная ссылка".into()); }
    // Step 2: download the file from the temporary link
    let download_url = format!("https://kernelos.org{rel_url}&r={}", rand_hex(8));
    let resp2 = client.get(&download_url)
        .header("User-Agent", "project-desktop")
        .send().await.map_err(|e| e.to_string())?;
    if !resp2.status().is_success() { return Err(format!("KerneLua download HTTP {}", resp2.status())); }
    let bytes = resp2.bytes().await.map_err(|e| e.to_string())?;
    let dest_dir = std::env::temp_dir().join("luatools_dl");
    std::fs::create_dir_all(&dest_dir).map_err(|e| e.to_string())?;
    let ext = if bytes.starts_with(b"PK") { "zip" } else { "lua" };
    let dest = dest_dir.join(format!("{app_id}_kernelua.{ext}"));
    std::fs::write(&dest, &bytes).map_err(|e| e.to_string())?;
    Ok(dest.to_string_lossy().into_owned())
}

fn rand_hex(n: usize) -> String {
    use std::fmt::Write;
    use std::time::{SystemTime, UNIX_EPOCH};
    let seed = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_nanos()).unwrap_or(0);
    let mut s = String::with_capacity(n * 2);
    let mut h = seed;
    for _ in 0..n {
        h = h.wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407);
        let _ = write!(s, "{:02x}", (h >> 33) as u8);
    }
    s
}

// ──────────────────────────────────────────────────────────────────
// SteamTools-Team/GameList — daily-updated game+DLC name lists
// ──────────────────────────────────────────────────────────────────

#[tauri::command]
pub async fn lt_gamelist_sync() -> Result<serde_json::Value, String> {
    let cache_dir = dirs_cache_dir();
    let games_file = cache_dir.join("steamtools-games.json");
    let dlc_file = cache_dir.join("steamtools-dlc.json");
    let max_age = std::time::Duration::from_secs(86400);
    let fresh = |p: &std::path::Path| -> bool {
        std::fs::metadata(p).ok()
            .and_then(|m| m.modified().ok())
            .map(|t| t.elapsed().map(|e| e < max_age).unwrap_or(false))
            .unwrap_or(false)
    };
    if fresh(&games_file) && fresh(&dlc_file) {
        return Ok(serde_json::json!({"cached": true}));
    }
    let client = lt_client_builder().timeout(std::time::Duration::from_secs(90))
        .build().map_err(|e| e.to_string())?;
    let _ = std::fs::create_dir_all(&cache_dir);
    let base = "https://raw.githubusercontent.com/SteamTools-Team/GameList/main";
    let mut updated = 0u32;
    for (url, dest) in [
        (format!("{base}/games.json"), &games_file),
        (format!("{base}/dlc.json"), &dlc_file),
    ] {
        if fresh(dest) { continue; }
        let resp = client.get(&url).header("User-Agent", "project-desktop")
            .send().await.map_err(|e| e.to_string())?;
        if !resp.status().is_success() { continue; }
        let bytes = resp.bytes().await.map_err(|e| e.to_string())?;
        std::fs::write(dest, &bytes).map_err(|e| e.to_string())?;
        updated += 1;
    }
    Ok(serde_json::json!({"updated": updated}))
}

#[tauri::command]
pub fn lt_gamelist_read() -> Result<String, String> {
    let cache_dir = dirs_cache_dir();
    let games_file = cache_dir.join("steamtools-games.json");
    if games_file.exists() {
        std::fs::read_to_string(&games_file).map_err(|e| e.to_string())
    } else {
        Ok("[]".into())
    }
}

#[tauri::command]
pub fn lt_gamelist_dlc_read() -> Result<String, String> {
    let cache_dir = dirs_cache_dir();
    let dlc_file = cache_dir.join("steamtools-dlc.json");
    if dlc_file.exists() {
        std::fs::read_to_string(&dlc_file).map_err(|e| e.to_string())
    } else {
        Ok("[]".into())
    }
}

// ──────────────────────────────────────────────────────────────────
// Sushitools / Hubcap sources
// ──────────────────────────────────────────────────────────────────

#[tauri::command]
pub async fn lt_source_sushitools(app_id: u64) -> Result<String, String> {
    let url = format!("https://raw.githubusercontent.com/sushi-dev55-alt/sushitools-games-repo-alt/refs/heads/main/{app_id}.zip");
    let client = lt_client_builder().timeout(std::time::Duration::from_secs(120))
        .build().map_err(|e| e.to_string())?;
    let resp = client.get(&url).header("User-Agent", "project-desktop")
        .send().await.map_err(|e| e.to_string())?;
    if !resp.status().is_success() { return Err(format!("Нет в sushitools: HTTP {}", resp.status())); }
    let bytes = resp.bytes().await.map_err(|e| e.to_string())?;
    let dest_dir = std::env::temp_dir().join("luatools_dl");
    std::fs::create_dir_all(&dest_dir).map_err(|e| e.to_string())?;
    let dest = dest_dir.join(format!("{app_id}_sushi.zip"));
    std::fs::write(&dest, &bytes).map_err(|e| e.to_string())?;
    Ok(dest.to_string_lossy().into_owned())
}

// Hubcap API lives under /api/v1/ (unknown paths fall through to the SPA and
// return 200 + HTML, so always check that a JSON/binary body actually came back).
const HUBCAP_API: &str = "https://hubcapmanifest.com/api/v1";

fn is_html(resp: &reqwest::Response) -> bool {
    resp.headers().get(reqwest::header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .map(|v| v.starts_with("text/html"))
        .unwrap_or(false)
}

/// Error text from a failed Hubcap response: `{"detail": "..."}` or the status.
async fn hubcap_error(resp: reqwest::Response) -> String {
    let status = resp.status();
    let body = resp.text().await.unwrap_or_default();
    let detail = serde_json::from_str::<serde_json::Value>(&body).ok()
        .and_then(|v| v["detail"].as_str().or(v["error"].as_str()).map(String::from));
    match (status.as_u16(), detail) {
        (401 | 403, Some(d)) => format!("Ключ не принят: {d}"),
        (401 | 403, None) => "Ключ не принят".into(),
        (404, _) => "Нет в Hubcap".into(),
        (_, Some(d)) => format!("Hubcap: {d}"),
        _ => format!("Hubcap HTTP {status}"),
    }
}

#[tauri::command]
pub async fn lt_hubcap_validate(api_key: String) -> Result<serde_json::Value, String> {
    let api_key = api_key.trim().to_string();
    if api_key.is_empty() { return Err("Введите API-ключ".into()); }
    let client = lt_client_builder().timeout(std::time::Duration::from_secs(15))
        .build().map_err(|e| e.to_string())?;
    let resp = client.get(format!("{HUBCAP_API}/user/stats"))
        .header("X-API-Key", &api_key)
        .header("User-Agent", "project-desktop")
        .send().await.map_err(|e| e.to_string())?;
    if !resp.status().is_success() { return Err(hubcap_error(resp).await); }
    if is_html(&resp) { return Err("Hubcap вернул страницу вместо ответа API — адрес API изменился".into()); }
    let text = resp.text().await.map_err(|e| e.to_string())?;
    Ok(serde_json::from_str(&text).unwrap_or(serde_json::json!({})))
}

/// Whether Hubcap has a manifest for the app: `null` when it doesn't (404),
/// otherwise the status JSON as Hubcap returns it.
#[tauri::command]
pub async fn lt_hubcap_status(app_id: u64, api_key: String) -> Result<serde_json::Value, String> {
    let api_key = api_key.trim().to_string();
    if api_key.is_empty() { return Err("Нет API-ключа Hubcap".into()); }
    let client = lt_client_builder().timeout(std::time::Duration::from_secs(15))
        .build().map_err(|e| e.to_string())?;
    let resp = client.get(format!("{HUBCAP_API}/status/{app_id}"))
        .header("X-API-Key", &api_key)
        .header("User-Agent", "project-desktop")
        .send().await.map_err(|e| e.to_string())?;
    if resp.status() == reqwest::StatusCode::NOT_FOUND { return Ok(serde_json::Value::Null); }
    if !resp.status().is_success() { return Err(hubcap_error(resp).await); }
    if is_html(&resp) { return Err("Hubcap вернул страницу вместо ответа API".into()); }
    let text = resp.text().await.map_err(|e| e.to_string())?;
    Ok(serde_json::from_str(&text).unwrap_or(serde_json::json!({})))
}

#[tauri::command]
pub async fn lt_hubcap_fetch(app_id: u64, api_key: String) -> Result<String, String> {
    let client = lt_client_builder().timeout(std::time::Duration::from_secs(120))
        .build().map_err(|e| e.to_string())?;
    let resp = client.get(format!("{HUBCAP_API}/manifest/{app_id}"))
        .header("X-API-Key", api_key.trim())
        .header("User-Agent", "project-desktop")
        .send().await.map_err(|e| e.to_string())?;
    if !resp.status().is_success() { return Err(hubcap_error(resp).await); }
    if is_html(&resp) { return Err("Hubcap вернул страницу вместо архива — адрес API изменился".into()); }
    let is_json = resp.headers().get(reqwest::header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok()).map(|v| v.contains("json")).unwrap_or(false);
    let bytes = if is_json {
        // Some APIs answer with a link to the archive instead of the archive itself.
        let v: serde_json::Value = resp.json().await.map_err(|e| e.to_string())?;
        let link = v["download_url"].as_str().or(v["url"].as_str())
            .ok_or_else(|| v["detail"].as_str().or(v["error"].as_str()).unwrap_or("Hubcap: нет ссылки на архив").to_string())?;
        if !link.starts_with("https://") { return Err("Hubcap: некорректная ссылка на архив".into()); }
        let r = client.get(link).header("User-Agent", "project-desktop")
            .send().await.map_err(|e| e.to_string())?;
        if !r.status().is_success() { return Err(format!("Hubcap HTTP {}", r.status())); }
        r.bytes().await.map_err(|e| e.to_string())?
    } else {
        resp.bytes().await.map_err(|e| e.to_string())?
    };
    if !bytes.starts_with(b"PK") { return Err("Hubcap вернул не zip-архив".into()); }
    let dest_dir = std::env::temp_dir().join("luatools_dl");
    std::fs::create_dir_all(&dest_dir).map_err(|e| e.to_string())?;
    let dest = dest_dir.join(format!("{app_id}_hubcap.zip"));
    std::fs::write(&dest, &bytes).map_err(|e| e.to_string())?;
    Ok(dest.to_string_lossy().into_owned())
}

// ──────────────────────────────────────────────────────────────────
// MFG local plugin HTTP API (127.0.0.1:6767)
// ──────────────────────────────────────────────────────────────────

#[tauri::command]
pub async fn lt_mfg_api(endpoint: String, method: Option<String>, body: Option<serde_json::Value>) -> Result<serde_json::Value, String> {
    let client = lt_client_builder().timeout(std::time::Duration::from_secs(10))
        .build().map_err(|e| e.to_string())?;
    let url = format!("http://127.0.0.1:6767{}", if endpoint.starts_with('/') { endpoint.clone() } else { format!("/{endpoint}") });
    let m = method.unwrap_or_else(|| "GET".into()).to_uppercase();
    let mut rb = match m.as_str() {
        "POST" => client.post(&url),
        "PUT" => client.put(&url),
        "DELETE" => client.delete(&url),
        _ => client.get(&url),
    };
    if let Some(b) = body { rb = rb.json(&b); }
    let resp = rb.send().await.map_err(|e| format!("MFG API недоступен: {e}"))?;
    if !resp.status().is_success() { return Err(format!("MFG HTTP {}", resp.status())); }
    resp.json().await.or_else(|_| Ok(serde_json::json!({"ok": true})))
}

#[tauri::command]
pub async fn lt_mfg_ping() -> bool {
    let client = match lt_client_builder().timeout(std::time::Duration::from_secs(2)).build() {
        Ok(c) => c, Err(_) => return false
    };
    client.get("http://127.0.0.1:6767/").send().await.map(|r| r.status().is_success()).unwrap_or(false)
}

// ──────────────────────────────────────────────────────────────────
// CEF/Steam WebHelper debug (127.0.0.1:8080/json)
// ──────────────────────────────────────────────────────────────────

#[tauri::command]
pub async fn lt_cef_targets() -> Result<serde_json::Value, String> {
    let client = lt_client_builder().timeout(std::time::Duration::from_secs(5))
        .build().map_err(|e| e.to_string())?;
    let targets: serde_json::Value = client.get("http://127.0.0.1:8080/json")
        .send().await.map_err(|e| format!("Steam CEF debug порт недоступен: {e}"))?
        .json().await.map_err(|e| e.to_string())?;
    Ok(targets)
}

#[tauri::command]
pub async fn lt_cef_dismiss_loaded_apps() -> Result<String, String> {
    let client = lt_client_builder().timeout(std::time::Duration::from_secs(5))
        .build().map_err(|e| e.to_string())?;
    let resp = client.post("http://127.0.0.1:6767/dismiss-loaded-apps")
        .send().await.map_err(|e| e.to_string())?;
    if resp.status().is_success() { return Ok("Загруженные приложения сброшены".into()); }
    Err(format!("HTTP {}", resp.status()))
}

// ──────────────────────────────────────────────────────────────────
// DPAPI encrypt/decrypt (Windows)
// ──────────────────────────────────────────────────────────────────

#[cfg(windows)]
fn dpapi_protect(data: &[u8], unprotect: bool) -> Result<Vec<u8>, String> {
    use windows::Win32::Security::Cryptography::{CryptProtectData, CryptUnprotectData, CRYPT_INTEGER_BLOB};
    let mut input = CRYPT_INTEGER_BLOB { cbData: data.len() as u32, pbData: data.as_ptr() as *mut u8 };
    let mut output = CRYPT_INTEGER_BLOB::default();
    unsafe {
        let ok = if unprotect {
            CryptUnprotectData(&mut input, None, None, None, None, 0, &mut output)
        } else {
            CryptProtectData(&mut input, None, None, None, None, 0, &mut output)
        };
        ok.map_err(|e| format!("DPAPI: {e}"))?;
        let v = std::slice::from_raw_parts(output.pbData, output.cbData as usize).to_vec();
        let _ = windows::Win32::Foundation::LocalFree(Some(windows::Win32::Foundation::HLOCAL(output.pbData as *mut _)));
        Ok(v)
    }
}

#[tauri::command]
pub fn lt_dpapi_encrypt(plaintext: String) -> Result<String, String> {
    #[cfg(windows)]
    {
        use base64::Engine;
        let bytes = dpapi_protect(plaintext.as_bytes(), false)?;
        Ok(base64::engine::general_purpose::STANDARD.encode(bytes))
    }
    #[cfg(not(windows))]
    { Ok(plaintext) }
}

#[tauri::command]
pub fn lt_dpapi_decrypt(ciphertext_b64: String) -> Result<String, String> {
    #[cfg(windows)]
    {
        use base64::Engine;
        let bytes = base64::engine::general_purpose::STANDARD.decode(&ciphertext_b64).map_err(|e| e.to_string())?;
        let out = dpapi_protect(&bytes, true)?;
        String::from_utf8(out).map_err(|e| e.to_string())
    }
    #[cfg(not(windows))]
    { Ok(ciphertext_b64) }
}

// ──────────────────────────────────────────────────────────────────
// Promo code redeem
// ──────────────────────────────────────────────────────────────────

#[tauri::command]
pub async fn lt_redeem_code(code: String, token: String) -> Result<serde_json::Value, String> {
    let client = lt_client_builder().timeout(std::time::Duration::from_secs(15))
        .build().map_err(|e| e.to_string())?;
    let resp = client.post("https://lua.tools/api/auth/code/redeem")
        .header("Authorization", format!("Bearer {token}"))
        .header("User-Agent", "project-desktop")
        .json(&serde_json::json!({ "code": code }))
        .send().await.map_err(|e| e.to_string())?;
    let status = resp.status();
    let json: serde_json::Value = resp.json().await.unwrap_or(serde_json::json!({}));
    if !status.is_success() {
        let msg = json["error"].as_str().unwrap_or("Ошибка").to_string();
        return Err(msg);
    }
    Ok(json)
}

// ──────────────────────────────────────────────────────────────────
// Persistent config (autoupdate, tray_lock, hubcap_key, etc.)
// ──────────────────────────────────────────────────────────────────

fn config_path() -> PathBuf {
    let base = std::env::var("LOCALAPPDATA").unwrap_or_else(|_| std::env::temp_dir().to_string_lossy().into_owned());
    PathBuf::from(base).join("project-desktop").join("luatools_config.json")
}

#[tauri::command]
pub fn lt_config_get() -> serde_json::Value {
    std::fs::read_to_string(config_path()).ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or(serde_json::json!({}))
}

#[tauri::command]
pub fn lt_config_set(key: String, value: serde_json::Value) -> Result<(), String> {
    let mut cfg = lt_config_get();
    if let Some(obj) = cfg.as_object_mut() { obj.insert(key.clone(), value); }
    else {
        let mut m = serde_json::Map::new();
        m.insert(key.clone(), value);
        cfg = serde_json::Value::Object(m);
    }
    let p = config_path();
    if let Some(parent) = p.parent() { let _ = std::fs::create_dir_all(parent); }
    std::fs::write(&p, serde_json::to_string_pretty(&cfg).unwrap_or_default()).map_err(|e| e.to_string())
}

// ──────────────────────────────────────────────────────────────────
// List AppIDs with lua in auto-update mode (no active manifest pins)
// ──────────────────────────────────────────────────────────────────

#[tauri::command]
pub fn lt_list_autoupdate_appids() -> Result<Vec<u64>, String> {
    let installed = lt_list_installed()?;
    let mut out = Vec::new();
    for item in installed {
        if let Ok(text) = lt_read_lua(item.app_id) {
            if !has_active_pin(&text) { out.push(item.app_id); }
        }
    }
    Ok(out)
}

// ──────────────────────────────────────────────────────────────────
// lua.tools login: Supabase OAuth callback on 127.0.0.1:53789
// ──────────────────────────────────────────────────────────────────
//
// Supabase (implicit flow) returns tokens in the URL *fragment*, which the
// browser never sends to a server. So /callback serves a tiny page that POSTs
// `location.hash` back to /token; we parse it and return the tokens to JS.

const LT_OAUTH_PORT: u16 = 53789;

const LT_CALLBACK_PAGE: &str = "<!doctype html><meta charset=utf-8><title>LuaTools</title>\
<body style=\"font-family:sans-serif;background:#111;color:#eee;text-align:center;padding-top:20vh\">\
<p id=m>Завершаю вход…</p><script>\
fetch('/token',{method:'POST',body:location.hash.slice(1)})\
.then(r=>{document.getElementById('m').textContent=r.ok?'Готово, можно закрыть вкладку.':'Ошибка входа.'})\
.catch(()=>{document.getElementById('m').textContent='Ошибка входа.'});\
</script>";

fn parse_form(s: &str) -> std::collections::HashMap<String, String> {
    s.split('&').filter_map(|kv| {
        let (k, v) = kv.split_once('=')?;
        Some((percent_decode(k), percent_decode(&v.replace('+', " "))))
    }).collect()
}

fn http_reply(stream: &mut std::net::TcpStream, status: &str, ctype: &str, body: &str) {
    let _ = write!(stream, "HTTP/1.1 {status}\r\nContent-Type: {ctype}\r\nContent-Length: {}\r\nConnection: close\r\nCache-Control: no-store\r\n\r\n{body}", body.len());
}

fn oauth_wait(listener: std::net::TcpListener) -> Result<serde_json::Value, String> {
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(300);
    listener.set_nonblocking(true).map_err(|e| e.to_string())?;
    while std::time::Instant::now() < deadline {
        let (mut stream, _) = match listener.accept() {
            Ok(c) => c,
            Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                std::thread::sleep(std::time::Duration::from_millis(150));
                continue;
            }
            Err(e) => return Err(e.to_string()),
        };
        let _ = stream.set_nonblocking(false);
        let _ = stream.set_read_timeout(Some(std::time::Duration::from_secs(5)));
        let mut buf = vec![0u8; 16 * 1024];
        let mut len = 0;
        // Read headers + (small) body.
        loop {
            match stream.read(&mut buf[len..]) {
                Ok(0) => break,
                Ok(n) => {
                    len += n;
                    let text = String::from_utf8_lossy(&buf[..len]);
                    if let Some(h_end) = text.find("\r\n\r\n") {
                        let cl = text[..h_end].lines()
                            .find_map(|l| l.to_ascii_lowercase().strip_prefix("content-length:").map(|v| v.trim().parse::<usize>().unwrap_or(0)))
                            .unwrap_or(0);
                        if len >= h_end + 4 + cl || len == buf.len() { break; }
                    }
                    if len == buf.len() { break; }
                }
                Err(_) => break,
            }
        }
        let text = String::from_utf8_lossy(&buf[..len]).into_owned();
        let first = text.lines().next().unwrap_or("");
        if first.starts_with("GET /callback") {
            // Error responses come back as query params.
            let query = first.split_whitespace().nth(1).and_then(|p| p.split_once('?')).map(|(_, q)| q).unwrap_or("");
            let q = parse_form(query);
            if let Some(err) = q.get("error_description").or(q.get("error")) {
                http_reply(&mut stream, "200 OK", "text/plain; charset=utf-8", "Вход отменён.");
                return Err(err.clone());
            }
            // PKCE flow: the auth code arrives as a query param; JS exchanges it.
            if let Some(code) = q.get("code") {
                http_reply(&mut stream, "200 OK", "text/plain; charset=utf-8", "Вход выполнен — можно закрыть вкладку.");
                return Ok(serde_json::json!({ "code": code }));
            }
            http_reply(&mut stream, "200 OK", "text/html; charset=utf-8", LT_CALLBACK_PAGE);
        } else if first.starts_with("POST /token") {
            let body = text.split_once("\r\n\r\n").map(|(_, b)| b).unwrap_or("");
            let f = parse_form(body.trim());
            if let Some(err) = f.get("error_description").or(f.get("error")) {
                http_reply(&mut stream, "400 Bad Request", "text/plain", "error");
                return Err(err.clone());
            }
            let Some(access) = f.get("access_token").filter(|v| !v.is_empty()) else {
                http_reply(&mut stream, "400 Bad Request", "text/plain", "no token");
                continue;
            };
            http_reply(&mut stream, "200 OK", "text/plain", "ok");
            let expires_in: u64 = f.get("expires_in").and_then(|v| v.parse().ok()).unwrap_or(3600);
            let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0);
            return Ok(serde_json::json!({
                "access_token": access,
                "refresh_token": f.get("refresh_token"),
                "expires_at": now + expires_in,
            }));
        } else {
            http_reply(&mut stream, "404 Not Found", "text/plain", "");
        }
    }
    Err("Время ожидания входа истекло".into())
}

/// Opens the lua.tools (Supabase/Discord) login page in the system browser and
/// waits up to 5 minutes for the redirect. Returns `{access_token, refresh_token, expires_at}`.
#[tauri::command]
pub async fn lt_oauth_login(app: tauri::AppHandle, login_url: String) -> Result<serde_json::Value, String> {
    use tauri_plugin_opener::OpenerExt;
    if !login_url.starts_with("https://") { return Err("Некорректный адрес входа".into()); }
    let listener = std::net::TcpListener::bind(("127.0.0.1", LT_OAUTH_PORT))
        .map_err(|e| format!("Порт {LT_OAUTH_PORT} занят: {e}"))?;
    app.opener().open_url(&login_url, None::<&str>).map_err(|e| e.to_string())?;
    tauri::async_runtime::spawn_blocking(move || oauth_wait(listener))
        .await.map_err(|e| e.to_string())?
}

// ──────────────────────────────────────────────────────────────────
// HTTP proxy for luatools-api.js
// ──────────────────────────────────────────────────────────────────
//
// The webview can't reach these APIs itself: the app CSP (connect-src) blocks
// them and the Steam store API sends no CORS headers. So JS goes through this
// command, limited to the LuaTools hosts (defaults + ones set in LuaTools settings).

const LT_HTTP_HOSTS: &[&str] = &["store.steampowered.com", "lua.tools", "db.lua.tools", "167.235.229.108", "api.steamcmd.net"];

fn lt_http_allowed(url: &reqwest::Url) -> bool {
    if !matches!(url.scheme(), "https" | "http") { return false; }
    let Some(host) = url.host_str() else { return false };
    if LT_HTTP_HOSTS.iter().any(|h| h.eq_ignore_ascii_case(host)) { return true; }
    // Hosts the user configured in LuaTools → Settings (own API server).
    let cfg = lt_config_get();
    ["api_base", "manifest_backend_url", "supabase_url"].iter()
        .filter_map(|k| cfg[*k].as_str())
        .filter_map(|v| reqwest::Url::parse(v).ok())
        .any(|u| u.host_str().map(|h| h.eq_ignore_ascii_case(host)).unwrap_or(false))
}

#[derive(Serialize)]
pub struct LtHttpResponse {
    pub status: u16,
    pub headers: std::collections::HashMap<String, String>,
    pub body: String,
}

#[tauri::command]
pub async fn lt_http(
    method: Option<String>,
    url: String,
    headers: Option<std::collections::HashMap<String, String>>,
    body: Option<String>,
) -> Result<LtHttpResponse, String> {
    let parsed = reqwest::Url::parse(&url).map_err(|e| e.to_string())?;
    if !lt_http_allowed(&parsed) {
        return Err(format!("Хост не разрешён: {}", parsed.host_str().unwrap_or("?")));
    }
    let client = lt_client_builder().timeout(std::time::Duration::from_secs(30))
        .build().map_err(|e| e.to_string())?;
    let m = reqwest::Method::from_bytes(method.as_deref().unwrap_or("GET").to_uppercase().as_bytes())
        .map_err(|e| e.to_string())?;
    let headers = headers.unwrap_or_default();
    let mut rb = client.request(m, parsed);
    if !headers.keys().any(|k| k.eq_ignore_ascii_case("user-agent")) {
        rb = rb.header("User-Agent", "project-desktop");
    }
    for (k, v) in headers { rb = rb.header(k, v); }
    if let Some(b) = body { rb = rb.body(b); }
    let resp = rb.send().await.map_err(|e| e.to_string())?;
    let status = resp.status().as_u16();
    let headers = resp.headers().iter()
        .filter_map(|(k, v)| v.to_str().ok().map(|v| (k.as_str().to_ascii_lowercase(), v.to_string())))
        .collect();
    let body = resp.text().await.unwrap_or_default();
    Ok(LtHttpResponse { status, headers, body })
}

fn variant_safe_name(name: &str) -> String {
    name.chars().map(|c| if c.is_alphanumeric() || c == '-' || c == '_' { c } else { '_' }).collect()
}

/// Rename a saved lua variant (preset). Fails if the target name exists.
#[tauri::command]
pub fn lt_rename_variant(app_id: u64, from: String, to: String) -> Result<(), String> {
    let steam = steam_path_from_registry().ok_or("Steam не найден")?;
    let dir = variants_dir(&steam, app_id);
    let (from_s, to_s) = (variant_safe_name(&from), variant_safe_name(to.trim()));
    if to_s.is_empty() { return Err("Пустое имя".into()); }
    let src = dir.join(format!("{from_s}.lua"));
    let dst = dir.join(format!("{to_s}.lua"));
    if !src.exists() { return Err("Пресет не найден".into()); }
    if dst.exists() { return Err("Пресет с таким именем уже есть".into()); }
    std::fs::rename(&src, &dst).map_err(|e| e.to_string())
}

// ──────────────────────────────────────────────────────────────────
// Game data: achievements / stats (read-only) and playtime
// ──────────────────────────────────────────────────────────────────
//
// Achievements and stats come from Steam's local cache:
//   appcache/stats/UserGameStatsSchema_<appid>.bin        — schema (names, icons…)
//   appcache/stats/UserGameStats_<accountid>_<appid>.bin  — user progress
// Both are binary KeyValues. Playtime lives in the text VDF
//   userdata/<accountid>/config/localconfig.vdf → …/Steam/apps/<appid>/Playtime (minutes)
// which Steam only reads at startup and rewrites on exit.

fn kv_read_cstr(b: &[u8], pos: &mut usize) -> Result<String, String> {
    let start = *pos;
    let len = b.get(start..).and_then(|s| s.iter().position(|&c| c == 0)).ok_or("KeyValues: строка без конца")?;
    *pos = start + len + 1;
    Ok(String::from_utf8_lossy(&b[start..start + len]).into_owned())
}

fn kv_take<'a>(b: &'a [u8], pos: &mut usize, n: usize) -> Result<&'a [u8], String> {
    if *pos + n > b.len() { return Err("KeyValues: обрезанный файл".into()); }
    let v = &b[*pos..*pos + n];
    *pos += n;
    Ok(v)
}

/// Binary KeyValues → JSON. Types: 0 subsection, 1 string, 2 int32, 3 float32,
/// 4 pointer, 5 wide string, 6 color, 7 uint64, 10 int64, 8/11 end of section.
fn kv_parse_binary(b: &[u8], pos: &mut usize, depth: u32) -> Result<serde_json::Value, String> {
    if depth > 64 { return Err("KeyValues: слишком глубокая вложенность".into()); }
    let mut map = serde_json::Map::new();
    while *pos < b.len() {
        let t = b[*pos];
        *pos += 1;
        if t == 8 || t == 11 { return Ok(serde_json::Value::Object(map)); }
        let key = kv_read_cstr(b, pos)?;
        let val = match t {
            0 => kv_parse_binary(b, pos, depth + 1)?,
            1 => serde_json::Value::String(kv_read_cstr(b, pos)?),
            2 | 4 | 6 => {
                let v = kv_take(b, pos, 4)?;
                serde_json::json!(i32::from_le_bytes([v[0], v[1], v[2], v[3]]))
            }
            3 => {
                let v = kv_take(b, pos, 4)?;
                serde_json::json!(f32::from_le_bytes([v[0], v[1], v[2], v[3]]) as f64)
            }
            5 => {
                let mut units: Vec<u16> = Vec::new();
                loop {
                    let v = kv_take(b, pos, 2)?;
                    let u = u16::from_le_bytes([v[0], v[1]]);
                    if u == 0 { break; }
                    units.push(u);
                }
                serde_json::Value::String(String::from_utf16_lossy(&units))
            }
            7 => {
                let v = kv_take(b, pos, 8)?;
                serde_json::json!(u64::from_le_bytes([v[0], v[1], v[2], v[3], v[4], v[5], v[6], v[7]]))
            }
            10 => {
                let v = kv_take(b, pos, 8)?;
                serde_json::json!(i64::from_le_bytes([v[0], v[1], v[2], v[3], v[4], v[5], v[6], v[7]]))
            }
            other => return Err(format!("KeyValues: неизвестный тип {other}")),
        };
        map.insert(key, val);
    }
    Ok(serde_json::Value::Object(map))
}

fn kv_read_file(path: &Path) -> Option<serde_json::Value> {
    let bytes = std::fs::read(path).ok()?;
    let mut pos = 0;
    kv_parse_binary(&bytes, &mut pos, 0).ok()
}

/// userdata/<accountid> of the account that used Steam last (newest localconfig.vdf).
fn steam_user_dir(steam: &str) -> Option<(String, PathBuf)> {
    let root = PathBuf::from(steam).join("userdata");
    std::fs::read_dir(&root).ok()?
        .flatten()
        .filter(|e| e.file_name().to_string_lossy().chars().all(|c| c.is_ascii_digit()))
        .filter_map(|e| {
            let lc = e.path().join("config").join("localconfig.vdf");
            let mtime = std::fs::metadata(&lc).and_then(|m| m.modified()).ok()?;
            Some((mtime, e.file_name().to_string_lossy().into_owned(), e.path()))
        })
        .max_by_key(|(t, _, _)| *t)
        .map(|(_, id, p)| (id, p))
}

#[derive(Serialize)]
pub struct GameStatsData {
    pub account_id: Option<String>,
    /// Root of UserGameStatsSchema_<appid>.bin, or null when Steam hasn't cached it yet.
    pub schema: Option<serde_json::Value>,
    /// Root of UserGameStats_<account>_<appid>.bin, or null when there's no progress.
    pub user: Option<serde_json::Value>,
}

#[tauri::command]
pub fn lt_game_stats(app_id: u64) -> Result<GameStatsData, String> {
    let steam = steam_path_from_registry().ok_or("Steam не найден")?;
    let dir = PathBuf::from(&steam).join("appcache").join("stats");
    let schema = kv_read_file(&dir.join(format!("UserGameStatsSchema_{app_id}.bin")));
    let account = steam_user_dir(&steam).map(|(id, _)| id);
    let user = account.as_ref()
        .and_then(|a| kv_read_file(&dir.join(format!("UserGameStats_{a}_{app_id}.bin"))));
    Ok(GameStatsData { account_id: account, schema, user })
}

// ── localconfig.vdf (text KeyValues) ───────────────────────────────

enum VdfTok {
    /// Quoted string; start/end are byte offsets of the content between the quotes.
    Str { start: usize, end: usize, text: String },
    Open(usize),
    Close,
}

fn vdf_tokens(s: &str) -> Vec<VdfTok> {
    let b = s.as_bytes();
    let mut out = Vec::new();
    let mut i = 0;
    while i < b.len() {
        match b[i] {
            b'"' => {
                let start = i + 1;
                let mut j = start;
                let mut text: Vec<u8> = Vec::new();
                while j < b.len() && b[j] != b'"' {
                    if b[j] == b'\\' && j + 1 < b.len() {
                        text.push(b[j + 1]);
                        j += 2;
                        continue;
                    }
                    text.push(b[j]);
                    j += 1;
                }
                out.push(VdfTok::Str { start, end: j, text: String::from_utf8_lossy(&text).into_owned() });
                i = j + 1;
            }
            b'{' => { out.push(VdfTok::Open(i)); i += 1; }
            b'}' => { out.push(VdfTok::Close); i += 1; }
            b'/' if i + 1 < b.len() && b[i + 1] == b'/' => {
                while i < b.len() && b[i] != b'\n' { i += 1; }
            }
            _ => i += 1,
        }
    }
    out
}

struct AppBlock {
    open: usize,
    playtime: Option<(usize, usize, String)>,
    last_played: Option<String>,
    launch_options: Option<(usize, usize, String)>,
}

/// Finds …/Steam/apps/<appid> { … } in localconfig.vdf.
fn vdf_find_app_block(s: &str, app_id: u64) -> Option<AppBlock> {
    let toks = vdf_tokens(s);
    let app = app_id.to_string();
    let mut path: Vec<String> = Vec::new();
    let mut depth_inside: Option<usize> = None;
    let mut result: Option<AppBlock> = None;
    let mut i = 0;
    while i < toks.len() {
        match &toks[i] {
            VdfTok::Str { text, .. } => {
                match toks.get(i + 1) {
                    Some(VdfTok::Open(pos)) => {
                        path.push(text.clone());
                        let n = path.len();
                        if depth_inside.is_none() && n >= 3 && path[n - 1] == app
                            && path[n - 2].eq_ignore_ascii_case("apps")
                            && path[n - 3].eq_ignore_ascii_case("steam")
                        {
                            depth_inside = Some(n);
                            result = Some(AppBlock { open: *pos, playtime: None, last_played: None, launch_options: None });
                        }
                        i += 2;
                    }
                    Some(VdfTok::Str { start, end, text: val }) => {
                        if let (Some(d), Some(r)) = (depth_inside, result.as_mut()) {
                            if path.len() == d {
                                if text.eq_ignore_ascii_case("Playtime") { r.playtime = Some((*start, *end, val.clone())); }
                                if text.eq_ignore_ascii_case("LastPlayed") { r.last_played = Some(val.clone()); }
                                if text.eq_ignore_ascii_case("LaunchOptions") { r.launch_options = Some((*start, *end, val.clone())); }
                            }
                        }
                        i += 2;
                    }
                    _ => i += 1,
                }
            }
            VdfTok::Open(_) => { path.push(String::new()); i += 1; }
            VdfTok::Close => {
                if depth_inside == Some(path.len()) { return result; }
                path.pop();
                i += 1;
            }
        }
    }
    result
}

fn localconfig_path(steam: &str) -> Result<PathBuf, String> {
    let (_, dir) = steam_user_dir(steam).ok_or("Не найден профиль Steam (userdata)")?;
    Ok(dir.join("config").join("localconfig.vdf"))
}

#[derive(Serialize)]
pub struct PlaytimeInfo {
    pub minutes: Option<u64>,
    pub last_played: Option<u64>,
    /// Steam has a section for this game in localconfig.vdf (else it can't be edited yet).
    pub known: bool,
    pub steam_running: bool,
}

#[tauri::command]
pub fn lt_get_playtime(app_id: u64) -> Result<PlaytimeInfo, String> {
    let steam = steam_path_from_registry().ok_or("Steam не найден")?;
    let text = std::fs::read_to_string(localconfig_path(&steam)?).map_err(|e| format!("localconfig.vdf: {e}"))?;
    let block = vdf_find_app_block(&text, app_id);
    let minutes = block.as_ref().and_then(|b| b.playtime.as_ref()).and_then(|(_, _, v)| v.parse().ok());
    let last_played = block.as_ref().and_then(|b| b.last_played.as_ref()).and_then(|v| v.parse().ok());
    Ok(PlaytimeInfo { minutes, last_played, known: block.is_some(), steam_running: is_steam_running() })
}

fn vdf_escape(v: &str) -> String { v.replace('\\', "\\\\").replace('"', "\\\"") }

/// Sets `key` inside Steam/apps/<appid> in localconfig.vdf (Playtime or LaunchOptions).
fn write_app_value(path: &Path, app_id: u64, key: &str, value: &str) -> Result<(), String> {
    let text = std::fs::read_to_string(path).map_err(|e| format!("localconfig.vdf: {e}"))?;
    let block = vdf_find_app_block(&text, app_id)
        .ok_or("Steam ещё не записал данные об этой игре — запустите её хотя бы раз")?;
    let existing = if key == "LaunchOptions" { &block.launch_options } else { &block.playtime };
    let value = vdf_escape(value);
    let new_text = match existing {
        Some((start, end, _)) => format!("{}{}{}", &text[..*start], value, &text[*end..]),
        None => {
            // Insert right after the block's "{", reusing that line's indentation.
            let line_start = text[..block.open].rfind('\n').map(|p| p + 1).unwrap_or(0);
            let indent: String = text[line_start..block.open].chars().take_while(|c| c.is_whitespace()).collect();
            let at = block.open + 1;
            format!("{}\n{}\t\"{}\"\t\t\"{}\"{}", &text[..at], indent, key, value, &text[at..])
        }
    };
    let _ = std::fs::copy(path, path.with_extension("vdf.ltbak"));
    let tmp = path.with_extension("vdf.lttmp");
    std::fs::write(&tmp, new_text).map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, path).map_err(|e| e.to_string())
}

fn write_playtime(path: &Path, app_id: u64, minutes: u64) -> Result<(), String> {
    write_app_value(path, app_id, "Playtime", &minutes.to_string())
}

/// Sets playtime (minutes). Steam must be closed while writing — it rewrites
/// localconfig.vdf on exit — so it is stopped and started again afterwards.
#[tauri::command]
pub async fn lt_set_playtime(app_id: u64, minutes: u64) -> Result<(), String> {
    if minutes > 100_000_000 { return Err("Слишком большое значение".into()); }
    let steam = steam_path_from_registry().ok_or("Steam не найден")?;
    let path = localconfig_path(&steam)?;
    let was_running = stop_steam().await;
    let res = write_playtime(&path, app_id, minutes);
    if was_running { start_steam(&steam); }
    res
}

#[tauri::command]
pub fn lt_get_launch_options(app_id: u64) -> Result<Option<String>, String> {
    let steam = steam_path_from_registry().ok_or("Steam не найден")?;
    let text = std::fs::read_to_string(localconfig_path(&steam)?).map_err(|e| format!("localconfig.vdf: {e}"))?;
    Ok(vdf_find_app_block(&text, app_id).and_then(|b| b.launch_options.map(|(_, _, v)| v)))
}

/// Writes Steam's own per-game launch options (what Properties → General shows).
#[tauri::command]
pub async fn lt_set_launch_options(app_id: u64, value: String) -> Result<(), String> {
    if value.len() > 4096 || value.contains(['\n', '\r']) { return Err("Недопустимые параметры".into()); }
    let steam = steam_path_from_registry().ok_or("Steam не найден")?;
    let path = localconfig_path(&steam)?;
    let was_running = stop_steam().await;
    let res = write_app_value(&path, app_id, "LaunchOptions", &value);
    if was_running { start_steam(&steam); }
    res
}

// ── External tools (CloudRedirect manager, SteamAutoCrack) ─────────
//
// Downloaded from their GitHub releases into our own folder and only ever
// launched from there — never from a path the webview passes in.

/// `files` are plain release assets (each may have a `<name>.sha256` next to it);
/// `zip` is an archive extracted as a whole. Names are fixed so downloads go
/// through `releases/latest/download/<name>` — no GitHub API call, so the
/// 60 req/h anonymous API limit can't break installs.
struct ExtTool { key: &'static str, repo: &'static str, exe: &'static str, files: &'static [&'static str], zip: Option<&'static str> }

const EXT_TOOLS: &[ExtTool] = &[
    ExtTool { key: "cloudredirect", repo: "madoiscool/CloudRedirect", exe: "CloudRedirect.exe", files: &["CloudRedirect.exe", "cloud_redirect.dll"], zip: None },
    ExtTool { key: "steamautocrack", repo: "SteamAutoCracks/Steam-auto-crack", exe: "SteamAutoCrack.exe", files: &[], zip: Some("SteamAutoCrack.zip") },
];

fn ext_tool(key: &str) -> Result<&'static ExtTool, String> {
    EXT_TOOLS.iter().find(|t| t.key == key).ok_or_else(|| format!("Неизвестный инструмент: {key}"))
}

fn ext_tool_dir(t: &ExtTool) -> PathBuf {
    let base = std::env::var("LOCALAPPDATA").unwrap_or_else(|_| std::env::temp_dir().to_string_lossy().into_owned());
    PathBuf::from(base).join("project-desktop").join(t.key)
}

/// The tool's exe anywhere under its folder (zips may nest a directory).
fn ext_tool_exe(t: &ExtTool) -> Option<PathBuf> {
    fn walk(dir: &Path, name: &str, depth: u8) -> Option<PathBuf> {
        let rd = std::fs::read_dir(dir).ok()?;
        let mut subdirs = vec![];
        for e in rd.flatten() {
            let p = e.path();
            if p.is_dir() { subdirs.push(p); }
            else if p.file_name().map(|f| f.to_string_lossy().eq_ignore_ascii_case(name)).unwrap_or(false) { return Some(p); }
        }
        if depth == 0 { return None; }
        subdirs.iter().find_map(|d| walk(d, name, depth - 1))
    }
    walk(&ext_tool_dir(t), t.exe, 2)
}

#[derive(Serialize)]
pub struct ExtToolInfo { pub installed: bool, pub version: Option<String> }

#[tauri::command]
pub fn lt_tool_info(tool: String) -> Result<ExtToolInfo, String> {
    let t = ext_tool(&tool)?;
    let version = std::fs::read_to_string(ext_tool_dir(t).join("version.txt")).ok().map(|s| s.trim().to_string());
    Ok(ExtToolInfo { installed: ext_tool_exe(t).is_some(), version })
}

/// Latest release tag from the `releases/latest` redirect (web, not API).
async fn gh_latest_tag(client: &reqwest::Client, repo: &str) -> Result<String, String> {
    let resp = client.get(format!("https://github.com/{repo}/releases/latest"))
        .header("User-Agent", "project-desktop").send().await.map_err(|e| e.to_string())?;
    let url = resp.url().clone();
    let segs: Vec<&str> = url.path_segments().map(|s| s.collect()).unwrap_or_default();
    match segs.iter().position(|s| *s == "tag") {
        Some(i) if i + 1 < segs.len() => Ok(segs[i + 1].to_string()),
        _ => Err("GitHub: не удалось узнать последнюю версию".into()),
    }
}

#[tauri::command]
pub async fn lt_tool_latest(tool: String) -> Result<String, String> {
    let t = ext_tool(&tool)?;
    let client = lt_client_builder().timeout(std::time::Duration::from_secs(20)).build().map_err(|e| e.to_string())?;
    gh_latest_tag(&client, t.repo).await
}

#[tauri::command]
pub async fn lt_tool_install(tool: String) -> Result<String, String> {
    let t = ext_tool(&tool)?;
    let client = lt_client_builder().timeout(std::time::Duration::from_secs(600)).build().map_err(|e| e.to_string())?;
    let tag = gh_latest_tag(&client, t.repo).await.unwrap_or_else(|_| "latest".into());
    let asset = |name: &str| format!("https://github.com/{}/releases/latest/download/{name}", t.repo);

    let dir = ext_tool_dir(t);
    let staging = dir.with_extension("new");
    let _ = std::fs::remove_dir_all(&staging);
    std::fs::create_dir_all(&staging).map_err(|e| e.to_string())?;
    let fail = |e: String| { let _ = std::fs::remove_dir_all(&staging); e };

    for name in t.files {
        let bytes = gh_download(&client, &asset(name)).await.map_err(&fail)?;
        // Checksum is optional (older releases have none) but enforced when present.
        if let Ok(sum) = gh_download(&client, &asset(&format!("{name}.sha256"))).await {
            let sum = String::from_utf8_lossy(&sum).to_lowercase();
            let want = sum.split_whitespace().next().unwrap_or("");
            if want.len() == 64 && want != sha256_hex(&bytes) {
                return Err(fail(format!("{name}: контрольная сумма не совпала — файл повреждён или подменён")));
            }
        }
        std::fs::write(staging.join(name), &bytes).map_err(|e| fail(e.to_string()))?;
    }
    if let Some(zip_name) = t.zip {
        let bytes = gh_download(&client, &asset(zip_name)).await.map_err(&fail)?;
        let mut archive = zip::ZipArchive::new(std::io::Cursor::new(bytes)).map_err(|e| fail(e.to_string()))?;
        for i in 0..archive.len() {
            let mut entry = archive.by_index(i).map_err(|e| fail(e.to_string()))?;
            if entry.is_dir() { continue; }
            let Some((out_path, _)) = zip_entry_dest(&staging, &entry) else { continue };
            if let Some(p) = out_path.parent() { let _ = std::fs::create_dir_all(p); }
            let mut buf = vec![];
            std::io::Read::read_to_end(&mut entry, &mut buf).map_err(|e| fail(e.to_string()))?;
            std::fs::write(&out_path, &buf).map_err(|e| fail(e.to_string()))?;
        }
    }
    let _ = std::fs::write(staging.join("version.txt"), &tag);
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::rename(&staging, &dir).map_err(|e| format!("Не удалось заменить папку (инструмент запущен?): {e}"))?;
    if ext_tool_exe(t).is_none() { return Err(format!("{} не найден в релизе {tag}", t.exe)); }
    Ok(tag)
}

#[tauri::command]
pub fn lt_tool_launch(tool: String) -> Result<(), String> {
    let t = ext_tool(&tool)?;
    let exe = ext_tool_exe(t).ok_or("Инструмент не установлен")?;
    std::process::Command::new(&exe)
        .current_dir(exe.parent().unwrap_or(Path::new(".")))
        .spawn().map(|_| ()).map_err(|e| e.to_string())
}

/// Candidate game executables for Steamless, biggest first (the real game exe
/// is almost always the largest; launchers, crash reporters and redists are skipped).
#[tauri::command]
pub fn lt_find_game_exes(app_id: u64) -> Result<Vec<String>, String> {
    let info = lt_game_install_path(app_id);
    let root = PathBuf::from(info.path.ok_or("Игра не установлена")?);
    const SKIP: &[&str] = &["unins", "crash", "redist", "vcredist", "dxsetup", "dotnet", "ue4prereq", "launcherhelper", "easyanticheat", "battleye", "cefprocess", "setup"];
    let mut found: Vec<(u64, PathBuf)> = vec![];
    fn walk(dir: &Path, depth: u8, out: &mut Vec<(u64, PathBuf)>) {
        let Ok(rd) = std::fs::read_dir(dir) else { return };
        for e in rd.flatten() {
            let p = e.path();
            if p.is_dir() {
                if depth > 0 { walk(&p, depth - 1, out); }
            } else if p.extension().map(|x| x.eq_ignore_ascii_case("exe")).unwrap_or(false) {
                out.push((e.metadata().map(|m| m.len()).unwrap_or(0), p));
            }
        }
    }
    walk(&root, 3, &mut found);
    found.retain(|(_, p)| {
        let n = p.file_name().map(|f| f.to_string_lossy().to_lowercase()).unwrap_or_default();
        !SKIP.iter().any(|s| n.contains(s)) && !n.ends_with(".unpacked.exe")
    });
    found.sort_by(|a, b| b.0.cmp(&a.0));
    Ok(found.into_iter().take(10).map(|(_, p)| p.to_string_lossy().into_owned()).collect())
}

// ── Store button (Steam CEF injection) ─────────────────────────────
//
// With Steam started with -cef-enable-debugging, its CEF exposes DevTools on
// 127.0.0.1:8080. We add an "Add to LuaProject" button to store app pages via
// Runtime.evaluate and poll the clicks back the same way, so the page never
// makes network requests of its own (no CSP / mixed-content issues).

const STORE_CDP_PORT: u16 = 8080;
static STORE_LOOP: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);
static STORE_STATUS: std::sync::Mutex<Vec<(u64, String)>> = std::sync::Mutex::new(Vec::new());

const STORE_INJECT_JS: &str = r##"(() => {
  const m = location.href.match(/store\.steampowered\.com\/app\/(\d+)/);
  if (!m) return;
  if (!window.__ltp) {
    window.__ltp = { q: [] };
    const add = () => {
      if (document.getElementById("ltp-add")) return;
      const host = document.querySelector("#queueActionsCtn") || document.querySelector(".game_area_purchase_game");
      if (!host) return;
      const b = document.createElement("a");
      b.id = "ltp-add";
      b.className = "btnv6_blue_hoverfade btn_medium";
      b.style.marginLeft = "6px";
      b.href = "#";
      const s = document.createElement("span");
      s.textContent = "Добавить в LuaProject";
      b.appendChild(s);
      b.addEventListener("click", e => { e.preventDefault(); window.__ltp.q.push(m[1]); s.textContent = "Отправлено…"; });
      host.appendChild(b);
    };
    add();
    new MutationObserver(add).observe(document.documentElement, { childList: true, subtree: true });
  }
  window.__ltpSet = (id, text) => { const b = document.getElementById("ltp-add"); if (b && m[1] === String(id)) b.firstChild.textContent = text; };
})();"##;

fn cdp_http_get(path: &str) -> Result<String, String> {
    use std::io::{Read, Write};
    let mut s = std::net::TcpStream::connect_timeout(&([127, 0, 0, 1], STORE_CDP_PORT).into(), std::time::Duration::from_secs(2))
        .map_err(|e| e.to_string())?;
    s.set_read_timeout(Some(std::time::Duration::from_secs(5))).ok();
    write!(s, "GET {path} HTTP/1.0\r\nHost: 127.0.0.1:{STORE_CDP_PORT}\r\n\r\n").map_err(|e| e.to_string())?;
    let mut buf = Vec::new();
    s.read_to_end(&mut buf).map_err(|e| e.to_string())?;
    let text = String::from_utf8_lossy(&buf).into_owned();
    Ok(text.split_once("\r\n\r\n").map(|(_, b)| b.to_string()).unwrap_or_default())
}

/// Minimal WebSocket client: enough for one CDP request/response on localhost.
struct Ws(std::net::TcpStream);

impl Ws {
    fn connect(url: &str) -> Result<Ws, String> {
        use std::io::{Read, Write};
        let rest = url.strip_prefix("ws://").ok_or("bad ws url")?;
        let (hostport, path) = rest.split_once('/').ok_or("bad ws url")?;
        // Only ever talk to the local DevTools endpoint.
        if hostport != format!("127.0.0.1:{STORE_CDP_PORT}") && hostport != format!("localhost:{STORE_CDP_PORT}") {
            return Err("unexpected ws host".into());
        }
        let mut s = std::net::TcpStream::connect_timeout(&([127, 0, 0, 1], STORE_CDP_PORT).into(), std::time::Duration::from_secs(2))
            .map_err(|e| e.to_string())?;
        s.set_read_timeout(Some(std::time::Duration::from_secs(5))).ok();
        let nonce = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_nanos()).unwrap_or(0);
        use base64::Engine;
        let key = base64::engine::general_purpose::STANDARD.encode(nonce.to_le_bytes());
        write!(s, "GET /{path} HTTP/1.1\r\nHost: {hostport}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: {key}\r\nSec-WebSocket-Version: 13\r\n\r\n")
            .map_err(|e| e.to_string())?;
        let mut head = Vec::new();
        let mut byte = [0u8; 1];
        while !head.ends_with(b"\r\n\r\n") {
            s.read_exact(&mut byte).map_err(|e| e.to_string())?;
            head.push(byte[0]);
            if head.len() > 8192 { return Err("ws handshake too long".into()); }
        }
        if !head.starts_with(b"HTTP/1.1 101") { return Err("ws handshake refused".into()); }
        Ok(Ws(s))
    }

    fn send_text(&mut self, text: &str) -> Result<(), String> {
        use std::io::Write;
        let payload = text.as_bytes();
        let mut frame = vec![0x81u8];
        let len = payload.len();
        if len < 126 { frame.push(0x80 | len as u8); }
        else if len <= 0xFFFF { frame.push(0x80 | 126); frame.extend_from_slice(&(len as u16).to_be_bytes()); }
        else { frame.push(0x80 | 127); frame.extend_from_slice(&(len as u64).to_be_bytes()); }
        let mask: [u8; 4] = (std::process::id() ^ 0x5a3c_9e17).to_le_bytes();
        frame.extend_from_slice(&mask);
        frame.extend(payload.iter().enumerate().map(|(i, b)| b ^ mask[i % 4]));
        self.0.write_all(&frame).map_err(|e| e.to_string())
    }

    fn read_text(&mut self) -> Result<String, String> {
        use std::io::Read;
        let mut msg = Vec::new();
        loop {
            let mut h = [0u8; 2];
            self.0.read_exact(&mut h).map_err(|e| e.to_string())?;
            let fin = h[0] & 0x80 != 0;
            let opcode = h[0] & 0x0F;
            let mut len = (h[1] & 0x7F) as u64;
            if len == 126 { let mut b = [0u8; 2]; self.0.read_exact(&mut b).map_err(|e| e.to_string())?; len = u16::from_be_bytes(b) as u64; }
            else if len == 127 { let mut b = [0u8; 8]; self.0.read_exact(&mut b).map_err(|e| e.to_string())?; len = u64::from_be_bytes(b); }
            if len > 64 * 1024 * 1024 { return Err("ws frame too large".into()); }
            let mut mask = [0u8; 4];
            if h[1] & 0x80 != 0 { self.0.read_exact(&mut mask).map_err(|e| e.to_string())?; }
            let mut data = vec![0u8; len as usize];
            self.0.read_exact(&mut data).map_err(|e| e.to_string())?;
            if h[1] & 0x80 != 0 { for (i, b) in data.iter_mut().enumerate() { *b ^= mask[i % 4]; } }
            match opcode {
                0x8 => return Err("ws closed".into()),
                0x9 | 0xA => continue,
                _ => msg.extend_from_slice(&data),
            }
            if fin { return Ok(String::from_utf8_lossy(&msg).into_owned()); }
        }
    }
}

/// Runs one expression in a CEF tab and returns its string result.
fn cdp_eval(ws_url: &str, expr: &str) -> Result<String, String> {
    let mut ws = Ws::connect(ws_url)?;
    let req = serde_json::json!({ "id": 1, "method": "Runtime.evaluate", "params": { "expression": expr, "returnByValue": true } });
    ws.send_text(&req.to_string())?;
    for _ in 0..50 {
        let msg: serde_json::Value = serde_json::from_str(&ws.read_text()?).unwrap_or_default();
        if msg["id"] == 1 { return Ok(msg["result"]["result"]["value"].as_str().unwrap_or("").to_string()); }
    }
    Err("no CDP reply".into())
}

fn store_tick(app: &tauri::AppHandle) {
    let Ok(body) = cdp_http_get("/json") else { return };
    let targets: Vec<serde_json::Value> = serde_json::from_str(&body).unwrap_or_default();
    let statuses: Vec<(u64, String)> = std::mem::take(&mut *STORE_STATUS.lock().unwrap_or_else(|e| e.into_inner()));
    let mut set_js = String::new();
    for (id, text) in &statuses {
        set_js.push_str(&format!("window.__ltpSet&&window.__ltpSet({id},{});", serde_json::Value::String(text.clone())));
    }
    for t in targets {
        let url = t["url"].as_str().unwrap_or("");
        let Some(ws_url) = t["webSocketDebuggerUrl"].as_str() else { continue };
        if t["type"] != "page" || !url.contains("store.steampowered.com/app/") { continue; }
        let expr = format!("{STORE_INJECT_JS}{set_js}(()=>{{const q=(window.__ltp&&window.__ltp.q)||[];if(window.__ltp)window.__ltp.q=[];return q.join(',');}})()");
        if let Ok(v) = cdp_eval(ws_url, &expr) {
            for id in v.split(',').filter_map(|x| x.trim().parse::<u64>().ok()) {
                let _ = app.emit("lt-store-add", id);
            }
        }
    }
}

fn store_loop_start(app: tauri::AppHandle) {
    if STORE_LOOP.swap(true, std::sync::atomic::Ordering::SeqCst) { return; }
    std::thread::spawn(move || {
        while lt_config_get()["store_button"].as_bool().unwrap_or(false) {
            store_tick(&app);
            std::thread::sleep(std::time::Duration::from_millis(1500));
        }
        STORE_LOOP.store(false, std::sync::atomic::Ordering::SeqCst);
    });
}

#[derive(Serialize)]
pub struct StoreButtonState { pub enabled: bool, pub cef_debug: bool }

#[tauri::command]
pub fn lt_store_button_state(app: tauri::AppHandle) -> StoreButtonState {
    let enabled = lt_config_get()["store_button"].as_bool().unwrap_or(false);
    if enabled { store_loop_start(app); }
    StoreButtonState { enabled, cef_debug: cdp_http_get("/json/version").is_ok() }
}

/// Turns the store button on/off. Steam needs -cef-enable-debugging for it,
/// so it is restarted with that flag when enabling.
#[tauri::command]
pub async fn lt_store_button_set(app: tauri::AppHandle, enabled: bool) -> Result<(), String> {
    lt_config_set("store_button".into(), serde_json::Value::Bool(enabled))?;
    if enabled {
        if let Some(steam) = steam_path_from_registry() {
            if cdp_http_get("/json/version").is_err() {
                stop_steam().await;
                start_steam(&steam);
            }
        }
        store_loop_start(app);
    }
    Ok(())
}

#[tauri::command]
pub fn lt_store_status(app_id: u64, text: String) {
    let text: String = text.chars().take(80).collect();
    STORE_STATUS.lock().unwrap_or_else(|e| e.into_inner()).push((app_id, text));
}

#[cfg(test)]
mod parity_tests {
    #[test]
    fn vdf_launch_options_roundtrip() {
        let dir = std::env::temp_dir().join(format!("lt_vdf_{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let p = dir.join("localconfig.vdf");
        std::fs::write(&p, "\"UserLocalConfigStore\"\n{\n\t\"Software\"\n\t{\n\t\t\"Valve\"\n\t\t{\n\t\t\t\"Steam\"\n\t\t\t{\n\t\t\t\t\"apps\"\n\t\t\t\t{\n\t\t\t\t\t\"10\"\n\t\t\t\t\t{\n\t\t\t\t\t\t\"Playtime\"\t\t\"5\"\n\t\t\t\t\t}\n\t\t\t\t}\n\t\t\t}\n\t\t}\n\t}\n}\n").unwrap();
        super::write_app_value(&p, 10, "LaunchOptions", "-novid \"x\"").unwrap();
        let t = std::fs::read_to_string(&p).unwrap();
        let b = super::vdf_find_app_block(&t, 10).unwrap();
        assert_eq!(b.launch_options.unwrap().2, "-novid \"x\"");
        assert_eq!(b.playtime.unwrap().2, "5");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn parses_manifest_pins() {
        let lua = "addappid(1)\nsetManifestid(553851, \"123456789\", 0)\n-- setManifestid(553852,\"42\")\nsetmanifestid(x, \"1\")";
        assert_eq!(super::manifest_pins(lua), vec![(553851, "123456789".to_string()), (553852, "42".to_string())]);
    }
}
