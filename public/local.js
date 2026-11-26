// Verbindet die Rezeptbuch-Oberfläche mit dem eigenen Server (statt claude.ai).
// Stellt dieselbe kleine Schnittstelle bereit, die die App erwartet: db, user, downloads, sample.
(() => {
  const j = async (method, url, body) => {
    const r = await fetch(url, { method, headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw { code: data.code || (r.status === 429 ? 'rate_limited' : 'http_' + r.status), message: data.message };
    return data;
  };
  const idOf = path => encodeURIComponent(String(path).split('/').pop());

  const db = {
    collection: () => ({
      add: async r => ({ id: (await j('POST', 'api/recipes', r)).id }),
      onSnapshot(cb, onErr) {
        let stop = false;
        const pull = async () => {
          try {
            const list = await j('GET', 'api/recipes');
            if (!stop) cb({ docs: list.map(x => ({ id: x.id, data: () => x })), metadata: { fromCache: false } });
          } catch (e) { onErr?.(e); }
        };
        pull();
        let es;
        try { es = new EventSource('api/events'); es.addEventListener('changed', pull); es.onopen = pull; } catch (_) {}
        // Rückfall, falls ein Proxy die Live-Verbindung blockiert
        const t = setInterval(() => { if (!es || es.readyState !== 1) pull(); }, 15000);
        document.addEventListener('visibilitychange', () => { if (!document.hidden) pull(); });
        return () => { stop = true; clearInterval(t); es?.close(); };
      }
    }),
    doc: path => ({
      set: r => j('PUT', 'api/recipes/' + idOf(path), r),
      update: r => j('PATCH', 'api/recipes/' + idOf(path), r),
      delete: () => j('DELETE', 'api/recipes/' + idOf(path))
    })
  };

  const user = {
    id: async () => { try { return localStorage.getItem('rb.name') || 'familie'; } catch (_) { return 'familie'; } },
    can: async () => true
  };

  const downloads = {
    save: async ({ filename, data }) => {
      const blob = data instanceof Blob ? data : new Blob([data], { type: /\.html$/.test(filename) ? 'text/html' : 'application/octet-stream' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob); a.download = filename;
      document.body.append(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 30000);
    }
  };

  const toDataUrl = b => new Promise((res, rej) => { const f = new FileReader(); f.onload = () => res(f.result); f.onerror = rej; f.readAsDataURL(b); });
  const sample = {
    json: async (prompt, opts = {}) => {
      const images = await Promise.all((opts.images || []).map(i => typeof i === 'string' ? i : toDataUrl(i)));
      return j('POST', 'api/ai', { prompt, images });
    },
    limits: async () => ({ images: true })
  };

  const cfg = fetch('api/config').then(r => r.json()).catch(() => ({ ai: false }));
  window.claude = {
    use: async name => {
      if (name === 'db') return db;
      if (name === 'user') return user;
      if (name === 'downloads') return downloads;
      if (name === 'sample') { if ((await cfg).ai) return sample; throw { code: 'sampling_disabled' }; }
      throw { code: 'not_declared' };
    }
  };
})();
