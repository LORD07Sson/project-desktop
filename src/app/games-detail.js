import { esc } from "./utils.js";
import { priceView, badgesOf, fmtNum, shortDate, initials2 } from "./games-core.js";
import { galleryHtml } from "./games-media.js";
import { fmtBytes } from "./games-build.js";

const ICONS = {
  overview: '<rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/>',
  price: '<path d="M20 13 11 22 2 13V3h10l8 8a1.4 1.4 0 0 1 0 2Z"/><circle cx="7" cy="8" r="1.5"/>',
  activity: '<path d="M3 19h18M4 14l5-6 5 4 6-9"/><path d="M15 3h5v5"/>',
  content: '<rect x="3" y="7" width="18" height="14" rx="2"/><path d="M7 7V3h10v4M3 12h18M10 12v3h4v-3"/>',
  system: '<rect x="3" y="3" width="18" height="13" rx="2"/><path d="M8 21h8M12 16v5M7 7h5M7 11h9"/>',
  community: '<path d="M21 11a8 8 0 0 1-8 8H7l-5 3 2-6a8 8 0 1 1 17-5Z"/><path d="M8 10h8M8 14h5"/>',
  updates: '<path d="M3 10a9 9 0 1 1 2 8M3 4v6h6M12 7v5l3 2"/>',
  arrow: '<path d="M5 12h14M14 7l5 5-5 5"/>',
  back: '<path d="M19 12H5M10 7l-5 5 5 5"/>',
  external: '<path d="M14 3h7v7M21 3 10 14M10 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-5"/>',
  close: '<path d="m6 6 12 12M18 6 6 18"/>',
  play: '<path d="m8 4 12 8-12 8Z"/>',
  thumb: '<path d="M7 10h-4v11h4M7 10l6-8c2 1 2 3 1 5l-1 3h6a2 2 0 0 1 2 2l-2 7a3 3 0 0 1-3 2H7Z"/>',
};
export const detailIcon = name => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[name] || ICONS.overview}</svg>`;
const VIEWS = [["overview", "Обзор"], ["price", "Цены и скидки"], ["activity", "Аудитория"], ["content", "Издания и DLC"], ["system", "Система и файлы"], ["community", "Сообщество"], ["updates", "Обновления"]];
const heading = (n, title, text) => `<header class="gd-page-head"><span class="gd-eyebrow">${n} / ${title}</span><h2>${title}</h2><p>${text}</p></header>`;
const loading = label => `<div class="gd-loading"><span class="ny-spin"></span>${label}</div>`;
const panel = (key, html) => `<section class="gd-panel" id="gd-panel-${key}" role="tabpanel" aria-labelledby="gd-tab-${key}" tabindex="0"${key === "overview" ? "" : " hidden"}>${html}</section>`;
const section = (id, title, html, subtitle = "") => `<section class="gd-section" id="gm-sec-${id}"><header class="gd-section-head"><h3>${title}</h3>${subtitle ? `<span>${subtitle}</span>` : ""}</header>${html}</section>`;

export const detailMediaIndex = d => d.shots && d.shots.length ? (d.movies || []).length : 0;

export function detailPriceHtml(d) {
  const p = d.free ? { now: "Бесплатно", old: "", badge: "" } : priceView(d.price);
  return `<div class="gm-box pr gd-price"><small>${d.free ? "Бесплатная игра" : "Цена в Steam"}</small><div><b>${esc(p.now)}</b>${p.badge ? `<i class="gd-discount">${esc(p.badge)}</i>` : ""}${p.old ? `<s>${esc(p.old)}</s>` : ""}</div>${d.at_lowest && !d.free ? `<span class="gd-price-low">Минимум за время наблюдения</span>` : ""}</div>`;
}

/** Structure only; existing Steam loaders fill the named slots without re-rendering the page. */
export function detailPageHtml(d, { appid, owned = false, hasSteam = false, image, picture }) {
  const platforms = Object.entries({ windows: "Windows", mac: "macOS", linux: "Linux" }).filter(([k]) => d.platforms && d.platforms[k]).map(([, v]) => v).join(" · ");
  const developers = (d.developers || []).join(", ");
  const types = { game: "Игра", dlc: "Дополнение", demo: "Демо", mod: "Мод", music: "Саундтрек" };
  const facts = [["Разработчик", developers], ["Издатель", (d.publishers || []).join(", ")], ["Дата выхода", d.release], ["Платформы", platforms], ["Жанры", (d.genres || []).join(", ")], ["Поддержка", d.support && d.support.email], ["Возраст", Number(d.age) > 0 ? `${d.age}+` : ""]];
  const links = [[d.website, "Сайт игры"], [d.support && d.support.url, "Поддержка"], [`https://steamdb.info/app/${appid}/`, "SteamDB"], [`https://www.protondb.com/app/${appid}`, "ProtonDB"]].filter(([url]) => /^https?:\/\//i.test(url || ""));
  const descriptorNames = { 1: "Нагота или сексуальный контент", 2: "Насилие и кровь", 3: "Сексуальный контент для взрослых", 4: "Нагота и сексуальный контент", 5: "Темы для взрослых" };
  const descriptors = (d.content_descriptors && d.content_descriptors.ids || []).map(id => descriptorNames[id] || `Возрастной маркер ${id}`);
  const money = esc(d.price && d.price.currency || "");
  const wish = `<button type="button" class="btn gd-wish" data-d-wish="${appid}" data-name="${esc(d.name)}" data-on="${d.wishlisted ? 1 : 0}" aria-pressed="${!!d.wishlisted}">${d.wishlisted ? "♥ В желаемом" : "♡ В желаемое"}</button>`;
  const ranges = (attr, items) => `<div class="ny-seg gd-range" aria-label="Период графика">${items.map(([k, label]) => `<button type="button" ${attr}="${k}">${label}</button>`).join("")}</div>`;
  const overview = `<div class="gd-hero" id="gm-sec-metadata">
    <div class="gd-media" id="gm-sec-screenshots"><div class="gd-media-label"><span>В кадре</span><span>${(d.movies || []).length} трейлеров · ${(d.shots || []).length} кадров</span></div>${galleryHtml(d, image, { initialIndex: detailMediaIndex(d) }) || picture(appid, d.image, d.name, "gm-img gd-cover")}</div>
    <div class="gd-intro"><div class="gd-eyebrow">${esc(types[d.type] || "Steam")}${platforms ? ` <span> / </span> ${esc(platforms)}` : ""}</div><h1 id="gd-game-name">${esc(d.name)}</h1><p class="gd-byline">${esc(developers)}${d.release ? `<span>${esc(d.release)}</span>` : ""}</p><p class="gd-description">${esc(d.description || "Описание пока недоступно.")}</p>
      ${detailPriceHtml(d)}<div class="gd-hero-actions">${wish}<button type="button" class="gd-icon-btn" data-d-view="price" title="История цены и уведомления" aria-label="История цены и уведомления">${detailIcon("price")}</button></div><div class="gm-d-badges gd-compat" id="gm-badges">${badgesOf(d, null).map(b => `<i class="gm-tag ${b.cls}">${esc(b.text)}</i>`).join("")}</div>
    </div></div>
    <div class="gd-metrics"><div class="gm-box" id="gm-rate"><b>—</b><small>отзывы Steam</small></div><div class="gm-box now"><b id="gm-now">—</b><small><i class="gd-live-dot"></i>играют сейчас</small></div><div class="gm-box"><b>${d.metacritic ? esc(d.metacritic) : "—"}<em>/100</em></b><small>Metacritic</small></div><button type="button" class="gd-metric-link" data-d-view="activity"><span>Вся статистика</span>${detailIcon("arrow")}</button></div>
    <div class="gd-about-grid">${section("about", "Об игре", `<dl class="gd-facts">${facts.filter(([, v]) => v).map(([k, v]) => `<div><dt>${k}</dt><dd>${esc(v)}</dd></div>`).join("")}</dl><div class="gd-links">${links.map(([url, label]) => `<button type="button" data-d-store="${esc(url)}">${label}${detailIcon("external")}</button>`).join("")}</div>`)}
    ${section("features", "Игровой опыт", `<div class="gd-tags" id="gm-tags">${loading("Загружаю теги…")}</div>${d.categories && d.categories.length ? `<details class="gd-disclosure"><summary>Возможности Steam <span>${d.categories.length}</span></summary><div class="gd-feature-list">${d.categories.map(x => `<span>${esc(x)}</span>`).join("")}</div></details>` : ""}${descriptors.length || d.content_descriptors && d.content_descriptors.notes ? `<details class="gd-disclosure"><summary>Возрастные особенности</summary><p>${esc(descriptors.join(" · "))}</p>${d.content_descriptors.notes ? `<p>${esc(d.content_descriptors.notes)}</p>` : ""}</details>` : ""}`)}</div>`;
  const price = heading("02", "Цены и скидки", "История стоимости, цены по регионам и уведомления о выгодном предложении.")
    + section("price", "История цены", d.free ? `<div class="gd-empty">Игра бесплатная. История стоимости для неё не ведётся.</div>` : `<div class="gm-online gm-hist"><div class="gd-chart-toolbar"><span class="gd-chart-label">${money || "Цена"} · ${esc(d.cc || "")}</span>${ranges("data-prange", [[30,"30 дней"],[90,"3 месяца"],[365,"Год"],[0,"Всё"]])}</div><div class="gm-pstats" id="gm-pstats"></div><div class="gm-chartbox" id="gm-pchart"></div><div class="gm-plist" id="gm-plist"></div></div><details class="gd-disclosure gd-source-note"><summary>Как собирается история</summary><p>Мы сохраняем замеченные изменения цены с датой проверки. Выбранный регион проверяется обычно раз в 2 часа; желаемое — каждые 30 минут и при просмотре. Другие регионы — не чаще раза в 20 часов. При большом списке интервалы могут увеличиваться. История начинается с первого наблюдения.</p></details><div class="gm-reg" id="gm-reg"><button type="button" class="btn" data-regions="${appid}">${detailIcon("price")}Сравнить цены по странам</button></div>`)
    + section("alerts", "Не пропустить скидку", `<div class="gd-alerts"><div><b>Твоя цена</b><p>Сохрани цель — сообщим, когда игра станет дешевле.</p></div><div class="gd-targets"><label>Цена до, ${money || "валюта региона"}<input type="number" class="gm-target" id="gm-target" min="0" step="0.01" placeholder="Любая" value="${d.target != null ? esc(d.target) : ""}"></label><label>Скидка от, %<input type="number" class="gm-target" id="gm-tdisc" min="1" max="95" step="1" placeholder="Любая" value="${d.target_discount != null ? esc(d.target_discount) : ""}"></label><button type="button" class="btn primary" data-save-target>Сохранить цель</button></div></div><div id="gm-watchbox"></div>`);
  const activity = heading("03", "Аудитория", "Кто играет прямо сейчас — и как меняется интерес к игре.")
    + section("charts", "Игроки онлайн", `<div class="gm-online" id="gm-online"><div class="gm-online-h"><span class="gd-chart-label" id="gm-rank"></span>${ranges("data-orange", [["48h","48 часов"],["7d","Неделя"],["30d","Месяц"],["90d","3 месяца"],["all","Всё"]])}</div><div class="gm-online-s"></div><div class="gm-chartbox gm-online-c"></div></div><details class="gd-disclosure gd-source-note"><summary>О данных и периоде наблюдения</summary><p>Сохраняем онлайн с датой наблюдения. После 14 дней оставляем один замер в час; после 400 дней сохраняются месячные сводки. История до начала наблюдения недоступна.</p></details>`)
    + section("monthly", "По месяцам", `<div id="gm-monthly">${loading("Считаю статистику…")}</div>`)
    + section("store", "В цифрах", `<div class="gm-store" id="gm-store"><div><b>${d.recommendations ? fmtNum(d.recommendations) : "—"}</b><small>рекомендаций Steam</small></div><div><b id="gm-dlc-count">${d.dlc ? fmtNum(d.dlc) : "—"}</b><small>дополнений</small></div><div><b>${fmtNum(d.watchers || 0)}</b><small>следят в Project</small></div><div><b>${fmtNum(d.sales || 0)}</b><small>скидок за наблюдение</small></div></div>`);
  const content = heading("04", "Издания и DLC", "Варианты покупки и дополнительный контент для игры.") + section("packages", "Издания", '<div id="gm-packages"></div>') + section("dlcs", "Дополнения", '<div id="gm-dlcs"></div>') + section("related", "Другие приложения", '<div id="gm-related"></div>');
  const system = heading("05", "Система и файлы", "Требования к компьютеру, языки и данные установки.") + section("configuration", "Конфигурация", '<div id="gm-config"></div>') + section("cloud", "Облачные сохранения", '<div id="gm-cloud"></div>') + section("depots", "Файлы установки", '<div id="gm-depots"></div>', "Публичные депо Steam");
  const community = heading("06", "Сообщество", "Впечатления игроков, новости и личные достижения.") + `<section class="gd-section gm-more" id="gm-sec-patches"><div class="ny-seg gm-mtabs gd-community-tabs" aria-label="Материалы об игре"><button type="button" data-more="reviews">Отзывы</button><button type="button" data-more="news">Новости</button><button type="button" data-more="patch">Патчноуты</button><button type="button" data-more="ach">Достижения</button>${hasSteam ? '<button type="button" data-more="stats">Моя статистика</button>' : ""}</div><div id="gm-more-body"></div></section>`;
  const updates = heading("07", "Обновления", "Текущая сборка игры и изменения, которые мы сохранили.") + section("technical", "Сведения Steam", `<div class="gm-tech-meta" id="gm-tech-meta">${loading("Загружаю сведения…")}</div>`) + section("updates", "История сборок", `<div id="gm-build">${loading("Загружаю историю…")}</div>`);
  return `<div class="gd-shell"><header class="gd-toolbar"><button type="button" class="gd-back" data-d-close aria-label="Вернуться к каталогу">${detailIcon("back")}<span>К каталогу</span></button><div class="gd-toolbar-title" id="gd-dialog-title">${esc(d.name)}</div><div class="gd-toolbar-actions"><button type="button" class="btn ghost gd-steam" data-d-store="${esc(d.store || `https://store.steampowered.com/app/${appid}/`)}">Steam${detailIcon("external")}</button>${owned ? `<button type="button" class="btn primary gd-launch" data-launch="${appid}">${detailIcon("play")}Запустить</button>` : ""}<button type="button" class="gd-icon-btn" data-d-close aria-label="Закрыть страницу игры">${detailIcon("close")}</button></div></header>
    <div class="gd-layout"><aside class="gd-sidebar"><div class="gd-rail-label">PROJECT <span>GAMES</span></div><nav class="gd-nav" role="tablist" aria-label="Разделы игры" aria-orientation="vertical">${VIEWS.map(([key, label], i) => `<button type="button" role="tab" id="gd-tab-${key}" data-d-view="${key}" aria-controls="gd-panel-${key}" aria-selected="${i === 0}" tabindex="${i === 0 ? 0 : -1}">${detailIcon(key)}<span>${label}</span></button>`).join("")}</nav><div class="gd-rail-foot"><small>ПРИЛОЖЕНИЕ STEAM</small><button type="button" data-copy="${appid}" title="Скопировать App ID">${appid}<span>Копировать</span></button></div></aside><main class="gd-scroll">${panel("overview", overview)}${panel("price", price)}${panel("activity", activity)}${panel("content", content)}${panel("system", system)}${panel("community", community)}${panel("updates", updates)}</main></div></div>`;
}

const SECTION_VIEW = { metadata: "overview", screenshots: "overview", price: "price", charts: "activity", packages: "content", dlcs: "content", related: "content", configuration: "system", cloud: "system", depots: "system", patches: "community", achievements: "community", updates: "updates" };
export function selectDetailView(root, key) {
  const view = SECTION_VIEW[key] || key;
  if (!VIEWS.some(([id]) => id === view)) return false;
  const scroller = root.querySelector(".gd-scroll");
  root.__detailScrolls ||= {};
  if (root.__detailView) root.__detailScrolls[root.__detailView] = scroller.scrollTop;
  root.__detailView = view;
  root.querySelectorAll(".gd-panel").forEach(el => { el.hidden = el.id !== `gd-panel-${view}`; });
  root.querySelectorAll('.gd-nav [role="tab"]').forEach(el => { const active = el.dataset.dView === view; el.setAttribute("aria-selected", String(active)); el.tabIndex = active ? 0 : -1; });
  scroller.scrollTop = root.__detailScrolls[view] || 0;
  if (view !== "overview") root.querySelector("[data-gal]")?.dispatchEvent(new Event("gm-gal-pause"));
  return true;
}

export function mountDetailNavigation(root, previousFocus) {
  const sheet = root.querySelector(".sheet");
  sheet.setAttribute("role", "dialog");
  sheet.setAttribute("aria-modal", "true");
  sheet.setAttribute("aria-labelledby", "gd-dialog-title");
  root.__detailView = "overview";
  const mq = window.matchMedia("(max-width: 900px)");
  const orient = () => root.querySelector(".gd-nav").setAttribute("aria-orientation", mq.matches ? "horizontal" : "vertical");
  orient(); mq.addEventListener("change", orient);
  const click = e => {
    const nav = e.target.closest("[data-d-view]");
    if (nav && selectDetailView(root, nav.dataset.dView) && !nav.closest(".gd-nav")) root.querySelector(`#gd-panel-${root.__detailView}`).focus({ preventScroll: true });
    const expand = e.target.closest("[data-review-expand]");
    if (expand) { const open = expand.getAttribute("aria-expanded") !== "true"; expand.setAttribute("aria-expanded", String(open)); expand.closest(".gd-review").classList.toggle("expanded", open); expand.textContent = open ? "Свернуть" : "Читать целиком"; }
  };
  const keydown = e => {
    const tab = e.target.closest('.gd-nav [role="tab"]');
    if (tab && ["ArrowDown", "ArrowUp", "ArrowLeft", "ArrowRight", "Home", "End"].includes(e.key)) {
      e.preventDefault();
      const tabs = [...root.querySelectorAll('.gd-nav [role="tab"]')], index = tabs.indexOf(tab);
      const next = e.key === "Home" ? 0 : e.key === "End" ? tabs.length - 1 : (index + (["ArrowDown", "ArrowRight"].includes(e.key) ? 1 : -1) + tabs.length) % tabs.length;
      selectDetailView(root, tabs[next].dataset.dView); tabs[next].focus();
    }
    if (e.key === "Tab") {
      const focusable = [...sheet.querySelectorAll('button:not(:disabled),input:not(:disabled),select,a[href],summary,[tabindex="0"]')].filter(el => el.getClientRects().length && !el.closest("[hidden]"));
      const first = focusable[0], last = focusable[focusable.length - 1];
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last?.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first?.focus(); }
    }
  };
  root.addEventListener("click", click); root.addEventListener("keydown", keydown);
  root.querySelector(".gd-back").focus({ preventScroll: true });
  return () => { root.removeEventListener("click", click); root.removeEventListener("keydown", keydown); mq.removeEventListener("change", orient); if (previousFocus && previousFocus.isConnected) previousFocus.focus({ preventScroll: true }); };
}

