//! Апскейл картинок (обложка/баннер тайтла) нейросетью ×4.
//!
//! Движок — upscayl-bin (поддерживаемый форк realesrgan-ncnn-vulkan от проекта Upscayl: свежий Vulkan, исправления;
//! работает на любой видеокарте с Vulkan). Модели — из Upscayl: digital-art-4x под аниме и рисунки, ultrasharp-4x —
//! самая резкая (реалистичные модели не берём: у нас только аниме). В установщик ничего не кладём:
//! при первом апскейле докачиваем закреплённый релиз движка и только выбранную модель (по закреплённому коммиту),
//! сверяем SHA-256, зашитую в приложение, и складываем в %LOCALAPPDATA%\Project Desktop\tools\upscayl — рядом с
//! докачанным ffmpeg (audio_qc::downloaded_tools_dir).
//!
//! Картинку присылает вебвью байтами, результат (PNG) уходит обратно сырым ответом IPC — для превью «до/после»;
//! сохраняется он отдельной командой, только в путь, выбранный в диалоге сохранения (file_scope).

use crate::audio_qc::hidden_command;
use sha2::{Digest, Sha256};
use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::Mutex;
use std::time::Instant;
use tauri::Emitter;

const ENGINE_URL: &str =
    "https://github.com/upscayl/upscayl-ncnn/releases/download/20251207-174704/upscayl-bin-20251207-174704-windows.zip";
const ENGINE_SHA256: &str = "1f0f65c5d2ade866555e2ac467d35952c35a47080a4060fe56a1ab028f67258a";
const EXE: &str = "upscayl-bin.exe";
/// Модели Upscayl по закреплённому коммиту (resources/models).
const MODELS_URL: &str = "https://raw.githubusercontent.com/upscayl/upscayl/e1aeaf1217b6061b4212b87c9fd421984f73e437/resources/models";

struct Model {
    key: &'static str,
    name: &'static str,
    param_sha: &'static str,
    bin_sha: &'static str,
}

const MODELS: [Model; 2] = [
    Model {
        key: "anime",
        name: "digital-art-4x",
        param_sha: "2b8fb6e0ae4d2d85704ca08c119a2f5ea40add4f2ecd512eb7f4cd44b6127ed4",
        bin_sha: "fe01c269cfd10cdef8e018ab66ebe750cf79c7af4d1f9c16c737e1295229bacc",
    },
    Model {
        key: "sharp",
        name: "ultrasharp-4x",
        param_sha: "0136ca83686809a8f17f7111f11b951e8db93610e24b7f4137c9ffe4dbc4a806",
        bin_sha: "fb3e279d40d4cddb44db4e684d59e68d0aa39852c8cc14dc3f23ccc7e6eee9c1",
    },
];
/// Больше — не обложка, а что-то не то; и памяти видеокарте хватит не на всё.
const MAX_INPUT: usize = 25 * 1024 * 1024;

/// Последний результат — его и сохраняет `save`, чтобы не гонять PNG через вебвью второй раз.
static LAST: Mutex<Option<PathBuf>> = Mutex::new(None);

fn engine_dir() -> Option<PathBuf> {
    std::env::var_os("LOCALAPPDATA").map(|l| PathBuf::from(l).join("Project Desktop").join("tools").join("upscayl"))
}

fn progress(app: &tauri::AppHandle, fraction: f64, label: &str) {
    let _ = app.emit("upscale-progress", serde_json::json!({ "fraction": fraction, "label": label }));
}

/// Скачивает файл, на лету считая SHA-256; при несовпадении суммы удаляет его. `span` — доля общей полосы прогресса.
async fn download(
    app: &tauri::AppHandle,
    client: &reqwest::Client,
    url: &str,
    sha: &str,
    to: &Path,
    label: &str,
    span: (f64, f64),
) -> Result<(), String> {
    let mut resp = client.get(url).send().await.map_err(|e| format!("Не удалось скачать {label}: {e}"))?;
    if !resp.status().is_success() {
        return Err(format!("Не удалось скачать {label}: сервер ответил {}", resp.status()));
    }
    let total = resp.content_length().unwrap_or(0);
    let tmp = to.with_extension("part");
    let mut file = std::fs::File::create(&tmp).map_err(|e| format!("Не удалось создать файл загрузки: {e}"))?;
    let mut hasher = Sha256::new();
    let (mut done, mut last) = (0u64, Instant::now());
    while let Some(chunk) = resp.chunk().await.map_err(|e| format!("Обрыв при скачивании {label}: {e}"))? {
        file.write_all(&chunk).map_err(|e| format!("Не удалось записать {label}: {e}"))?;
        hasher.update(&chunk);
        done += chunk.len() as u64;
        if last.elapsed().as_millis() > 300 {
            last = Instant::now();
            let frac = if total > 0 { done as f64 / total as f64 } else { 0.0 };
            progress(app, span.0 + (span.1 - span.0) * frac, &format!("Скачиваю {label} (один раз): {:.1} из {:.1} МБ", done as f64 / 1_048_576.0, total as f64 / 1_048_576.0));
        }
    }
    drop(file);
    let hash = format!("{:x}", hasher.finalize());
    if hash != sha {
        let _ = std::fs::remove_file(&tmp);
        return Err(format!("Сумма SHA-256 скачанного файла ({label}) не совпала — файл удалён."));
    }
    std::fs::rename(&tmp, to).map_err(|e| format!("Не удалось сохранить {label}: {e}"))
}

