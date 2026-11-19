
import { esc } from "./utils.js";

export function donutHtml(segments, size, thickness) {
  size = size || 120;
  thickness = thickness || 16;
  const r = (size - thickness) / 2;
  const circumference = 2 * Math.PI * r;
  const total = segments.reduce((s, x) => s + x.count, 0);
  const cx = size / 2, cy = size / 2;
  let offsetAcc = 0;
  const circles = segments.filter(s => s.count > 0).map(s => {
    const frac = total ? s.count / total : 0;
    const len = frac * circumference;
    const dasharray = `${len} ${circumference - len}`;
    const dashoffset = -offsetAcc;
    offsetAcc += len;
    return `<circle class="donut-seg" cx="${cx}" cy="${cy}" r="${r}" fill="none"
      stroke="var(${s.colorVar})" stroke-width="${thickness}"
      stroke-dasharray="${circumference} ${circumference}"
      stroke-dashoffset="${circumference}"
      data-target-dasharray="${dasharray}" data-target-dashoffset="${dashoffset}"
      transform="rotate(-90 ${cx} ${cy})"></circle>`;
  }).join("");
  return `
    <svg class="donut-svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">
      <circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="var(--surface-2)" stroke-width="${thickness}"></circle>
      ${circles}
      <text x="${cx}" y="${cy - 3}" text-anchor="middle" font-size="20" font-weight="700" fill="var(--ink)">${total}</text>
      <text x="${cx}" y="${cy + 15}" text-anchor="middle" font-size="10" fill="var(--ink-dim)">всего</text>
    </svg>`;
}

export function playDonutIntro(root) {
  const segs = root.querySelectorAll(".donut-seg");
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      segs.forEach(c => {
        c.setAttribute("stroke-dasharray", c.dataset.targetDasharray);
        c.setAttribute("stroke-dashoffset", c.dataset.targetDashoffset);
      });
    });
  });
}

export function donutLegendHtml(segments) {
  const total = segments.reduce((s, x) => s + x.count, 0);
  return segments.filter(s => s.count > 0).map(s => `
    <div class="donut-legend-item">
      <span class="dot" style="background:var(${s.colorVar})"></span>
      <span class="name">${esc(s.label)}</span>
      <span class="count">${s.count}${total ? ` · ${Math.round(s.count / total * 100)}%` : ""}</span>
    </div>
  `).join("") || `<div class="no-assignee">Пока нет данных</div>`;
}

export function deltaPillHtml(pct) {
  if (pct === null || pct === undefined) return "";
  const positive = pct >= 0;
  return `<span class="delta-pill ${positive ? "up" : "down"}">${positive ? "+" : ""}${pct}%</span>`;
}

export function timelineHtml(rows, rangeStart, rangeEnd, todayMs) {
  const span = Math.max(1, rangeEnd - rangeStart);
  const pct = ms => Math.max(0, Math.min(100, ((ms - rangeStart) / span) * 100));
  const fmt = ms => {
    const d = new Date(ms);
    return `${String(d.getDate()).padStart(2, "0")}.${String(d.getMonth() + 1).padStart(2, "0")}`;
  };
  const tagHtml = (left, current, text) => left > 65
    ? `<div class="gantt-tag end${current ? " current" : ""}" style="right:${(100 - left).toFixed(2)}%;">${esc(text)}</div>`
    : `<div class="gantt-tag${current ? " current" : ""}" style="left:${left.toFixed(2)}%;">${esc(text)}</div>`;
  const bars = rows.map(r => {
    const left = pct(r.startMs);
    const width = Math.max(2, pct(r.endMs) - left);
    const current = todayMs >= r.startMs && todayMs <= r.endMs;
    return `
      <div class="gantt-row" title="${esc(r.title)}: ${esc(fmt(r.startMs))} → ${esc(fmt(r.endMs))}">
        <div class="gantt-track">
          ${tagHtml(left, current, `${fmt(r.startMs)} ${r.title}`)}
          <div class="gantt-bar" style="left:${left.toFixed(2)}%; width:0%; background:var(${r.colorVar}); color:var(${r.colorVar});" data-target-width="${width.toFixed(2)}"></div>
        </div>
      </div>`;
  }).join("");
  return `
    <div class="gantt">
      <div class="gantt-axis"><span>${fmt(rangeStart)}</span><span>${fmt(rangeEnd)}</span></div>
      <div class="gantt-body" style="--today-pct:${pct(todayMs).toFixed(2)}%;">
        <div class="gantt-today-line" title="Сегодня"></div>
        ${bars || `<div class="no-assignee">Нет активных серий со сроком</div>`}
      </div>
    </div>`;
}

export function playTimelineIntro(root) {
  const bars = root.querySelectorAll(".gantt-bar");
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      bars.forEach(el => { el.style.width = `${el.dataset.targetWidth}%`; });
    });
  });
}
