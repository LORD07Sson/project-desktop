
// Actor field of .ass subtitles ↔ title characters and their dubbers. Pure functions, no DOM.

export const normName = s => String(s || "").normalize("NFKC").toLowerCase().replace(/ё/g, "е").replace(/[«»"'`]/g, "").replace(/\s+/g, " ").trim();

function dialogueLayout(lines) {
  let section = "", fields = null;
  return lines.map(line => {
    const head = /^\s*\[([^\]]+)\]/.exec(line);
    if (head) { section = head[1].toLowerCase(); fields = null; return null; }
    if (section !== "events") return null;
    if (/^\s*Format\s*:/i.test(line)) { fields = line.slice(line.indexOf(":") + 1).split(",").map(f => f.trim().toLowerCase()); return null; }
    if (!fields || !/^\s*Dialogue\s*:/i.test(line)) return null;
    const actor = fields.indexOf("name") >= 0 ? fields.indexOf("name") : fields.indexOf("actor");
    return actor >= 0 ? { fields, actor } : null;
  });
}

function splitDialogue(line, count) {
  const colon = line.indexOf(":");
  const prefix = line.slice(0, colon + 1);
  const parts = [];
  let rest = line.slice(colon + 1);
  for (let i = 0; i < count - 1; i++) {
    const c = rest.indexOf(",");
    if (c < 0) return null;
    parts.push(rest.slice(0, c));
    rest = rest.slice(c + 1);
  }
  parts.push(rest);
  return { prefix, parts };
}

/** Unique Actor values with how many dialogue lines use each. */
export function assActors(text) {
  const lines = String(text || "").replace(/^﻿/, "").split(/\r?\n/);
  const layout = dialogueLayout(lines);
  const counts = new Map();
  let total = 0, empty = 0;
  lines.forEach((line, i) => {
    const l = layout[i];
    if (!l) return;
    const d = splitDialogue(line, l.fields.length);
    if (!d) return;
    total++;
    const actor = d.parts[l.actor].trim();
    if (!actor) { empty++; return; }
    counts.set(actor, (counts.get(actor) || 0) + 1);
  });
  return { total, empty, actors: [...counts].map(([actor, lines]) => ({ actor, lines })).sort((a, b) => b.lines - a.lines) };
}

/** "Персонаж (Даббер)", "Персонаж - Даббер", "Персонаж | Даббер", "Персонаж / Даббер" or just one name. */
export function splitActor(actor) {
  const s = String(actor || "").trim();
  let m = /^(.+?)\s*[([]\s*([^)\]]+?)\s*[)\]]\s*$/.exec(s);
  if (m) return { left: m[1].trim(), right: m[2].trim() };
  m = /^(.+?)\s+[-–—|/]\s+(.+)$/.exec(s) || /^(.+?)\s*[|/]\s*(.+)$/.exec(s);
  if (m) return { left: m[1].trim(), right: m[2].trim() };
  return { left: s, right: "" };
}

function characterIndex(characters) {
  const idx = new Map();
  for (const c of characters || []) {
    const n = normName(c.name);
    if (!n) continue;
    if (!idx.has(n)) idx.set(n, c);
    const first = n.split(" ")[0];
    if (first && first !== n && !idx.has(`~${first}`)) idx.set(`~${first}`, c);
  }
  return idx;
}
function editDistance(a, b) {
  if (Math.abs(a.length - b.length) > 2) return 9;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = cur;
  }
  return prev[b.length];
}
// Subbers spell names their own way: "Ниа" for "Ния Листон", "Линокис" for "Ринокис Фанк".
// Allow 1 typo (2 for long names) against a full name or its first word, only when exactly one character fits.
function fuzzyCharacter(idx, n) {
  const word = n.split(" ")[0];
  if (word.length < 3) return null;
  const limit = word.length >= 8 ? 2 : 1;
  let best = limit + 1, hits = new Set();
  for (const [key, c] of idx) {
    const k = key.startsWith("~") ? key.slice(1) : key;
    const d = editDistance(key.startsWith("~") ? word : n, k);
    if (d < best) { best = d; hits = new Set([c]); } else if (d === best) hits.add(c);
  }
  if (hits.size === 1) return [...hits][0];
  if (!hits.size) {
    // A whole word of the name ("Клоун" for "Жестокий клоун") or its ending ("Хиро" for "Такахиро Сато"); not a
    // beginning: "Люди" (a crowd) must not become "Людивина".
    // 4+ letters, only one character.
    if (word.length < 4) return null;
    const inside = new Set([...idx.values()].filter(c => normName(c.name).split(" ").some(w => w === word || (w.length > word.length && w.endsWith(word)))));
    return inside.size === 1 ? [...inside][0] : null;
  }
  // A tie ("Ниа": Ния or Нил?) goes to the only main character among them, if there is one.
  const main = [...hits].filter(c => c.role === "main");
  return main.length === 1 ? main[0] : null;
}
const findCharacter = (idx, name) => {
  const n = normName(name);
  return n ? idx.get(n) || idx.get(`~${n}`) || idx.get(`~${n.split(" ")[0]}`) || fuzzyCharacter(idx, n) : null;
};

