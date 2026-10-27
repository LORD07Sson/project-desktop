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
use std::process::Stdio;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};

use crate::audio_qc::{binary_runs, downloaded_tools_dir, hidden_command, resolve_ffmpeg};
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
    /// Видео лежит на этом компьютере («Скачать у себя»): вместо загрузки с сервера берём файл, который выбрал пользователь.
    #[serde(default)]
    pub local: Option<bool>,
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

#[derive(Serialize, Clone)]
pub struct EncoderStatus {
    pub nvenc_h264: bool,
    pub nvenc_h265: bool,
    pub soft_h264: bool,
    pub soft_h265: bool,
    pub nvenc_h264_error: Option<String>,
    pub nvenc_h265_error: Option<String>,
}

/// Закреплённая сборка ffmpeg (LGPL, с NVENC) в нашем же релизе на GitHub — тот же файл и та же сумма, что в CI.
const FFMPEG_URL: &str = "https://github.com/LORD07Sson/project-desktop/releases/download/tools-ffmpeg-N-127271/ffmpeg-N-127271-gba987fe24d-win64-lgpl.zip";
/// Официальная сборка (ссылка на неё — на ffmpeg.org/download.html): GPL-версия с libx264/libx265 и NVENC.
const OFFICIAL_URL: &str = "https://www.gyan.dev/ffmpeg/builds/ffmpeg-release-essentials.zip";
const OFFICIAL_SHA_URL: &str = "https://www.gyan.dev/ffmpeg/builds/ffmpeg-release-essentials.zip.sha256";
const FFMPEG_SHA256: &str = "32b374c9831ae5640e33977baa4cf04a59704f616a0c3743654697fb3c7f26de";

#[derive(Serialize)]
pub struct ToolsStatus {
    pub ffmpeg_ok: bool,
    pub ffprobe_ok: bool,
    /// bundled | downloaded | path | none
    pub source: String,
    pub path: String,
    pub downloaded_now: bool,
    pub gpu: String,
    pub nvenc_h264: bool,
    pub nvenc_h265: bool,
    pub soft_h264: bool,
    pub soft_h265: bool,
    pub nvenc_h264_error: Option<String>,
    pub nvenc_h265_error: Option<String>,
    pub error: Option<String>,
}

fn tools_source(path: &str) -> &'static str {
    let p = std::path::Path::new(path);
    if let Some(dir) = downloaded_tools_dir() {
        if p.starts_with(&dir) {
            return "downloaded";
        }
    }
    if let Some(exe_dir) = std::env::current_exe().ok().and_then(|e| e.parent().map(|d| d.to_path_buf())) {
        if p.starts_with(&exe_dir) {
            return "bundled";
        }
    }
    "path"
}

fn gpu_names() -> String {
    hidden_command("powershell")
        .args([
            "-NoProfile",
            "-Command",
            "(Get-CimInstance Win32_VideoController | Select-Object -ExpandProperty Name) -join ', '",
        ])
        .output()
        .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
        .unwrap_or_default()
}

/// Скачивает ffmpeg в папку приложения (если рядом с .exe его нет и в PATH тоже), проверяет сумму и распаковывает.
async fn download_ffmpeg(app: &tauri::AppHandle, client: &reqwest::Client) -> Result<(), String> {
    // Источники по порядку: наш закреплённый релиз на GitHub (сумма зашита в приложение), затем официальная сборка
    // gyan.dev (ссылка на ffmpeg.org/download; её сумма берётся из файла .sha256 рядом). Первая удавшаяся — используется.
    let mut errors: Vec<String> = Vec::new();
    match download_from(app, client, FFMPEG_URL, Some(FFMPEG_SHA256), None).await {
        Ok(()) => return Ok(()),
        Err(e) => errors.push(format!("GitHub: {e}")),
    }
    match download_from(app, client, OFFICIAL_URL, None, Some(OFFICIAL_SHA_URL)).await {
        Ok(()) => return Ok(()),
        Err(e) => errors.push(format!("официальная сборка: {e}")),
    }
    Err(format!("Не удалось скачать ffmpeg ни с GitHub, ни с официального сайта ({}).", errors.join("; ")))
}

