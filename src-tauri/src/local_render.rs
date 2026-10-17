//! «Собрать финал у себя»: рендер серии на ПК владельца (видеокарта NVIDIA, NVENC) вместо слабого сервера.
//!
//! Сервер присылает ПЛАН (`POST /api/report/{id}/local-render/plan`): какие файлы скачать, какие тексты записать и какие
//! шаги ffmpeg выполнить (подстановка озвучки, рендер). Здесь мы только исполняем план: качаем файлы потоком в рабочую
//! папку, запускаем ffmpeg В ЭТОЙ папке (поэтому в аргументах короткие имена файлов, а не пути с двоеточиями),
//! выбираем кодировщик — NVENC, если видеокарта его тянет, иначе программный (если он есть в нашем ffmpeg) — и отдаём
//! фронтенду путь к готовому файлу. Загрузку результата в отчёт делает уже существующая `upload_report_file`.

use std::collections::HashMap;
use std::io::Write;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Instant;

use serde::{Deserialize, Serialize};

use crate::audio_qc::{hidden_command, resolve_ffmpeg};
use crate::media_tools::{run_ffmpeg_in, Progress, Stage};

/// Отмена скачивания: ffmpeg отменяется своим механизмом (media_tools::cancel_current_job), загрузка — этим флагом.
static CANCEL_DOWNLOAD: AtomicBool = AtomicBool::new(false);

#[derive(Deserialize)]
pub struct Download {
    pub name: String,
    pub file: Option<i64>,
    pub watermark: Option<bool>,
    pub intro: Option<bool>,
    pub image: Option<String>,
    pub prepared: Option<String>,
    pub label: Option<String>,
}

#[derive(Deserialize, Clone)]
pub struct Fallback {
    pub args: Vec<String>,
    pub args_nvenc: Option<Vec<String>>,
}

#[derive(Deserialize)]
pub struct PlanStep {
    pub label: String,
    pub duration: f64,
    pub output: String,
    pub args: Vec<String>,
    pub args_nvenc: Option<Vec<String>>,
    pub vcodec: Option<String>,
    pub weight: Option<f64>,
    pub fallback: Option<Fallback>,
}

#[derive(Deserialize)]
pub struct Plan {
    pub public_id: String,
    pub downloads: Vec<Download>,
    pub texts: HashMap<String, String>,
    pub steps: Vec<PlanStep>,
    #[serde(rename = "final")]
    pub final_name: String,
    pub out_name: String,
}

#[derive(Serialize)]
pub struct RenderResult {
    pub path: String,
    pub out_name: String,
    pub size: u64,
    pub encoder: String,
    pub seconds: f64,
}

#[derive(Serialize)]
pub struct EncoderStatus {
    pub nvenc_h264: bool,
    pub nvenc_h265: bool,
    pub soft_h264: bool,
    pub soft_h265: bool,
}

pub fn request_cancel() {
    CANCEL_DOWNLOAD.store(true, Ordering::SeqCst);
}

/// Рабочая папка отчёта: только латиница/цифры/дефис из номера отчёта, чтобы имя не вывело за пределы временной папки.
pub fn work_dir(public_id: &str) -> Result<PathBuf, String> {
    let safe: String = public_id.chars().filter(|c| c.is_ascii_alphanumeric() || *c == '-').collect();
    if safe.is_empty() {
        return Err("Некорректный номер отчёта.".into());
    }
    Ok(std::env::temp_dir().join("project-local-render").join(safe))
}

pub fn cleanup(public_id: &str) -> Result<(), String> {
    let dir = work_dir(public_id)?;
    if dir.exists() {
        std::fs::remove_dir_all(&dir).map_err(|e| format!("Не удалось убрать рабочую папку: {e}"))?;
    }
    Ok(())
}

/// Имя файла плана — только простое имя (без путей): план приходит с сервера, но ему всё равно не доверяем.
fn safe_name(name: &str) -> Result<&str, String> {
    if name.is_empty() || name.contains(['/', '\\', ':']) || name == "." || name == ".." || name.contains("..") {
        return Err(format!("Недопустимое имя файла в плане: «{name}»."));
    }
    Ok(name)
}

fn encoders_text() -> String {
    hidden_command(resolve_ffmpeg())
        .args(["-hide_banner", "-encoders"])
        .output()
        .map(|o| String::from_utf8_lossy(&o.stdout).into_owned())
        .unwrap_or_default()
}