function userLabels(u) {
  return [u.name, u.username, u.username && `@${u.username}`].map(normName).filter(Boolean);
}
function findUser(users, name) {
  const n = normName(name);
  if (!n) return null;
  return (users || []).find(u => userLabels(u).includes(n))
    || (users || []).find(u => userLabels(u).some(l => l.split(" ")[0] === n)) || null;
}

/**
 * Import plan: which characters get which dubber, based on Actor values.
 * Returns { pairs: [{actor, lines, character, user}], unknownCharacters: [actor], unknownDubbers: [{actor, dubber}] }.
 */
export function planImport(actors, characters, users) {
  const idx = characterIndex(characters);
  const pairs = [], unknownCharacters = [], unknownDubbers = [];
  const taken = new Set();
  for (const { actor, lines } of actors) {
    const { left, right } = splitActor(actor);
    let character = findCharacter(idx, left), dubberName = right;
    if (!character && right) { character = findCharacter(idx, right); dubberName = left; }
    if (!character) { unknownCharacters.push(actor); continue; }
    if (!dubberName) continue;
    const user = findUser(users, dubberName);
    if (!user) { unknownDubbers.push({ actor, dubber: dubberName }); continue; }
    if (taken.has(character.id)) continue;
    taken.add(character.id);
    pairs.push({ actor, lines, character, user });
  }
  return { pairs, unknownCharacters, unknownDubbers };
}

/**
 * Rewrites Actor of every dialogue line whose character is known.
 * mode: "both" → "Персонаж (Даббер)", "dubber" → "Даббер".
 * Returns { text, changed, noActor, unknownActors: [actor], unvoiced: [character name] }.
 */
export function applyDubbers(text, characters, mode = "both") {
  const src = String(text || "");
  const bom = src.startsWith("﻿") ? "﻿" : "";
  const eol = /\r\n/.test(src) ? "\r\n" : "\n";
  const lines = src.slice(bom.length).split(/\r?\n/);
  const layout = dialogueLayout(lines);
  const idx = characterIndex(characters);
  const unknown = new Set(), unvoiced = new Set();
  let changed = 0, noActor = 0;
  const out = lines.map((line, i) => {
    const l = layout[i];
    if (!l) return line;
    const d = splitDialogue(line, l.fields.length);
    if (!d) return line;
    const actor = d.parts[l.actor].trim();
    if (!actor) { noActor++; return line; }
    const { left, right } = splitActor(actor);
    const character = findCharacter(idx, left) || (right ? findCharacter(idx, right) : null);
    if (!character) { unknown.add(actor); return line; }
    const dubber = character.voiced_by && String(character.voiced_by.name || character.voiced_by.username || "").trim().replace(/^@/, "");
    if (!dubber) { unvoiced.add(character.name); return line; }
    const next = (mode === "dubber" ? dubber : `${character.name} (${dubber})`).replace(/,/g, " ");
    if (next === d.parts[l.actor]) return line;
    d.parts[l.actor] = next;
    changed++;
    return d.prefix + d.parts.join(",");
  });
  return { text: bom + out.join(eol), changed, noActor, unknownActors: [...unknown], unvoiced: [...unvoiced] };
}

/**
 * Dialogue lines per dubber, from the Actor field.
 * Actor may be "Персонаж (Даббер)", just "Персонаж" (dubber from the title's casting) or just "Даббер".
 * users: [{telegram_id, name, username}].
 * Returns { total, empty, people: [{telegram_id, name, lines, characters: [{id, name, image_url, lines}]}], unknown: [{actor, lines}] },
 * people and their characters sorted by lines, most first.
 */
// Actor values that mark on-screen text, not a voiced line.
const SIGN_ACTOR_RE = /^(надпис[ьи]|надпись \d+|sign|signs|text|title|caption|титр|титры|примечание|note|comment)$/;