export function requirementsHtml(text) {
  const lines = text.split(/\n+/).map(s => s.replace(/^[•\s]+/, "").trim()).filter(s => s && !/^(минимальные|рекомендуемые|рекомендованные|minimum|recommended)\s*:$/i.test(s));
  if (!lines.length) return '<p class="gd-empty">Требования не указаны.</p>';
  return `<dl class="gd-requirements">${lines.map(line => { const match = line.match(/^([^:]{1,55}):\s*(.+)$/); return match ? `<div><dt>${esc(match[1])}</dt><dd>${esc(match[2])}</dd></div>` : `<div class="gd-req-note"><dt class="gd-sr-only">Примечание</dt><dd>${esc(line)}</dd></div>`; }).join("")}</dl>`;
}

export function languagesHtml(languages) {
  if (!languages.length) return '<p class="gd-empty">Информация о языках пока недоступна.</p>';
  const mark = value => `<span class="gd-language-mark ${value == null ? "unknown" : value ? "yes" : "no"}" aria-label="${value == null ? "Неизвестно" : value ? "Поддерживается" : "Не поддерживается"}" title="${value == null ? "Steam не указал" : value ? "Поддерживается" : "Не поддерживается"}">${value == null ? "?" : value ? "✓" : "—"}</span>`;
  const rows = [...languages].sort((a, b) => Number(/^русский$/i.test(b.name)) - Number(/^русский$/i.test(a.name)));
  return `<div class="gd-language-section"><h4>Языки</h4><div class="gd-table-scroll"><table class="gd-languages"><thead><tr><th scope="col">Язык</th><th scope="col">Интерфейс</th><th scope="col">Озвучка</th><th scope="col">Субтитры</th></tr></thead><tbody>${rows.map(x => `<tr${/^русский$/i.test(x.name) ? ' class="gd-native-language"' : ""}><th scope="row">${esc(x.name)}</th><td>${mark(x.interface)}</td><td>${mark(x.audio)}</td><td>${mark(x.subtitles)}</td></tr>`).join("")}</tbody></table></div></div>`;
}