/// Кодировщик есть в сборке и реально работает (на машине без видеокарты NVENC в списке есть, но не запускается).
fn encoder_works(list: &str, name: &str) -> bool {
    if !list.contains(name) {
        return false;
    }
    hidden_command(resolve_ffmpeg())
        .args(["-v", "error", "-f", "lavfi", "-i", "color=c=black:s=256x144:d=0.2", "-c:v", name, "-f", "null", "-"])
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false)
}

pub fn encoder_status() -> EncoderStatus {
    let list = encoders_text();
    EncoderStatus {
        nvenc_h264: encoder_works(&list, "h264_nvenc"),
        nvenc_h265: encoder_works(&list, "hevc_nvenc"),
        soft_h264: list.contains("libx264"),
        soft_h265: list.contains("libx265"),
    }
}

pub async fn run(
    app: &tauri::AppHandle,
    client: &reqwest::Client,
    api_base: &str,
    plan: Plan,
    init_data: &str,
) -> Result<RenderResult, String> {
    use tauri::Emitter;

    let started = Instant::now();
    let dir = work_dir(&plan.public_id)?;
    if dir.exists() {
        let _ = std::fs::remove_dir_all(&dir);
    }
    std::fs::create_dir_all(&dir).map_err(|e| format!("Не удалось создать рабочую папку: {e}"))?;
    CANCEL_DOWNLOAD.store(false, Ordering::SeqCst);

    let emit = |stage: &str, fraction: f64, label: &str| {
        let _ = app.emit(
            "localrender-progress",
            serde_json::json!({ "stage": stage, "fraction": fraction.clamp(0.0, 1.0), "label": label }),
        );
    };

    // 1) тексты (надпись) — маленькие файлы рядом с видео
    for (name, content) in &plan.texts {
        let name = safe_name(name)?;
        std::fs::write(dir.join(name), content).map_err(|e| format!("Не удалось записать {name}: {e}"))?;
    }

    // 2) скачивание файлов потоком (доля прогресса 0–20%)
    let total_files = plan.downloads.len().max(1);
    for (index, item) in plan.downloads.iter().enumerate() {
        let name = safe_name(&item.name)?;
        let label = item.label.clone().unwrap_or_else(|| name.to_string());
        let url = if item.watermark.unwrap_or(false) {
            format!("{api_base}/report/{}/local-asset?watermark=1", plan.public_id)
        } else if item.intro.unwrap_or(false) {
            format!("{api_base}/report/{}/local-asset?intro=1", plan.public_id)
        } else if let Some(image) = &item.image {
            format!("{api_base}/report/{}/local-asset?image={}", plan.public_id, urlencode(image))
        } else if let Some(prepared) = &item.prepared {
            format!("{api_base}/report/{}/local-asset?prepared={}", plan.public_id, urlencode(prepared))
        } else {
            format!("{api_base}/report/{}/local-asset?file={}", plan.public_id, item.file.unwrap_or(0))
        };
        let mut resp = client
            .get(&url)
            .header("X-Init-Data", init_data)
            .send()
            .await
            .map_err(|e| format!("Не удалось скачать «{label}»: {e}"))?;
        if !resp.status().is_success() {
            let detail = resp
                .json::<serde_json::Value>()
                .await
                .ok()
                .and_then(|v| v.get("detail").and_then(|d| d.as_str()).map(str::to_string))
                .unwrap_or_else(|| "сервер отказал".to_string());
            return Err(format!("Не удалось скачать «{label}»: {detail}"));
        }
        let total = resp.content_length().unwrap_or(0);
        let mut file = std::fs::File::create(dir.join(name)).map_err(|e| format!("Не удалось создать {name}: {e}"))?;
        let mut done: u64 = 0;
        let mut last_emit = Instant::now();
        while let Some(chunk) = resp.chunk().await.map_err(|e| format!("Обрыв при скачивании «{label}»: {e}"))? {
            if CANCEL_DOWNLOAD.load(Ordering::SeqCst) {
                return Err("Операция отменена.".into());
            }
            file.write_all(&chunk).map_err(|e| format!("Не удалось записать {name}: {e}"))?;
            done += chunk.len() as u64;
            if last_emit.elapsed().as_millis() > 400 {
                last_emit = Instant::now();
                let part = if total > 0 { done as f64 / total as f64 } else { 0.0 };
                let overall = (index as f64 + part) / total_files as f64 * 0.2;
                emit(
                    "download",
                    overall,
                    &format!("Скачиваю {label}: {} из {}", fmt_mb(done), if total > 0 { fmt_mb(total) } else { "?".into() }),
                );
            }
        }
    }
    emit("download", 0.2, "Файлы скачаны");

    // 3) кодировщики: проверяем один раз (это запуск ffmpeg)
    let encs = tauri::async_runtime::spawn_blocking(encoder_status)
        .await
        .map_err(|e| format!("Проверка кодировщиков не завершилась: {e}"))?;

    // 4) шаги ffmpeg (доля 20–100% делится по длительности материала и «тяжести»: озвучка — копирование, рендер — основное)
    let weights: Vec<f64> = plan
        .steps
        .iter()
        .map(|s| s.weight.unwrap_or(if s.args_nvenc.is_some() { 0.9 } else { 0.1 }))
        .collect();
    let weight_sum: f64 = weights.iter().sum::<f64>().max(0.0001);
    let mut base = 0.2;
    let mut used_encoder = String::from("копирование");
    for (index, step) in plan.steps.iter().enumerate() {
        let span = 0.8 * weights[index] / weight_sum;
        let out_name = safe_name(&step.output)?.to_string();
        let (args, encoder_label) = pick_args(&step.args, step.args_nvenc.as_ref(), step.vcodec.as_deref(), &encs)?;
        if step.args_nvenc.is_some() {
            used_encoder = encoder_label.to_string();
        }
        let label = if step.args_nvenc.is_some() {
            format!("{} — {}", step.label, encoder_label)
        } else {
            step.label.clone()
        };
        emit("render", base, &label);
        let out_path = dir.join(&out_name);
        let mut attempt = run_step(app, &dir, &out_path, args, &label, base, span, step.duration).await;
        if let (Err(first), Some(fb)) = (&attempt, &step.fallback) {
            if !first.contains("отменена") {
                // Склейка без перекодирования не вышла — общая перекодировка с фильтром concat.
                let (fb_args, fb_label) = pick_args(&fb.args, fb.args_nvenc.as_ref(), step.vcodec.as_deref(), &encs)?;
                let label = format!("{} (запасной путь) — {}", step.label, fb_label);
                emit("render", base, &label);
                attempt = run_step(app, &dir, &out_path, fb_args, &label, base, span, 0.0).await;
            }
        }
        attempt?;
        base += span;
    }

    let final_path = dir.join(safe_name(&plan.final_name)?);
    let size = std::fs::metadata(&final_path)
        .map_err(|e| format!("Готовый файл не найден: {e}"))?
        .len();
    if size == 0 {
        return Err("Рендер дал пустой файл.".into());
    }
    emit("render", 1.0, "Рендер готов");
    Ok(RenderResult {
        path: final_path.to_string_lossy().into_owned(),
        out_name: plan.out_name,
        size,
        encoder: used_encoder,
        seconds: started.elapsed().as_secs_f64(),
    })
}

