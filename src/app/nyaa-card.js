// Карточка раздачи Nyaa в чате: ссылка project://nyaa/<номер> показывается обложкой, названием и кнопкой «Открыть».
// Данные подгружаются при появлении карточки на экране; тяжёлый модуль «Релизов» загружается только тогда.
import { esc } from "./utils.js";

const cache = new Map();   // номер раздачи → { title, meta, image }

function cardInner(id) {
  const c = cache.get(id);
  const pic = c && c.image ? `<img src="${esc(c.image)}" alt="">` : "";
  return `<span class="ms-ny-pic">${pic}</span><span class="ms-ny-t"><b>${esc(c ? c.title : `Раздача №${id}`)}</b><small>${esc(c ? c.meta : "Загружаю…")}</small></span><button type="button" class="btn" data-nyaa-open="${id}">Открыть</button>`;
}

// Чат перерисовывает список целиком при каждом сообщении — уже загруженная карточка рисуется сразу полной.
export function nyaaCardsHtml(ids) {
  return ids.map(id => `<div class="ms-nyaa${cache.has(Number(id)) ? " ready" : ""}" data-nyaa="${id}">${cardInner(Number(id))}</div>`).join("");
}

const done = new WeakSet();
async function hydrate(card) {
  if (card.classList.contains("ready") || done.has(card)) return;
  done.add(card);
  const id = Number(card.dataset.nyaa);
  try {
    if (!cache.has(id)) {
      const m = await import("./nyaa.js");
      cache.set(id, await m.nyaaCardInfo(id));
    }
    card.innerHTML = cardInner(id);
    card.classList.add("ready");
  } catch (_) {
    const s = card.querySelector("small");
    if (s) s.textContent = "Не удалось загрузить описание — откройте раздачу.";
  }
}

let timer = 0;
new MutationObserver(() => {
  clearTimeout(timer);
  timer = setTimeout(() => document.querySelectorAll(".ms-nyaa").forEach(hydrate), 80);
}).observe(document.body, { childList: true, subtree: true });

document.addEventListener("click", async e => {
  const b = e.target.closest("[data-nyaa-open]");
  if (!b) return;
  e.preventDefault();
  const m = await import("./nyaa.js");
  m.openNyaaById(Number(b.dataset.nyaaOpen));
});
