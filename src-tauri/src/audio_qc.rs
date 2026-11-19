
use serde::Serialize;
use std::path::PathBuf;
use std::process::Command;

#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

pub(crate) fn hidden_command(exe: impl AsRef<std::ffi::OsStr>) -> Command {
    #[allow(unused_mut)]
    let mut cmd = Command::new(exe);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    cmd
}

pub(crate) fn ffmpeg_command(exe: impl AsRef<std::ffi::OsStr>) -> Command {
    hidden_command(exe)
}

#[derive(Serialize, Clone)]
pub struct QcFinding {
    pub kind: String,
    pub start: f64,
    pub end: f64,
    pub severity: String,
    pub message: String,
}

#[derive(Serialize)]
pub struct QcReport {
    pub duration: f64,
    pub findings: Vec<QcFinding>,
    pub peak_dbfs: f64,
    pub rms_dbfs: f64,
}

const SAMPLE_RATE: u32 = 16_000;
const CLIP_THRESHOLD: i32 = 32_600;
const SILENCE_RMS_THRESHOLD: f64 = 0.006;
const MIN_SILENCE_SECONDS: f64 = 1.2;
const WINDOW_SECONDS: f64 = 0.05;

pub fn analyze(path: &str) -> Result<QcReport, String> {
    let samples = decode_pcm(path)?;
    analyze_samples(&samples)
}

#[derive(Serialize)]
pub struct WaveformData {
    pub duration: f64,
    pub peaks: Vec<f32>,
}

const MIN_WAVEFORM_BUCKETS: u32 = 8;
const MAX_WAVEFORM_BUCKETS: u32 = 4000;

pub fn generate_waveform(path: &str, buckets: u32) -> Result<WaveformData, String> {
    let samples = decode_pcm(path)?;
    if samples.is_empty() {
        return Err("Не удалось прочитать аудио — файл пуст или повреждён.".into());
    }
    let buckets = buckets.clamp(MIN_WAVEFORM_BUCKETS, MAX_WAVEFORM_BUCKETS);
    let duration = samples.len() as f64 / SAMPLE_RATE as f64;
    Ok(WaveformData {
        duration,
        peaks: downsample_peaks(&samples, buckets),
    })
}

fn downsample_peaks(samples: &[i16], buckets: u32) -> Vec<f32> {
    let buckets = buckets.max(1) as usize;
    let len = samples.len();
    let mut out = Vec::with_capacity(buckets * 2);
    for b in 0..buckets {
        let start = b * len / buckets;
        let end = (((b + 1) * len / buckets).max(start + 1)).min(len);
        let slice = &samples[start..end];
        let mut mn = i16::MAX;
        let mut mx = i16::MIN;
        for &s in slice {
            if s < mn {
                mn = s;
            }
            if s > mx {
                mx = s;
            }
        }
        out.push(mn as f32 / 32768.0);
        out.push(mx as f32 / 32768.0);
    }
    out
}

pub fn export_clip(path: &str, start: f64, end: f64, out_path: &str) -> Result<(), String> {
    if !(start.is_finite() && end.is_finite() && start >= 0.0 && end > start) {
        return Err("Некорректный диапазон фрагмента.".into());
    }
    let duration = end - start;
    let ffmpeg = resolve_ffmpeg();
    let output = ffmpeg_command(ffmpeg)
        .args([
            "-v", "error",
            "-y",
            "-ss", &format!("{start:.3}"),
            "-i", path,
            "-t", &format!("{duration:.3}"),
            "-vn",
            "-acodec", "pcm_s16le",
            "-ar", "44100",
            "-ac", "2",
        ])
        .arg(out_path)
        .output()
        .map_err(|e| format!(
            "ffmpeg не найден или не запустился ({ffmpeg}): {e}."
        ))?;

    if !output.status.success() {
        let err = String::from_utf8_lossy(&output.stderr);
        return Err(format!("ffmpeg не смог вырезать фрагмент: {}", err.trim()));
    }
    Ok(())
}

pub(crate) fn bundled_binary_path(unix_name: &str, windows_name: &str) -> Option<PathBuf> {
    let exe_dir = std::env::current_exe().ok()?.parent()?.to_path_buf();
    let candidate = exe_dir.join(if cfg!(windows) { windows_name } else { unix_name });
    candidate.is_file().then_some(candidate)
}

pub(crate) fn binary_runs(exe: &std::path::Path) -> bool {
    ffmpeg_command(exe)
        .arg("-version")
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false)
}

pub(crate) fn resolve_ffmpeg() -> &'static str {
    static RESOLVED: std::sync::Mutex<Option<&'static str>> = std::sync::Mutex::new(None);
    cached_resolve(&RESOLVED, "ffmpeg", "ffmpeg.exe")
}