async fn download_from(
    app: &tauri::AppHandle,
    client: &reqwest::Client,
    url: &str,
    fixed_sha: Option<&str>,
    sha_url: Option<&str>,
) -> Result<(), String> {
    use tauri::Emitter;
    let expected_sha: String = match (fixed_sha, sha_url) {
        (Some(sha), _) => sha.to_string(),
        (None, Some(sha_url)) => {
            let text = client
                .get(sha_url)
                .send()
                .await
                .map_err(|e| format!("не получилось получить контрольную сумму: {e}"))?
                .text()
                .await
                .map_err(|e| format!("не получилось прочитать контрольную сумму: {e}"))?;
            text.split_whitespace().next().unwrap_or("").to_lowercase()
        }
        _ => return Err("нет контрольной суммы".into()),
    };
    if expected_sha.len() != 64 {
        return Err("контрольная сумма в неожиданном виде".into());
    }
    let tools = downloaded_tools_dir().ok_or("Не найдена папка пользователя для загрузки ffmpeg.")?;
    std::fs::create_dir_all(&tools).map_err(|e| format!("Не удалось создать папку {tools:?}: {e}"))?;
    let zip_path = tools.join("ffmpeg.zip");
    let mut resp = client
        .get(url)
        .send()
        .await
        .map_err(|e| format!("Не удалось скачать ffmpeg: {e}"))?;
    if !resp.status().is_success() {
        return Err(format!("сервер ответил {}", resp.status()));
    }
    let total = resp.content_length().unwrap_or(0);
    let mut file = std::fs::File::create(&zip_path).map_err(|e| format!("Не удалось создать файл загрузки: {e}"))?;
    let mut done: u64 = 0;
    let mut last = Instant::now();
    while let Some(chunk) = resp.chunk().await.map_err(|e| format!("Обрыв при скачивании ffmpeg: {e}"))? {
        file.write_all(&chunk).map_err(|e| format!("Не удалось записать ffmpeg: {e}"))?;
        done += chunk.len() as u64;
        if last.elapsed().as_millis() > 400 {
            last = Instant::now();
            let frac = if total > 0 { done as f64 / total as f64 } else { 0.0 };
            let _ = app.emit(
                "ffmpeg-fetch-progress",
                serde_json::json!({ "fraction": frac, "label": format!("Скачиваю ffmpeg: {} из {}", fmt_mb(done), if total > 0 { fmt_mb(total) } else { "?".into() }) }),
            );
        }
    }
    drop(file);

    let zip_for_check = zip_path.clone();
    let expected_for_check = expected_sha.clone();
    let tools_for_extract = tools.clone();
    tauri::async_runtime::spawn_blocking(move || -> Result<(), String> {
        // сумма — через PowerShell (отдельный крейт под одно действие не тянем)
        let out = hidden_command("powershell")
            .args(["-NoProfile", "-Command", &format!("(Get-FileHash -Algorithm SHA256 -LiteralPath '{}').Hash", zip_for_check.display())])
            .output()
            .map_err(|e| format!("Не удалось проверить сумму ffmpeg: {e}"))?;
        let hash = String::from_utf8_lossy(&out.stdout).trim().to_lowercase();
        if hash != expected_for_check {
            let _ = std::fs::remove_file(&zip_for_check);
            return Err(format!("Сумма SHA256 скачанного ffmpeg не совпала (получено {hash}) — файл удалён."));
        }
        let ex = hidden_command("powershell")
            .args([
                "-NoProfile",
                "-Command",
                &format!(
                    "Expand-Archive -LiteralPath '{}' -DestinationPath '{}' -Force",
                    zip_for_check.display(),
                    tools_for_extract.join("x").display()
                ),
            ])
            .output()
            .map_err(|e| format!("Не удалось распаковать ffmpeg: {e}"))?;
        if !ex.status.success() {
            return Err(format!("Не удалось распаковать ffmpeg: {}", String::from_utf8_lossy(&ex.stderr).trim()));
        }
        // в архиве бинарники лежат в bin/ — достаём ffmpeg.exe и ffprobe.exe в корень папки инструментов
        let mut found = 0;
        for entry in walk(&tools_for_extract.join("x")) {
            let name = entry.file_name().map(|n| n.to_string_lossy().to_lowercase()).unwrap_or_default();
            if name == "ffmpeg.exe" || name == "ffprobe.exe" {
                std::fs::copy(&entry, tools_for_extract.join(&name)).map_err(|e| format!("Не удалось скопировать {name}: {e}"))?;
                found += 1;
            }
        }
        let _ = std::fs::remove_dir_all(tools_for_extract.join("x"));
        let _ = std::fs::remove_file(&zip_for_check);
        if found < 2 {
            return Err("В скачанном архиве нет ffmpeg.exe и ffprobe.exe.".into());
        }
        Ok(())
    })
    .await
    .map_err(|e| format!("Распаковка ffmpeg не завершилась: {e}"))??;
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

/// Автоматическая проверка инструментов: находит ffmpeg (рядом с .exe → докачанный → PATH); если нет — докачивает из
/// нашего релиза на GitHub; затем определяет видеокарту и рабочие кодировщики. Всегда возвращает понятный статус.
pub async fn prepare(app: &tauri::AppHandle, client: &reqwest::Client) -> ToolsStatus {
    let mut error: Option<String> = None;
    let mut downloaded_now = false;
    if !binary_runs(std::path::Path::new(resolve_ffmpeg())) {
        match download_ffmpeg(app, client).await {
            Ok(()) => downloaded_now = true,
            Err(e) => {
                log::error!("[ffmpeg-prepare] {e}");
                error = Some(e);
            }
        }
    }
    let path = resolve_ffmpeg().to_string();
    let ffmpeg_ok = binary_runs(std::path::Path::new(&path));
    let ffprobe_ok = binary_runs(std::path::Path::new(crate::media_tools::resolve_ffprobe()));
    if !ffmpeg_ok && error.is_none() {
        let message = "ffmpeg не найден и не скачался.";
        log::error!("[ffmpeg-prepare] {message}");
        error = Some(message.into());
    }
    if !ffprobe_ok {
        log::error!("[ffmpeg-prepare] ffprobe не найден или не запускается.");
    }
    let (enc, gpu) = tauri::async_runtime::spawn_blocking(|| (encoder_status(), gpu_names()))
        .await
        .unwrap_or_else(|_| (
            EncoderStatus {
                nvenc_h264: false,
                nvenc_h265: false,
                soft_h264: false,
                soft_h265: false,
                nvenc_h264_error: Some("проверка кодировщика аварийно завершилась".into()),
                nvenc_h265_error: Some("проверка кодировщика аварийно завершилась".into()),
            },
            String::new(),
        ));
    ToolsStatus {
        ffmpeg_ok,
        ffprobe_ok,
        source: if ffmpeg_ok { tools_source(&path).to_string() } else { "none".into() },
        path,
        downloaded_now,
        gpu,
        nvenc_h264: enc.nvenc_h264,
        nvenc_h265: enc.nvenc_h265,
        soft_h264: enc.soft_h264,
        soft_h265: enc.soft_h265,
        nvenc_h264_error: enc.nvenc_h264_error,
        nvenc_h265_error: enc.nvenc_h265_error,
        error,
    }
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

fn encoders_text() -> Result<String, String> {
    let output = hidden_command(resolve_ffmpeg())
        .args(["-hide_banner", "-encoders"])
        .output()
        .map_err(|e| format!("не удалось запустить ffmpeg для проверки кодировщиков: {e}"))?;
    if !output.status.success() {
        let detail = String::from_utf8_lossy(&output.stderr).trim().to_string();
        return Err(if detail.is_empty() {
            format!("ffmpeg -encoders завершился с кодом {}", output.status.code().map_or("неизвестен".into(), |c| c.to_string()))
        } else {
            detail.chars().take(360).collect()
        });
    }
    let encoders = String::from_utf8_lossy(&output.stdout).into_owned();
    if encoders.trim().is_empty() {
        return Err("ffmpeg вернул пустой список кодировщиков".into());
    }
    Ok(encoders)
}

/// Кодировщик есть в сборке и реально работает (на машине без видеокарты NVENC в списке есть, но не запускается).
fn encoder_works(list: &str, name: &str) -> Result<(), String> {
    if !list.contains(name) {
        return Err(format!("в этой сборке FFmpeg нет кодировщика {name}"));
    }
    let mut command = hidden_command(resolve_ffmpeg());
    command
        .args(["-v", "error", "-f", "lavfi", "-i", "color=c=black:s=256x144:d=0.2", "-c:v", name, "-f", "null", "-"])
        .stdout(Stdio::null())
        .stderr(Stdio::piped());
    let mut child = command.spawn().map_err(|e| format!("не удалось запустить короткую проверку {name}: {e}"))?;
    let deadline = Instant::now() + Duration::from_secs(20);
    loop {
        match child.try_wait() {
            Ok(Some(_)) => break,
            Ok(None) if Instant::now() < deadline => std::thread::sleep(Duration::from_millis(100)),
            Ok(None) => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(format!("проверка {name} длится больше 20 секунд; возможно, завис видеодрайвер"));
            }
            Err(e) => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(format!("не удалось проверить {name}: {e}"));
            }
        }
    }
    let output = child.wait_with_output().map_err(|e| format!("не удалось прочитать результат проверки {name}: {e}"))?;
    if output.status.success() {
        return Ok(());
    }
    let detail = String::from_utf8_lossy(&output.stderr)
        .lines()
        .filter(|line| !line.trim().is_empty())
        .take(3)
        .collect::<Vec<_>>()
        .join("; ");
    let detail = if detail.is_empty() {
        format!("процесс завершился с кодом {}", output.status.code().map_or("неизвестно".into(), |c| c.to_string()))
    } else {
        detail.chars().take(360).collect()
    };
    Err(detail)
}

