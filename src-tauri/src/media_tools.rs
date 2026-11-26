
use crate::audio_qc::{ffmpeg_command, hidden_command, resolve_ffmpeg};
use serde::{Deserialize, Serialize};
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::process::{Child, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::OnceLock;

pub(crate) fn resolve_ffprobe() -> &'static str {
    static RESOLVED: std::sync::Mutex<Option<&'static str>> = std::sync::Mutex::new(None);
    crate::audio_qc::cached_resolve(&RESOLVED, "ffprobe", "ffprobe.exe")
}

fn tool_version(bin: &str) -> Option<String> {
    let out = std::process::Command::new(bin).arg("-version").output().ok()?;
    if !out.status.success() {
        return None;
    }
    String::from_utf8_lossy(&out.stdout).lines().next().map(|l| l.trim().to_string())
}

#[derive(Serialize)]
pub struct ToolStatus {
    pub ffmpeg: Option<String>,
    pub ffprobe: Option<String>,
}

pub fn tool_status() -> ToolStatus {
    ToolStatus { ffmpeg: tool_version(resolve_ffmpeg()), ffprobe: tool_version(resolve_ffprobe()) }
}

#[derive(Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct StreamInfo {
    pub codec: String,
    pub width: Option<u32>,
    pub height: Option<u32>,
    pub fps: Option<f64>,
    pub channels: Option<u32>,
    pub sample_rate: Option<u32>,
    pub bit_rate: Option<u64>,
}

#[derive(Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct MediaInfo {
    pub duration: f64,
    pub container: String,
    pub video: Option<StreamInfo>,
    pub audio: Option<StreamInfo>,
}

pub fn probe_media(path: &str) -> Result<MediaInfo, String> {
    let ffprobe = resolve_ffprobe();
    let output = ffmpeg_command(ffprobe)
        .args(["-v", "error", "-print_format", "json", "-show_format", "-show_streams"])
        .arg(path)
        .output()
        .map_err(|e| format!("ffprobe не найден или не запустился ({ffprobe}): {e}."))?;

    if !output.status.success() {
        let err = String::from_utf8_lossy(&output.stderr);
        return Err(format!("ffprobe не смог прочитать файл: {}", err.trim()));
    }

    let json: serde_json::Value = serde_json::from_slice(&output.stdout)
        .map_err(|e| format!("Не удалось разобрать вывод ffprobe: {e}"))?;

    let duration = json
        .get("format")
        .and_then(|f| f.get("duration"))
        .and_then(|d| d.as_str())
        .and_then(|s| s.parse::<f64>().ok())
        .unwrap_or(0.0);
    let container = json
        .get("format")
        .and_then(|f| f.get("format_name"))
        .and_then(|s| s.as_str())
        .unwrap_or("")
        .to_string();

    let mut info = MediaInfo { duration, container, video: None, audio: None };
    if let Some(streams) = json.get("streams").and_then(|s| s.as_array()) {
        for s in streams {
            let codec_type = s.get("codec_type").and_then(|v| v.as_str()).unwrap_or("");
            let codec = s.get("codec_name").and_then(|v| v.as_str()).unwrap_or("?").to_string();
            match codec_type {
                "video" if info.video.is_none() => {
                    let fps = s
                        .get("avg_frame_rate")
                        .and_then(|v| v.as_str())
                        .and_then(|s| {
                            let mut parts = s.split('/');
                            let num: f64 = parts.next()?.parse().ok()?;
                            let den: f64 = parts.next()?.parse().ok()?;
                            (den > 0.0).then_some(num / den)
                        });
                    info.video = Some(StreamInfo {
                        codec,
                        width: s.get("width").and_then(|v| v.as_u64()).map(|v| v as u32),
                        height: s.get("height").and_then(|v| v.as_u64()).map(|v| v as u32),
                        fps,
                        ..Default::default()
                    });
                }
                "audio" if info.audio.is_none() => {
                    info.audio = Some(StreamInfo {
                        codec,
                        channels: s.get("channels").and_then(|v| v.as_u64()).map(|v| v as u32),
                        sample_rate: s
                            .get("sample_rate")
                            .and_then(|v| v.as_str())
                            .and_then(|s| s.parse::<u32>().ok()),
                        bit_rate: s
                            .get("bit_rate")
                            .and_then(|v| v.as_str())
                            .and_then(|s| s.parse::<u64>().ok()),
                        ..Default::default()
                    });
                }
                _ => {}
            }
        }
    }
    Ok(info)
}

pub fn register_media_file(app: &tauri::AppHandle, path: &str) -> Result<(), String> {
    use tauri::Manager;
    app.asset_protocol_scope()
        .allow_file(path)
        .map_err(|e| format!("Не удалось открыть файл для предпросмотра: {e}"))
}

