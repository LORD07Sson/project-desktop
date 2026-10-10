//! «Расширенные возможности Steam»: вход по QR и запросы к Steam Web API от имени игрока.
//!
//! Как это устроено и почему безопасно настолько, насколько возможно:
//!  • Пароль в приложение не вводится: вход подтверждается в мобильном приложении Steam (QR-код).
//!  • Долгий токен обновления лежит ТОЛЬКО в хранилище учётных данных ОС (Credential Manager) на этом компьютере.
//!    Сервер проекта его никогда не видит; в JavaScript он тоже не передаётся — страница получает лишь статус и ответы методов.
//!  • Короткие токены (доступа и «магазина») живут в памяти и обновляются сами за пять минут до конца срока.
//!  • Разрешены только методы чтения из списка `ALLOWED`. Ничего в аккаунте (желаемое, покупки, друзья) не меняется.
//!  • Через 7 дней без использования вход сбрасывается сам; «Выйти» стирает токен сразу.
//!  • Токены не попадают в логи и тексты ошибок (в адресах запросов токена нет, у ошибок reqwest адрес убирается).

use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use keyring::Entry;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::sync::OnceLock;
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tokio::sync::Mutex;

const SERVICE: &str = "ProjectDesktop";
const REFRESH_ENTRY: &str = "steam_refresh";
const META_ENTRY: &str = "steam_meta";
const API: &str = "https://api.steampowered.com";
const STORE: &str = "https://store.steampowered.com";
/// Через сколько дней без использования вход сбрасывается сам.
pub const IDLE_DAYS: u64 = 7;
/// За сколько секунд до конца срока короткий токен обновляется.
const RENEW_MARGIN: u64 = 300;

/// Разрешённые вызовы: (интерфейс, метод, версия, способ). Только чтение.
const ALLOWED: &[(&str, &str, u32, &str)] = &[
    ("IStoreService", "GetDiscoveryQueue", 1, "GET"),
    ("IStoreService", "GetRecommendedTagsForUser", 1, "GET"),
    ("IStoreQueryService", "GetItemsByUserRecommendedTags", 1, "GET"),
    ("IWishlistService", "GetWishlistItemsOnSale", 1, "GET"),
    ("IPlayerService", "GetFriendsGameplayInfo", 1, "GET"),
    ("IPlayerService", "GetAchievementsProgress", 1, "POST"),
    ("IPlayerService", "GetSingleGamePlaytime", 1, "GET"),
    ("IFamilyGroupsService", "GetSharedLibraryApps", 1, "GET"),
    ("IStorePreferencesService", "GetIgnoreList", 1, "GET"),
    ("IUserReviewsService", "GetFriendsRecommendedApp", 1, "GET"),
    ("IWishlistService", "GetWishlistSortedFiltered", 1, "GET"),
    ("IPlayerService", "GetProfileItemsEquipped", 1, "GET"),
    // Расширенный список для проверки «что ещё открывает токен»: только методы чтения для обычного игрока.
    ("IDailyDealService", "GetDailyDeals", 1, "GET"),
    ("IFriendsListService", "GetFriendsList", 1, "GET"),
    ("IFriendsListService", "GetFavorites", 1, "GET"),
    ("IFamilyGroupsService", "GetFamilyGroupForUser", 1, "GET"),
    ("IFamilyGroupsService", "GetPlaytimeSummary", 1, "POST"),
    ("IPlayerService", "GetProfileItemsOwned", 1, "GET"),
    ("IPlayerService", "GetProfileThemesAvailable", 1, "GET"),
    ("IPlayerService", "GetNicknameList", 1, "GET"),
    ("IPlayerService", "GetCommunityPreferences", 1, "POST"),
    ("ISaleFeatureService", "GetFriendsSharedYearInReview", 1, "GET"),
    ("ISaleFeatureService", "GetUserActionData", 1, "GET"),
    ("ISaleFeatureService", "GetYIRCurrentMonthlySummary", 1, "GET"),
    ("ISaleItemRewardsService", "GetClaimedSaleRewards", 1, "GET"),
    ("ISaleItemRewardsService", "GetRewardDefinitions", 1, "GET"),
    ("IStoreService", "GetDiscoveryQueueSettings", 1, "GET"),
    ("IStoreService", "GetDiscoveryQueueSkippedApps", 1, "GET"),
    ("IStoreService", "GetStorePreferences", 1, "GET"),
    ("IStoreQueryService", "GetItemByUserCombinedTagsPriority", 1, "GET"),
    ("IUserReviewsService", "GetIndividualRecommendations", 1, "GET"),
    ("IUserStoreVisitService", "GetFrequentlyVisitedPages", 1, "GET"),
    ("IWishlistService", "GetWishlistCategories", 1, "GET"),
    ("IWishlistService", "GetItemCategories", 1, "GET"),
    ("ISteamNotificationService", "GetSteamNotifications", 1, "GET"),
    ("IMarketingMessagesService", "GetMarketingMessagesForUser", 1, "GET"),
    ("ILoyaltyRewardsService", "GetSummary", 1, "GET"),
    ("IQuestService", "GetNumTradingCardsEarned", 1, "GET"),
    ("IUserGameNotesService", "GetGamesWithNotes", 1, "POST"),
    ("IStoreSalesService", "GetUserVotes", 1, "GET"),
    ("ISteamAwardsService", "GetUserNominations", 1, "GET"),
    ("IMobileNotificationService", "GetUserNotificationCounts", 1, "GET"),
    ("ICommunityService", "GetBestEventsForUser", 1, "GET"),
    ("ICommunityService", "GetUserPartnerEventNews", 1, "GET"),
    ("IEconMarketService", "GetMarketEligibility", 1, "GET"),
];

