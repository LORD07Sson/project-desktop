//! Апскейл картинок (обложка/баннер тайтла) нейросетью Real-ESRGAN: ×4 с моделью под аниме или под фото.
//!
//! Движок — официальная сборка realesrgan-ncnn-vulkan (работает на любой видеокарте с Vulkan). В установщик его не
//! кладём (45 МБ ради одной кнопки): при первом апскейле докачиваем закреплённый релиз с GitHub, сверяем SHA-256,
//! зашитую в приложение, и распаковываем нужное в %LOCALAPPDATA%\Project Desktop\tools\realesrgan — рядом с
//! докачанным ffmpeg (audio_qc::downloaded_tools_dir).
//!
//! Картинку присылает вебвью байтами, результат (PNG) уходит обратно сырым ответом IPC — для превью «до/после»;
//! сохраняется он отдельной командой, только в путь, выбранный в диалоге сохранения (file_scope).

use crate::audio_qc::hidden_command;
use sha2::{Digest, Sha256};
use std::io::{BufRead, BufReader, Write};
use std::path::PathBuf;
use std::process::Stdio;
use std::sync::Mutex;
use std::time::Instant;
use tauri::Emitter;

const ENGINE_URL: &str =
    "https://github.com/xinntao/Real-ESRGAN/releases/download/v0.2.5.0/realesrgan-ncnn-vulkan-20220424-windows.zip";
const ENGINE_SHA256: &str = "abc02804e17982a3be33675e4d471e91ea374e65b70167abc09e31acb412802d";
const EXE: &str = "realesrgan-ncnn-vulkan.exe";
/// Модели, которые разрешено запускать (имя файла без .param/.bin).
const MODELS: [&str; 2] = ["realesrgan-x4plus-anime", "realesrgan-x4plus"];
/// Больше — не обложка, а что-то не то; и памяти видеокарте хватит не на всё.
const MAX_INPUT: usize = 25 * 1024 * 1024;

/// Последний результат — его и сохраняет `save`, чтобы не гонять PNG через вебвью второй раз.
static LAST: Mutex<Option<PathBuf>> = Mutex::new(None);

fn engine_dir() -> Option<PathBuf> {
    std::env::var_os("LOCALAPPDATA").map(|l| PathBuf::from(l).join("Project Desktop").join("tools").join("realesrgan"))
}

fn engine_ready(dir: &std::path::Path) -> bool {
    dir.join(EXE).is_file() && MODELS.iter().all(|m| dir.join("models").join(format!("{m}.bin")).is_file())
}

fn progress(app: &tauri::AppHandle, fraction: f64, label: &str) {
    let _ = app.emit("upscale-progress", serde_json::json!({ "fraction": fraction, "label": label }));
}

/// Докачивает движок, если его ещё нет. Возвращает папку с ним.
async fn ensure_engine(app: &tauri::AppHandle, client: &reqwest::Client) -> Result<PathBuf, String> {
    let dir = engine_dir().ok_or("Не найдена папка пользователя для движка апскейла.")?;
    if engine_ready(&dir) {
        return Ok(dir);
    }
    std::fs::create_dir_all(&dir).map_err(|e| format!("Не удалось создать папку {dir:?}: {e}"))?;
    let zip_path = dir.join("engine.zip");
    let mut resp = client.get(ENGINE_URL).send().await.map_err(|e| format!("Не удалось скачать движок апскейла: {e}"))?;
    if !resp.status().is_success() {
        return Err(format!("Не удалось скачать движок апскейла: сервер ответил {}", resp.status()));
    }
    let total = resp.content_length().unwrap_or(0);
    let mut file = std::fs::File::create(&zip_path).map_err(|e| format!("Не удалось создать файл загрузки: {e}"))?;
    let mut hasher = Sha256::new();
    let (mut done, mut last) = (0u64, Instant::now());
    while let Some(chunk) = resp.chunk().await.map_err(|e| format!("Обрыв при скачивании движка: {e}"))? {
        file.write_all(&chunk).map_err(|e| format!("Не удалось записать движок: {e}"))?;
        hasher.update(&chunk);
        done += chunk.len() as u64;
        if last.elapsed().as_millis() > 300 {
            last = Instant::now();
            let frac = if total > 0 { done as f64 / total as f64 } else { 0.0 };
            progress(app, frac * 0.5, &format!("Скачиваю движок апскейла (один раз): {} из {} МБ", done / 1_048_576, total / 1_048_576));
        }
    }
    drop(file);
    let hash = format!("{:x}", hasher.finalize());
    if hash != ENGINE_SHA256 {
        let _ = std::fs::remove_file(&zip_path);
        return Err(format!("Сумма SHA-256 скачанного движка не совпала (получено {hash}) — файл удалён."));
    }
    progress(app, 0.5, "Распаковываю движок…");
    let dir2 = dir.clone();
    tauri::async_runtime::spawn_blocking(move || extract(&dir2, &zip_path))
        .await
        .map_err(|e| format!("Распаковка движка не завершилась: {e}"))??;
    if !engine_ready(&dir) {
        return Err("В скачанном архиве не нашлось движка или моделей.".into());
    }
    Ok(dir)
}

