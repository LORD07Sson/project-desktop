//! Локальная медиатека для «Релизов»: папка с аниме, имена файлов из которой
//! сопоставляются с раздачами («уже скачано»). Папку выбирает пользователь
//! нативным диалогом, её путь запоминается здесь, в каталоге данных программы:
//! повторное сканирование читает его оттуда, а не из вебвью. Наружу уходят
//! только имена файлов и имя родительской папки — содержимое не читается.

use serde::Serialize;
use std::path::{Path, PathBuf};
use tauri::Manager;
use tauri_plugin_dialog::DialogExt;

const EXTS: [&str; 7] = ["mkv", "mp4", "avi", "webm", "ts", "m2ts", "mov"];
const MAX_DEPTH: usize = 4;
const MAX_FILES: usize = 8000;
const MAX_VISITED: usize = 40_000;

#[derive(Serialize, Clone, Debug, PartialEq)]
pub struct LibFile {
    pub name: String,
    pub folder: String,
}

#[derive(Serialize)]
pub struct LibraryScan {
    pub dir: String,
    pub files: Vec<LibFile>,
    pub truncated: bool,
}

fn store_path(app: &tauri::AppHandle) -> Option<PathBuf> {
    app.path().app_data_dir().ok().map(|d| d.join("nyaa_library.txt"))
}

fn is_media(name: &str) -> bool {
    Path::new(name)
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| EXTS.contains(&e.to_ascii_lowercase().as_str()))
        .unwrap_or(false)
}

/// Обход папки в ширину: глубина и число файлов ограничены, ссылки на каталоги
/// не раскрываются (чтобы не уйти за пределы выбранной папки).
pub fn scan_dir(root: &Path) -> (Vec<LibFile>, bool) {
    let mut out = Vec::new();
    let mut truncated = false;
    let mut visited = 0usize;
    let mut level: Vec<(PathBuf, usize)> = vec![(root.to_path_buf(), 0)];
    while let Some((dir, depth)) = level.pop() {
        let Ok(rd) = std::fs::read_dir(&dir) else { continue };
        let folder = dir.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
        for entry in rd.flatten() {
            visited += 1;
            if visited > MAX_VISITED {
                return (out, true);
            }
            let Ok(ft) = entry.file_type() else { continue };
            let name = entry.file_name().to_string_lossy().into_owned();
            if ft.is_dir() {
                if depth < MAX_DEPTH {
                    level.push((entry.path(), depth + 1));
                }
            } else if ft.is_file() && is_media(&name) {
                if out.len() >= MAX_FILES {
                    truncated = true;
                    continue;
                }
                out.push(LibFile { name, folder: folder.clone() });
            }
        }
    }
    (out, truncated)
}

fn scan_to_result(dir: &Path) -> LibraryScan {
    let (files, truncated) = scan_dir(dir);
    LibraryScan { dir: dir.to_string_lossy().into_owned(), files, truncated }
}

/// Выбрать папку медиатеки и просканировать её.
#[tauri::command(async)]
pub fn library_pick(app: tauri::AppHandle) -> Option<LibraryScan> {
    let dir = app.dialog().file().blocking_pick_folder()?.into_path().ok()?;
    if let Some(p) = store_path(&app) {
        if let Some(parent) = p.parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        let _ = std::fs::write(p, dir.to_string_lossy().as_bytes());
    }
    Some(scan_to_result(&dir))
}

/// Повторное сканирование ранее выбранной папки.
#[tauri::command(async)]
pub fn library_rescan(app: tauri::AppHandle) -> Option<LibraryScan> {
    let saved = std::fs::read_to_string(store_path(&app)?).ok()?;
    let dir = PathBuf::from(saved.trim());
    if !dir.is_dir() {
        return None;
    }
    Some(scan_to_result(&dir))
}

/// Забыть папку медиатеки.
#[tauri::command(async)]
pub fn library_clear(app: tauri::AppHandle) {
    if let Some(p) = store_path(&app) {
        let _ = std::fs::remove_file(p);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn media_extensions_are_case_insensitive() {
        assert!(is_media("Show - 01.MKV"));
        assert!(is_media("a.b.mp4"));
        assert!(!is_media("notes.txt"));
        assert!(!is_media("mkv"));
    }

    #[test]
    fn scans_nested_folders_and_skips_other_files() {
        let base = std::env::temp_dir().join(format!("lib-test-{}", std::process::id()));
        let sub = base.join("Show Season 2");
        std::fs::create_dir_all(&sub).unwrap();
        std::fs::write(sub.join("[G] Show - 01 [1080p].mkv"), b"x").unwrap();
        std::fs::write(sub.join("readme.txt"), b"x").unwrap();
        std::fs::write(base.join("movie.mp4"), b"x").unwrap();
        let (files, truncated) = scan_dir(&base);
        let _ = std::fs::remove_dir_all(&base);
        assert!(!truncated);
        assert_eq!(files.len(), 2);
        assert!(files.iter().any(|f| f.name.ends_with("01 [1080p].mkv") && f.folder == "Show Season 2"));
    }
}