/// Выбор аргументов шага: NVENC, если видеокарта его тянет; иначе программный кодек (если он есть); шаги без перекодирования — как есть.
fn pick_args(
    soft: &[String],
    hw: Option<&Vec<String>>,
    vcodec: Option<&str>,
    encs: &EncoderStatus,
) -> Result<(Vec<String>, &'static str), String> {
    match (hw, vcodec) {
        (Some(hw), Some("h265")) if encs.nvenc_h265 => Ok((hw.clone(), "видеокарта NVIDIA (NVENC)")),
        (Some(hw), Some("h264")) if encs.nvenc_h264 => Ok((hw.clone(), "видеокарта NVIDIA (NVENC)")),
        (Some(_), Some("h265")) if !encs.soft_h265 => Err(
            "На этом компьютере нет видеокарты NVIDIA с NVENC, а программного кодировщика H.265 в приложении нет. Соберите на сервере.".into(),
        ),
        (Some(_), Some("h264")) if !encs.soft_h264 => Err(
            "На этом компьютере нет видеокарты NVIDIA с NVENC, а программного кодировщика H.264 в приложении нет. Соберите на сервере.".into(),
        ),
        (Some(_), _) => Ok((soft.to_vec(), "процессор (программный кодек)")),
        (None, _) => Ok((soft.to_vec(), "копирование")),
    }
}

