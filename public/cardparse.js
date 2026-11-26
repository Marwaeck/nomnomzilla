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
      // Zeichen ohne Unicode-Zuordnung landen im Private-Use-Bereich;
      // bei Chrome-PDFs ist das einzeln stehend praktisch immer der Gedankenstrich „–“
      if (/^[\uE000-\uF8FF]$/.test(s) && it.width > h * 0.3 && it.width < h * 1.1) s = '–';
      s = s.replace(/[\uE000-\uF8FF]/g, '');
      if (!s.trim()) continue;
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
  function parseCard({ items }, opt = {}) {
    const CATS = opt.cats || [];
    const all = lines(items, false);
    const find = word => {
      for (const l of all) for (const r of l.runs) if (squash(r.text) === word) return r;
      return null;
    };
    const hZ = find('ZUTATEN'), hS = find('ZUBEREITUNG');
    if (!hZ || !hS || hS.x <= hZ.x) return null;
    const yBody = Math.min(hZ.y, hS.y);
    const xR = hS.x;

    // Kopf + Menge/Zeit/Kochgeschirr
    const metaL = ['MENGE', 'ZEIT', 'KOCHGESCHIRR'].map(find);
    const yMeta = Math.min(...metaL.filter(Boolean).map(m => m.y), yBody);
    const headIt = items.filter(it => it.y < yMeta - 4);
    const head = lines(headIt, false);
    let label = '';
    if (head.length && /REZEPTKARTE/.test(squash(head[0].text))) label = lines(head.shift().items, true)[0].text;
    const maxH = Math.max(0, ...head.map(l => l.h));
    const tLines = head.filter(l => l.h >= maxH * 0.8);
    const title = plain(joinSegs(tLines));
    const subtitle = plain(joinSegs(head.filter(l => l.h < maxH * 0.8 && l.y > (tLines[0]?.y ?? 0))));
    const meta = metaL.map((m, i) => {
      if (!m) return '';
      const nx = metaL.slice(i + 1).find(Boolean)?.x ?? Infinity;
      return plain(joinSegs(lines(items.filter(it => it.y > m.y + 1 && it.y < yBody - 4 && it.x >= m.x - 4 && it.x < nx - 4), false)));
    });

    // Etikett: REZEPTKARTE · KATEGORIE · STICHWORT
    let category = '', tags = [];
    // Gesperrte Schrift kommt je nach PDF-Erzeuger als „K I N D E R“ heraus: Leerzeichen dann entfernen
    // und über bekannte Kategorien/Stichworte die richtige Schreibweise (mit Leerzeichen) zurückholen.
    const known = [...CATS, ...(opt.tags || [])];
    const parts = label.split('·').map(p => {
      const tok = p.trim().split(/\s+/).filter(Boolean);
      const spaced = tok.length > 2 && tok.filter(t => t.length <= 2).length >= tok.length * 0.7;
      const txt = spaced ? tok.join('') : tok.join(' ');
      return known.find(k => squash(k) === squash(txt)) || titleCase(txt);
    }).filter(Boolean).slice(1);
    if (parts.length) {
      const c = CATS.find(c => squash(c) === squash(parts[0]));
      if (c) { category = c; parts.shift(); }
      tags = parts;
    }

    // Linke Spalte: Zutaten (Menge | Zutat) und Tipp
    const left = items.filter(it => it.y > yBody + 2 && it.x < xR - 6);
    const tipIt = lines(left, false).flatMap(l => l.runs).find(r => squash(r.text) === 'TIPP');
    const ingIt = left.filter(it => !tipIt || it.y < tipIt.y - 2);
    const tip = tipIt ? marked(joinSegs(lines(left.filter(it => it.y > tipIt.y + 2), false))) : '';
    const ingL = lines(ingIt, false);
    const second = ingL.filter(l => l.runs.length > 1).map(l => l.runs[1].x).sort((a, b) => a - b);
    const nameX = second.length ? second[second.length >> 1] : hZ.x + 1e4;
    const rows = [];
    let lastY = -1e9;
    for (const l of ingL) {
      const part = f => plain(l.runs.filter(f).flatMap(r => [{ s: ' ', b: false }, ...r.segs]));
      const a = part(r => r.x < nameX - 3), nT = part(r => r.x >= nameX - 3);
      const cont = rows.length && l.y - lastY < l.h * 1.7;
      if (cont) { const r = rows[rows.length - 1]; if (a) r.a = (r.a + ' ' + a).trim(); if (nT) r.n = (r.n + ' ' + nT).trim(); }
      else rows.push({ a, n: nT });
      lastY = l.y;
    }
    // Leerzeichen zwischen Zahl und Einheit sicherstellen („220g“ → „220 g“)
    const ingredients = rows.filter(r => r.n).map(r => ({ a: r.a.replace(/(\d)([a-zA-ZäöüÄÖÜ])/g, '$1 $2'), n: r.n }));

    // Rechte Spalte: nummerierte Schritte
    const right = items.filter(it => it.y > yBody + 2 && it.x >= xR - 20);
    const rl = lines(right, false);
    const steps = [];
    let cur = null;
    for (const l of rl) {
      const isNum = l.runs.length > 1 && /^\d{1,2}\.?$/.test(l.runs[0].text);
      const segs = isNum ? l.runs.slice(1).flatMap((r, i) => i ? [{ s: ' ', b: false }, ...r.segs] : r.segs) : l.segs;
      if (isNum || !cur) { cur = { lines: [] }; steps.push(cur); }
      cur.lines.push({ segs });
    }
    const outSteps = steps.map(st => {
      const segs = joinSegs(st.lines);
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
    }).filter(s => s.x);

    const min = meta[1] || '';
    let minutes = null;
    const hm = min.match(/(\d+(?:[.,]\d+)?)\s*(?:Std|h\b|Stunde)/i), mm = min.match(/(\d+)\s*(?:Min|m\b)/i);
    if (hm || mm) minutes = Math.round((hm ? parseFloat(hm[1].replace(',', '.')) * 60 : 0) + (mm ? +mm[1] : 0));
    else if (/\d+/.test(min)) minutes = +min.match(/\d+/)[0];

    if (!title || (!ingredients.length && !outSteps.length)) return null;
    return { title, subtitle, category, tags, servings: meta[0] && meta[0] !== '–' ? meta[0] : '', minutes, cookware: meta[2] && meta[2] !== '–' ? meta[2] : '', ingredients, steps: outSteps, tip };
  }

  // ---------- Merkmale schätzen, die nicht auf der Karte stehen ----------
  const MEAT = /hähnchen|huhn|hühnchen|pute|rind|schwein|bacon|speck|schinken|salami|chorizo|hackfleisch|hack\b|wurst|würstchen|lamm|kalb|ente|gans|wild|reh|hirsch|steak|gulasch|frikadelle|leberkäse|prosciutto|pancetta|hühnerbrühe|rinderbrühe|fleischbrühe/i;
  const FISH = /lachs|thunfisch|forelle|kabeljau|dorsch|seelachs|zander|garnele|shrimp|scampi|krabbe|muschel|tintenfisch|sardelle|sardine|hering|makrele|fisch/i;
  const ANIMAL = /(?<!kokos|hafer|soja|mandel|reis|dinkel|cashew)milch|sahne|butter|käse|parmesan|mozzarella|quark|joghurt|ei\b|eier|eigelb|eiweiß|honig|schmand|crème|creme|mascarpone|ricotta|feta|gelatine/i;
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
