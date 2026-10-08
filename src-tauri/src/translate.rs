//! Перевод текста для окна «Переводчик».
//!
//! Идёт через бесплатную веб-точку Google Translate (translate.googleapis.com,
//! client=gtx) — ключа не нужно. Запрос делает Rust, а не страница: у окна
//! строгий CSP, и наружу из него ходить нельзя. ВАЖНО: переведённый текст
//! уходит на сервера Google — для неопубликованных материалов это надо
//! помнить. Точка неофициальная и может начать отказывать; ошибки
//! возвращаются понятным текстом.

use std::sync::OnceLock;
use std::time::Duration;

use serde::Serialize;

const ENDPOINT: &str = "https://translate.googleapis.com/translate_a/single";
// Больше за раз точка не берёт (в теле формы — с запасом до ~5000 знаков).
const MAX_CHARS: usize = 4800;

fn client() -> &'static reqwest::Client {
    static C: OnceLock<reqwest::Client> = OnceLock::new();
    C.get_or_init(|| {
        reqwest::Client::builder()
            .timeout(Duration::from_secs(20))
            .user_agent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36")
            .build()
            .unwrap_or_else(|_| reqwest::Client::new())
    })
}

#[derive(Serialize)]
pub struct Translation {
    text: String,
    /// Определённый язык оригинала (код), если точка его вернула.
    detected: Option<String>,
}

fn valid_lang(code: &str) -> bool {
    !code.is_empty()
        && code.len() <= 8
        && code.chars().all(|c| c.is_ascii_alphanumeric() || c == '-')
}

/// Делит текст на куски не длиннее MAX_CHARS по границам строк (и по
/// пробелам, если строка сама длиннее предела), сохраняя переводы строк.
fn split_chunks(text: &str) -> Vec<String> {
    let mut chunks = Vec::new();
    let mut cur = String::new();
    for line in text.split_inclusive('\n') {
        if line.chars().count() > MAX_CHARS {
            if !cur.is_empty() {
                chunks.push(std::mem::take(&mut cur));
            }
            let mut piece = String::new();
            for word in line.split_inclusive(' ') {
                if piece.chars().count() + word.chars().count() > MAX_CHARS {
                    chunks.push(std::mem::take(&mut piece));
                }
                piece.push_str(word);
            }
            if !piece.is_empty() {
                chunks.push(piece);
            }
            continue;
        }
        if cur.chars().count() + line.chars().count() > MAX_CHARS {
            chunks.push(std::mem::take(&mut cur));
        }
        cur.push_str(line);
    }
    if !cur.is_empty() {
        chunks.push(cur);
    }
    chunks
}

async fn translate_chunk(chunk: &str, from: &str, to: &str) -> Result<(String, Option<String>), String> {
    let resp = client()
        .post(ENDPOINT)
        .form(&[("client", "gtx"), ("sl", from), ("tl", to), ("dt", "t"), ("dj", "0"), ("q", chunk)])
        .send()
        .await
        .map_err(|e| {
            if e.is_timeout() {
                "Сервис перевода не ответил вовремя — попробуйте ещё раз.".to_string()
            } else {
                format!("Нет связи с сервисом перевода: {e}")
            }
        })?;
    let status = resp.status();
    if status.as_u16() == 429 {
        return Err("Сервис перевода просит подождать (слишком много запросов). Попробуйте через минуту.".into());
    }
    if !status.is_success() {
        return Err(format!("Сервис перевода ответил ошибкой {status}."));
    }
    let v: serde_json::Value = resp
        .json()
        .await
        .map_err(|_| "Сервис перевода ответил непонятно — возможно, он изменил формат.".to_string())?;
    let segments = v
        .get(0)
        .and_then(|s| s.as_array())
        .ok_or_else(|| "Сервис перевода ответил пустотой.".to_string())?;
    let mut out = String::new();
    for seg in segments {
        if let Some(t) = seg.get(0).and_then(|t| t.as_str()) {
            out.push_str(t);
        }
    }
    let detected = v.get(2).and_then(|d| d.as_str()).map(|s| s.to_string());
    Ok((out, detected))
}

#[tauri::command(async)]
pub async fn translate_text(text: String, from: String, to: String) -> Result<Translation, String> {
    if !valid_lang(&from) || !valid_lang(&to) {
        return Err("Неверный код языка.".into());
    }
    if text.trim().is_empty() {
        return Ok(Translation { text: String::new(), detected: None });
    }
    if text.chars().count() > 60_000 {
        return Err("Слишком длинный текст — переводите частями (до 60 000 знаков).".into());
    }
    let mut out = String::new();
    let mut detected = None;
    for (i, chunk) in split_chunks(&text).iter().enumerate() {
        if i > 0 {
            tokio::time::sleep(Duration::from_millis(350)).await;
        }
        let (t, d) = translate_chunk(chunk, &from, &to).await?;
        out.push_str(&t);
        if detected.is_none() {
            detected = d;
        }
    }
    Ok(Translation { text: out, detected })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn chunks_keep_all_text_and_limit() {
        let text = "строка\n".repeat(2000);
        let chunks = split_chunks(&text);
        assert!(chunks.len() > 1);
        assert!(chunks.iter().all(|c| c.chars().count() <= MAX_CHARS));
        assert_eq!(chunks.concat(), text);
    }

    #[test]
    fn long_line_is_split_by_words() {
        let text = "слово ".repeat(2000);
        let chunks = split_chunks(&text);
        assert!(chunks.iter().all(|c| c.chars().count() <= MAX_CHARS));
        assert_eq!(chunks.concat(), text);
    }

    #[test]
    fn language_codes_are_validated() {
        assert!(valid_lang("ru"));
        assert!(valid_lang("zh-CN"));
        assert!(valid_lang("auto"));
        assert!(!valid_lang(""));
        assert!(!valid_lang("ru&q=x"));
    }
}
