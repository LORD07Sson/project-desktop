
use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use serde::Deserialize;
use tauri::Manager;
use tauri_plugin_dialog::DialogExt;

#[derive(Default)]
pub struct FileScope {
    readable: Mutex<HashSet<PathBuf>>,
    writable: Mutex<HashSet<PathBuf>>,
    writable_dirs: Mutex<HashSet<PathBuf>>,
}

fn normalize(path: &Path) -> PathBuf {
    if let Ok(c) = path.canonicalize() {
        return c;
    }
    match (path.parent(), path.file_name()) {
        (Some(parent), Some(name)) => match parent.canonicalize() {
            Ok(c) => c.join(name),
            Err(_) => path.to_path_buf(),
        },
        _ => path.to_path_buf(),
    }
}

impl FileScope {
    pub fn allow_read(&self, path: &Path) {
        if let Ok(mut set) = self.readable.lock() {
            set.insert(normalize(path));
        }
    }

    pub fn allow_write(&self, path: &Path) {
        if let Ok(mut set) = self.writable.lock() {
            set.insert(normalize(path));
        }
    }

    pub fn allow_write_dir(&self, path: &Path) {
        if let Ok(mut set) = self.writable_dirs.lock() {
            set.insert(normalize(path));
        }
    }

    pub fn check_read(&self, path: &str) -> Result<PathBuf, String> {
        let p = normalize(Path::new(path));
        let ok = self.readable.lock().map(|s| s.contains(&p)).unwrap_or(false);
        if ok {
            Ok(p)
        } else {
            Err(DENIED_READ.into())
        }
    }

    pub fn check_write(&self, path: &str) -> Result<PathBuf, String> {
        let p = normalize(Path::new(path));
        let explicit = self.writable.lock().map(|s| s.contains(&p)).unwrap_or(false);
        if explicit {
            return Ok(p);
        }
        let in_dir = self
            .writable_dirs
            .lock()
            .map(|dirs| dirs.iter().any(|d| p.starts_with(d)))
            .unwrap_or(false);
        if in_dir {
            Ok(p)
        } else {
            Err(DENIED_WRITE.into())
        }
    }
}

const DENIED_READ: &str =
    "Этот файл не выбирали в приложении — доступ отклонён. Добавьте файл кнопкой выбора или перетащите в окно.";
const DENIED_WRITE: &str =
    "Запись по этому пути не разрешена — выберите файл или папку через диалог сохранения.";

pub fn refuse_input_as_output(input: &Path, output: &Path) -> Result<(), String> {
    if normalize(input) == normalize(output) {
        return Err("Результат нельзя писать поверх исходника — выберите другое имя файла.".into());
    }
    Ok(())
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PickFilter {
    pub name: String,
    pub extensions: Vec<String>,
}

fn dialog_builder(app: &tauri::AppHandle, filters: &[PickFilter]) -> tauri_plugin_dialog::FileDialogBuilder<tauri::Wry> {
    let mut b = app.dialog().file();
    for f in filters {
        let exts: Vec<&str> = f.extensions.iter().map(String::as_str).collect();
        b = b.add_filter(&f.name, &exts);
    }
    b
}

pub fn pick_input_files(
    app: &tauri::AppHandle,
    filters: Vec<PickFilter>,
    multiple: bool,
) -> Vec<String> {
    let scope = app.state::<FileScope>();
    let builder = dialog_builder(app, &filters);
    let picked: Vec<PathBuf> = if multiple {
        builder
            .blocking_pick_files()
            .unwrap_or_default()
            .into_iter()
            .filter_map(|f| f.into_path().ok())
            .collect()
    } else {
        builder
            .blocking_pick_file()
            .and_then(|f| f.into_path().ok())
            .into_iter()
            .collect()
    };
    for p in &picked {
        scope.allow_read(p);
    }
    picked.iter().map(|p| p.to_string_lossy().into_owned()).collect()
}

pub fn pick_output_file(
    app: &tauri::AppHandle,
    default_name: Option<String>,
    filters: Vec<PickFilter>,
) -> Option<String> {
    let scope = app.state::<FileScope>();
    let mut builder = dialog_builder(app, &filters);
    if let Some(name) = default_name.as_deref() {
        if let Some(base) = Path::new(name).file_name() {
            builder = builder.set_file_name(base.to_string_lossy().into_owned());
        }
    }
    let path = builder.blocking_save_file()?.into_path().ok()?;
    scope.allow_write(&path);
    Some(path.to_string_lossy().into_owned())
}

pub fn pick_output_dir(app: &tauri::AppHandle) -> Option<String> {
    let scope = app.state::<FileScope>();
    let path = app.dialog().file().blocking_pick_folder()?.into_path().ok()?;
    scope.allow_write_dir(&path);
    Some(path.to_string_lossy().into_owned())
}
