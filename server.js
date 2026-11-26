// NomNomZilla – kleiner Server ohne externe Abhängigkeiten.
// Speichert alle Rezepte als JSON in DATA_DIR, liefert die Web-App aus
// und leitet den Import (Text/PDF) an die Anthropic-API weiter.
'use strict';
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const PORT = +process.env.PORT || 8080;
const DATA_DIR = process.env.DATA_DIR || '/data';
const PUBLIC_DIR = path.join(__dirname, 'public');
const SEED_FILE = path.join(__dirname, 'seed', 'recipes.json');
const DB_FILE = path.join(DATA_DIR, 'recipes.json');
const APP_PASSWORD = process.env.APP_PASSWORD || '';
const API_KEY = process.env.ANTHROPIC_API_KEY || '';
const MODEL = process.env.ANTHROPIC_MODEL || 'claude-sonnet-5-5';
const API_BASE = (process.env.ANTHROPIC_BASE_URL || 'https://api.anthropic.com').replace(/\/$/, '');
const MAX_BODY = 40 * 1024 * 1024;

// ---------- Rechte (Unraid: nobody:users = 99:100) ----------
// Startet der Container als root, gehört der Datenordner danach PUID:PGID
// und der Server läuft mit diesen Rechten weiter.
fs.mkdirSync(DATA_DIR, { recursive: true });
if (process.getuid && process.getuid() === 0) {
  const uid = +(process.env.PUID ?? 99), gid = +(process.env.PGID ?? 100);
  const own = p => { try { fs.chownSync(p, uid, gid); } catch (e) { console.warn('chown', p, e.message); } };
  own(DATA_DIR);
  for (const f of fs.readdirSync(DATA_DIR)) own(path.join(DATA_DIR, f));
  if (uid !== 0) { process.setgid(gid); process.setuid(uid); }
}

// ---------- Speicher ----------
let recipes = new Map();
function load() {
  let list = [];
  if (fs.existsSync(DB_FILE)) list = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
  else if (fs.existsSync(SEED_FILE)) { list = JSON.parse(fs.readFileSync(SEED_FILE, 'utf8')); recipes = new Map(list.map(r => [r.id, r])); persist(); }
  recipes = new Map(list.map(r => [r.id, r]));
}
function persist() {
  const tmp = DB_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify([...recipes.values()], null, 1));
  fs.renameSync(tmp, DB_FILE);
}
load();
console.log(`NomNomZilla: ${recipes.size} Rezepte aus ${DB_FILE}`);

// ---------- Live-Aktualisierung (Server-Sent Events) ----------
const clients = new Set();
function broadcast() { for (const res of clients) res.write('event: changed\ndata: {}\n\n'); }
setInterval(() => { for (const res of clients) res.write(': ping\n\n'); }, 25000).unref();