/// Докачивает движок и нужную модель, если их ещё нет. Возвращает папку движка.
async fn ensure(app: &tauri::AppHandle, client: &reqwest::Client, model: &Model) -> Result<PathBuf, String> {
    let dir = engine_dir().ok_or("Не найдена папка пользователя для движка апскейла.")?;
    let models = dir.join("models");
    std::fs::create_dir_all(&models).map_err(|e| format!("Не удалось создать папку {dir:?}: {e}"))?;
    if !dir.join(EXE).is_file() {
        let zip = dir.join("engine.zip");
        download(app, client, ENGINE_URL, ENGINE_SHA256, &zip, "движок апскейла", (0.0, 0.08)).await?;
        let dir2 = dir.clone();
        tauri::async_runtime::spawn_blocking(move || extract(&dir2, &zip))
            .await
            .map_err(|e| format!("Распаковка движка не завершилась: {e}"))??;
    }
    for (ext, sha, span) in [("param", model.param_sha, (0.08, 0.1)), ("bin", model.bin_sha, (0.1, 0.45))] {
        let path = models.join(format!("{}.{ext}", model.name));
        if !path.is_file() {
            let url = format!("{MODELS_URL}/{}.{ext}", model.name);
            download(app, client, &url, sha, &path, &format!("модель «{}»", model.name), span).await?;
        }
    }
    Ok(dir)
}

/// Распаковывает архив движка и оставляет только сам движок.
fn extract(dir: &Path, zip: &Path) -> Result<(), String> {
    let tmp = dir.join("x");
    let out = hidden_command("powershell")
        .args([
            "-NoProfile",
            "-Command",
            &format!("Expand-Archive -LiteralPath '{}' -DestinationPath '{}' -Force", zip.display(), tmp.display()),
        ])
        .output()
        .map_err(|e| format!("Не удалось распаковать движок: {e}"))?;
    if !out.status.success() {
        return Err(format!("Не удалось распаковать движок: {}", String::from_utf8_lossy(&out.stderr).trim()));
    }
    let exe = walk(&tmp).into_iter().find(|p| p.file_name().is_some_and(|n| n.to_string_lossy().eq_ignore_ascii_case(EXE)));
    let result = match exe {
        Some(p) => std::fs::copy(p, dir.join(EXE)).map(|_| ()).map_err(|e| format!("Не удалось скопировать движок: {e}")),
        None => Err("В скачанном архиве нет движка.".into()),
    };
    let _ = std::fs::remove_dir_all(&tmp);
    let _ = std::fs::remove_file(zip);
    result
}

fn walk(dir: &Path) -> Vec<PathBuf> {
    let mut out = Vec::new();
    if let Ok(rd) = std::fs::read_dir(dir) {
        for e in rd.flatten() {
            let p = e.path();
            if p.is_dir() {
                out.extend(walk(&p));
            } else {
                out.push(p);
            }
        }
    }
    out
}

/// Строка прогресса движка: «57.14%».
fn parse_percent(line: &str) -> Option<f64> {
    let num = line.trim().strip_suffix('%')?;
    num.trim().replace(',', ".").parse::<f64>().ok().filter(|v| (0.0..=100.0).contains(v))
}

/// Размер результата: во сколько раз (2–4) или до какой ширины в пикселях. Модели всегда ×4 — движок сам ужимает
/// до ×2/×3 или подгоняет под ширину после нейросети.
pub enum Size {
    Scale(u32),
    Width(u32),
}

impl Size {
    pub fn from(scale: Option<u32>, width: Option<u32>) -> Result<Size, String> {
        match (scale, width) {
            (_, Some(w)) if (64..=8192).contains(&w) => Ok(Size::Width(w)),
            (_, Some(_)) => Err("Ширина — от 64 до 8192 пикселей.".into()),
            (Some(s), None) if (2..=4).contains(&s) => Ok(Size::Scale(s)),
            (None, None) => Ok(Size::Scale(4)),
            _ => Err("Увеличение — ×2, ×3 или ×4.".into()),
        }
    }

    fn args(&self) -> Vec<String> {
        match self {
            Size::Scale(s) => vec!["-s".into(), s.to_string()],
            // «-w» вместе с «-s» движок молча игнорирует — только отдельно, с фильтром
            Size::Width(w) => vec!["-w".into(), format!("{w}:default")],
        }
    }
}

/// Своя картинка с диска — только файл, выбранный в диалоге (file_scope), и не больше 25 МБ.
pub fn read_input(app: &tauri::AppHandle, path: &str) -> Result<Vec<u8>, String> {
    use tauri::Manager;
    let p = app.state::<crate::file_scope::FileScope>().check_read(path)?;
    let len = std::fs::metadata(&p).map_err(|e| e.to_string())?.len();
    if len as usize > MAX_INPUT {
        return Err("Картинка больше 25 МБ.".into());
    }
    std::fs::read(p).map_err(|e| format!("Не удалось прочитать картинку: {e}"))
}