#[derive(Serialize, Deserialize, Clone)]
struct Meta {
    steamid: String,
    account: String,
    created: u64,
    last_used: u64,
}

#[derive(Default)]
struct Cache {
    access: Option<(String, u64)>,
    web: Option<(String, u64)>,
}

static CACHE: OnceLock<Mutex<Cache>> = OnceLock::new();

fn cache() -> &'static Mutex<Cache> {
    CACHE.get_or_init(|| Mutex::new(Cache::default()))
}

#[derive(Serialize)]
pub struct QrStart {
    pub client_id: String,
    pub request_id: String,
    pub url: String,
    pub interval: u64,
}

#[derive(Serialize)]
pub struct QrPoll {
    /// pending — ждём сканирования, scanned — отсканировано, ждём подтверждения на телефоне, approved — вошли, expired — код устарел.
    pub status: String,
    /// Если Steam обновил QR-код, здесь новые данные для следующего опроса и для показа.
    pub client_id: Option<String>,
    pub url: Option<String>,
}

#[derive(Serialize)]
pub struct Status {
    pub signed_in: bool,
    pub steamid: Option<String>,
    pub account: Option<String>,
    pub days_left: Option<u64>,
    /// Почему вход сброшен: idle — неделя без использования, expired — токен устарел, revoked — отозван в Steam.
    pub reason: Option<String>,
}

fn now() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0)
}

// ---------- чистые помощники (покрыты тестами) ----------

/// Полезная нагрузка JWT (вторая часть) как JSON; подпись здесь не проверяется — токен берётся напрямую у Steam по HTTPS.
pub fn jwt_claims(token: &str) -> Option<Value> {
    let part = token.split('.').nth(1)?;
    let bytes = URL_SAFE_NO_PAD.decode(part.trim_end_matches('=')).ok()?;
    serde_json::from_slice(&bytes).ok()
}

pub fn jwt_exp(token: &str) -> Option<u64> {
    jwt_claims(token)?.get("exp")?.as_u64()
}

pub fn jwt_sub(token: &str) -> Option<String> {
    jwt_claims(token)?.get("sub")?.as_str().map(String::from)
}

pub fn is_idle(last_used: u64, now: u64) -> bool {
    now.saturating_sub(last_used) > IDLE_DAYS * 86400
}

