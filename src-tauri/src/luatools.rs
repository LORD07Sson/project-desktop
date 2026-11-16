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
