
const ADD_APPID_RE = /addappid\s*\(\s*(\d+)\s*(?:,\s*\d+\s*(?:,\s*"([^"]*)")?)?\s*\)[ \t]*(?:--[ \t]*(.*?)[ \t]*)?$/i;
const SET_MANIFEST_RE = /setManifestid\s*\(\s*(\d+)\s*,\s*"(\d+)"\s*(?:,\s*(\d+))?/i;
const ADD_TOKEN_RE = /addtoken\s*\(\s*(\d+)\s*,\s*"([^"]*)"\s*\)/i;
const SET_APP_TICKET_RE = /setappticket\s*\(\s*(\d+)\s*,\s*"([^"]*)"\s*\)/i;
const SET_ETICKET_RE = /seteticket\s*\(\s*(\d+)\s*,\s*"([^"]*)"\s*\)/i;
const SET_STAT_RE = /setstat\s*\(\s*(\d+)\s*,\s*"([^"]*)"\s*\)/i;
const SET_CDKEY_RE = /setlegacycdkey\s*\(\s*(\d+)\s*,\s*"([^"]*)"\s*\)/i;
const COMMENT_TAIL_RE = /\s*\(\d+\)\s*\S*\s*$/;

function cleanComment(raw) {
  if (!raw?.trim()) return null;
  let s = raw.trim();
  if (/setManifestid|addappid|addtoken|setappticket|seteticket|setstat|setlegacycdkey/i.test(s)) return null;
  s = s.replace(COMMENT_TAIL_RE, "").trim();
  return s || null;
}

function parseExtras(line) {
  const out = [];
  for (const [re, kind, valIdx] of [
    [ADD_TOKEN_RE, "token", 2],
    [SET_APP_TICKET_RE, "appTicket", 2],
    [SET_ETICKET_RE, "eTicket", 2],
    [SET_STAT_RE, "stat", 2],
    [SET_CDKEY_RE, "cdKey", 2],
  ]) {
    const m = re.exec(line);
    if (m) out.push({ appId: parseInt(m[1], 10), kind, value: m[valIdx] });
  }
  return out;
}

export function parseLua(text, appIdFromName) {
  const order = [];
  const keyById = new Map();
  const commentById = new Map();
  const manifests = new Map();
  const sizes = new Map();
  const commentedManifests = new Map();
  const disabledOrder = [];
  const disabledKeyById = new Map();
  const extras = [];

  for (const rawLine of text.split("\n")) {
    const line = rawLine.trim();
    const commented = line.startsWith("--");

    const pin = SET_MANIFEST_RE.exec(line);
    if (pin) {
      const depot = parseInt(pin[1], 10);
      (commented ? commentedManifests : manifests).set(depot, pin[2]);
      if (pin[3]) {
        const sz = parseInt(pin[3], 10);
        if (sz > 0 && !sizes.has(depot)) sizes.set(depot, sz);
      }
    }

    const stripped = commented ? line.replace(/^-+\s*/, "") : line;

    for (const ex of parseExtras(stripped)) {
      ex.disabled = commented;
      extras.push(ex);
    }

    const m = ADD_APPID_RE.exec(stripped);
    if (!m) continue;
    const id = parseInt(m[1], 10);
    if (isNaN(id)) continue;

    const key = m[2] && m[2].length > 0 ? m[2] : null;
    const comment = cleanComment(m[3] || null);
    if (comment && (!commentById.has(id) || comment.length > commentById.get(id).length)) {
      commentById.set(id, comment);
    }

    if (commented) {
      if (disabledKeyById.has(id)) {
        disabledKeyById.set(id, disabledKeyById.get(id) ?? key);
      } else {
        disabledKeyById.set(id, key);
        disabledOrder.push(id);
      }
      continue;
    }
    if (keyById.has(id)) {
      keyById.set(id, keyById.get(id) ?? key);
    } else {
      keyById.set(id, key);
      order.push(id);
    }
  }

  const entries = order.map(id => ({
    id,
    key: keyById.get(id) ?? null,
    manifestId: manifests.get(id) ?? null,
    commentedManifestId: commentedManifests.get(id) ?? null,
    comment: commentById.get(id) ?? null,
    sizeOnDisk: sizes.get(id) ?? null,
    hasKey: keyById.get(id) != null,
  }));

  const disabledEntries = disabledOrder
    .filter(id => !keyById.has(id))
    .map(id => ({
      id,
      key: disabledKeyById.get(id) ?? null,
      manifestId: manifests.get(id) ?? null,
      commentedManifestId: commentedManifests.get(id) ?? null,
      comment: commentById.get(id) ?? null,
      sizeOnDisk: sizes.get(id) ?? null,
      hasKey: disabledKeyById.get(id) != null,
    }));

  const baseAppId = entries.length > 0 ? entries[0].id : appIdFromName;

  return {
    baseAppId,
    entries,
    disabledEntries,
    extras,
    activePins: Object.fromEntries(manifests),
    commentedPins: Object.fromEntries(commentedManifests),
    depotCount: entries.filter(e => e.hasKey).length,
    dlcCount: entries.filter(e => !e.hasKey && e.id !== baseAppId).length,
    hasActivePins: manifests.size > 0,
  };
}

export function diffLua(oldLua, newLua) {
  const oldIds = new Set(oldLua?.entries.map(e => e.id) ?? []);
  const newIds = new Set(newLua.entries.map(e => e.id));
  return {
    added: newLua.entries.filter(e => !oldIds.has(e.id)),
    removed: oldLua?.entries.filter(e => !newIds.has(e.id)) ?? [],
  };
}


export function setDepotLocked(lua, depotId, locked) {
  const re = new RegExp(`^(\\s*)(--\\s*)?(setManifestid\\s*\\(\\s*${depotId}\\s*[,)])`, "im");
  return rewriteLines(lua, re, locked);
}

export function setDepotEnabled(lua, depotId, enabled) {
  const re = new RegExp(`^(\\s*)(--\\s*)?(addappid\\s*\\(\\s*${depotId}\\s*[,)])`, "im");
  return rewriteLines(lua, re, enabled);
}

export function setDepotManifest(lua, depotId, gid) {
  if (!/^\d+$/.test(String(gid))) throw new Error("Некорректный ID манифеста");
  const re = new RegExp(`^(\\s*)(setManifestid\\s*\\(\\s*${depotId}\\s*,\\s*)(["'])\\d+\\3(\\s*,\\s*\\d+)?`, "i");
  let hit = false;
  const out = lua.split("\n").map(line => {
    if (hit || !re.test(line)) return line;
    hit = true;
    return line.replace(re, (_, ind, head, q) => `${ind}${head}${q}${gid}${q}`);
  }).join("\n");
  if (!hit) throw new Error(`Строка setManifestid для депо ${depotId} не найдена`);
  return out;
}

function rewriteLines(lua, re, active) {
  return lua.split("\n").map(line => {
    const m = re.exec(line);
    if (!m) return line;
    const indent = m[1];
    const isCommented = !!m[2];
    if (isCommented === !active) return line;
    if (active) {
      const afterComment = line.substring((m[1] + m[2]).length);
      return indent + afterComment;
    }
    return indent + "--" + line.substring(indent.length);
  }).join("\n");
}