/// (версия, способ) для разрешённого метода или None.
pub fn method_allowed(interface: &str, method: &str) -> Option<(u32, &'static str)> {
    ALLOWED.iter().find(|(i, m, _, _)| *i == interface && *m == method).map(|(_, _, v, h)| (*v, *h))
}

// ---------- хранилище ----------

fn entry(name: &str) -> Result<Entry, String> {
    Entry::new(SERVICE, name).map_err(|e| e.to_string())
}

fn load_meta() -> Option<Meta> {
    serde_json::from_str(&entry(META_ENTRY).ok()?.get_password().ok()?).ok()
}

fn save_meta(m: &Meta) -> Result<(), String> {
    entry(META_ENTRY)?.set_password(&serde_json::to_string(m).map_err(|e| e.to_string())?).map_err(|e| e.to_string())
}

fn load_refresh() -> Option<String> {
    String::from_utf8(entry(REFRESH_ENTRY).ok()?.get_secret().ok()?).ok()
}

fn clear_entry(name: &str) {
    if let Ok(e) = entry(name) {
        let _ = e.delete_credential();
    }
}

async fn clear_all() {
    clear_entry(REFRESH_ENTRY);
    clear_entry(META_ENTRY);
    let mut c = cache().lock().await;
    c.access = None;
    c.web = None;
}

fn touch() {
    if let Some(mut m) = load_meta() {
        if now().saturating_sub(m.last_used) > 60 {
            m.last_used = now();
            let _ = save_meta(&m);
        }
    }
}

// ---------- HTTP ----------

fn http() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .timeout(Duration::from_secs(20))
        .user_agent("ProjectDesktop/1.0 (steam-session)")
        .build()
        .map_err(|e| e.to_string())
}

fn net_err(e: reqwest::Error) -> String {
    format!("нет связи со Steam: {}", e.without_url())
}

/// POST к сервису Steam с телом input_json. Возвращает (HTTP-статус, EResult из заголовка, поле response).
async fn post_service(path: &str, payload: &Value) -> Result<(u16, i64, Value), String> {
    let r = http()?
        .post(format!("{API}/{path}"))
        .form(&[("input_json", payload.to_string())])
        .send()
        .await
        .map_err(net_err)?;
    let status = r.status().as_u16();
    let eresult = r.headers().get("x-eresult").and_then(|h| h.to_str().ok()).and_then(|s| s.parse::<i64>().ok()).unwrap_or(1);
    let v: Value = r.json().await.unwrap_or(Value::Null);
    Ok((status, eresult, v.get("response").cloned().unwrap_or(Value::Null)))
}

// ---------- вход по QR ----------

pub async fn begin_qr() -> Result<QrStart, String> {
    let (st, er, resp) = post_service(
        "IAuthenticationService/BeginAuthSessionViaQR/v1/",
        &json!({ "device_friendly_name": "Project Desktop", "platform_type": 2, "website_id": "Store" }),
    )
    .await?;
    if st != 200 || er != 1 {
        return Err(format!("Steam не начал вход (HTTP {st}, код {er})"));
    }
    let url = resp["challenge_url"].as_str().unwrap_or_default().to_string();
    let client_id = resp["client_id"].as_str().unwrap_or_default().to_string();
    let request_id = resp["request_id"].as_str().unwrap_or_default().to_string();
    if !url.starts_with("https://s.team/q/") || client_id.is_empty() || request_id.is_empty() {
        return Err("Steam вернул неожиданный ответ при начале входа".to_string());
    }
    Ok(QrStart { client_id, request_id, url, interval: resp["interval"].as_u64().unwrap_or(5).clamp(2, 15) })
}