// Separators between several speakers of one line, and "together" fillers.
const JOIN_ACTOR_RE = /\s*(?:[,;&+]|\s(?:и|and|with|с)\s)\s*/i;
const TOGETHER_RE = /\s*[([]?\s*(?:вместе|хором|together)\s*[)\]]?\s*$/i;
const EVERYONE_WORDS = new Set(["все", "всё", "вместе", "хором", "толпа", "all", "everyone", "together", "crowd"]);
const isEveryone = n => { const w = n.replace(/[^a-zа-я0-9 ]+/gi, " ").split(" ").filter(Boolean); return w.length > 0 && w.every(x => EVERYONE_WORDS.has(x)); };

/**
 * Dialogue lines the tally skips, in file order, so the roll can be fixed in Aegisub:
 * empty Actor, signs, and Actor values that matched nobody (pass countDubberLines(...).unknown).
 * → [{ start: "0:03:12", reason: "empty" | "sign" | "unknown", actor, text }]
 */
export function assSkippedLines(text, unknown = []) {
  const lines = String(text || "").replace(/^\uFEFF/, "").split(/\r?\n/);
  const layout = dialogueLayout(lines);
  // "Part (из «Actor»)" entries only partly failed; the line itself was still counted.
  const bad = new Set(unknown.filter(u => !/ \(из «.+»\)$/.test(u.actor)).map(u => u.actor.trim()));
  const out = [];
  lines.forEach((line, i) => {
    const l = layout[i];
    if (!l) return;
    const d = splitDialogue(line, l.fields.length);
    if (!d) return;
    const actor = d.parts[l.actor].trim();
    const reason = !actor ? "empty" : SIGN_ACTOR_RE.test(normName(actor)) ? "sign" : bad.has(actor) ? "unknown" : "";
    if (!reason) return;
    const si = l.fields.indexOf("start");
    const start = si >= 0 ? d.parts[si].trim().replace(/\.\d+$/, "") : "";
    const body = d.parts[l.fields.length - 1].replace(/\{[^}]*\}/g, "").replace(/\\[Nnh]/g, " ").replace(/\s+/g, " ").trim();
    out.push({ start, reason, actor, text: body });
  });
  return out;
}

/** Dialogue lines in file order: [{ start: "0:03:12", actor, text }]. */
export function assTimedLines(text) {
  const lines = String(text || "").replace(/^\uFEFF/, "").split(/\r?\n/);
  const layout = dialogueLayout(lines);
  const out = [];
  lines.forEach((line, i) => {
    const l = layout[i];
    if (!l) return;
    const d = splitDialogue(line, l.fields.length);
    if (!d) return;
    const si = l.fields.indexOf("start"), ei = l.fields.indexOf("end"), yi = l.fields.indexOf("style");
    const secs = v => { const m = /^(\d+):(\d+):(\d+(?:\.\d+)?)$/.exec(String(v || "").trim()); return m ? +m[1] * 3600 + +m[2] * 60 + +m[3] : null; };
    out.push({
      start: si >= 0 ? d.parts[si].trim().replace(/\.\d+$/, "") : "",
      t0: si >= 0 ? secs(d.parts[si]) : null,
      t1: ei >= 0 ? secs(d.parts[ei]) : null,
      style: yi >= 0 ? d.parts[yi].trim() : "",
      actor: d.parts[l.actor].trim(),
      text: d.parts[l.fields.length - 1].replace(/\{[^}]*\}/g, "").replace(/\\[Nnh]/g, " ").replace(/\s+/g, " ").trim(),
    });
  });
  return out;
}