fn ext_of(path: &str) -> String {
    Path::new(path)
        .extension()
        .map(|e| e.to_string_lossy().to_lowercase())
        .unwrap_or_else(|| "mp4".to_string())
}

struct TempWork {
    path: PathBuf,
    dir: PathBuf,
}

impl TempWork {
    fn file(name: &str) -> Result<Self, String> {
        let dir = Self::make_dir()?;
        let path = dir.join(name);
        Ok(Self { path, dir })
    }

    fn make_dir() -> Result<PathBuf, String> {
        let unique = format!(
            "{}_{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_nanos())
                .unwrap_or(0)
        );
        let dir = std::env::temp_dir().join(format!("project_mt_{unique}"));
        std::fs::create_dir(&dir)
            .map_err(|e| format!("Не удалось подготовить временный каталог: {e}"))?;
        Ok(dir)
    }

    fn concat_list(paths: &[String]) -> Result<Self, String> {
        let dir = Self::make_dir()?;
        let path = dir.join("list.txt");
        let body = paths
            .iter()
            .map(|p| format!("file '{}'\n", p.replace('\'', "'\\''")))
            .collect::<String>();
        std::fs::write(&path, body)
            .map_err(|e| format!("Не удалось подготовить список склейки: {e}"))?;
        Ok(Self { path, dir })
    }
}

impl Drop for TempWork {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.dir);
    }
}

const VIDEO_CODECS: &[&str] = &["copy", "libx264", "libx265", "libvpx-vp9", "libaom-av1", "mpeg4", "prores_ks"];
const AUDIO_CODECS: &[&str] = &["copy", "aac", "mp3", "libmp3lame", "flac", "libopus", "pcm_s16le", "pcm_s24le", "ac3"];

fn check_codec(value: &str, allowed: &[&str], kind: &str) -> Result<String, String> {
    if allowed.contains(&value) {
        Ok(value.to_string())
    } else {
        Err(format!("Неизвестный {kind}-кодек: {value}"))
    }
}

fn check_bitrate(value: &str) -> Result<String, String> {
    let v = value.trim();
    let (digits, suffix) = match v.strip_suffix(['k', 'K', 'm', 'M']) {
        Some(d) => (d, true),
        None => (v, false),
    };
    let ok = !digits.is_empty()
        && digits.chars().all(|c| c.is_ascii_digit() || c == '.')
        && digits.parse::<f64>().map(|n| n > 0.0).unwrap_or(false);
    if ok {
        Ok(if suffix { v.to_string() } else { digits.to_string() })
    } else {
        Err(format!("Некорректный битрейт: {value} (ожидается, например, 128k или 2M)"))
    }
}