pub async fn poll_qr(client_id: String, request_id: String) -> Result<QrPoll, String> {
    let (st, er, resp) = post_service("IAuthenticationService/PollAuthSessionStatus/v1/", &json!({ "client_id": client_id, "request_id": request_id })).await?;
    if st != 200 {
        return Err(format!("Steam не ответил на проверку входа (HTTP {st})"));
    }
    if er != 1 {
        return Ok(QrPoll { status: "expired".into(), client_id: None, url: None });
    }
    if let Some(refresh) = resp["refresh_token"].as_str().filter(|s| !s.is_empty()) {
        let steamid = jwt_sub(refresh).ok_or("в токене нет SteamID")?;
        entry(REFRESH_ENTRY)?
            .set_secret(refresh.as_bytes())
            .map_err(|e| format!("не удалось сохранить токен в хранилище Windows: {e}"))?;
        let account = resp["account_name"].as_str().unwrap_or_default().to_string();
        save_meta(&Meta { steamid, account, created: now(), last_used: now() })?;
        let mut c = cache().lock().await;
        c.access = resp["access_token"].as_str().filter(|s| !s.is_empty()).map(|t| (t.to_string(), jwt_exp(t).unwrap_or(now() + 3600)));
        c.web = None;
        log::info!("[steam_session] вход выполнен, токен сохранён в хранилище ОС");
        return Ok(QrPoll { status: "approved".into(), client_id: None, url: None });
    }
    let rotated_url = resp["new_challenge_url"].as_str().filter(|u| u.starts_with("https://s.team/q/")).map(String::from);
    let rotated_id = resp["new_client_id"].as_str().filter(|s| !s.is_empty()).map(String::from);
    let scanned = resp["had_remote_interaction"].as_bool().unwrap_or(false);
    Ok(QrPoll { status: if scanned { "scanned" } else { "pending" }.into(), client_id: rotated_id, url: rotated_url })
}

// ---------- состояние и выход ----------

pub async fn status() -> Status {
    let none = |reason: Option<&str>| Status { signed_in: false, steamid: None, account: None, days_left: None, reason: reason.map(String::from) };
    let Some(meta) = load_meta() else { return none(None) };
    let Some(refresh) = load_refresh() else {
        clear_all().await;
        return none(Some("expired"));
    };
    if is_idle(meta.last_used, now()) {
        clear_all().await;
        log::info!("[steam_session] вход сброшен: неделя без использования");
        return none(Some("idle"));
    }
    if jwt_exp(&refresh).map(|e| e <= now()).unwrap_or(false) {
        clear_all().await;
        return none(Some("expired"));
    }
    Status {
        signed_in: true,
        steamid: Some(meta.steamid),
        account: Some(meta.account),
        days_left: Some(IDLE_DAYS.saturating_sub(now().saturating_sub(meta.last_used) / 86400)),
        reason: None,
    }
}

pub async fn sign_out() -> Result<(), String> {
    clear_all().await;
    log::info!("[steam_session] выход: токен стёрт");
    Ok(())
}

// ---------- токены ----------

/// Короткий токен доступа: из памяти или заново по токену обновления.
async fn access_token() -> Result<String, String> {
    {
        let c = cache().lock().await;
        if let Some((t, exp)) = &c.access {
            if *exp > now() + RENEW_MARGIN {
                return Ok(t.clone());
            }
        }
    }
    let refresh = load_refresh().ok_or("вход в Steam не выполнен")?;
    let meta = load_meta().ok_or("вход в Steam не выполнен")?;
    let (st, er, resp) = post_service(
        "IAuthenticationService/GenerateAccessTokenForApp/v1/",
        &json!({ "refresh_token": refresh, "steamid": meta.steamid, "renewal_type": 0 }),
    )
    .await?;
    let direct = resp["access_token"].as_str().filter(|s| !s.is_empty()).map(String::from);
    let token = match direct {
        Some(t) => t,
        None => {
            // Токен обновления входа через браузер этим вызовом Steam не принимает: тогда делаем то же, что сайт, — получаем куки входа.
            match web_access_from_refresh(&refresh, &meta.steamid).await {
                Ok(t) => t,
                Err(e) => {
                    log::warn!("[steam_session] токен доступа не получен (HTTP {st}, код {er}): {e}");
                    // Вход стираем только если Steam прямо отверг токен обновления; при сбое сети или формата он остаётся.
                    if e.starts_with("отвергнут") {
                        clear_all().await;
                        return Err("Вход в Steam недействителен: войдите заново".to_string());
                    }
                    return Err(format!("Steam не выдал токен доступа (HTTP {st}, код {er}; {e})"));
                }
            }
        }
    };
    let token = token.as_str();
    let exp = jwt_exp(token).unwrap_or(now() + 3600);
    cache().lock().await.access = Some((token.to_string(), exp));
    Ok(token.to_string())
}