/// Один шаг ffmpeg в рабочей папке (в отдельном потоке — процесс блокирующий).
#[allow(clippy::too_many_arguments)]
async fn run_step(
    app: &tauri::AppHandle,
    dir: &std::path::Path,
    out_path: &std::path::Path,
    args: Vec<String>,
    label: &str,
    base: f64,
    span: f64,
    duration: f64,
) -> Result<(), String> {
    use tauri::Emitter;
    let app = app.clone();
    let dir = dir.to_path_buf();
    let out_path = out_path.to_path_buf();
    let label = label.to_string();
    tauri::async_runtime::spawn_blocking(move || {
        let sink = {
            let app = app.clone();
            move |fraction: f64, label: &str| {
                let _ = app.emit(
                    "localrender-progress",
                    serde_json::json!({ "stage": "render", "fraction": fraction, "label": label }),
                );
            }
        };
        let progress = Progress(&sink);
        let stage = Stage { label, base, span, duration };
        run_ffmpeg_in(&progress, &args, &out_path, stage, Some(&dir))
    })
    .await
    .map_err(|e| format!("Рендер не завершился: {e}"))?
}

fn urlencode(text: &str) -> String {
    text.bytes()
        .map(|b| match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' | b'/' => (b as char).to_string(),
            _ => format!("%{b:02X}"),
        })
        .collect()
}

/// Загрузка готового файла на сервер: дальше им занимается бот (обложка, Telegram, отчёт, пост).
pub async fn upload_final(
    client: &reqwest::Client,
    api_base: &str,
    public_id: &str,
    path: &str,
    init_data: &str,
) -> Result<(), String> {
    let path = path.to_string();
    let name = std::path::Path::new(&path)
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_else(|| "final.mp4".into());
    let bytes = tauri::async_runtime::spawn_blocking(move || std::fs::read(&path))
        .await
        .map_err(|e| format!("Не удалось прочитать готовый файл: {e}"))?
        .map_err(|e| format!("Не удалось прочитать готовый файл: {e}"))?;
    if bytes.len() as u64 > 1_950_000_000 {
        return Err(format!(
            "Готовое видео вышло {:.1} ГБ — больше лимита Telegram (2 ГБ). Выберите профиль полегче.",
            bytes.len() as f64 / 1024.0 / 1024.0 / 1024.0
        ));
    }
    let part = reqwest::multipart::Part::bytes(bytes).file_name(name);
    let form = reqwest::multipart::Form::new().part("file", part);
    let resp = client
        .post(format!("{api_base}/report/{public_id}/local-render/final"))
        .header("X-Init-Data", init_data)
        .multipart(form)
        .send()
        .await
        .map_err(|e| format!("Не удалось отправить готовый файл: {e}"))?;
    if !resp.status().is_success() {
        let detail = resp
            .json::<serde_json::Value>()
            .await
            .ok()
            .and_then(|v| v.get("detail").and_then(|d| d.as_str()).map(str::to_string))
            .unwrap_or_else(|| "сервер отказал".to_string());
        return Err(format!("Сервер не принял готовый файл: {detail}"));
    }
    Ok(())
}

fn fmt_mb(bytes: u64) -> String {
    if bytes >= 1024 * 1024 * 1024 {
        format!("{:.2} ГБ", bytes as f64 / 1024.0 / 1024.0 / 1024.0)
    } else {
        format!("{} МБ", bytes / 1024 / 1024)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn safe_name_rejects_paths() {
        assert!(safe_name("episode.mkv").is_ok());
        assert!(safe_name("../x").is_err());
        assert!(safe_name("a/b").is_err());
        assert!(safe_name("C:evil").is_err());
        assert!(safe_name("").is_err());
    }

    #[test]
    fn urlencode_keeps_file_id_chars_and_escapes_the_rest() {
        assert_eq!(urlencode("BQACAgIAAxk-_x"), "BQACAgIAAxk-_x");
        assert_eq!(urlencode("a b&c"), "a%20b%26c");
        assert_eq!(urlencode("asm_local_1/a2/дорожка.wav"), "asm_local_1/a2/%D0%B4%D0%BE%D1%80%D0%BE%D0%B6%D0%BA%D0%B0.wav");
    }

    #[test]
    fn work_dir_strips_unsafe_chars() {
        let dir = work_dir("R-000019/../../x").unwrap();
        assert!(dir.ends_with("R-000019x"));
        assert!(work_dir("///").is_err());
    }
}