/// Проверка кодировщиков — это несколько запусков ffmpeg (и инициализация драйвера NVENC, секунды), поэтому
/// удачный результат запоминаем до закрытия приложения: перед каждым рендером заново её гонять незачем.
pub fn encoder_status() -> EncoderStatus {
    static CACHE: std::sync::OnceLock<EncoderStatus> = std::sync::OnceLock::new();
    if let Some(cached) = CACHE.get() {
        return cached.clone();
    }
    let list = match encoders_text() {
        Ok(list) => list,
        Err(error) => {
            log::info!("FFmpeg encoder list check failed: {error}");
            return EncoderStatus {
                nvenc_h264: false,
                nvenc_h265: false,
                soft_h264: false,
                soft_h265: false,
                nvenc_h264_error: Some(error.clone()),
                nvenc_h265_error: Some(error),
            };
        }
    };
    let (h264, h265) = std::thread::scope(|sc| {
        let a = sc.spawn(|| encoder_works(&list, "h264_nvenc"));
        let b = sc.spawn(|| encoder_works(&list, "hevc_nvenc"));
        (
            a.join().unwrap_or_else(|_| Err("проверка кодировщика аварийно завершилась".into())),
            b.join().unwrap_or_else(|_| Err("проверка кодировщика аварийно завершилась".into())),
        )
    });
    let status = EncoderStatus {
        nvenc_h264: h264.is_ok(),
        nvenc_h265: h265.is_ok(),
        soft_h264: list.contains("libx264"),
        soft_h265: list.contains("libx265"),
        nvenc_h264_error: h264.err(),
        nvenc_h265_error: h265.err(),
    };
    log::info!("FFmpeg NVENC H.264 check: {}", status.nvenc_h264_error.as_deref().unwrap_or("готов"));
    log::info!("FFmpeg NVENC H.265 check: {}", status.nvenc_h265_error.as_deref().unwrap_or("готов"));
    let _ = CACHE.set(status.clone());
    status
}

