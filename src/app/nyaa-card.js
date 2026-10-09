// Карточка раздачи Nyaa в чате: ссылка project://nyaa/<номер> показывается обложкой, названием и кнопкой «Открыть».
// Данные подгружаются при появлении карточки на экране; тяжёлый модуль «Релизов» загружается только тогда.
import { esc } from "./utils.js";

export function nyaaCardsHtml(ids) {
  return ids.map(id => `<div class="ms-nyaa" data-nyaa="${id}"><span class="ms-ny-pic"></span><span class="ms-ny-t"><b>Раздача №${id}</b><small>Загружаю…</small></span><button type="button" class="btn" data-nyaa-open="${id}">Открыть</button></div>`).join("");
}

const done = new WeakSet();
async function hydrate(card) {
  if (done.has(card)) return;
  done.add(card);
  try {
    const m = await import("./nyaa.js");
    const info = await m.nyaaCardInfo(Number(card.dataset.nyaa));
    card.querySelector(".ms-ny-t").innerHTML = `<b>${esc(info.title)}</b><small>${esc(info.meta)}</small>`;
    if (info.image) card.querySelector(".ms-ny-pic").innerHTML = `<img src="${esc(info.image)}" alt="">`;
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