/// Увеличивает картинку. `mode` — "anime" или "sharp", `size` — во сколько раз или до какой ширины. Возвращает PNG.
pub async fn upscale(app: &tauri::AppHandle, client: &reqwest::Client, bytes: Vec<u8>, mode: &str, size: Size) -> Result<Vec<u8>, String> {
    if bytes.is_empty() || bytes.len() > MAX_INPUT {
        return Err("Картинка пустая или слишком большая (больше 25 МБ).".into());
    }
    let model = MODELS.iter().find(|m| m.key == mode).unwrap_or(&MODELS[0]);
    let dir = ensure(app, client, model).await?;
    let work = std::env::temp_dir().join("project-desktop-upscale");
    std::fs::create_dir_all(&work).map_err(|e| e.to_string())?;
    let input = work.join("in.img");
    let output = work.join(format!("out-{}.png", std::process::id()));
    std::fs::write(&input, &bytes).map_err(|e| format!("Не удалось сохранить картинку для обработки: {e}"))?;
    progress(app, 0.45, "Нейросеть увеличивает картинку…");

    let app2 = app.clone();
    let (input2, output2, name, size_args) = (input.clone(), output.clone(), model.name, size.args());
    tauri::async_runtime::spawn_blocking(move || -> Result<(), String> {
        let mut child = hidden_command(dir.join(EXE))
            .current_dir(&dir)
            .arg("-i").arg(&input2)
            .arg("-o").arg(&output2)
            .args(["-n", name])
            .args(&size_args)
            .args(["-f", "png", "-m"])
            .arg(dir.join("models"))
            .stdout(Stdio::null())
            .stderr(Stdio::piped())
            .spawn()
            .map_err(|e| format!("Не удалось запустить движок апскейла: {e}"))?;
        let mut tail: Vec<String> = Vec::new();
        if let Some(err) = child.stderr.take() {
            for line in BufReader::new(err).lines().map_while(Result::ok) {
                if let Some(p) = parse_percent(&line) {
                    progress(&app2, 0.45 + p / 100.0 * 0.55, &format!("Нейросеть увеличивает картинку: {p:.0}%"));
                } else if !line.trim().is_empty() {
                    tail.push(line);
                    if tail.len() > 6 {
                        tail.remove(0);
                    }
                }
            }
        }
        let status = child.wait().map_err(|e| e.to_string())?;
        if !status.success() || !output2.is_file() {
            let why = tail.join(" ");
            let low = why.to_lowercase();
            let hint = if low.contains("vulkan") || low.contains("gpu") {
                " Похоже, видеокарта или её драйвер не поддерживают Vulkan — обновите драйвер видеокарты."
            } else {
                ""
            };
            return Err(format!("Движок апскейла не справился.{hint} {why}").trim().to_string());
        }
        Ok(())
    })
    .await
    .map_err(|e| format!("Апскейл не завершился: {e}"))??;
    let _ = std::fs::remove_file(&input);

    let png = std::fs::read(&output).map_err(|e| format!("Не удалось прочитать результат: {e}"))?;
    if let Ok(mut last) = LAST.lock() {
        if let Some(prev) = last.replace(output) {
            let _ = std::fs::remove_file(prev);
        }
    }
    progress(app, 1.0, "Готово");
    Ok(png)
}

/// Копирует последний результат в путь, выбранный пользователем в диалоге сохранения.
pub fn save(app: &tauri::AppHandle, path: &str) -> Result<(), String> {
    use tauri::Manager;
    let target = app.state::<crate::file_scope::FileScope>().check_write(path)?;
    let last = LAST.lock().map_err(|e| e.to_string())?.clone().ok_or("Сначала увеличьте картинку.")?;
    std::fs::copy(last, target).map(|_| ()).map_err(|e| format!("Не удалось сохранить: {e}"))
}

#[cfg(test)]
mod tests {
    use super::{parse_percent, Size, MODELS};

    #[test]
    fn size_args() {
        assert_eq!(Size::from(None, None).unwrap().args(), ["-s", "4"]);
        assert_eq!(Size::from(Some(2), None).unwrap().args(), ["-s", "2"]);
        assert_eq!(Size::from(Some(4), Some(3840)).unwrap().args(), ["-w", "3840:default"]);
        assert!(Size::from(Some(5), None).is_err());
        assert!(Size::from(None, Some(99999)).is_err());
    }

    #[test]
    fn percent_lines() {
        assert_eq!(parse_percent("57.14%"), Some(57.14));
        assert_eq!(parse_percent(" 0,00% "), Some(0.0));
        assert_eq!(parse_percent("[0 NVIDIA GeForce RTX 3070]  queueC=2[8]"), None);
        assert_eq!(parse_percent("150%"), None);
    }

    #[test]
    fn models_pinned() {
        for m in MODELS {
            assert_eq!(m.param_sha.len(), 64);
            assert_eq!(m.bin_sha.len(), 64);
        }
    }
}
