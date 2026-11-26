
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
const findCharacter = (idx, name) => { const n = normName(name); return n ? idx.get(n) || idx.get(`~${n}`) || idx.get(`~${n.split(" ")[0]}`) || null : null; };

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
  const people = new Map(), unknown = [], everyone = [];
  let signs = 0, joint = 0;
  const credit = ({ user, character }, lines, shared) => {
    const key = String(user.telegram_id);
    const p = people.get(key) || { telegram_id: key, name: user.name || user.username || "", lines: 0, joint: 0, chars: new Map() };
    p.lines += lines;
    if (shared) p.joint += lines;
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
    // Several speakers in one line: "Мэбуки и Ясуко", "Oni, Совесть - толпа", "Куруми + Мотико вместе".
    // Split before matching the whole value: the first-word match would take "Мэбуки и Мотико" for Мэбуки alone.
    // A character literally named with "и"/a comma stays whole.
    const parts = idx.has(n) ? [] : actor.split(JOIN_ACTOR_RE).map(x => x.replace(TOGETHER_RE, "").trim()).filter(Boolean);
    if (parts.length < 2) {
      const whole = resolve(actor);
      if (whole) credit(whole, lines, false); else unknown.push({ actor, lines });
      continue;
    }
    const hits = new Map(), missed = [];
    for (const part of parts) {
      const r = resolve(part);
      if (r) { if (!hits.has(String(r.user.telegram_id))) hits.set(String(r.user.telegram_id), r); } else missed.push(part);
    }
    if (!hits.size) { unknown.push({ actor, lines }); continue; }
    const shared = hits.size > 1;
    if (shared) joint += lines;
    hits.forEach(r => credit(r, lines, shared));
    missed.forEach(part => unknown.push({ actor: `${part} (из «${actor}»)`, lines }));
  }
  // "Все вместе" / "хором": everyone who speaks in this episode says it.
  for (const { actor, lines } of everyone) {
    if (people.size < 2) { unknown.push({ actor, lines }); continue; }
    joint += lines;
    people.forEach(p => { p.lines += lines; p.joint += lines; });
  }
  const list = [...people.values()].map(({ chars, ...p }) => ({ ...p, characters: [...chars.values()].sort((a, b) => b.lines - a.lines) }));
  return { total, empty, signs, joint, people: list.sort((a, b) => b.lines - a.lines), unknown };
}