// ---------- Hilfen ----------
const send = (res, code, body, type = 'application/json; charset=utf-8') => {
  res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-store' });
  res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body));
};
function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', c => { size += c.length; if (size > MAX_BODY) { reject(Object.assign(new Error('too_large'), { status: 413 })); req.destroy(); } else chunks.push(c); });
    req.on('end', () => { try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}); } catch (e) { reject(Object.assign(e, { status: 400 })); } });
    req.on('error', reject);
  });
}
const clean = o => { const r = { ...(o && typeof o === 'object' ? o : {}) }; delete r.id; return r; };
const newId = () => crypto.randomBytes(9).toString('base64url');
function authorized(req) {
  if (!APP_PASSWORD) return true;
  const h = req.headers.authorization || '';
  if (!h.startsWith('Basic ')) return false;
  const pass = Buffer.from(h.slice(6), 'base64').toString().split(':').slice(1).join(':');
  const a = Buffer.from(pass), b = Buffer.from(APP_PASSWORD);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css', '.png': 'image/png', '.svg': 'image/svg+xml', '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.ico': 'image/x-icon', '.woff2': 'font/woff2' };

// ---------- Claude ----------
async function askClaude({ prompt, images }) {
  const content = [];
  for (const img of (images || []).slice(0, 4)) {
    const m = /^data:(image\/(?:jpeg|png|webp|gif));base64,(.+)$/.exec(img || '');
    if (m) content.push({ type: 'image', source: { type: 'base64', media_type: m[1], data: m[2] } });
  }
  content.push({ type: 'text', text: String(prompt || '').slice(0, 60000) });
  const r = await fetch(API_BASE + '/v1/messages', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': API_KEY, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({ model: MODEL, max_tokens: 16000, system: 'Du bist ein präziser Rezept-Parser. Antworte ausschließlich mit gültigem JSON, ohne Erklärungen und ohne Markdown-Codeblock.', messages: [{ role: 'user', content }] })
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) {
    const code = r.status === 429 ? 'rate_limited' : r.status === 401 ? 'bad_api_key' : 'api_error';
    throw Object.assign(new Error(j?.error?.message || 'API-Fehler'), { status: 502, code });
  }
  const text = (j.content || []).filter(c => c.type === 'text').map(c => c.text).join('').trim()
    .replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '');
  const start = text.search(/[[{]/);
  try { return JSON.parse(start > 0 ? text.slice(start) : text); }
  catch { throw Object.assign(new Error('Antwort war kein JSON'), { status: 502, code: 'invalid_json' }); }
}

// ---------- Routen ----------
async function api(req, res, url) {
  const p = url.pathname;
  if (p === '/api/config') return send(res, 200, { ai: !!API_KEY, model: API_KEY ? MODEL : null });
  if (p === '/api/events') {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
    res.write('retry: 3000\n\n'); clients.add(res); req.on('close', () => clients.delete(res)); return;
  }
  if (p === '/api/backup') {
    const name = `nomnomzilla-${new Date().toISOString().slice(0, 10)}.json`;
    res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Disposition': `attachment; filename="${name}"` });
    return res.end(JSON.stringify([...recipes.values()], null, 1));
  }
  if (p === '/api/ai' && req.method === 'POST') {
    if (!API_KEY) return send(res, 503, { code: 'sampling_disabled' });
    return send(res, 200, await askClaude(await readBody(req)));
  }
  if (p === '/api/recipes' && req.method === 'GET') return send(res, 200, [...recipes.values()]);
  if (p === '/api/recipes' && req.method === 'POST') {
    const body = await readBody(req);
    const list = Array.isArray(body) ? body : [body];
    const ids = list.map(r => { let id = r?.id && !recipes.has(r.id) ? String(r.id) : newId(); recipes.set(id, { ...clean(r), id }); return id; });
    persist(); broadcast();
    return send(res, 201, Array.isArray(body) ? { ids } : { id: ids[0] });
  }
  const m = /^\/api\/recipes\/([\w-]{1,80})$/.exec(p);
  if (m) {
    const id = m[1], cur = recipes.get(id);
    if (req.method === 'GET') return cur ? send(res, 200, cur) : send(res, 404, { code: 'not_found' });
    if (req.method === 'PUT') { recipes.set(id, { ...clean(await readBody(req)), id }); persist(); broadcast(); return send(res, 200, { id }); }
    if (req.method === 'PATCH') { if (!cur) return send(res, 404, { code: 'not_found' }); recipes.set(id, { ...cur, ...clean(await readBody(req)), id }); persist(); broadcast(); return send(res, 200, { id }); }
    if (req.method === 'DELETE') { recipes.delete(id); persist(); broadcast(); return send(res, 200, { id }); }
  }
  send(res, 404, { code: 'not_found' });
}

function serveStatic(req, res, url) {
  let rel = decodeURIComponent(url.pathname);
  if (rel === '/') rel = '/index.html';
  const file = path.join(PUBLIC_DIR, path.normalize(rel));
  if (!file.startsWith(PUBLIC_DIR)) return send(res, 403, 'Forbidden', 'text/plain');
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) return send(res, 404, 'Nicht gefunden', 'text/plain; charset=utf-8');
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': rel.startsWith('/vendor/') ? 'public, max-age=604800' : 'no-cache' });
    fs.createReadStream(file).pipe(res);
  });
}

http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  if (url.pathname === '/health') return send(res, 200, { ok: true });
  if (!authorized(req)) { res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="NomNomZilla", charset="UTF-8"' }); return res.end('Anmeldung erforderlich'); }
  try {
    if (url.pathname.startsWith('/api/')) await api(req, res, url);
    else serveStatic(req, res, url);
  } catch (e) {
    console.error(e.message);
    if (!res.headersSent) send(res, e.status || 500, { code: e.code || 'error', message: e.message });
  }
}).listen(PORT, () => console.log(`NomNomZilla läuft auf Port ${PORT}${APP_PASSWORD ? ' (mit Passwort)' : ''}${API_KEY ? `, Import mit ${MODEL}` : ', Import aus (kein ANTHROPIC_API_KEY)'}`));

for (const sig of ['SIGTERM', 'SIGINT']) process.on(sig, () => process.exit(0));