export function countDubberLines(text, characters, users, aliases = {}) {
  const { total, empty, actors } = assActors(text);
  const idx = characterIndex(characters);
  const byTid = new Map((users || []).map(u => [String(u.telegram_id), u]));
  // Nicknames bound to people in tally notes ("Ewaii" → Ren), keys normalized like normName.
  const alias = new Map(Object.entries(aliases || {}).map(([k, v]) => [normName(k), String(v)]));
  const person = name => {
    const n = normName(name);
    if (!n) return null;
    const tid = alias.get(n);
    if (tid) return byTid.get(tid) || { telegram_id: tid, name };
    const one = test => { const hit = (users || []).filter(u => userLabels(u).some(test)); return hit.length === 1 ? hit[0] : null; };
    // Exact name, then first word of a name or username ("Ewaii" ~ "Ewaii_Ren"),
    // then a unique prefix of 3+ letters ("Богдан" ~ "богданчик <3").
    return findUser(users, name)
      || one(l => l.split(/[_\s.-]+/)[0] === n)
      || (n.length >= 3 ? one(l => l.startsWith(n)) : null);
  };
  // One Actor value → {user, character} or null.
  const resolve = actor => {
    const { left, right } = splitActor(actor);
    let character = findCharacter(idx, left), dubber = right;
    if (!character && right) { character = findCharacter(idx, right); dubber = left; }
    let user = dubber ? person(dubber) : null;
    if (!user && character && character.voiced_by) {
      const tid = String(character.voiced_by.telegram_id || "");
      user = byTid.get(tid) || (tid ? { telegram_id: tid, name: character.voiced_by.name || character.voiced_by.username || "" } : null);
    }
    // No such character in the title: "Даббер - Персонаж" or "Персонаж - Даббер", or just the dubber.
    if (!user && !character) user = person(left) || (right ? person(right) : null);
    return user ? { user, character } : null;
  };
  // Dubbers who aren't in the team (guests, ex-members) still get a tile by name. Which side of "A - B" is the
  // dubber is learned from this roll's own lines that resolved ("Даббер - Персонаж" or "Персонаж - Даббер").
  let dubLeft = 0, dubRight = 0;
  for (const { actor, lines } of actors) {
    const { left, right } = splitActor(actor);
    if (!right) continue;
    if (person(left)) dubLeft += lines;
    else if (person(right)) dubRight += lines;
  }
  const guests = new Map();
  const dubberSide = actor => {
    const { left, right } = splitActor(actor);
    if (!right || (!dubLeft && !dubRight)) return null;
    return dubLeft >= dubRight ? [left, right] : [right, left];
  };
  for (const { actor } of actors) {
    const n = normName(actor);
    if (SIGN_ACTOR_RE.test(n) || isEveryone(n) || resolve(actor) || JOIN_ACTOR_RE.test(actor)) continue;
    const side = dubberSide(actor);
    const key = side && normName(side[0]);
    if (key && key.length >= 2 && !findCharacter(idx, side[0]) && !isEveryone(key)) {
      if (!guests.has(key)) guests.set(key, { telegram_id: `name:${key}`, name: side[0].trim() });
    }
  }
  const resolveOrGuest = actor => {
    const r = resolve(actor);
    if (r) return r;
    const side = dubberSide(actor);
    if (side) {
      const g = guests.get(normName(side[0]));
      return g ? { user: g, character: findCharacter(idx, side[1]) } : null;
    }
    const g = guests.get(normName(actor));
    return g ? { user: g, character: null } : null;
  };
  const people = new Map(), groups = new Map(), unknown = [], everyone = [];
  let signs = 0, joint = 0;
  // A line several people say together goes to their group, not to each of them, so the tiles add up to the total.
  const together = (members, lines) => {
    const list = [...new Map(members.map(u => [String(u.telegram_id), u])).values()];
    if (list.length < 2) { credit({ user: list[0], character: null }, lines); return; }
    joint += lines;
    const key = list.map(u => String(u.telegram_id)).sort().join(",");
    const g = groups.get(key) || { members: list.map(u => ({ telegram_id: String(u.telegram_id), name: u.name || u.username || "" })), lines: 0 };
    g.lines += lines;
    groups.set(key, g);
  };
  let current = "";
  const credit = ({ user, character }, lines) => {
    const key = String(user.telegram_id);
    const p = people.get(key) || { telegram_id: key, name: user.name || user.username || "", lines: 0, joint: 0, chars: new Map(), actors: new Set() };
    p.lines += lines;
    if (current) p.actors.add(current);
    if (character) {
      const c = p.chars.get(character.id) || { id: character.id, name: character.name, image_url: character.image_url || "", lines: 0 };
      c.lines += lines;
      p.chars.set(character.id, c);
    }
    people.set(key, p);
  };
  for (const { actor, lines } of actors) {
    const n = normName(actor);
    if (SIGN_ACTOR_RE.test(n)) { signs += lines; continue; }
    if (isEveryone(n)) { everyone.push({ actor, lines }); continue; }
    current = actor;
    // Several speakers in one line: "Мэбуки и Ясуко", "Oni, Совесть - толпа", "Куруми + Мотико вместе".
    // Split before matching the whole value: the first-word match would take "Мэбуки и Мотико" for Мэбуки alone.
    // A character literally named with "и"/a comma stays whole.
    const parts = idx.has(n) ? [] : actor.split(JOIN_ACTOR_RE).map(x => x.replace(TOGETHER_RE, "").trim()).filter(Boolean);
    if (parts.length < 2) {
      const whole = resolveOrGuest(actor);
      if (whole) { credit(whole, lines); continue; }
      // Just listed with spaces: "Ewaii Богдан вместе". Only when every word is a person of the team.
      const words = actor.replace(TOGETHER_RE, "").split(/\s+/).filter(Boolean);
      const who = words.length > 1 ? words.map(w => person(w) || guests.get(normName(w)) || null) : [];
      const ids = new Set(who.filter(Boolean).map(u => String(u.telegram_id)));
      if (who.length && who.every(Boolean) && ids.size > 1) together(who, lines);
      else unknown.push({ actor, lines });
      continue;
    }
    const hits = new Map(), missed = [];
    for (const part of parts) {
      const r = resolveOrGuest(part);
      if (r) { if (!hits.has(String(r.user.telegram_id))) hits.set(String(r.user.telegram_id), r); } else missed.push(part);
    }
    if (!hits.size) { unknown.push({ actor, lines }); continue; }
    if (hits.size === 1) hits.forEach(r => credit(r, lines));
    else together([...hits.values()].map(r => r.user), lines);
    missed.forEach(part => unknown.push({ actor: `${part} (из «${actor}»)`, lines }));
  }
  // "Все вместе" / "хором": everyone who speaks in this episode says it.
  for (const { actor, lines } of everyone) {
    if (people.size < 2) { unknown.push({ actor, lines }); continue; }
    together([...people.values()], lines);
  }
  const groupList = [...groups.values()].sort((a, b) => b.lines - a.lines);
  for (const g of groupList) for (const m of g.members) { const p = people.get(m.telegram_id); if (p) p.joint += g.lines; }
  const list = [...people.values()].map(({ chars, actors, ...p }) => ({ ...p, actors: [...actors], characters: [...chars.values()].sort((a, b) => b.lines - a.lines) }));
  return { total, empty, signs, joint, people: list.sort((a, b) => b.lines - a.lines), groups: groupList, unknown };
}