pub async fn run(
    app: &tauri::AppHandle,
    client: &reqwest::Client,
    api_base: &str,
    plan: Plan,
    init_data: &str,
    local_video: Option<PathBuf>,
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
        if item.local.unwrap_or(false) {
            let src = local_video.as_ref().ok_or("План требует видео с этого компьютера, но файл не выбран.")?;
            emit("download", index as f64 / total_files as f64 * 0.2, &format!("Беру видео с компьютера: {label}"));
            let dest = dir.join(name);
            // Жёсткая ссылка не копирует гигабайты (если файл на том же диске, что и Temp); иначе обычное копирование.
            if std::fs::hard_link(src, &dest).is_err() {
                std::fs::copy(src, &dest).map_err(|e| format!("Не удалось взять видео «{label}»: {e}"))?;
            }
            continue;
        }
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
            let detail = response_detail(resp).await;
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

/// Причина отказа сервера: текст из `detail`, а если ответ не от бота (например, от nginx) — по коду статуса.
async fn response_detail(resp: reqwest::Response) -> String {
    let status = resp.status();
    let detail = resp
        .json::<serde_json::Value>()
        .await
        .ok()
        .and_then(|v| v.get("detail").and_then(|d| d.as_str()).map(str::to_string));
    if let Some(d) = detail {
        return d;
    }
    match status.as_u16() {
        413 => "файл больше лимита сервера (413)".to_string(),
        502 | 503 | 504 => format!("сервер недоступен или перезапускается ({})", status.as_u16()),
        code => format!("сервер ответил {code}"),
    }
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
        let detail = response_detail(resp).await;
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

#[derive(Serialize)]
pub struct LocalVideoInfo {
    pub name: String,
    pub width: u32,
    pub height: u32,
    pub duration: f64,
    pub fps: String,
    pub has_audio: bool,
    pub audio_codec: String,
    pub size: u64,
}

/// Параметры видео на этом компьютере для плана сборки: сервер файла не видит, поэтому ffprobe выполняем здесь.
pub fn probe_local_video(path: &std::path::Path) -> Result<LocalVideoInfo, String> {
    let ffprobe = crate::media_tools::resolve_ffprobe();
    let output = hidden_command(ffprobe)
        .args(["-v", "error", "-print_format", "json", "-show_format", "-show_streams"])
        .arg(path)
        .output()
        .map_err(|e| format!("ffprobe не запустился: {e}"))?;
    if !output.status.success() {
        return Err(format!("ffprobe не смог прочитать видео: {}", String::from_utf8_lossy(&output.stderr).trim()));
    }
    let json: serde_json::Value = serde_json::from_slice(&output.stdout).map_err(|e| format!("Не удалось разобрать ответ ffprobe: {e}"))?;
    let streams = json["streams"].as_array().cloned().unwrap_or_default();
    let video = streams.iter().find(|s| s["codec_type"] == "video").ok_or("В файле нет видеодорожки.")?;
    let audio = streams.iter().find(|s| s["codec_type"] == "audio");
    let duration = json["format"]["duration"].as_str().and_then(|d| d.parse::<f64>().ok()).unwrap_or(0.0);
    Ok(LocalVideoInfo {
        name: path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_else(|| "episode.mkv".into()),
        width: video["width"].as_u64().unwrap_or(0) as u32,
        height: video["height"].as_u64().unwrap_or(0) as u32,
        duration,
        fps: video["r_frame_rate"].as_str().unwrap_or("24/1").to_string(),
        has_audio: audio.is_some(),
        audio_codec: audio.and_then(|a| a["codec_name"].as_str()).unwrap_or("").to_string(),
        size: std::fs::metadata(path).map(|m| m.len()).unwrap_or(0),
    })
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