/// Короткий токен доступа по токену обновления «веб-входа»: так же, как делает сайт Steam (jwt/finalizelogin и куки магазина).
async fn web_access_from_refresh(refresh: &str, steamid: &str) -> Result<String, String> {
    let c = http()?;
    let sessionid = format!("{:024x}", SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_nanos()).unwrap_or(1));
    let r = c
        .post("https://login.steampowered.com/jwt/finalizelogin")
        .header("Origin", "https://steamcommunity.com")
        .header("Referer", "https://steamcommunity.com/")
        .form(&[("nonce", refresh), ("sessionid", sessionid.as_str()), ("redir", "https://steamcommunity.com/login/home/?goto=")])
        .send()
        .await
        .map_err(net_err)?;
    let http_st = r.status().as_u16();
    let v: Value = r.json().await.unwrap_or(Value::Null);
    if v.get("error").is_some() {
        return Err(format!("отвергнут Steam: {}", v["error"]));
    }
    let list = v["transfer_info"].as_array().ok_or_else(|| format!("finalizelogin: HTTP {http_st}, нет transfer_info"))?;
    let t = list.iter().find(|t| t["url"].as_str().is_some_and(|u| u.starts_with("https://store.steampowered.com/"))).or(list.first()).ok_or("пустой transfer_info")?;
    let url = t["url"].as_str().filter(|u| u.starts_with("https://")).ok_or("в transfer_info нет адреса")?;
    let form = reqwest::multipart::Form::new()
        .text("nonce", t["params"]["nonce"].as_str().unwrap_or_default().to_string())
        .text("auth", t["params"]["auth"].as_str().unwrap_or_default().to_string())
        .text("steamID", v["steamID"].as_str().unwrap_or(steamid).to_string());
    let r2 = c.post(url).multipart(form).send().await.map_err(net_err)?;
    for h in r2.headers().get_all("set-cookie") {
        let Ok(line) = h.to_str() else { continue };
        if let Some(val) = line.strip_prefix("steamLoginSecure=") {
            let val = val.split(';').next().unwrap_or_default();
            if let Some((_, tok)) = val.split_once("%7C%7C").or_else(|| val.split_once("||")) {
                if !tok.is_empty() {
                    return Ok(tok.to_string());
                }
            }
        }
    }
    Err(format!("в ответе магазина нет куки входа (HTTP {})", r2.status().as_u16()))
}

/// «Токен магазина» (тот, что сайт магазина передаёт своим скриптам). Получаем его так же, как браузер: по куки входа.
async fn web_token() -> Result<String, String> {
    {
        let c = cache().lock().await;
        if let Some((t, exp)) = &c.web {
            if *exp > now() + RENEW_MARGIN {
                return Ok(t.clone());
            }
        }
    }
    let access = access_token().await?;
    let meta = load_meta().ok_or("вход в Steam не выполнен")?;
    let r = http()?
        .get(format!("{STORE}/pointssummary/ajaxgetasyncconfig"))
        .header("Cookie", format!("steamLoginSecure={}%7C%7C{}", meta.steamid, access))
        .send()
        .await
        .map_err(net_err)?;
    if r.status().as_u16() != 200 {
        return Err(format!("магазин не выдал токен (HTTP {})", r.status().as_u16()));
    }
    let v: Value = r.json().await.map_err(|_| "магазин вернул не JSON".to_string())?;
    let token = v["data"]["webapi_token"].as_str().filter(|s| !s.is_empty()).ok_or("в ответе магазина нет токена")?;
    let exp = jwt_exp(token).unwrap_or(now() + 1800);
    cache().lock().await.web = Some((token.to_string(), exp));
    Ok(token.to_string())
}

// ---------- запросы ----------

