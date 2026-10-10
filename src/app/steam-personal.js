// Личные подборки Steam (по токену входа): очередь открытий и желаемое со скидкой.
// Чистый разбор ответов Steam в карточки витрины { appid, name, image, price } — проверяется в scripts/games-test.mjs.

const ASSET_HOST = "https://shared.fastly.steamstatic.com/store_item_assets/";

/** Адрес шапки игры по описанию ресурсов Steam (assets.asset_url_format + имя файла); иначе null — витрина возьмёт стандартную. */
export function assetUrl(a) {
  if (!a || typeof a.asset_url_format !== "string") return null;
  const f = a.header || a.main_capsule || a.small_capsule;
  if (typeof f !== "string" || !f) return null;
  const path = a.asset_url_format.replace("${FILENAME}", f);
  return /^[\w\-./?=&%]+$/.test(path) && !path.includes("..") ? ASSET_HOST + path : null;
}

/** Один элемент Steam (StoreItem) → карточка витрины; без идентификатора или названия — null. */
export function storeItemToCard(si, currency = "USD") {
  if (si && typeof si === "object" && si.store_item && typeof si.store_item === "object") si = { ...si.store_item, appid: si.appid || si.store_item.appid };   // желаемое: элемент с вложенным store_item
  if (!si || typeof si !== "object") return null;
  const appid = Number(si.appid || si.id);
  const name = typeof si.name === "string" ? si.name.trim() : "";
  if (!appid || !name) return null;
  const o = si.best_purchase_option || null;
  const cents = v => (Number.isFinite(Number(v)) ? Number(v) / 100 : null);
  let price = null, label = "";
  if (o) {
    const final = cents(o.final_price_in_cents), initial = cents(o.original_price_in_cents);
    if (final != null) price = { final, initial: initial != null ? initial : final, discount: Number(o.discount_pct) || 0, currency: o.currency_code || currency };
  } else if (si.is_free) label = "Бесплатно";
  return { appid, name, image: assetUrl(si.assets), price, label };
}

/** Ответ GetDiscoveryQueue / GetWishlistItemsOnSale → список карточек без повторов. */
export function cardsFrom(body, key, currency) {
  const list = body && Array.isArray(body[key]) ? body[key] : [];
  const seen = new Set();
  return list.map(x => storeItemToCard(x, currency)).filter(c => c && !seen.has(c.appid) && seen.add(c.appid));
}

const esc = s => String(s == null ? "" : s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const cnt = v => (Array.isArray(v) ? v.length : 0);
const num = v => (Number.isFinite(Number(v)) ? Number(v) : 0);

/** Сводка аккаунта: счётчики уведомлений, число карточек и предметов оформления профиля. Пустые значения не показываем. */
export function accountChips({ notes, cards, items, points } = {}) {
  const n = notes || {}, it = items || {};
  const list = [
    ["Непрочитанных уведомлений", num(n.unread_count)],
    ["Запросов в друзья", num(n.pending_friend_count)],
    ["Подарков ждёт", num(n.pending_gift_count)],
    ["Приглашений в семью", num(n.pending_family_invite_count)],
    ["Подтверждений", num(n.confirmation_count)],
  ].filter(x => x[1] > 0);
  const own = [
    ["Рамок аватара", cnt(it.avatar_frames)],
    ["Анимированных аватаров", cnt(it.animated_avatars)],
    ["Фонов профиля", cnt(it.profile_backgrounds) + cnt(it.mini_profile_backgrounds)],
    ["Эффектов профиля", cnt(it.profile_modifiers)],
  ].filter(x => x[1] > 0);
  const c = num(cards);
  if (c > 0) own.push(["Карточек получено", c]);
  const pts = num(points);
  if (pts > 0) own.unshift(["Очков Steam", pts]);
  return { alerts: list, own };
}

export function accountPanelHtml(data, proxy) {
  const { alerts, own } = accountChips(data);
  if (!alerts.length && !own.length && !(data && data.equipped && data.equipped.length)) return "";
  const chip = ([l, v]) => `<div><small>${esc(l)}</small><b>${v.toLocaleString("ru-RU")}</b></div>`;
  return `<section class="gm-sesscard"><h3 class="gm-h3">Ваш аккаунт Steam</h3>${equippedHtml(data && data.equipped, proxy)}
    ${alerts.length ? `<div class="gm-online-s gm-prof-s gm-alerts">${alerts.map(chip).join("")}</div>` : `<p class="ny-hint">Новых уведомлений нет.</p>`}
    ${own.length ? `<div class="gm-online-s gm-prof-s">${own.map(chip).join("")}</div>` : ""}</section>`;
}

/** Баннеры «Для вас» из GetMarketingMessagesForUser: игры, о которых Steam хочет сообщить именно вам. */
export function bannerCards(body, currency) {
  const list = body && Array.isArray(body.messages) ? body.messages : [];
  const seen = new Set();
  return list.map(m => storeItemToCard(m && m.message && m.message.associated_item, currency)).filter(c => c && !seen.has(c.appid) && seen.add(c.appid));
}

/** Категории желаемого: список {id, name, count} и соответствие appid → набор id категорий (из GetWishlistCategories и GetWishlistSortedFiltered). */
export function wishCategoryIndex(catBody, listBody) {
  const cats = (catBody && Array.isArray(catBody.categories) ? catBody.categories : [])
    .filter(c => c && c.categoryid != null && c.name)
    .map(c => ({ id: String(c.categoryid), name: String(c.name), count: num(c.item_count) }));
  const map = new Map();
  for (const it of (listBody && Array.isArray(listBody.items) ? listBody.items : [])) {
    const ids = Array.isArray(it.category_ids) ? it.category_ids.map(String) : [];
    if (it.appid && ids.length) map.set(Number(it.appid), new Set(ids));
  }
  return { cats, map };
}

const COMMUNITY_IMG = "https://cdn.cloudflare.steamstatic.com/steamcommunity/public/images/";
/** Адрес картинки предмета сообщества; только безопасный относительный путь. */
export function communityImg(p) {
  return typeof p === "string" && /^[\w\-./]+$/.test(p) && !p.includes("..") ? COMMUNITY_IMG + p.replace(/^\/+/, "") : null;
}

/** Надетое оформление профиля из GetProfileItemsEquipped: [{ kind, title, img }]. */
export function equippedItems(body) {
  const kinds = [["animated_avatar", "Аватар"], ["avatar_frame", "Рамка"], ["profile_background", "Фон"], ["mini_profile_background", "Мини-фон"], ["profile_modifier", "Эффект"]];
  const out = [];
  for (const [key, kind] of kinds) {
    const it = body && body[key];
    if (!it || typeof it !== "object") continue;
    const title = String(it.item_title || it.name || "").trim();
    if (!title) continue;
    out.push({ kind, title, img: communityImg(it.image_small || it.image_large) });
  }
  return out;
}

export function equippedHtml(items, proxy = u => u) {
  if (!items || !items.length) return "";
  return `<div class="gm-equip">${items.map(i => `<div class="gm-eq">${i.img ? `<img src="${esc(proxy(i.img))}" alt="" loading="lazy" referrerpolicy="no-referrer">` : `<i></i>`}<small>${esc(i.kind)}</small><b>${esc(i.title)}</b></div>`).join("")}</div>`;
}