/// Распаковывает архив и оставляет только нужное: сам движок, его библиотеку и две модели (без демо-видео и картинок).
fn extract(dir: &std::path::Path, zip: &std::path::Path) -> Result<(), String> {
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
    std::fs::create_dir_all(dir.join("models")).map_err(|e| e.to_string())?;
    for path in walk(&tmp) {
        let name = path.file_name().map(|n| n.to_string_lossy().to_lowercase()).unwrap_or_default();
        let target = if name == EXE || name.ends_with(".dll") {
            dir.join(&name)
        } else if MODELS.iter().any(|m| name == format!("{m}.param") || name == format!("{m}.bin")) {
            dir.join("models").join(&name)
        } else {
            continue;
        };
        std::fs::copy(&path, &target).map_err(|e| format!("Не удалось скопировать {name}: {e}"))?;
    }
    let _ = std::fs::remove_dir_all(&tmp);
    let _ = std::fs::remove_file(zip);
    Ok(())
}

fn walk(dir: &std::path::Path) -> Vec<PathBuf> {
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
    let t = line.trim();
    let num = t.strip_suffix('%')?;
    num.trim().replace(',', ".").parse::<f64>().ok().filter(|v| (0.0..=100.0).contains(v))
}

/// Увеличивает картинку в 4 раза. `model` — "anime" или "photo". Возвращает PNG.
pub async fn upscale(app: &tauri::AppHandle, client: &reqwest::Client, bytes: Vec<u8>, model: &str) -> Result<Vec<u8>, String> {
    if bytes.is_empty() || bytes.len() > MAX_INPUT {
        return Err("Картинка пустая или слишком большая (больше 25 МБ).".into());
    }
    let model = if model == "photo" { MODELS[1] } else { MODELS[0] };
    let dir = ensure_engine(app, client).await?;
    let work = std::env::temp_dir().join("project-desktop-upscale");
    std::fs::create_dir_all(&work).map_err(|e| e.to_string())?;
    let input = work.join("in.img");
    let output = work.join(format!("out-{}.png", std::process::id()));
    std::fs::write(&input, &bytes).map_err(|e| format!("Не удалось сохранить картинку для обработки: {e}"))?;
    progress(app, 0.5, "Нейросеть увеличивает картинку…");

    let app2 = app.clone();
    let (dir2, input2, output2) = (dir.clone(), input.clone(), output.clone());
    let model = model.to_string();
    tauri::async_runtime::spawn_blocking(move || -> Result<(), String> {
        let mut child = hidden_command(dir2.join(EXE))
            .current_dir(&dir2)
            .arg("-i").arg(&input2)
            .arg("-o").arg(&output2)
            .args(["-n", &model, "-s", "4", "-f", "png", "-m"])
            .arg(dir2.join("models"))
            .stdout(Stdio::null())
            .stderr(Stdio::piped())
            .spawn()
            .map_err(|e| format!("Не удалось запустить движок апскейла: {e}"))?;
        let mut tail: Vec<String> = Vec::new();
        if let Some(err) = child.stderr.take() {
            for line in BufReader::new(err).lines().map_while(Result::ok) {
                if let Some(p) = parse_percent(&line) {
                    progress(&app2, 0.5 + p / 200.0, &format!("Нейросеть увеличивает картинку: {p:.0}%"));
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
            let hint = if why.to_lowercase().contains("vulkan") || why.to_lowercase().contains("gpu") {
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
    use super::parse_percent;

    #[test]
    fn percent_lines() {
        assert_eq!(parse_percent("57.14%"), Some(57.14));
        assert_eq!(parse_percent(" 0,00% "), Some(0.0));
        assert_eq!(parse_percent("[0 NVIDIA GeForce RTX 3070]  queueC=2[8]"), None);
        assert_eq!(parse_percent("150%"), None);
    }
}
