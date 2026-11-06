// «Что мешает сейчас» для карточки отчёта: одна строка с действием над этапами производства.
// Чистая функция без DOM и без обращений к состоянию — права приходят аргументами, чтобы её можно было
// проверить в Node (scripts/now-test.mjs). Разметку из результата собирает productionHtml (report-detail.js).
//
// tone "wait" — что-то стопорит работу, "go" — можно двигаться дальше. null — сказать нечего.
// act = { jump } прокручивает к блоку, { click } нажимает существующую кнопку (сборка, пост).
export function productionNow({ hasVideo, hasFinal, pipeLeft = "", canAssemble = false, canPost = false }) {
  if (!hasVideo) {
    return { tone: "wait", title: "Сейчас блокирует: нет видео", sub: "Пока видео нет, сборка финала не начнётся.", label: "Добавить видео", act: { jump: ".rd-files" } };
  }
  if (pipeLeft) {
    return { tone: "wait", title: `Сейчас ждём озвучку: ${pipeLeft}`, sub: "Финал соберётся, когда пройдёт весь пайплайн.", label: "К пайплайну", act: { jump: ".rd-pipe" } };
  }
  if (!hasFinal) {
    return canAssemble ? { tone: "go", title: "Можно собирать финал", sub: "Видео прикреплено, пайплайн пройден.", label: "Собрать финал", act: { click: "#report-assemble" } } : null;
  }
  return canPost ? { tone: "go", title: "Финал готов — можно готовить пост", sub: "", label: "Пост в канал", act: { click: "#report-post" } } : null;
}