fn check_dimension(value: u32, name: &str) -> Result<u32, String> {
    if (1..=16384).contains(&value) {
        Ok(value)
    } else {
        Err(format!("{name} должна быть от 1 до 16384 пикселей."))
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TranscodeOpts {
    pub video_codec: Option<String>,
    pub audio_codec: Option<String>,
    pub video_bitrate: Option<String>,
    pub audio_bitrate: Option<String>,
    pub width: Option<u32>,
    pub height: Option<u32>,
    pub crf: Option<u32>,
}

pub fn transcode_media(progress: &Progress, path: &str, out_path: &str, opts: &TranscodeOpts) -> Result<(), String> {
    let duration_hint = probe_media(path).map(|m| m.duration).unwrap_or(0.0);
    let args = transcode_args(path, out_path, opts)?;
    run_ffmpeg(
        progress,
        &args,
        Path::new(out_path),
        Stage { label: "Перекодирование".into(), base: 0.0, span: 1.0, duration: duration_hint },
    )
}

fn transcode_args(path: &str, out_path: &str, opts: &TranscodeOpts) -> Result<Vec<String>, String> {
    let mut args: Vec<String> = vec!["-v".into(), "error".into(), "-y".into(), "-i".into(), path.into()];

    match (opts.width, opts.height) {
        (Some(w), Some(h)) => {
            let (w, h) = (check_dimension(w, "Ширина")?, check_dimension(h, "Высота")?);
            args.extend(["-vf".into(), format!("scale={w}:{h}")]);
        }
        (Some(w), None) => {
            let w = check_dimension(w, "Ширина")?;
            args.extend(["-vf".into(), format!("scale={w}:-2")]);
        }
        (None, Some(h)) => {
            let h = check_dimension(h, "Высота")?;
            args.extend(["-vf".into(), format!("scale=-2:{h}")]);
        }
        (None, None) => {}
    }

    let video_codec = opts
        .video_codec
        .as_deref()
        .filter(|c| !c.is_empty())
        .map(|c| check_codec(c, VIDEO_CODECS, "видео"))
        .transpose()?;
    if let Some(vc) = &video_codec {
        args.extend(["-c:v".into(), vc.clone()]);
        if vc == "libx264" {
            args.extend(["-pix_fmt".into(), "yuv420p".into()]);
        }
    }
    if let Some(vb) = opts.video_bitrate.as_deref().filter(|v| !v.is_empty()) {
        args.extend(["-b:v".into(), check_bitrate(vb)?]);
    }
    if let Some(crf) = opts.crf {
        if crf > 63 {
            return Err("CRF должен быть от 0 до 63.".into());
        }
        args.extend(["-crf".into(), crf.to_string()]);
    }

    let audio_codec = opts
        .audio_codec
        .as_deref()
        .filter(|c| !c.is_empty())
        .map(|c| check_codec(c, AUDIO_CODECS, "аудио"))
        .transpose()?;
    if let Some(ac) = &audio_codec {
        args.extend(["-c:a".into(), ac.clone()]);
    }
    if let Some(ab) = opts.audio_bitrate.as_deref().filter(|v| !v.is_empty()) {
        args.extend(["-b:a".into(), check_bitrate(ab)?]);
    }

    if matches!(ext_of(out_path).as_str(), "mp4" | "m4v" | "mov") {
        args.extend(["-movflags".into(), "+faststart".into()]);
    }
    Ok(args)
}

#[derive(Deserialize)]
pub struct ExtractAudioOpts {
    pub codec: String,
    pub bitrate: Option<String>,
    pub normalize: bool,
}

#[derive(Debug, PartialEq)]
struct LoudnormMeasurement {
    input_i: String,
    input_tp: String,
    input_lra: String,
    input_thresh: String,
    target_offset: String,
}

fn measure_loudness(path: &str) -> Option<LoudnormMeasurement> {
    let ffmpeg = resolve_ffmpeg();
    let output = ffmpeg_command(ffmpeg)
        .args([
            "-v", "error",
            "-i", path,
            "-vn",
            "-af", "loudnorm=I=-16:TP=-1.5:LRA=11:print_format=json",
            "-f", "null",
            "-",
        ])
        .output()
        .ok()?;
    parse_loudnorm_json(&String::from_utf8_lossy(&output.stderr))
}

fn parse_loudnorm_json(stderr: &str) -> Option<LoudnormMeasurement> {
    let start = stderr.rfind('{')?;
    let end = stderr[start..].find('}')? + start + 1;
    let v: serde_json::Value = serde_json::from_str(&stderr[start..end]).ok()?;
    let get = |k: &str| v.get(k).and_then(|x| x.as_str()).map(str::to_string);
    Some(LoudnormMeasurement {
        input_i: get("input_i")?,
        input_tp: get("input_tp")?,
        input_lra: get("input_lra")?,
        input_thresh: get("input_thresh")?,
        target_offset: get("target_offset")?,
    })
}

fn loudnorm_filter(measured: Option<&LoudnormMeasurement>) -> String {
    match measured {
        Some(m) => format!(
            "loudnorm=I=-16:TP=-1.5:LRA=11:measured_I={}:measured_TP={}:measured_LRA={}:measured_thresh={}:offset={}:linear=true",
            m.input_i, m.input_tp, m.input_lra, m.input_thresh, m.target_offset
        ),
        None => "loudnorm=I=-16:TP=-1.5:LRA=11".to_string(),
    }
}

pub fn extract_audio(progress: &Progress, path: &str, out_path: &str, opts: &ExtractAudioOpts) -> Result<(), String> {
    let codec = if opts.normalize && opts.codec == "copy" { "aac" } else { opts.codec.as_str() };
    let codec = check_codec(codec, AUDIO_CODECS, "аудио")?;
    let bitrate = opts
        .bitrate
        .as_deref()
        .filter(|b| !b.is_empty())
        .map(check_bitrate)
        .transpose()?;

    let duration_hint = probe_media(path).map(|m| m.duration).unwrap_or(0.0);
    let (measure_span, encode_base) = if opts.normalize { (0.45, 0.45) } else { (0.0, 0.0) };
    let measured = if opts.normalize {
        progress.report(0.0, "Измеряю громкость (EBU R128)");
        let m = measure_loudness(path);
        progress.report(measure_span, "Измеряю громкость (EBU R128)");
        if m.is_none() {
            log::warn!("loudnorm: первый проход не дал измерений, используем однопроходный режим");
        }
        m
    } else {
        None
    };

    let mut args: Vec<String> = vec![
        "-v".into(), "error".into(), "-y".into(), "-i".into(), path.into(), "-vn".into(),
        "-c:a".into(), codec,
    ];
    if let Some(b) = bitrate {
        args.extend(["-b:a".into(), b]);
    }
    if opts.normalize {
        args.extend(["-af".into(), loudnorm_filter(measured.as_ref())]);
    }

    run_ffmpeg(
        progress,
        &args,
        Path::new(out_path),
        Stage {
            label: if opts.normalize { "Нормализация и кодирование".into() } else { "Извлечение звука".into() },
            base: encode_base,
            span: 1.0 - encode_base,
            duration: duration_hint,
        },
    )
}

fn same_codecs(infos: &[MediaInfo]) -> bool {
    let first = match infos.first() {
        Some(f) => f,
        None => return false,
    };
    infos.iter().all(|m| {
        let video_ok = match (&m.video, &first.video) {
            (Some(a), Some(b)) => a.codec == b.codec && a.width == b.width && a.height == b.height,
            (None, None) => true,
            _ => false,
        };
        let audio_ok = match (&m.audio, &first.audio) {
            (Some(a), Some(b)) => a.codec == b.codec,
            (None, None) => true,
            _ => false,
        };
        video_ok && audio_ok
    })
}

pub fn concat_media(progress: &Progress, paths: &[String], out_path: &str) -> Result<String, String> {
    if paths.len() < 2 {
        return Err("Нужно как минимум два файла для склейки.".into());
    }
    let infos: Vec<MediaInfo> = paths
        .iter()
        .map(|p| probe_media(p))
        .collect::<Result<_, _>>()?;
    let total: f64 = infos.iter().map(|i| i.duration).sum();
    let can_copy = same_codecs(&infos);

    if can_copy {
        let list = TempWork::concat_list(paths)?;
        let args = vec![
            "-v".to_string(), "error".into(),
            "-y".into(),
            "-f".into(), "concat".into(),
            "-safe".into(), "0".into(),
            "-i".into(), list.path.to_string_lossy().into_owned(),
            "-c".into(), "copy".into(),
        ];
        run_ffmpeg(
            progress,
            &args,
            Path::new(out_path),
            Stage { label: "Склейка без перекодирования".into(), base: 0.0, span: 1.0, duration: total },
        )?;
        Ok("copy".to_string())
    } else {
        if infos.iter().any(|i| i.video.is_none()) || infos.iter().any(|i| i.audio.is_none()) {
            return Err(
                "Склейка с перекодированием требует, чтобы у всех файлов были и видео-, и аудио-дорожка. \
                 Уберите файлы без звука (или без картинки) из списка."
                    .into(),
            );
        }
        let mut args: Vec<String> = vec!["-v".into(), "error".into(), "-y".into()];
        for p in paths {
            args.extend(["-i".into(), p.clone()]);
        }
        let filter = (0..paths.len())
            .map(|i| format!("[{i}:v:0][{i}:a:0]"))
            .collect::<String>()
            + &format!("concat=n={}:v=1:a=1[v][a]", paths.len());
        args.extend([
            "-filter_complex".into(), filter,
            "-map".into(), "[v]".into(),
            "-map".into(), "[a]".into(),
        ]);
        run_ffmpeg(
            progress,
            &args,
            Path::new(out_path),
            Stage { label: "Склейка с перекодированием".into(), base: 0.0, span: 1.0, duration: total },
        )?;
        Ok("reencode".to_string())
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DubOpts {
    pub offset: f64,
    pub mode: String,
    pub original_volume: f64,
    pub audio_codec: String,
    pub audio_bitrate: Option<String>,
}

fn dub_args(video: &str, dub: &str, opts: &DubOpts) -> Result<Vec<String>, String> {
    if !opts.offset.is_finite() || opts.offset.abs() > 3600.0 {
        return Err("Сдвиг дорожки должен быть в пределах часа.".into());
    }
    if !(0.0..=1.0).contains(&opts.original_volume) {
        return Err("Громкость оригинала должна быть от 0 до 1.".into());
    }
    let codec = check_codec(&opts.audio_codec, AUDIO_CODECS, "аудио")?;
    let mut args: Vec<String> = vec!["-v".into(), "error".into(), "-y".into()];
    args.extend(["-i".into(), video.to_string()]);
    args.extend(["-itsoffset".into(), format!("{:.3}", opts.offset)]);
    args.extend(["-i".into(), dub.to_string()]);

    match opts.mode.as_str() {
        "replace" => {
            args.extend([
                "-map".into(), "0:v:0".into(),
                "-map".into(), "1:a:0".into(),
                "-c:v".into(), "copy".into(),
                "-c:a".into(), codec,
            ]);
        }
        "add" => {
            args.extend([
                "-map".into(), "0:v:0".into(),
                "-map".into(), "1:a:0".into(),
                "-map".into(), "0:a:0?".into(),
                "-c:v".into(), "copy".into(),
                "-c:a".into(), codec,
                "-disposition:a:0".into(), "default".into(),
                "-disposition:a:1".into(), "0".into(),
                "-metadata:s:a:0".into(), "title=Дубляж".into(),
                "-metadata:s:a:1".into(), "title=Оригинал".into(),
            ]);
        }
        "mix" => {
            let filter = format!(
                "[0:a]volume={:.3}[orig];[orig][1:a]amix=inputs=2:duration=first:dropout_transition=0[mix];[mix]volume=2.0[a]",
                opts.original_volume
            );
            args.extend([
                "-filter_complex".into(), filter,
                "-map".into(), "0:v:0".into(),
                "-map".into(), "[a]".into(),
                "-c:v".into(), "copy".into(),
                "-c:a".into(), codec,
            ]);
        }
        other => return Err(format!("Неизвестный режим сведения: {other}")),
    }
    if let Some(b) = opts.audio_bitrate.as_deref().filter(|b| !b.is_empty()) {
        args.extend(["-b:a".into(), check_bitrate(b)?]);
    }
    args.push("-shortest".into());
    Ok(args)
}

pub fn dub_audio(
    progress: &Progress,
    video: &str,
    dub: &str,
    out_path: &str,
    opts: &DubOpts,
) -> Result<(), String> {
    let args = dub_args(video, dub, opts)?;
    let duration = probe_media(video).map(|m| m.duration).unwrap_or(0.0);
    run_ffmpeg(
        progress,
        &args,
        Path::new(out_path),
        Stage { label: "Свожу дубляж с видео".into(), base: 0.0, span: 1.0, duration },
    )
}

fn atempo_chain(speed: f64) -> String {
    let mut parts = Vec::new();
    let mut left = speed;
    while left > 2.0 {
        parts.push("atempo=2.0".to_string());
        left /= 2.0;
    }
    while left < 0.5 {
        parts.push("atempo=0.5".to_string());
        left /= 0.5;
    }
    parts.push(format!("atempo={left:.6}"));
    parts.join(",")
}

fn speed_args(path: &str, speed: f64, keep_pitch: bool) -> Result<Vec<String>, String> {
    if !speed.is_finite() || !(0.1..=10.0).contains(&speed) {
        return Err("Скорость должна быть от 0.1 до 10.".into());
    }
    let audio_filter = if keep_pitch {
        atempo_chain(speed)
    } else {
        format!("asetrate=44100*{speed:.6},aresample=44100")
    };
    Ok(vec![
        "-v".into(), "error".into(), "-y".into(),
        "-i".into(), path.into(),
        "-filter_complex".into(),
        format!("[0:v]setpts={:.6}*PTS[v];[0:a]{audio_filter}[a]", 1.0 / speed),
        "-map".into(), "[v]".into(),
        "-map".into(), "[a]".into(),
    ])
}

pub fn change_speed(
    progress: &Progress,
    path: &str,
    out_path: &str,
    speed: f64,
    keep_pitch: bool,
) -> Result<(), String> {
    let args = speed_args(path, speed, keep_pitch)?;
    let duration = probe_media(path).map(|m| m.duration / speed).unwrap_or(0.0);
    run_ffmpeg(
        progress,
        &args,
        Path::new(out_path),
        Stage { label: format!("Меняю скорость на {speed}×"), base: 0.0, span: 1.0, duration },
    )
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FrameOpts {
    pub at: f64,
    pub count: u32,
    pub columns: u32,
    pub width: u32,
}

fn frame_args(path: &str, duration: f64, opts: &FrameOpts) -> Result<Vec<String>, String> {
    if !opts.at.is_finite() || opts.at < 0.0 {
        return Err("Некорректная позиция кадра.".into());
    }
    let width = check_dimension(opts.width, "Ширина кадра")?;
    if opts.count == 0 || opts.count > 400 {
        return Err("Кадров в листе должно быть от 1 до 400.".into());
    }
    if opts.count == 1 {
        return Ok(vec![
            "-v".into(), "error".into(), "-y".into(),
            "-ss".into(), format!("{:.3}", opts.at),
            "-i".into(), path.into(),
            "-frames:v".into(), "1".into(),
            "-vf".into(), format!("scale={width}:-2"),
            "-q:v".into(), "2".into(),
        ]);
    }
    let columns = opts.columns.clamp(1, 20);
    let rows = opts.count.div_ceil(columns);
    if duration <= 0.0 {
        return Err("Не удалось определить длительность — контактный лист не собрать.".into());
    }
    let fps = opts.count as f64 / duration;
    Ok(vec![
        "-v".into(), "error".into(), "-y".into(),
        "-i".into(), path.into(),
        "-vf".into(),
        format!("fps={fps:.6},scale={width}:-2,tile={columns}x{rows}"),
        "-frames:v".into(), "1".into(),
        "-q:v".into(), "3".into(),
    ])
}

pub fn extract_frames(progress: &Progress, path: &str, out_path: &str, opts: &FrameOpts) -> Result<(), String> {
    let duration = probe_media(path).map(|m| m.duration).unwrap_or(0.0);
    let args = frame_args(path, duration, opts)?;
    let label = if opts.count == 1 { "Снимаю кадр" } else { "Собираю контактный лист" };
    run_ffmpeg(
        progress,
        &args,
        Path::new(out_path),
        Stage { label: label.into(), base: 0.0, span: 1.0, duration: if opts.count == 1 { 0.0 } else { duration } },
    )
}

pub fn make_gif(
    progress: &Progress,
    path: &str,
    out_path: &str,
    start: f64,
    duration: f64,
    fps: u32,
    width: u32,
) -> Result<(), String> {
    if !(start.is_finite() && duration.is_finite() && start >= 0.0 && duration > 0.0) {
        return Err("Некорректный диапазон фрагмента.".into());
    }
    if duration > 60.0 {
        return Err("Фрагмент длиннее минуты — GIF выйдет на сотни мегабайт. Возьмите кусок покороче.".into());
    }
    let fps = fps.clamp(5, 50);
    let width = check_dimension(width, "Ширина")?;

    let palette = TempWork::file("palette.png")?;
    let palette_path = palette.path.to_string_lossy().into_owned();
    let common = |extra: &str| -> Vec<String> {
        vec![
            "-v".into(), "error".into(), "-y".into(),
            "-ss".into(), format!("{start:.3}"),
            "-t".into(), format!("{duration:.3}"),
            "-i".into(), path.into(),
            "-vf".into(), format!("fps={fps},scale={width}:-1:flags=lanczos{extra}"),
        ]
    };
    run_ffmpeg(
        progress,
        &common(",palettegen=stats_mode=diff"),
        Path::new(&palette_path),
        Stage { label: "Подбираю палитру".into(), base: 0.0, span: 0.4, duration },
    )?;

    let mut args = vec![
        "-v".to_string(), "error".into(), "-y".into(),
        "-ss".into(), format!("{start:.3}"),
        "-t".into(), format!("{duration:.3}"),
        "-i".into(), path.into(),
        "-i".into(), palette_path,
        "-lavfi".into(),
        format!("fps={fps},scale={width}:-1:flags=lanczos[x];[x][1:v]paletteuse=dither=bayer:bayer_scale=3"),
    ];
    args.extend(["-loop".into(), "0".into()]);
    run_ffmpeg(
        progress,
        &args,
        Path::new(out_path),
        Stage { label: "Собираю GIF".into(), base: 0.4, span: 0.6, duration },
    )
}

fn escape_filter_path(path: &str) -> String {
    let mut out = String::with_capacity(path.len() + 16);
    for ch in path.chars() {
        match ch {
            '\\' => out.push_str(r"\\\\"),
            ':' => out.push_str(r"\\:"),
            '\'' => out.push_str(r"\\\'"),
            ' ' | ',' | ';' | '[' | ']' | '=' => {
                out.push('\\');
                out.push(ch);
            }
            _ => out.push(ch),
        }
    }
    out
}

fn burn_subtitles_args(video: &str, subs: &str, font_size: u32) -> Result<Vec<String>, String> {
    if !(8..=96).contains(&font_size) {
        return Err("Размер шрифта должен быть от 8 до 96.".into());
    }
    let escaped = escape_filter_path(subs);
    let filter = format!("subtitles='{escaped}':force_style='FontSize={font_size}'");
    Ok(vec![
        "-v".into(), "error".into(), "-y".into(),
        "-i".into(), video.into(),
        "-vf".into(), filter,
        "-c:a".into(), "copy".into(),
    ])
}

pub fn burn_subtitles(
    progress: &Progress,
    video: &str,
    subs: &str,
    out_path: &str,
    font_size: u32,
) -> Result<(), String> {
    let args = burn_subtitles_args(video, subs, font_size)?;
    let duration = probe_media(video).map(|m| m.duration).unwrap_or(0.0);
    run_ffmpeg(
        progress,
        &args,
        Path::new(out_path),
        Stage { label: "Вшиваю субтитры".into(), base: 0.0, span: 1.0, duration },
    )
}

pub fn extract_subtitles(progress: &Progress, path: &str, out_path: &str, track: u32) -> Result<(), String> {
    let args = vec![
        "-v".to_string(), "error".into(), "-y".into(),
        "-i".into(), path.into(),
        "-map".into(), format!("0:s:{track}"),
    ];
    run_ffmpeg(
        progress,
        &args,
        Path::new(out_path),
        Stage { label: "Извлекаю субтитры".into(), base: 0.0, span: 1.0, duration: 0.0 },
    )
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MuxTrack {
    pub path: String,
    pub kind: String,
    pub language: Option<String>,
    pub title: Option<String>,
    pub is_default: bool,
}

pub fn mux_media(tracks: &[MuxTrack], out_path: &str) -> Result<(), String> {
    if tracks.is_empty() {
        return Err("Не выбрано ни одной дорожки для муксинга.".into());
    }
    let ffmpeg = resolve_ffmpeg();
    let mut cmd = ffmpeg_command(ffmpeg);
    cmd.args(["-v", "error", "-y"]);
    for t in tracks {
        cmd.args(["-i", &t.path]);
    }
    for i in 0..tracks.len() {
        cmd.args(["-map", &format!("{i}:0")]);
    }
    cmd.args(["-c", "copy"]);
    let out_ext = ext_of(out_path);
    let has_subtitles = tracks.iter().any(|t| t.kind == "subtitle");
    if has_subtitles && matches!(out_ext.as_str(), "mp4" | "m4v" | "mov") {
        cmd.args(["-c:s", "mov_text"]);
    }

    let mut counters: std::collections::HashMap<&str, usize> = std::collections::HashMap::new();
    for t in tracks {
        let type_code = match t.kind.as_str() {
            "video" => "v",
            "audio" => "a",
            "subtitle" => "s",
            other => return Err(format!("Неизвестный тип дорожки: {other}")),
        };
        let idx = *counters.entry(type_code).or_insert(0);
        if let Some(lang) = t.language.as_deref().filter(|l| !l.is_empty()) {
            cmd.args([format!("-metadata:s:{type_code}:{idx}"), format!("language={lang}")]);
        }
        if let Some(title) = t.title.as_deref().filter(|s| !s.is_empty()) {
            cmd.args([format!("-metadata:s:{type_code}:{idx}"), format!("title={title}")]);
        }
        cmd.args([
            format!("-disposition:{type_code}:{idx}"),
            if t.is_default { "default".to_string() } else { "0".to_string() },
        ]);
        counters.insert(type_code, idx + 1);
    }
    cmd.arg(out_path);

    let output = cmd.output().map_err(|e| format!("ffmpeg не найден или не запустился ({ffmpeg}): {e}."))?;
    if !output.status.success() {
        let err = String::from_utf8_lossy(&output.stderr);
        return Err(format!("ffmpeg не смог смуксить файлы: {}", err.trim()));
    }
    Ok(())
}

pub(crate) struct Stage {
    pub label: String,
    pub base: f64,
    pub span: f64,
    pub duration: f64,
}

pub struct Progress<'a>(pub &'a (dyn Fn(f64, &str) + Sync));

impl Progress<'_> {
    fn report(&self, fraction: f64, label: &str) {
        (self.0)(fraction.clamp(0.0, 1.0), label);
    }
}

fn current_job() -> &'static std::sync::Mutex<Option<std::sync::Arc<std::sync::Mutex<Child>>>> {
    static JOB: OnceLock<std::sync::Mutex<Option<std::sync::Arc<std::sync::Mutex<Child>>>>> = OnceLock::new();
    JOB.get_or_init(|| std::sync::Mutex::new(None))
}

static CANCEL_REQUESTED: AtomicBool = AtomicBool::new(false);

pub fn cancel_current_job() -> Result<(), String> {
    let guard = current_job().lock().map_err(|_| "внутренняя ошибка блокировки")?;
    match guard.as_ref() {
        Some(child) => {
            CANCEL_REQUESTED.store(true, Ordering::SeqCst);
            if let Ok(mut c) = child.lock() {
                let _ = c.kill();
            }
            log::info!("операция ffmpeg отменена пользователем");
            Ok(())
        }
        None => Err("Сейчас нечего отменять — операция уже завершилась.".into()),
    }
}

fn is_progress_line(line: &str) -> bool {
    match line.split_once('=') {
        Some((key, _)) => {
            !key.is_empty() && key.chars().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '_')
        }
        None => false,
    }
}

pub(crate) fn run_ffmpeg(
    progress: &Progress,
    args: &[String],
    out_path: &Path,
    stage: Stage,
) -> Result<(), String> {
    run_ffmpeg_in(progress, args, out_path, stage, None, None)
}

pub(crate) type LineSink<'a> = &'a (dyn Fn(&str, &str) + Sync);

fn line_kind(line: &str) -> &'static str {
    let low = line.to_ascii_lowercase();
    if low.contains("error") || low.contains("invalid") || low.contains("failed") || low.contains("cannot") || low.contains("could not") {
        "err"
    } else if low.contains("warning") || low.contains("deprecated") || low.contains("past duration") {
        "warn"
    } else {
        "out"
    }
}

fn shell_arg(arg: &str) -> String {
    if arg.is_empty() || arg.contains(' ') || arg.contains('"') {
        format!("\"{}\"", arg.replace('"', "\\\""))
    } else {
        arg.to_string()
    }
}

pub(crate) fn run_ffmpeg_in(
    progress: &Progress,
    args: &[String],
    out_path: &Path,
    stage: Stage,
    cwd: Option<&Path>,
    on_line: Option<LineSink>,
) -> Result<(), String> {
    let ffmpeg = resolve_ffmpeg();
    let say = |kind: &str, text: &str| {
        if let Some(sink) = on_line {
            sink(kind, text);
        }
    };
    say(
        "cmd",
        &format!(
            "ffmpeg {} -progress pipe:2 -nostats {}",
            args.iter().map(|a| shell_arg(a)).collect::<Vec<_>>().join(" "),
            shell_arg(&out_path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default())
        ),
    );
    let existed_before = out_path.exists();

    let mut command = hidden_command(ffmpeg);
    command
        .args(args)
        .args(["-progress", "pipe:2", "-nostats"])
        .arg(out_path)
        .stderr(Stdio::piped())
        .stdout(Stdio::null());
    if let Some(dir) = cwd {
        command.current_dir(dir);
    }
    let mut child = command
        .spawn()
        .map_err(|e| format!("ffmpeg не найден или не запустился ({ffmpeg}): {e}."))?;
    let started = std::time::Instant::now();
    log::info!(target: "project_desktop::media_tools", "FFmpeg запущен: {} (шаг занимает {:.0}%–{:.0}% общего прогресса).", stage.label, stage.base * 100.0, (stage.base + stage.span) * 100.0);

    let stderr = child.stderr.take().ok_or("не удалось получить поток ошибок ffmpeg")?;
    CANCEL_REQUESTED.store(false, Ordering::SeqCst);
    let handle = std::sync::Arc::new(std::sync::Mutex::new(child));
    if let Ok(mut slot) = current_job().lock() {
        *slot = Some(handle.clone());
    }

    progress.report(stage.base, &stage.label);
    let mut stderr_text = String::new();
    let mut next_log_percent = 5_u8;
    let (mut frame, mut fps, mut speed, mut bitrate) = (String::new(), String::new(), String::new(), String::new());
    let mut last_stat = std::time::Instant::now();
    for line in BufReader::new(stderr).lines().map_while(Result::ok) {
        if on_line.is_some() {
            if let Some((key, value)) = line.split_once('=') {
                let value = value.trim().to_string();
                match key {
                    "frame" => frame = value,
                    "fps" => fps = value,
                    "speed" => speed = value,
                    "bitrate" => bitrate = value,
                    "progress" if last_stat.elapsed().as_millis() >= 1000 || value == "end" => {
                        last_stat = std::time::Instant::now();
                        say("stat", &format!("кадр {frame} · {fps} fps · скорость {speed} · битрейт {bitrate}"));
                    }
                    _ => {}
                }
            }
        }
        if let Some(us) = line.strip_prefix("out_time_ms=").and_then(|v| v.trim().parse::<f64>().ok()) {
            if stage.duration > 0.0 {
                let frac = ((us / 1_000_000.0) / stage.duration).clamp(0.0, 1.0);
                progress.report(stage.base + frac * stage.span, &stage.label);
                let percent = (frac * 100.0).floor() as u8;
                if percent >= next_log_percent {
                    log::info!(target: "project_desktop::media_tools", "FFmpeg: шаг выполнен на {percent}%, время {:.0} с.", started.elapsed().as_secs_f64());
                    next_log_percent = percent.saturating_add(5);
                }
            }
        } else if !is_progress_line(&line) {
            if !line.trim().is_empty() {
                say(line_kind(&line), &line);
            }
            if stderr_text.len() < 4000 {
                stderr_text.push_str(&line);
                stderr_text.push('\n');
            }
        }
    }

    let status = {
        let mut c = handle.lock().map_err(|_| "внутренняя ошибка блокировки")?;
        c.wait().map_err(|e| format!("ffmpeg завершился с ошибкой ожидания: {e}"))?
    };
    if let Ok(mut slot) = current_job().lock() {
        if matches!(slot.as_ref(), Some(current) if std::sync::Arc::ptr_eq(current, &handle)) {
            *slot = None;
        }
    }

    let cancelled = CANCEL_REQUESTED.swap(false, Ordering::SeqCst);
    if cancelled {
        if !existed_before {
            let _ = std::fs::remove_file(out_path);
        }
        return Err("Операция отменена.".into());
    }
    if !status.success() {
        if !existed_before {
            let _ = std::fs::remove_file(out_path);
        }
        let details = stderr_text.trim();
        let code = status.code().map_or("неизвестен".into(), |c| c.to_string());
        say("err", &format!("ffmpeg завершился с кодом {code}"));
        return Err(if details.is_empty() {
            format!("ffmpeg завершился с кодом {code}, но не сообщил причину; откройте логи приложения.")
        } else {
            format!("ffmpeg завершился с кодом {code}: {details}")
        });
    }
    log::info!(target: "project_desktop::media_tools", "FFmpeg завершён успешно за {:.0} с.", started.elapsed().as_secs_f64());
    say("ok", &format!("Шаг готов за {:.0} с", started.elapsed().as_secs_f64()));
    progress.report(stage.base + stage.span, &stage.label);
    Ok(())
}