async fn do_call(interface: &str, method: &str, version: u32, http_method: &str, token: &str, params: &Value) -> Result<(u16, Value), String> {
    let url = format!("{API}/{interface}/{method}/v{version}/");
    let c = http()?;
    let req = if http_method == "POST" {
        c.post(&url).query(&[("access_token", token)]).form(&[("input_json", params.to_string())])
    } else {
        c.get(&url).query(&[("access_token", token), ("input_json", params.to_string().as_str())])
    };
    let r = req.send().await.map_err(net_err)?;
    let status = r.status().as_u16();
    let text = r.text().await.unwrap_or_default();
    let body = serde_json::from_str::<Value>(&text).unwrap_or(Value::Null);
    Ok((status, body.get("response").cloned().unwrap_or(body)))
}

/// Вызов с токеном магазина, а при отказе (401/403) — с обычным токеном доступа. Возвращает (статус, ответ, какой токен подошёл).
async fn call_with_tokens(interface: &str, method: &str, version: u32, http_method: &str, params: &Value) -> Result<(u16, Value, &'static str), String> {
    let mut last: Option<(u16, Value, &'static str)> = None;
    for which in ["магазин", "доступ"] {
        let token = if which == "магазин" { web_token().await } else { access_token().await };
        let Ok(token) = token else { continue };
        let (st, body) = do_call(interface, method, version, http_method, &token, params).await?;
        if st == 200 {
            return Ok((st, body, which));
        }
        last = Some((st, body, which));
        if st != 401 && st != 403 {
            break;
        }
    }
    last.ok_or_else(|| "не удалось получить токен Steam: войдите заново".to_string())
}

/// Разрешённый метод чтения. Возвращает JSON {"status": HTTP, "body": ответ}.
pub async fn api(interface: &str, method: &str, params: &str) -> Result<String, String> {
    let (version, http_method) = method_allowed(interface, method).ok_or("этот метод Steam не разрешён")?;
    if params.len() > 4000 {
        return Err("слишком длинные параметры".to_string());
    }
    let pv: Value = serde_json::from_str(params).map_err(|_| "параметры не в формате JSON".to_string())?;
    if !pv.is_object() {
        return Err("параметры должны быть объектом".to_string());
    }
    touch();
    let (status, body, _) = call_with_tokens(interface, method, version, http_method, &pv).await?;
    Ok(json!({ "status": status, "body": body }).to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn jwt(payload: &str) -> String {
        format!("aaa.{}.sig", URL_SAFE_NO_PAD.encode(payload.as_bytes()))
    }

    #[test]
    fn jwt_claims_are_read() {
        let t = jwt(r#"{"sub":"76561198816026829","exp":1791700000,"aud":["web"]}"#);
        assert_eq!(jwt_sub(&t).as_deref(), Some("76561198816026829"));
        assert_eq!(jwt_exp(&t), Some(1791700000));
    }


    #[test]
    fn broken_jwt_gives_none() {
        assert_eq!(jwt_exp("not-a-token"), None);
        assert_eq!(jwt_sub("a.b.c"), None);
        assert_eq!(jwt_exp(&jwt("{}")), None);
    }

    #[test]
    fn idle_after_a_week() {
        assert!(!is_idle(1000, 1000 + IDLE_DAYS * 86400));
        assert!(is_idle(1000, 1000 + IDLE_DAYS * 86400 + 1));
        assert!(!is_idle(5000, 1000));
    }

    #[test]
    fn only_listed_methods_are_allowed() {
        assert_eq!(method_allowed("IStoreService", "GetDiscoveryQueue"), Some((1, "GET")));
        assert_eq!(method_allowed("IPlayerService", "GetAchievementsProgress"), Some((1, "POST")));
        assert_eq!(method_allowed("IWishlistService", "AddToWishlist"), None);
        assert_eq!(method_allowed("IStoreService", "SetStorePreferences"), None);
        assert_eq!(method_allowed("IAuthenticationService", "RevokeRefreshToken"), None);
    }

    #[test]
    fn allowed_list_has_only_read_methods() {
        for (_, m, _, _) in ALLOWED {
            assert!(m.starts_with("Get"), "в списке разрешённых не чтение: {m}");
        }
    }
}