pub(crate) fn downloaded_tools_dir() -> Option<PathBuf> {
    std::env::var_os("LOCALAPPDATA").map(|l| PathBuf::from(l).join("Project Desktop").join("tools").join("ffmpeg"))
}

pub(crate) fn cached_resolve(
    slot: &'static std::sync::Mutex<Option<&'static str>>,
    unix_name: &str,
    windows_name: &str,
) -> &'static str {
    let mut guard = slot.lock().unwrap_or_else(|p| p.into_inner());
    if let Some(found) = *guard {
        return found;
    }
    let found = resolve_binary_uncached(unix_name, windows_name);
    let ok = binary_runs(std::path::Path::new(&found));
    let leaked: &'static str = Box::leak(found.into_boxed_str());
    if ok {
        *guard = Some(leaked);
    }
    leaked
}

pub(crate) fn resolve_binary_uncached(unix_name: &str, windows_name: &str) -> String {
    if let Some(bundled) = bundled_binary_path(unix_name, windows_name) {
        if binary_runs(&bundled) {
            log::info!("{windows_name}: используем bundled-версию {bundled:?}");
            return bundled.to_string_lossy().into_owned();
        }
        log::warn!("bundled {windows_name:?} найден по пути {bundled:?}, но не запустился — ищем дальше");
    } else {
        log::warn!("{windows_name}: bundled-копия не найдена рядом с .exe — ищем докачанную или PATH ({unix_name})");
    }
    if let Some(dir) = downloaded_tools_dir() {
        let candidate = dir.join(if cfg!(windows) { windows_name } else { unix_name });
        if candidate.is_file() && binary_runs(&candidate) {
            log::info!("{windows_name}: используем докачанную версию {candidate:?}");
            return candidate.to_string_lossy().into_owned();
        }
    }
    unix_name.to_string()
}

fn analyze_samples(samples: &[i16]) -> Result<QcReport, String> {
    if samples.is_empty() {
        return Err("Не удалось прочитать аудио — файл пуст или повреждён.".into());
    }

    let duration = samples.len() as f64 / SAMPLE_RATE as f64;
    let window_len = ((WINDOW_SECONDS * SAMPLE_RATE as f64) as usize).max(1);

    let mut findings = Vec::new();
    let mut peak: i32 = 0;
    let mut sum_sq: f64 = 0.0;
    for &s in samples {
        let a = (s as i32).abs();
        if a > peak {
            peak = a;
        }
        sum_sq += (s as f64) * (s as f64);
    }
    let rms = (sum_sq / samples.len() as f64).sqrt();
    let peak_dbfs = amplitude_to_dbfs(peak as f64 / 32768.0);
    let rms_dbfs = amplitude_to_dbfs(rms / 32768.0);

    let mut clip_run_start: Option<usize> = None;
    for (i, &s) in samples.iter().enumerate() {
        let clipped = (s as i32).abs() >= CLIP_THRESHOLD;
        match (clipped, clip_run_start) {
            (true, None) => clip_run_start = Some(i),
            (false, Some(start)) => {
                let run_len = i - start;
                if run_len >= 3 {
                    findings.push(QcFinding {
                        kind: "clipping".into(),
                        start: start as f64 / SAMPLE_RATE as f64,
                        end: i as f64 / SAMPLE_RATE as f64,
                        severity: "error".into(),
                        message: "Клиппинг — сигнал упирается в потолок шкалы.".into(),
                    });
                }
                clip_run_start = None;
            }
            _ => {}
        }
    }
    if let Some(start) = clip_run_start {
        findings.push(QcFinding {
            kind: "clipping".into(),
            start: start as f64 / SAMPLE_RATE as f64,
            end: samples.len() as f64 / SAMPLE_RATE as f64,
            severity: "error".into(),
            message: "Клиппинг — сигнал упирается в потолок шкалы.".into(),
        });
    }

    let mut silence_start: Option<usize> = None;
    let mut i = 0usize;
    while i < samples.len() {
        let end = (i + window_len).min(samples.len());
        let window = &samples[i..end];
        let win_rms = rms_amplitude(window) / 32768.0;
        let is_silent = win_rms < SILENCE_RMS_THRESHOLD;
        match (is_silent, silence_start) {
            (true, None) => silence_start = Some(i),
            (false, Some(start)) => {
                let dur = (i - start) as f64 / SAMPLE_RATE as f64;
                if dur >= MIN_SILENCE_SECONDS {
                    findings.push(QcFinding {
                        kind: "silence".into(),
                        start: start as f64 / SAMPLE_RATE as f64,
                        end: i as f64 / SAMPLE_RATE as f64,
                        severity: "warn".into(),
                        message: format!("Пауза без звука {:.1} с.", dur),
                    });
                }
                silence_start = None;
            }
            _ => {}
        }
        i = end;
    }
    if let Some(start) = silence_start {
        let dur = (samples.len() - start) as f64 / SAMPLE_RATE as f64;
        if dur >= MIN_SILENCE_SECONDS {
            findings.push(QcFinding {
                kind: "silence".into(),
                start: start as f64 / SAMPLE_RATE as f64,
                end: samples.len() as f64 / SAMPLE_RATE as f64,
                severity: "warn".into(),
                message: format!("Пауза без звука {:.1} с.", dur),
            });
        }
    }

    if rms_dbfs < -38.0 {
        findings.insert(
            0,
            QcFinding {
                kind: "quiet".into(),
                start: 0.0,
                end: duration,
                severity: "warn".into(),
                message: format!("Общая громкость низкая ({:.1} дБФС) — возможно, дорожку стоит поднять.", rms_dbfs),
            },
        );
    } else if peak_dbfs > -0.3 {
        findings.insert(
            0,
            QcFinding {
                kind: "loud".into(),
                start: 0.0,
                end: duration,
                severity: "warn".into(),
                message: "Пик почти на потолке шкалы — риск клиппинга при перекодировании.".into(),
            },
        );
    }

    findings.sort_by(|a, b| a.start.partial_cmp(&b.start).unwrap());

    Ok(QcReport {
        duration,
        findings,
        peak_dbfs,
        rms_dbfs,
    })
}