export function depotsHtml(depots) {
  const total = depots.reduce((sum, x) => sum + (Number(x.size) || 0), 0);
  return `<div class="gd-depot-summary"><b>${esc(fmtBytes(total))}</b><span>Сумма размеров публичных депо · ${depots.length} файловых наборов</span></div><div class="gd-table-scroll"><table class="gd-depots"><thead><tr><th>Депо</th><th>Система</th><th>На диске</th><th>Загрузка</th><th><span class="gd-sr-only">Ссылка</span></th></tr></thead><tbody>${depots.map(x => `<tr><th scope="row"><span>${esc(x.id)}</span><i class="gd-size-track"><i style="width:${total ? Math.min(100, Math.max(0, Number(x.size) || 0) / total * 100) : 0}%"></i></i></th><td>${esc(x.os || "Все")}</td><td>${esc(fmtBytes(x.size))}</td><td>${esc(fmtBytes(x.download))}</td><td><button type="button" class="gd-icon-btn" data-d-store="https://steamdb.info/depot/${Number(x.id)}/" aria-label="Депо ${esc(x.id)} в SteamDB">${detailIcon("external")}</button></td></tr>`).join("")}</tbody></table></div><p class="gd-footnote">Размер депо может включать файлы для разных конфигураций и отличаться от места, необходимого для установки.</p>`;
}

export function reviewCardsHtml(items) {
  return `<div class="gd-reviews">${items.map((x, i) => `<article class="gd-review ${x.up ? "up" : "down"}"><header><span class="gd-review-avatar" aria-hidden="true">${esc(initials2(x.name))}</span><div><b>${esc(x.name || "Игрок Steam")}</b><small>${fmtNum(x.hours)} ч в игре · ${esc(shortDate(x.ts))}</small></div><span class="gd-verdict">${detailIcon("thumb")}<span>${x.up ? "Рекомендует" : "Не рекомендует"}</span></span></header><p id="gd-review-${i}" class="gd-review-copy">${esc(x.text)}</p>${(x.text || "").length > 360 ? `<button type="button" class="gd-text-btn" data-review-expand aria-expanded="false" aria-controls="gd-review-${i}">Читать целиком</button>` : ""}</article>`).join("")}</div>`;
}
