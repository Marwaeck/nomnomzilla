// NomNomZilla – Rezeptkarten-PDFs ohne Claude einlesen.
// 1. PDFs aus dem eigenen Export tragen die Rezeptdaten als JSON in den Metadaten (exakt).
// 2. PDFs im selben Kartenlayout, aber ohne diese Daten (z. B. als HTML im Browser gedruckt),
//    werden anhand der Textpositionen gelesen: Kopf, Menge/Zeit/Kochgeschirr, Zutaten, Tipp, Zubereitung.
// Läuft im Browser (window.NNZCard) und in Node (module.exports) für Tests.
(function (g) {
  'use strict';
  const TAG = 'nnz1:';
  const FIELDS = ['title', 'subtitle', 'category', 'cuisine', 'diet', 'mainIngredient', 'minutes', 'difficulty', 'season', 'servings', 'cookware', 'tags', 'ingredients', 'steps', 'tip', 'color', 'icon'];

  // ---------- Metadaten ----------
  const b64enc = s => { const b = new TextEncoder().encode(s); let t = ''; for (let i = 0; i < b.length; i += 0x8000) t += String.fromCharCode.apply(null, b.subarray(i, i + 0x8000)); return btoa(t); };
  const b64dec = s => new TextDecoder().decode(Uint8Array.from(atob(s), c => c.charCodeAt(0)));
  function pack(list) {
    const slim = list.map(r => { const o = {}; for (const k of FIELDS) if (r[k] != null && r[k] !== '') o[k] = r[k]; return o; });
    return 'NomNomZilla ' + TAG + b64enc(JSON.stringify({ v: 1, recipes: slim }));
  }
  function unpack(keywords) {
    const i = String(keywords || '').indexOf(TAG);
    if (i < 0) return null;
    try {
      const o = JSON.parse(b64dec(String(keywords).slice(i + TAG.length).trim()));
      return Array.isArray(o?.recipes) ? o.recipes.filter(r => r && typeof r === 'object' && r.title) : null;
    } catch (_) { return null; }
  }

  const PUA = { '\uE081': '(', '\uE082': ')', '\uE089': '–', '\uE09F': '×' };
  // ---------- Text mit Positionen aus einer pdf.js-Seite ----------
  async function pageItems(page) {
    const vp = page.getViewport({ scale: 1 });
    const tc = await page.getTextContent();
    const bold = {};
    try {
      await page.getOperatorList();
      for (const it of tc.items) {
        if (it.fontName in bold) continue;
        let name = '';
        try { if (page.commonObjs.has(it.fontName)) name = page.commonObjs.get(it.fontName)?.name || ''; } catch (_) {}
        bold[it.fontName] = /Bold|Black|Heavy/i.test(name) && !/SemiBold|DemiBold/i.test(name);
      }
    } catch (_) {}
    const items = [];
    for (const it of tc.items) {
      const h = Math.hypot(it.transform[2], it.transform[3]) || it.height;
      if (!h) continue;
      let s = it.str;
      // Zeichen ohne Unicode-Zuordnung landen im Private-Use-Bereich. In Chrome-PDFs mit der
      // Schrift Inter sind das immer dieselben: ( ) – ×. Unbekannte einzelne mit Strichbreite → „–“.
      s = s.replace(/[\uE000-\uF8FF]/g, c => PUA[c] ?? (it.width > h * 0.3 && it.width < h * 0.6 && s.length === 1 ? '–' : '')).replace(/\u00AD/g, '');
      if (!s.trim()) {
        // breites Leerzeichen = Wortgrenze in gesperrter Schrift
        if (items.length && it.width > h * 0.45) items[items.length - 1].ws = true;
        continue;
      }
      items.push({ s, x: it.transform[4], y: vp.height - it.transform[5], w: it.width, h, b: !!bold[it.fontName] });
    }
    return { items, width: vp.width, height: vp.height };
  }

  // ---------- Hilfen ----------
  const squash = s => s.replace(/\s+/g, '').toUpperCase();
  function lines(items, spaced) {
    const sorted = [...items].sort((a, b) => a.y - b.y || a.x - b.x);
    const out = [];
    for (const it of sorted) {
      const l = out.find(l => Math.abs(l.y - it.y) < Math.min(l.h, it.h) * 0.45);
      if (l) { l.items.push(it); l.h = Math.max(l.h, it.h); } else out.push({ y: it.y, h: it.h, items: [it] });
    }
    for (const l of out) {
      l.items.sort((a, b) => a.x - b.x);
      l.x = l.items[0].x;
      l.segs = [];
      let prev = null;
      for (const it of l.items) {
        let s = spaced && /^\S( \S)+ ?$/.test(it.s) ? it.s.replace(/ /g, '') : it.s;
        if (prev) {
          const gap = it.x - (prev.x + prev.w);
          if (gap > it.h * (spaced ? 0.4 : 0.15) && !/\s$/.test(prev.s) && !/^\s/.test(s)) s = ' ' + s;
        }
        l.segs.push({ s, b: it.b });
        prev = it;
      }
      l.text = l.segs.map(x => x.s).join('').replace(/\s+/g, ' ').trim();
      // Abschnitte einer Zeile, getrennt durch große Lücken (Spalten)
      l.runs = [];
      l.items.forEach((it, i) => {
        const r = l.runs[l.runs.length - 1];
        if (r && it.x - r.x2 < it.h * 0.9) { r.items.push(it); r.segs.push(l.segs[i]); r.x2 = Math.max(r.x2, it.x + it.w); }
        else l.runs.push({ x: it.x, y: l.y, h: it.h, x2: it.x + it.w, items: [it], segs: [{ ...l.segs[i], s: l.segs[i].s.replace(/^\s+/, '') }] });
      });
      for (const r of l.runs) r.text = r.segs.map(x => x.s).join('').replace(/\s+/g, ' ').trim();
    }
    return out.sort((a, b) => a.y - b.y);
  }
  // Zeilen zu Fließtext verbinden, Trennstrich am Zeilenende („Bacon-“ + „One“) ohne Leerzeichen
  function joinSegs(ls) {
    const segs = [];
    ls.forEach((l, i) => {
      if (i && segs.length) {
        const last = segs[segs.length - 1];
        if (!/\p{L}-$/u.test(last.s.trimEnd())) segs.push({ s: ' ', b: false });
        else last.s = last.s.trimEnd();
      }
      segs.push(...l.segs.map(x => ({ ...x })));
    });
    return segs;
  }
  const plain = segs => segs.map(x => x.s).join('').replace(/\s+/g, ' ').trim();
  function marked(segs) {
    let out = '', open = false;
    for (const { s, b } of segs) {
      if (b && !open) { const m = s.match(/^\s*/)[0]; out += m + '**' + s.slice(m.length); open = true; }
      else if (!b && open) { const m = s.match(/^\s*/)[0]; out = out.replace(/\s+$/, x => { open = false; return '**' + x; }); if (open) { out += '**'; open = false; } out += s; }
      else out += s;
    }
    if (open) out = out.replace(/\s*$/, '**');
    return out.replace(/\*\*\s*\*\*/g, ' ').replace(/\s+/g, ' ').trim();
  }
  const titleCase = s => s.toLowerCase().replace(/(^|[\s\-/])(\p{L})/gu, (m, a, c) => a + c.toUpperCase());

  // ---------- Kartenlayout lesen ----------
  const UPPER = t => /\p{Lu}/u.test(t) && !/\p{Ll}/u.test(t);
  const CAT_ALIAS = { SUPPEN: 'Suppe', EINTOPF: 'Suppe', KUCHEN: 'Gebäck', TORTE: 'Gebäck', TORTEN: 'Gebäck', BROT: 'Gebäck', BACKEN: 'Gebäck', PIZZA: 'Hauptgericht', FLEISCH: 'Hauptgericht', FISCH: 'Hauptgericht', NUDELN: 'Pasta', SALATE: 'Salat', DESSERTS: 'Dessert', NACHTISCH: 'Dessert', GETRÄNKE: 'Getränk', DRINKS: 'Getränk', BEILAGEN: 'Beilage', SNACKS: 'Snack', VORSPEISEN: 'Vorspeise' };
  // Minuten aus „1 Std. 10 Min.“, „30 Minuten“, „10–15 Min.“ (untere Grenze), „bis 22 Std.“
  function toMinutes(v) {
    v = String(v || '').replace(/(\d)\s*[–-]\s*\d+/g, '$1');
    const h = v.match(/(\d+(?:[.,]\d+)?)\s*(?:Std|Stunde|h\b)/i), m = v.match(/(\d+)\s*(?:Min|m\b)/i);
    return h || m ? Math.round((h ? parseFloat(h[1].replace(',', '.')) * 60 : 0) + (m ? +m[1] : 0)) : null;
  }
  function labelText(line) {
    if (line.items.length >= 4) {
      // Gesperrte Schrift als Einzelstücke: Wortgrenzen stecken in breiten Leerzeichen
      return line.items.map(it => it.s.replace(/ /g, '') + (it.ws ? ' ' : '')).join('').replace(/\s*·\s*/g, ' · ').trim();
    }
    return line.text;
  }
  function parseLabel(label, CATS, knownTags) {
    // Gesperrte Schrift kommt je nach PDF-Erzeuger als „K I N D E R“ heraus: Leerzeichen dann entfernen
    // und über bekannte Kategorien/Stichworte die richtige Schreibweise (mit Leerzeichen) zurückholen.
    const known = [...CATS, ...knownTags];
    const parts = label.split('·').map(p => {
      const tok = p.trim().split(/\s+/).filter(Boolean);
      const spaced = tok.length > 2 && tok.filter(t => t.length <= 2).length >= tok.length * 0.7;
      const txt = spaced ? tok.join('') : tok.join(' ');
      return known.find(k => squash(k) === squash(txt)) || titleCase(txt);
    }).filter(Boolean).slice(1);
    let category = '';
    if (parts.length) {
      const c = CATS.find(c => squash(c) === squash(parts[0]));
      const a = CAT_ALIAS[squash(parts[0])];
      if (c) { category = c; parts.shift(); } else if (a && CATS.includes(a)) { category = a; if (squash(parts[0]).startsWith(squash(a))) parts.shift(); } // „Kuchen“ bleibt als Stichwort, „Suppen“ nicht
    }
    return { category, tags: parts };
  }
  // Kästen (Tipp, Hinweis, Backform …): erste Zeile ist die Überschrift
  function boxText(ls) {
    if (!ls.length) return '';
    const [hd, ...rest] = ls;
    if (!rest.length) return marked(joinSegs([hd]));
    const body = marked(joinSegs(rest));
    return /^tipp/i.test(hd.text) ? body : `${UPPER(hd.text) ? titleCase(hd.text) : hd.text}: ${body}`;
  }
  function splitBoxes(ls) {
    const out = [];
    ls.forEach((l, i) => { if (!i || l.y - ls[i - 1].y > l.h * 2.4) out.push([]); out[out.length - 1].push(l); });
    return out;
  }
  function stepFrom(segs) {
    const txt = plain(segs);
    const dot = txt.indexOf('·');
    if (dot > 0 && dot <= 50) {
      // Kurztitel bis zum „·“, Rest als Beschreibung
      let n = 0; const rest = [];
      for (const sg of segs) {
        if (n > dot) { rest.push(sg); continue; }
        const k = sg.s.indexOf('·');
        if (k >= 0 && n + sg.s.length > dot) rest.push({ ...sg, s: sg.s.slice(k + 1) });
        n += sg.s.length;
      }
      return { t: txt.slice(0, dot).trim(), x: marked(rest) };
    }
    return { t: '', x: marked(segs) };
  }

  function parseCard({ items }, opt = {}) {
    const CATS = opt.cats || [];
    let all = lines(items, false);
    // „Meine Notizen“ am Kartenende abschneiden
    const notes = all.find(l => /^(MEINE)?NOTIZEN$/.test(squash(l.text)));
    if (notes) { items = items.filter(it => it.y < notes.y - 2); all = lines(items, false); }
    const runs = all.flatMap(l => l.runs);
    const find = word => runs.find(r => squash(r.text) === word) || null;

    const labelLine = all.slice(0, 3).find(l => /REZEPTKARTE/.test(squash(l.text)));
    let hZ = find('ZUTATEN'), hS = find('ZUBEREITUNG');
    if (!hZ || !hS || hS.x <= hZ.x || Math.abs(hZ.y - hS.y) > hZ.h) hZ = hS = null;
    if (!hZ && !labelLine) return null;

    // Kopfzeilen bis zur Merkmalszeile (MENGE, ZEIT, …: nur Großbuchstaben, darunter die Werte)
    const yLimit = hZ ? Math.min(hZ.y, hS.y) : Infinity;
    const top = all.filter(l => l !== labelLine && l.y < yLimit);
    const maxH = Math.max(0, ...top.slice(0, 4).map(l => l.h));
    const metaLine = top.find(l => UPPER(l.text) && l.h < maxH * 0.6 && top.some(v => v.y > l.y && v.y - l.y < l.h * 3.2 && !UPPER(v.text)));
    const yMeta = metaLine ? metaLine.y : yLimit;
    const head = top.filter(l => l.y < yMeta - 2);
    const tLines = head.filter(l => l.h >= maxH * 0.8);
    const title = plain(joinSegs(tLines));
    const subtitle = plain(joinSegs(head.filter(l => l.h < maxH * 0.8 && l.y > (tLines[0]?.y ?? 0))));
    if (!title) return null;

    const meta = [];
    let yAfterMeta = yMeta;
    if (metaLine) {
      const vals = [];
      for (const v of all) {
        if (v.y <= metaLine.y + 1 || v.y >= yLimit - 2) continue;
        const prev = vals[vals.length - 1];
        if (prev ? v.y - prev.y < prev.h * 1.8 : v.y - metaLine.y < metaLine.h * 3.2) vals.push(v); else break;
      }
      metaLine.runs.forEach((r, i) => {
        const nx = metaLine.runs[i + 1]?.x ?? Infinity;
        const v = plain(joinSegs(lines(vals.flatMap(l => l.items).filter(it => it.x >= r.x - 4 && it.x < nx - 4), false)));
        meta.push({ k: squash(r.text), label: titleCase(r.text), v: v === '–' ? '' : v });
      });
      if (vals.length) yAfterMeta = vals[vals.length - 1].y;
    }
    const pick = re => meta.find(m => !m.used && re.test(m.k) && (m.used = true));
    const servings = pick(/^(MENGE|ERGIBT|PORTIONEN?|STÜCK|FÜR)$/)?.v || '';
    let cookware = pick(/^(KOCHGESCHIRR|GESCHIRR|FORM|BACKFORM)$/)?.v || '';
    let minutes = null;
    const total = pick(/^(GESAMTZEIT|ZEIT|DAUER)$/);
    if (total) minutes = toMinutes(total.v);
    else {
      const parts = meta.filter(m => !m.used && /ZEIT|DAUER|GARE|RUHE|KOCHEN|MARINIER|VORBEREITUNG|ZUBEREITUNG/.test(m.k));
      const sum = parts.filter(m => !/optional/i.test(m.v)).map(m => toMinutes(m.v)).filter(Boolean);
      if (sum.length) minutes = sum.reduce((a, b) => a + b, 0);
      if (parts.length === 1 && sum.length) parts[0].used = true;
    }
    const extra = {};
    const dietOf = v => (opt.diets || []).find(d => d.toLowerCase() === v.toLowerCase());
    for (const m of meta) {
      if (m.used || !m.v) continue;
      if (/^(ERNÄHRUNG|KÜCHE|ART)$/.test(m.k) && dietOf(m.v)) { extra.diet = dietOf(m.v); m.used = true; }
      else if (m.k === 'KÜCHE') { extra.cuisine = m.v; m.used = true; }
      else if (m.k === 'SCHWIERIGKEIT' && (opt.diffs || []).includes(m.v.toLowerCase())) { extra.difficulty = m.v.toLowerCase(); m.used = true; }
    }
    const metaNotes = meta.filter(m => !m.used && m.v).map(m => `${m.label}: ${m.v}`);

    const { category, tags } = parseLabel(labelLine ? labelText(lines(labelLine.items, false)[0]) : '', CATS, opt.tags || []);
    const ingredients = [], steps = [], boxes = [];

    if (hZ) {
      const yBody = Math.min(hZ.y, hS.y), xR = hS.x;
      const body = all.filter(l => l.y > yBody + 2);
      // Kasten über die ganze Breite unten (z. B. „Tipps & Tricks“)
      const cross = body.find(l => l.runs.some(r => r.x < xR - 6 && r.x2 > xR + 6));
      let yFull = Infinity;
      if (cross) {
        const prev = body.filter(l => l.y < cross.y && l.x < xR - 6).pop();
        yFull = prev && cross.y - prev.y < cross.h * 2.2 && prev.text.length < 40 ? prev.y : cross.y;
        boxes.push(boxText(lines(items.filter(it => it.y >= yFull - 1), false)));
      }
      const inBody = it => it.y > yBody + 2 && it.y < yFull - 1;

      // Linke Spalte: Zutaten (Menge | Zutat), Zwischenüberschriften, danach eingerückte Kästen
      const left = lines(items.filter(it => inBody(it) && it.x < xR - 6), false);
      const second = left.filter(l => l.runs.length > 1).map(l => l.runs[1].x).sort((a, b) => a - b);
      const nameX = second.length ? second[second.length >> 1] : hZ.x + 1e4;
      const boxAt = left.findIndex(l => l.x > hZ.x + 5 && l.x < nameX - 10);
      const ingL = boxAt < 0 ? left : left.slice(0, boxAt);
      if (boxAt >= 0) for (const b of splitBoxes(left.slice(boxAt)).reverse()) {
        // Kasten „Backform“ o. ä. wird zum Kochgeschirr
        if (!cookware && b.length > 1 && /^(BACKFORM|FORM|KOCHGESCHIRR|GESCHIRR)$/.test(squash(b[0].text))) cookware = plain(joinSegs(b.slice(1)));
        else boxes.unshift(boxText(b));
      }
      let lastY = -1e9, cur = null;
      for (const l of ingL) {
        // Zwischenüberschrift („SUPPENBASIS“, „ZUM ABSCHMECKEN“), darf in die Zutatenspalte ragen
        if (l.runs.length === 1 && UPPER(l.text) && l.text.length > 2 && !/\d/.test(l.text) && l.x < nameX - 3) { ingredients.push({ a: '', n: l.text }); cur = null; lastY = l.y; continue; }
        const part = f => plain(lines(l.items.filter(f), false).flatMap(x => x.segs));
        const a = part(it => it.x < nameX - 3), n = part(it => it.x >= nameX - 3);
        if (!n && UPPER(a) && a.length > 2 && !/\d/.test(a)) { ingredients.push({ a: '', n: a }); cur = null; lastY = l.y; continue; }
        if (cur && l.y - lastY < l.h * 1.7) { if (a) cur.a = (cur.a + ' ' + a).trim(); if (n) cur.n = (cur.n + ' ' + n).trim(); }
        else { cur = { a, n }; ingredients.push(cur); }
        lastY = l.y;
      }
      // Leerzeichen zwischen Zahl und Einheit sicherstellen („220g“ → „220 g“)
      for (const i of ingredients) i.a = i.a.replace(/(\d)([a-zA-ZäöüÄÖÜ])/g, '$1 $2');

      // Rechte Spalte: nummerierte Schritte, danach evtl. ein Kasten („Tipp“, „Das Besondere“)
      const right = lines(items.filter(it => inBody(it) && it.x >= xR - 20), false);
      const isNum = l => l.runs.length > 1 && /^\d{1,2}\.?$/.test(l.runs[0].text);
      const tx = right.filter(isNum).map(l => l.runs[1].x).sort((a, b) => a - b);
      const textX = tx.length ? tx[tx.length >> 1] : xR;
      let st = null, box = null;
      for (const l of right) {
        if (isNum(l)) { st = []; steps.push(st); st.push({ segs: l.runs.slice(1).flatMap((r, i) => i ? [{ s: ' ', b: false }, ...r.segs] : r.segs) }); continue; }
        if (!box && st && l.x < textX - 8) { box = []; }
        if (box) box.push(l); else if (st) st.push(l); else { st = [l]; steps.push(st); }
      }
      if (box) boxes.push(boxText(box));
    } else {
      // Freies Layout ohne „Zutaten/Zubereitung“: nummerierte Blöcke werden Schritte, der Rest Hinweise
      const body = all.filter(l => l.y > yAfterMeta + 2);
      const bodyH = Math.min(...body.map(l => l.h));
      const big = body.filter(l => l.h > bodyH * 1.5 && l.runs.length === 1);
      const nums = body.flatMap(l => l.runs.map((r, i) => ({ r, l, i }))).filter(({ r, l, i }) => /^\d{1,2}\.?$/.test(r.text) && l.runs[i + 1] && l.runs[i + 1].x - r.x2 < r.h * 3);
      const cols = [...new Set(nums.map(n => Math.round(n.r.x / 40)))].map(k => nums.filter(n => Math.round(n.r.x / 40) === k)[0].r.x).sort((a, b) => a - b);
      const colOf = x => cols.filter(c => c <= x + 25).length - 1;
      const used = new Set(nums.flatMap(n => n.r.items));
      const blocks = nums.sort((a, b) => +a.r.text.replace('.', '') - +b.r.text.replace('.', '')).map(n => {
        const c = colOf(n.r.x), x0 = cols[c] - 25, x1 = cols[c + 1] != null ? cols[c + 1] - 25 : Infinity;
        const below = nums.filter(m => colOf(m.r.x) === c && m.r.y > n.r.y + 1).map(m => m.r.y);
        const yEnd = below.length ? Math.min(...below) - 2 : Infinity;
        const its = items.filter(it => it.y > n.r.y - n.r.h * 0.6 && it.y < yEnd && it.x >= x0 && it.x < x1 && !n.r.items.includes(it));
        its.forEach(it => used.add(it));
        return lines(its, false);
      });
      for (const ls of blocks) {
        if (!ls.length) continue;
        const [hd, ...rest] = ls;
        steps.push(rest.length ? [{ segs: [{ s: hd.text, b: false }, { s: ' · ', b: false }] }, ...rest] : [hd]);
      }
      const restL = lines(items.filter(it => it.y > yAfterMeta + 2 && !used.has(it) && !big.some(b => b.items.includes(it))), false);
      for (const b of splitBoxes(restL)) boxes.push(boxText(b));
      if (!steps.length) return null;
    }

    const outSteps = steps.map(st => stepFrom(joinSegs(st))).filter(s => s.x);
    const tip = [...boxes, ...metaNotes].filter(Boolean).join(' · ');
    const ings = ingredients.filter(i => i.n);
    if (!ings.length && !outSteps.length) return null;
    return { title, subtitle, category, tags, servings, minutes, cookware, ingredients: ings, steps: outSteps, tip, ...extra };
  }

  // ---------- Merkmale schätzen, die nicht auf der Karte stehen ----------
  const MEAT = /hähnchen|huhn|hühnchen|pute|rind|schwein|bacon|speck|schinken|salami|chorizo|hackfleisch|hack\b|wurst|würstchen|lamm|kalb|ente|gans|wild|reh|hirsch|steak|gulasch|frikadelle|leberkäse|prosciutto|pancetta|hühnerbrühe|rinderbrühe|fleischbrühe/i;
  const FISH = /lachs|thunfisch|forelle|kabeljau|dorsch|seelachs|zander|garnele|shrimp|scampi|krabbe|muschel|tintenfisch|sardelle|sardine|hering|makrele|fisch/i;
  const ANIMAL = /(?<!kokos|hafer|soja|mandel|reis|dinkel|cashew)milch|sahne|butter|käse|parmesan|mozzarella|quark|joghurt|ei\b|eier|eigelb|eiweiß|honig|schmand|crème|creme|mascarpone|ricotta|feta|gelatine|pecorino|latte\b|burrata|ghee|cheese/i;
  const MAIN = [['Pasta', /pasta|nudel|spaghetti|penne|rigatoni|tagliatelle|fusilli|farfalle|lasagne|gnocchi|maultasche|spätzle/i], ['Reis', /reis|risotto/i], ['Kartoffeln', /kartoffel/i], ['Kürbis', /kürbis/i], ['Hülsenfrüchte', /linse|kichererbse|bohne/i], ['Hähnchen', /hähnchen|huhn|hühnchen|pute/i], ['Rind', /rind|hackfleisch|steak/i], ['Schwein', /schwein|bacon|speck|schinken|wurst/i], ['Fisch', FISH], ['Eier', /\beier?\b/i], ['Käse', /käse/i]];
  function guess(r) {
    const ing = (r.ingredients || []).map(i => i.n).join(' · ');
    const hay = r.title + ' · ' + ing;
    const diet = MEAT.test(hay) ? 'mit Fleisch' : FISH.test(hay) ? 'mit Fisch' : (r.ingredients || []).length ? (ANIMAL.test(ing) ? 'vegetarisch' : 'vegan') : '';
    let mainIngredient = (MAIN.find(([, re]) => re.test(r.title)) || MAIN.find(([, re]) => re.test(ing)) || [''])[0];
    if (/Gebäck|Dessert|Getränk/.test(r.category || '')) mainIngredient = '';
    if (!mainIngredient && r.category === 'Pasta') mainIngredient = 'Pasta';
    const cw = (r.cookware || '') + ' ' + r.title;
    const icon = /gebäck|dessert/i.test(r.category) || /kuchen|torte|muffin|brownie|keks|plätzchen/i.test(cw) ? 'kuchen'
      : /pfanne|wok/i.test(cw) ? 'pfanne' : /blech|auflauf|ofen|form\b|gratin/i.test(cw) ? 'ofen' : /salat|schüssel|bowl/i.test(cw) || r.category === 'Salat' ? 'schuessel' : 'topf';
    return { diet, mainIngredient, icon };
  }
  // Farbe der Kopfzeile → nächste Kartenfarbe
  function nearestColor(rgb, colors) {
    let best = null, bd = Infinity;
    for (const [k, [hex]] of Object.entries(colors)) {
      const c = [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16));
      const d = c.reduce((s, v, i) => s + (v - rgb[i]) ** 2, 0);
      if (d < bd) { bd = d; best = k; }
    }
    return bd < 60 ** 2 ? best : null;
  }

  const api = { pack, unpack, pageItems, parseCard, guess, nearestColor };
  if (typeof module === 'object' && module.exports) module.exports = api; else g.NNZCard = api;
})(typeof window !== 'undefined' ? window : globalThis);