// Why a hand count tends to lose a line, with a base weight. Weights drop for a sign that also occurs
// in the lines of people whose hand count matched the file: that counter evidently handles it fine.
const MISS_SIGNS = [
  { key: "repeat", label: "повтор предыдущей строки", w: 5 },
  { key: "sametime", label: "тот же тайминг, что у предыдущей своей строки", w: 4 },
  { key: "overlap", label: "звучит одновременно с другой репликой", w: 3 },
  { key: "cont", label: "продолжение фразы без паузы", w: 2 },
  { key: "style", label: "редкий стиль", w: 2 },
  { key: "short", label: "очень короткая", w: 1 },
];

/**
 * Lines a hand count most likely missed.
 * timed: assTimedLines(text); missing: [{ actors: [...], d }] people whose note is short by d lines;
 * matched: [{ actors: [...] }] people whose note matched. → per person [{ line, score, why: [labels] }], best first.
 */
export function missCandidates(timed, missing, matched = []) {
  const flat = s => String(s || "").toLowerCase().replace(/[^a-zа-яё0-9]+/gi, "");
  const styleUse = new Map();
  for (const l of timed) styleUse.set(l.style, (styleUse.get(l.style) || 0) + 1);
  const signs = (l, i) => {
    const prev = timed[i - 1];
    const out = new Set();
    if (prev && prev.actor === l.actor && flat(l.text) && flat(prev.text) === flat(l.text)) out.add("repeat");
    if (prev && prev.actor === l.actor && l.t0 != null && prev.t0 != null && Math.abs(l.t0 - prev.t0) < 0.05 && !out.has("repeat")) out.add("sametime");
    if (prev && prev.actor !== l.actor && l.t0 != null && prev.t1 != null && l.t0 < prev.t1 - 0.05) out.add("overlap");
    if (prev && prev.actor === l.actor && l.t0 != null && prev.t1 != null && l.t0 - prev.t1 <= 0.1 && !/[.!?…»"]$/.test(prev.text)) out.add("cont");
    if (l.style && (styleUse.get(l.style) || 0) <= Math.max(2, timed.length * 0.05)) out.add("style");
    if (flat(l.text).length <= 3) out.add("short");
    return out;
  };
  const all = timed.map(signs);
  const okActors = new Set(matched.flatMap(p => p.actors));
  const handled = new Set();
  timed.forEach((l, i) => { if (okActors.has(l.actor)) all[i].forEach(k => handled.add(k)); });
  const weight = k => { const s = MISS_SIGNS.find(x => x.key === k); return s ? s.w * (handled.has(k) ? 0.25 : 1) : 0; };
  return missing.map(p => {
    const own = new Set(p.actors);
    const list = [];
    timed.forEach((l, i) => {
      if (!own.has(l.actor) || !all[i].size) return;
      const keys = [...all[i]];
      const score = keys.reduce((a, k) => a + weight(k), 0);
      list.push({ line: l, score, why: keys.sort((a, b) => weight(b) - weight(a)).map(k => MISS_SIGNS.find(x => x.key === k).label) });
    });
    return list.sort((a, b) => b.score - a.score);
  });
}
