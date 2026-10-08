import assert from "node:assert/strict";
import { pkcePair, authUrl, looksLikeClientId, fmtMs, parsePlayer, spotifyError, REDIRECT_URI, SCOPES, randomString } from "../src/app/spotify-core.js";

const { verifier, challenge } = await pkcePair();
assert.ok(verifier.length >= 43 && verifier.length <= 128);
assert.match(verifier, /^[A-Za-z0-9_-]+$/);
assert.match(challenge, /^[A-Za-z0-9_-]{43}$/, "SHA-256 в base64url без «=» — 43 символа");
// эталон из RFC 7636, приложение B
const rfc = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk")));
let s = ""; for (const b of rfc) s += String.fromCharCode(b);
assert.equal(btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, ""), "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM");
assert.notEqual(randomString(), randomString());

const u = new URL(authUrl({ clientId: "a".repeat(32), challenge, state: "st" }));
assert.equal(u.origin + u.pathname, "https://accounts.spotify.com/authorize");
assert.equal(u.searchParams.get("redirect_uri"), REDIRECT_URI);
assert.equal(u.searchParams.get("code_challenge_method"), "S256");
assert.equal(u.searchParams.get("scope"), SCOPES.join(" "));
assert.ok(!u.search.includes("client_secret"));

assert.ok(looksLikeClientId("0123456789abcdef0123456789ABCDEF"));
assert.ok(!looksLikeClientId("short"));
assert.equal(fmtMs(83000), "1:23");
assert.equal(fmtMs(undefined), "0:00");

const p = parsePlayer({ is_playing: true, progress_ms: 5000, shuffle_state: true, device: { id: "d", name: "ПК", volume_percent: 40 },
  item: { name: "Midnight City", duration_ms: 243000, artists: [{ name: "M83" }, { name: "X" }], album: { name: "Hurry Up", images: [{ url: "big" }, { url: "mid" }] } } });
assert.equal(p.title, "Midnight City");
assert.equal(p.artist, "M83, X");
assert.equal(p.art, "mid");
assert.equal(p.playing, true);
assert.deepEqual(parsePlayer({ device: { id: "d" } }), { idle: true, device: { id: "d" } });
assert.equal(parsePlayer(null), null);

assert.match(spotifyError(404, '{"error":{"reason":"NO_ACTIVE_DEVICE"}}'), /Нет активного устройства/);
assert.match(spotifyError(403, '{"error":{"reason":"PREMIUM_REQUIRED"}}'), /Premium/);
assert.match(spotifyError(401, ""), /заново/);
assert.match(spotifyError(500, "<html>"), /500/);
console.log("spotify-test: ok");
