
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

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp() -> PathBuf {
        let d = std::env::temp_dir().join(format!("project_scope_{}", std::process::id()));
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    #[test]
    fn explicitly_picked_file_is_readable_but_not_writable() {
        let dir = tmp();
        let file = dir.join("input.wav");
        std::fs::write(&file, b"x").unwrap();
        let scope = FileScope::default();
        scope.allow_read(&file);

        assert!(scope.check_read(&file.to_string_lossy()).is_ok());
        assert!(scope.check_write(&file.to_string_lossy()).is_err());
        let _ = std::fs::remove_file(&file);
    }

    #[test]
    fn attack_arbitrary_file_read_via_asset_protocol_is_blocked() {
        let scope = FileScope::default();
        for target in [
            "/etc/shadow",
            "/root/.ssh/id_rsa",
            "C:\\Users\\studio\\.ssh\\id_rsa",
            "C:\\Users\\studio\\AppData\\Roaming\\ProjectDesktop\\settings.json",
        ] {
            assert!(scope.check_read(target).is_err(), "чтение {target} должно быть отклонено");
        }
    }

    #[test]
    fn attack_write_into_autostart_is_blocked() {
        let scope = FileScope::default();
        let startup = "C:\\Users\\studio\\AppData\\Roaming\\Microsoft\\Windows\\Start Menu\\Programs\\Startup\\upd.bat";
        assert!(scope.check_write(startup).is_err());
        assert!(scope.check_write("/etc/cron.daily/backup").is_err());
        assert!(scope.check_write("/root/.bashrc").is_err());
    }

    #[test]
    fn attack_cannot_escape_the_chosen_output_folder() {
        let dir = tmp();
        let out_dir = dir.join("renders");
        std::fs::create_dir_all(&out_dir).unwrap();
        let scope = FileScope::default();
        scope.allow_write_dir(&out_dir);

        for escape in [
            out_dir.join("..").join("..").join("evil.exe"),
            out_dir.join("..").join("sibling.mp4"),
        ] {
            assert!(
                scope.check_write(&escape.to_string_lossy()).is_err(),
                "выход за пределы выбранной папки должен быть отклонён: {escape:?}"
            );
        }
        let _ = std::fs::remove_dir_all(&out_dir);
    }

    #[test]
    fn attack_overwriting_the_source_is_refused_even_when_both_paths_are_allowed() {
        let dir = tmp();
        let master = dir.join("master.mov");
        std::fs::write(&master, "важный исходник").unwrap();
        let scope = FileScope::default();
        scope.allow_read(&master);
        scope.allow_write(&master);

        let input = scope.check_read(&master.to_string_lossy()).unwrap();
        let output = scope.check_write(&master.to_string_lossy()).unwrap();
        assert!(refuse_input_as_output(&input, &output).is_err());
        let _ = std::fs::remove_file(&master);
    }

    #[test]
    fn writing_over_the_input_is_refused() {
        let dir = tmp();
        let file = dir.join("same.mp4");
        std::fs::write(&file, b"x").unwrap();
        assert!(refuse_input_as_output(&file, &file).is_err());
        assert!(refuse_input_as_output(&file, &dir.join("other.mp4")).is_ok());
        let _ = std::fs::remove_file(&file);
    }
}
