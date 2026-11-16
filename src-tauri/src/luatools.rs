// LuaTools интеграция: нахождение Steam, парсинг/установка lua-файлов,
// скачивание манифестов через lua.tools API.

use std::io::{Read, Write};
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

// ── Steam detection ─────────────────────────────────────────────────

fn steam_path_from_registry() -> Option<String> {
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
        "lua" => install_lua(&steam, &path, app_id, auto_update),
        "manifest" => install_manifest(&steam, &path),
        "zip" => install_zip(&steam, &path, app_id, auto_update),
        _ => Err(format!("Неизвестный тип файла: .{ext}")),
    }
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
            let tmp = std::env::temp_dir().join(format!("lt_{}.lua", app_id));
            match extract_entry(&mut entry, &tmp) {
                Ok(()) => {
                    match install_lua(steam, &tmp.to_string_lossy(), app_id, auto_update) {
                        Ok(_) => lua_installed = true,
                        Err(_) => failed.push(name),
                    }
                    let _ = std::fs::remove_file(&tmp);
                }
                Err(_) => failed.push(name),
            }
        } else if lower.ends_with(".manifest") {
            let fname = Path::new(&name)
                .file_name()
                .map(|f| f.to_string_lossy().into_owned())
                .unwrap_or(name.clone());
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

fn stamp_now(path: &Path) {
    let _ = filetime::set_file_mtime(path, filetime::FileTime::now());
}

// ── Remove installed lua ────────────────────────────────────────────

#[tauri::command]
pub fn lt_remove_lua(app_id: u64) -> Result<(), String> {
    let steam = steam_path_from_registry().ok_or("Steam не найден")?;
    let path = stplugin_dir(&steam).join(format!("{app_id}.lua"));
    if path.exists() {
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
    let sp = stplugin_dir(&steam);
    let dll = sp.join("stplug-in.dll");
    let dll64 = sp.join("stplug-in64.dll");
    let bst_dll = PathBuf::from(&steam).join("BetterSteamTools.dll");
    let mode = if bst_dll.exists() {
        Some("BetterSteamTools".into())
    } else if dll.exists() || dll64.exists() {
        Some("stplug-in".into())
    } else {
        None
    };
    let installed = mode.is_some();
    let dll_path = if bst_dll.exists() {
        Some(bst_dll.to_string_lossy().into_owned())
    } else if dll.exists() {
        Some(dll.to_string_lossy().into_owned())
    } else if dll64.exists() {
        Some(dll64.to_string_lossy().into_owned())
    } else {
        None
    };
    let version = dll_path.as_ref().and_then(|p| {
        let meta = std::fs::metadata(p).ok()?;
        let modified = meta.modified().ok()?;
        let dt = modified.duration_since(std::time::UNIX_EPOCH).ok()?;
        let secs = dt.as_secs();
        let days = secs / 86400;
        let y = 1970 + days / 365;
        let m = (days % 365) / 30 + 1;
        let d = (days % 365) % 30 + 1;
        Some(format!("{y}.{m}.{d}"))
    });
    PluginStatus { installed, version, dll_path, mode }
}

// ── Restart Steam ──────────────────────────────────────────────────

#[tauri::command]
pub fn lt_restart_steam() -> Result<(), String> {
    #[cfg(windows)]
    {
        let steam = steam_path_from_registry().ok_or("Steam не найден")?;
        let exe = PathBuf::from(&steam).join("steam.exe");
        if !exe.exists() {
            return Err("steam.exe не найден".into());
        }
        let _ = std::process::Command::new("taskkill")
            .args(["/F", "/IM", "steam.exe"])
            .output();
        std::thread::sleep(std::time::Duration::from_secs(2));
        std::process::Command::new(&exe)
            .spawn()
            .map_err(|e| e.to_string())?;
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

    let file = std::fs::File::open(&zip_path).map_err(|e| e.to_string())?;
    let mut archive = zip::ZipArchive::new(file).map_err(|e| e.to_string())?;

    let mut extracted = 0u32;
    let mut backed_up = false;
    let mut manifest = Vec::new();

    for i in 0..archive.len() {
        let mut entry = match archive.by_index(i) { Ok(e) => e, Err(_) => continue };
        if entry.is_dir() { continue; }
        let name = entry.name().to_string();
        let dest = PathBuf::from(&game_path).join(&name);

        if dest.exists() {
            let bak = backup_dir.join(&name);
            if let Some(p) = bak.parent() { let _ = std::fs::create_dir_all(p); }
            let _ = std::fs::copy(&dest, &bak);
            backed_up = true;
        }
        manifest.push(name.clone());

        if let Some(p) = dest.parent() { let _ = std::fs::create_dir_all(p); }
        let _ = extract_entry(&mut entry, &dest);
        extracted += 1;
    }

    let manifest_path = backup_dir.join("_manifest.txt");
    let _ = std::fs::write(&manifest_path, manifest.join("\n"));

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

    for line in manifest.lines() {
        let line = line.trim();
        if line.is_empty() { continue; }
        let game_file = PathBuf::from(&game_path).join(line);
        let backup_file = backup_dir.join(line);
        if backup_file.exists() {
            let _ = std::fs::copy(&backup_file, &game_file);
            reverted += 1;
        } else if game_file.exists() {
            let _ = std::fs::remove_file(&game_file);
            reverted += 1;
        }
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

// ── Install unlocker mode (BST/OST from GitHub) ───────────────────

#[tauri::command]
pub async fn lt_install_mode(mode: String) -> Result<String, String> {
    let steam = steam_path_from_registry().ok_or("Steam не найден")?;

    if is_steam_running() {
        let _ = std::process::Command::new("taskkill")
            .args(["/F", "/IM", "steam.exe"])
            .output();
        std::thread::sleep(std::time::Duration::from_secs(3));
    }

    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(120))
        .build().map_err(|e| e.to_string())?;

    match mode.as_str() {
        "bst" => install_bst(&client, &steam).await,
        "ost" => install_ost(&client, &steam).await,
        "ltsp" => install_ltsp(&client, &steam).await,
        "custom" => {
            remove_unlocker_dlls(&steam);
            Ok("Custom режим установлен".into())
        }
        _ => Err(format!("Неизвестный режим: {mode}")),
    }
}

async fn install_ltsp(client: &reqwest::Client, steam: &str) -> Result<String, String> {
    remove_unlocker_dlls(steam);
    let json: serde_json::Value = client.get("https://api.github.com/repos/madoiscool/LTSP/releases/latest")
        .header("User-Agent", "project-desktop").send().await.map_err(|e| e.to_string())?
        .json().await.map_err(|e| e.to_string())?;
    let assets = json["assets"].as_array().ok_or("Нет assets")?;
    let zip_asset = assets.iter()
        .find(|a| a["name"].as_str().map(|n| n.ends_with(".zip")).unwrap_or(false))
        .ok_or("Zip не найден")?;
    let dl_url = zip_asset["browser_download_url"].as_str().ok_or("Нет URL")?;
    let tag = json["tag_name"].as_str().unwrap_or("unknown");
    let bytes = client.get(dl_url).header("User-Agent", "project-desktop")
        .send().await.map_err(|e| e.to_string())?
        .bytes().await.map_err(|e| e.to_string())?;
    let tmp = std::env::temp_dir().join("ltsp_release.zip");
    std::fs::write(&tmp, &bytes).map_err(|e| e.to_string())?;
    let file = std::fs::File::open(&tmp).map_err(|e| e.to_string())?;
    let mut archive = zip::ZipArchive::new(file).map_err(|e| e.to_string())?;
    for i in 0..archive.len() {
        let mut entry = match archive.by_index(i) { Ok(e) => e, Err(_) => continue };
        if entry.is_dir() { continue; }
        let name = entry.name().to_string();
        let fname = Path::new(&name).file_name().map(|f| f.to_string_lossy().into_owned()).unwrap_or(name.clone());
        if fname.ends_with(".dll") {
            let dest = PathBuf::from(steam).join(&fname);
            let _ = extract_entry(&mut entry, &dest);
        }
    }
    let _ = std::fs::remove_file(&tmp);
    Ok(format!("LTSP {tag} установлен"))
}

fn remove_unlocker_dlls(steam: &str) {
    let targets = ["BetterSteamTools.dll", "dwmapi.dll", "xinput1_4.dll"];
    for name in targets {
        let p = PathBuf::from(steam).join(name);
        if p.exists() { let _ = std::fs::remove_file(&p); }
    }
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
        .find(|a| a["name"].as_str().map(|n| n.ends_with(".zip")).unwrap_or(false))
        .ok_or("Zip не найден в релизе")?;
    let dl_url = zip_asset["browser_download_url"].as_str().ok_or("Нет URL")?;
    let tag = json["tag_name"].as_str().unwrap_or("unknown");

    let bytes = client.get(dl_url)
        .header("User-Agent", "project-desktop")
        .send().await.map_err(|e| e.to_string())?
        .bytes().await.map_err(|e| e.to_string())?;

    let tmp = std::env::temp_dir().join("bst_release.zip");
    std::fs::write(&tmp, &bytes).map_err(|e| e.to_string())?;

    let file = std::fs::File::open(&tmp).map_err(|e| e.to_string())?;
    let mut archive = zip::ZipArchive::new(file).map_err(|e| e.to_string())?;
    for i in 0..archive.len() {
        let mut entry = match archive.by_index(i) { Ok(e) => e, Err(_) => continue };
        if entry.is_dir() { continue; }
        let name = entry.name().to_string();
        let fname = Path::new(&name).file_name().map(|f| f.to_string_lossy().into_owned()).unwrap_or(name.clone());
        if fname.ends_with(".dll") {
            let dest = PathBuf::from(steam).join(&fname);
            let _ = extract_entry(&mut entry, &dest);
        }
    }
    let _ = std::fs::remove_file(&tmp);
    Ok(format!("BetterSteamTools {tag} установлен"))
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

    let bytes = client.get(dl_url)
        .header("User-Agent", "project-desktop")
        .send().await.map_err(|e| e.to_string())?
        .bytes().await.map_err(|e| e.to_string())?;

    let tmp = std::env::temp_dir().join("ost_release.zip");
    std::fs::write(&tmp, &bytes).map_err(|e| e.to_string())?;

    let file = std::fs::File::open(&tmp).map_err(|e| e.to_string())?;
    let mut archive = zip::ZipArchive::new(file).map_err(|e| e.to_string())?;
    for i in 0..archive.len() {
        let mut entry = match archive.by_index(i) { Ok(e) => e, Err(_) => continue };
        if entry.is_dir() { continue; }
        let name = entry.name().to_string();
        let fname = Path::new(&name).file_name().map(|f| f.to_string_lossy().into_owned()).unwrap_or(name.clone());
        if fname.ends_with(".dll") {
            let dest = PathBuf::from(steam).join(&fname);
            let _ = extract_entry(&mut entry, &dest);
        }
    }
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
    let cr_dll = PathBuf::from(&steam).join("CloudRedirect.dll");
    let installed = cr_dll.exists();
    let mut enabled = false;
    if toml_path.exists() {
        if let Ok(content) = std::fs::read_to_string(&toml_path) {
            enabled = content.lines().any(|l| {
                let t = l.trim();
                t.starts_with("cloud_redirect") && t.contains("true")
            });
        }
    }
    let bst = PathBuf::from(&steam).join("BetterSteamTools.dll").exists();
    let ost = PathBuf::from(&steam).join("dwmapi.dll").exists();
    CloudRedirectState { supported: bst || ost, enabled, installed }
}

#[tauri::command]
pub fn lt_cloud_redirect_toggle(enable: bool) -> Result<(), String> {
    let steam = steam_path_from_registry().ok_or("Steam не найден")?;
    let toml_path = PathBuf::from(&steam).join("opensteamtool.toml");
    let mut content = std::fs::read_to_string(&toml_path).unwrap_or_default();
    let key = "cloud_redirect";
    if content.contains(key) {
        let new_content: String = content.lines().map(|l| {
            if l.trim().starts_with(key) {
                format!("{key} = {enable}")
            } else { l.to_string() }
        }).collect::<Vec<_>>().join("\n");
        content = new_content;
    } else {
        content.push_str(&format!("\n{key} = {enable}\n"));
    }
    std::fs::write(&toml_path, &content).map_err(|e| e.to_string())?;
    Ok(())
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
    let client = reqwest::Client::builder()
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

// ── Download from lua.tools API (proxied through Tauri for auth) ────

#[derive(Deserialize)]
struct ApiError {
    error: Option<String>,
}

#[tauri::command]
pub async fn lt_download(
    url: String,
    token: String,
    dest_dir: String,
) -> Result<String, String> {
    let client = reqwest::Client::builder()
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
        .and_then(|v| {
            v.split("filename=").nth(1).map(|s| s.trim_matches('"').to_string())
        })
        .unwrap_or_else(|| "download.zip".to_string());

    let dest = PathBuf::from(&dest_dir).join(&filename);
    let bytes = resp.bytes().await.map_err(|e| e.to_string())?;
    std::fs::create_dir_all(&dest_dir).map_err(|e| e.to_string())?;
    std::fs::write(&dest, &bytes).map_err(|e| e.to_string())?;

    Ok(dest.to_string_lossy().into_owned())
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
    let client = reqwest::Client::builder().timeout(std::time::Duration::from_secs(20))
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
    let client = reqwest::Client::builder().timeout(std::time::Duration::from_secs(60))
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

#[tauri::command]
pub async fn lt_doh_resolve(host: String) -> Result<Vec<String>, String> {
    let client = reqwest::Client::builder().timeout(std::time::Duration::from_secs(10))
        .build().map_err(|e| e.to_string())?;
    let url = format!("https://1.1.1.1/dns-query?name={}&type=A", host);
    let json: serde_json::Value = client.get(&url)
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
    let client = reqwest::Client::builder().timeout(std::time::Duration::from_secs(15))
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
    let client = reqwest::Client::builder().timeout(std::time::Duration::from_secs(300))
        .build().map_err(|e| e.to_string())?;
    let bytes = client.get(&url).header("User-Agent", "project-desktop")
        .send().await.map_err(|e| e.to_string())?
        .bytes().await.map_err(|e| e.to_string())?;
    let tmp = std::env::temp_dir().join("ddm.zip");
    std::fs::write(&tmp, &bytes).map_err(|e| e.to_string())?;
    let file = std::fs::File::open(&tmp).map_err(|e| e.to_string())?;
    let mut archive = zip::ZipArchive::new(file).map_err(|e| e.to_string())?;
    for i in 0..archive.len() {
        let mut entry = match archive.by_index(i) { Ok(e) => e, Err(_) => continue };
        if entry.is_dir() { continue; }
        let name = entry.name().to_string();
        let fname = Path::new(&name).file_name().map(|f| f.to_string_lossy().into_owned()).unwrap_or(name);
        let dest = dir.join(&fname);
        let _ = extract_entry(&mut entry, &dest);
    }
    let _ = std::fs::remove_file(&tmp);
    Ok(dir.to_string_lossy().into_owned())
}

#[tauri::command]
pub fn lt_depot_downloader_run(args: Vec<String>) -> Result<String, String> {
    let exe = ddm_dir().join("DepotDownloaderMod.exe");
    if !exe.exists() { return Err("DepotDownloaderMod не установлен".into()); }
    let out = std::process::Command::new(&exe).args(&args)
        .output().map_err(|e| e.to_string())?;
    let stdout = String::from_utf8_lossy(&out.stdout).into_owned();
    let stderr = String::from_utf8_lossy(&out.stderr).into_owned();
    if !out.status.success() { return Err(format!("{stdout}\n{stderr}")); }
    Ok(stdout)
}

// ──────────────────────────────────────────────────────────────────
// SteamAutoCrack launcher
// ──────────────────────────────────────────────────────────────────

#[tauri::command]
pub fn lt_steam_autocrack_launch(exe_path: String, args: Vec<String>) -> Result<(), String> {
    let p = PathBuf::from(&exe_path);
    if !p.exists() { return Err("SteamAutoCrack.exe не найден".into()); }
    std::process::Command::new(&p).args(&args).spawn().map_err(|e| e.to_string())?;
    Ok(())
}

// ──────────────────────────────────────────────────────────────────
// Sushitools / Hubcap sources
// ──────────────────────────────────────────────────────────────────

#[tauri::command]
pub async fn lt_source_sushitools(app_id: u64) -> Result<String, String> {
    let url = format!("https://raw.githubusercontent.com/sushi-dev55-alt/sushitools-games-repo-alt/refs/heads/main/{app_id}.zip");
    let client = reqwest::Client::builder().timeout(std::time::Duration::from_secs(120))
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

#[tauri::command]
pub async fn lt_hubcap_validate(api_key: String) -> Result<serde_json::Value, String> {
    let client = reqwest::Client::builder().timeout(std::time::Duration::from_secs(15))
        .build().map_err(|e| e.to_string())?;
    let resp = client.get("https://hubcapmanifest.com/api/validate")
        .header("X-API-Key", &api_key)
        .header("User-Agent", "project-desktop")
        .send().await.map_err(|e| e.to_string())?;
    if !resp.status().is_success() { return Err(format!("HTTP {}", resp.status())); }
    resp.json().await.map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn lt_hubcap_fetch(app_id: u64, api_key: String) -> Result<String, String> {
    let client = reqwest::Client::builder().timeout(std::time::Duration::from_secs(120))
        .build().map_err(|e| e.to_string())?;
    let url = format!("https://hubcapmanifest.com/api/games/{app_id}");
    let resp = client.get(&url)
        .header("X-API-Key", &api_key)
        .header("User-Agent", "project-desktop")
        .send().await.map_err(|e| e.to_string())?;
    if !resp.status().is_success() { return Err(format!("Hubcap HTTP {}", resp.status())); }
    let bytes = resp.bytes().await.map_err(|e| e.to_string())?;
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
    let client = reqwest::Client::builder().timeout(std::time::Duration::from_secs(10))
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
    let client = match reqwest::Client::builder().timeout(std::time::Duration::from_secs(2)).build() {
        Ok(c) => c, Err(_) => return false
    };
    client.get("http://127.0.0.1:6767/").send().await.map(|r| r.status().is_success()).unwrap_or(false)
}

// ──────────────────────────────────────────────────────────────────
// CEF/Steam WebHelper debug (127.0.0.1:8080/json)
// ──────────────────────────────────────────────────────────────────

#[tauri::command]
pub async fn lt_cef_targets() -> Result<serde_json::Value, String> {
    let client = reqwest::Client::builder().timeout(std::time::Duration::from_secs(5))
        .build().map_err(|e| e.to_string())?;
    let targets: serde_json::Value = client.get("http://127.0.0.1:8080/json")
        .send().await.map_err(|e| format!("Steam CEF debug порт недоступен: {e}"))?
        .json().await.map_err(|e| e.to_string())?;
    Ok(targets)
}

#[tauri::command]
pub async fn lt_cef_dismiss_loaded_apps() -> Result<String, String> {
    let client = reqwest::Client::builder().timeout(std::time::Duration::from_secs(5))
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
        let slice = std::slice::from_raw_parts(output.pbData, output.cbData as usize);
        let v = slice.to_vec();
        // LocalFree is not exposed in windows 0.62 — tiny leak per call (few hundred bytes),
        // acceptable for an infrequent op (login/save session). Alternative would be LocalFree
        // via FFI, but that pulls another crate in.
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
    let client = reqwest::Client::builder().timeout(std::time::Duration::from_secs(15))
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
            let has_pin = text.lines().any(|l| {
                let t = l.trim_start();
                !t.starts_with("--") && t.contains("setManifestid")
            });
            if !has_pin { out.push(item.app_id); }
        }
    }
    Ok(out)
}