fn rms_amplitude(samples: &[i16]) -> f64 {
    if samples.is_empty() {
        return 0.0;
    }
    let sum_sq: f64 = samples.iter().map(|&s| (s as f64) * (s as f64)).sum();
    (sum_sq / samples.len() as f64).sqrt()
}

fn amplitude_to_dbfs(a: f64) -> f64 {
    if a <= 0.0 {
        return -120.0;
    }
    20.0 * a.log10()
}

fn decode_pcm(path: &str) -> Result<Vec<i16>, String> {
    let ffmpeg = resolve_ffmpeg();
    let output = ffmpeg_command(ffmpeg)
        .args([
            "-v", "error",
            "-i", path,
            "-f", "s16le",
            "-acodec", "pcm_s16le",
            "-ac", "1",
            "-ar", &SAMPLE_RATE.to_string(),
            "-",
        ])
        .output()
        .map_err(|e| format!(
            "ffmpeg не найден или не запустился ({ffmpeg}): {e}. В штатной сборке ffmpeg идёт вместе с приложением — \
             попробуйте переустановить; либо поставьте ffmpeg сами и добавьте его в PATH."
        ))?;

    if !output.status.success() {
        let err = String::from_utf8_lossy(&output.stderr);
        return Err(format!("ffmpeg не смог прочитать файл: {}", err.trim()));
    }

    let bytes = output.stdout;
    let mut samples = Vec::with_capacity(bytes.len() / 2);
    let (chunks, _remainder) = bytes.as_chunks::<2>();
    for c in chunks {
        samples.push(i16::from_le_bytes(*c));
    }
    Ok(samples)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn silence(seconds: f64) -> Vec<i16> {
        vec![0i16; (seconds * SAMPLE_RATE as f64) as usize]
    }

    fn tone(seconds: f64, amplitude: i16) -> Vec<i16> {
        (0..(seconds * SAMPLE_RATE as f64) as usize)
            .map(|i| if i % 2 == 0 { amplitude } else { -amplitude })
            .collect()
    }

    #[test]
    fn empty_input_is_an_error() {
        assert!(analyze_samples(&[]).is_err());
    }

    #[test]
    fn clean_quiet_free_audio_has_no_findings() {
        let samples = tone(3.0, 8000);
        let report = analyze_samples(&samples).unwrap();
        assert!(
            report.findings.is_empty(),
            "ожидали пустой список находок, получили: {:?}",
            report.findings.iter().map(|f| &f.kind).collect::<Vec<_>>()
        );
        assert!((report.duration - 3.0).abs() < 0.01);
    }

    #[test]
    fn sustained_clipping_is_detected() {
        let mut samples = tone(0.5, 8000);
        for s in samples.iter_mut().skip(1000).take(50) {
            *s = 32767;
        }
        let report = analyze_samples(&samples).unwrap();
        assert!(
            report.findings.iter().any(|f| f.kind == "clipping"),
            "клиппинг на 50 сэмплах подряд должен быть найден"
        );
    }

    #[test]
    fn brief_clipping_under_threshold_is_ignored() {
        let mut samples = tone(0.5, 8000);
        samples[1000] = 32767;
        samples[1001] = 32767;
        let report = analyze_samples(&samples).unwrap();
        assert!(!report.findings.iter().any(|f| f.kind == "clipping"));
    }

    #[test]
    fn long_silence_is_detected() {
        let mut samples = tone(0.5, 8000);
        samples.extend(silence(2.0));
        samples.extend(tone(0.5, 8000));
        let report = analyze_samples(&samples).unwrap();
        let sil = report.findings.iter().find(|f| f.kind == "silence");
        assert!(sil.is_some(), "пауза 2с должна быть найдена");
        let sil = sil.unwrap();
        assert!(sil.end - sil.start >= 1.2);
    }

    #[test]
    fn short_silence_is_not_reported() {
        let mut samples = tone(0.5, 8000);
        samples.extend(silence(0.5));
        samples.extend(tone(0.5, 8000));
        let report = analyze_samples(&samples).unwrap();
        assert!(!report.findings.iter().any(|f| f.kind == "silence"));
    }

    #[test]
    fn overall_silence_is_flagged_quiet() {
        let samples = silence(2.0);
        let report = analyze_samples(&samples).unwrap();
        assert!(report.findings.iter().any(|f| f.kind == "quiet"));
        assert!(report.rms_dbfs < -38.0);
    }

    #[test]
    fn near_full_scale_audio_is_flagged_loud() {
        let samples = tone(1.0, 32000);
        let report = analyze_samples(&samples).unwrap();
        assert!(report.findings.iter().any(|f| f.kind == "loud" || f.kind == "clipping"));
    }

    #[test]
    fn waveform_peaks_length_matches_requested_buckets() {
        let samples = tone(2.0, 8000);
        let peaks = downsample_peaks(&samples, 100);
        assert_eq!(peaks.len(), 200);
    }

    #[test]
    fn waveform_peaks_reflect_full_scale_tone() {
        let samples = tone(1.0, 32000);
        let peaks = downsample_peaks(&samples, 10);
        for chunk in peaks.chunks(2) {
            assert!(chunk[0] < -0.9, "min бакета должен быть у -1: {}", chunk[0]);
            assert!(chunk[1] > 0.9, "max бакета должен быть у +1: {}", chunk[1]);
        }
    }

    #[test]
    fn waveform_peaks_are_near_zero_for_silence() {
        let samples = silence(1.0);
        let peaks = downsample_peaks(&samples, 20);
        assert!(peaks.iter().all(|&p| p == 0.0));
    }

    #[test]
    fn waveform_handles_more_buckets_than_samples_without_panicking() {
        let samples = tone(0.0005, 8000);
        let peaks = downsample_peaks(&samples, 500);
        assert_eq!(peaks.len(), 1000);
    }

    #[test]
    fn export_clip_rejects_invalid_range() {
        assert!(export_clip("whatever.wav", -1.0, 1.0, "/tmp/out.wav").is_err());
        assert!(export_clip("whatever.wav", 2.0, 1.0, "/tmp/out.wav").is_err());
        assert!(export_clip("whatever.wav", 1.0, 1.0, "/tmp/out.wav").is_err());
    }

    #[test]
    fn export_clip_produces_wav_of_requested_duration() {
        if Command::new("ffmpeg").arg("-version").output().map(|o| !o.status.success()).unwrap_or(true) {
            eprintln!("ffmpeg не найден в PATH — пропускаем интеграционный тест export_clip");
            return;
        }
        let dir = std::env::temp_dir();
        let src = dir.join("project_test_source.wav");
        let out = dir.join("project_test_clip.wav");

        let gen = Command::new("ffmpeg")
            .args(["-v", "error", "-y", "-f", "lavfi", "-i", "sine=frequency=440:duration=5"])
            .arg(&src)
            .output()
            .expect("не удалось сгенерировать тестовый тон");
        assert!(gen.status.success(), "ffmpeg lavfi source: {}", String::from_utf8_lossy(&gen.stderr));

        let src_str = src.to_string_lossy().into_owned();
        let out_str = out.to_string_lossy().into_owned();
        export_clip(&src_str, 1.0, 3.0, &out_str).expect("export_clip не должен падать на валидном входе");

        let clipped_samples = decode_pcm(&out_str).expect("результат export_clip должен читаться decode_pcm");
        let got_duration = clipped_samples.len() as f64 / SAMPLE_RATE as f64;
        assert!(
            (got_duration - 2.0).abs() < 0.1,
            "ожидали ~2с, получили {got_duration:.3}с"
        );

        let _ = std::fs::remove_file(&src);
        let _ = std::fs::remove_file(&out);
    }

    #[test]
    fn findings_are_sorted_by_start_time() {
        let mut samples = silence(1.5);
        samples.extend(tone(0.5, 8000));
        samples.extend(silence(1.5));
        let report = analyze_samples(&samples).unwrap();
        let starts: Vec<f64> = report.findings.iter().map(|f| f.start).collect();
        let mut sorted = starts.clone();
        sorted.sort_by(|a, b| a.partial_cmp(b).unwrap());
        assert_eq!(starts, sorted);
    }
}
