(() => {
  'use strict';

  // Config injected by HTML template (`src/client/index.template.html`)
  const TURNSTILE_SITE_KEY = String(window.__turnstileSiteKey || '');

  // Simple perf logger (relative to earliest point we can anchor to)
  const __ompStart = (typeof window.__ohmyphotoStart === 'number' && Number.isFinite(window.__ohmyphotoStart))
    ? window.__ohmyphotoStart
    : performance.now();
  const __ompNow = () => performance.now();
  function __ompLog(label, extra) {
    const delta = (__ompNow() - __ompStart).toFixed(1);
    if (extra !== undefined) console.log(`[ohmyphoto +${delta}ms] ${label}`, extra);
    else console.log(`[ohmyphoto +${delta}ms] ${label}`);
  }

  __ompLog('ui.js executed', { readyState: document.readyState });

  function getAlbumIdFromPath() {
    // expect /<albumId>
    const parts = location.pathname.split('/').filter(Boolean);
    return parts[0] || '';
  }

  // Lightbox state
  let __lightboxIndex = -1;
  let __lightboxItems = []; // { name, fullSrc }

  function openLightboxByIndex(idx) {
    if (!Array.isArray(__lightboxItems) || __lightboxItems.length === 0) return;
    const i = Number(idx);
    if (!Number.isFinite(i) || i < 0 || i >= __lightboxItems.length) return;
    __lightboxIndex = i;
    const lb = document.getElementById('lightbox');
    const img = document.getElementById('lightbox-img');
    if (!lb || !img) return;
    img.src = __lightboxItems[__lightboxIndex].fullSrc || '';
    lb.style.display = 'block';
    document.body.style.overflow = 'hidden';
  }

  function closeLightbox() {
    const lb = document.getElementById('lightbox');
    if (lb) lb.style.display = 'none';
    document.body.style.overflow = 'auto';
    __lightboxIndex = -1;
    const img = document.getElementById('lightbox-img');
    if (img) img.src = '';
  }

  function previousImage(e) {
    if (e && e.stopPropagation) e.stopPropagation();
    if (!__lightboxItems.length) return;
    __lightboxIndex = (__lightboxIndex - 1 + __lightboxItems.length) % __lightboxItems.length;
    const img = document.getElementById('lightbox-img');
    if (img) img.src = __lightboxItems[__lightboxIndex].fullSrc || '';
  }

  function nextImage(e) {
    if (e && e.stopPropagation) e.stopPropagation();
    if (!__lightboxItems.length) return;
    __lightboxIndex = (__lightboxIndex + 1) % __lightboxItems.length;
    const img = document.getElementById('lightbox-img');
    if (img) img.src = __lightboxItems[__lightboxIndex].fullSrc || '';
  }

  // Expose for onclick handlers in HTML
  window.closeLightbox = closeLightbox;
  window.previousImage = previousImage;
  window.nextImage = nextImage;

  function renderFallbackStatus(message) {
    const statusEl = document.getElementById('status');
    if (!statusEl) return;
    statusEl.textContent = '';
    const card = document.createElement('div');
    card.className = 'status-card';
    const p = document.createElement('p');
    p.textContent = String(message || '');
    card.appendChild(p);
    statusEl.appendChild(card);
  }

  async function main() {
    const albumId = getAlbumIdFromPath();
    const secret = (location.hash || '').replace(/^#/, '');

    __ompLog('main() start', { albumId, hasSecret: Boolean(secret) });

    const logoLinkEl = document.getElementById('logoLink');
    const titleEl = document.getElementById('title');
    const statusEl = document.getElementById('status');
    const gridEl = document.getElementById('grid');

    const AUTO_REFRESH_MS = 5 * 60 * 1000;
    let __autoRefreshTimeout = null;

    const clearAutoRefresh = () => {
      if (__autoRefreshTimeout) clearTimeout(__autoRefreshTimeout);
      __autoRefreshTimeout = null;
    };

    const clearStatus = () => {
      clearAutoRefresh();
      if (statusEl) statusEl.textContent = '';
    };

    const el = (tag, attrs, ...children) => {
      const node = document.createElement(tag);
      if (attrs && typeof attrs === 'object') {
        for (const [k, v] of Object.entries(attrs)) {
          if (v == null) continue;
          if (k === 'class') node.className = String(v);
          else if (k === 'style') node.setAttribute('style', String(v));
          else if (k.startsWith('on') && typeof v === 'function') node[k] = v;
          else node.setAttribute(k, String(v));
        }
      }
      for (const c of children.flat()) {
        if (c == null) continue;
        node.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
      }
      return node;
    };

    const normalizeAlbumId = (raw) => String(raw || '').trim().replace(/^\/+|\/+$/g, '');
    const normalizeSecret = (raw) => String(raw || '').trim().replace(/^#/, '');

    const navigateToAlbum = (albumIdRaw, secretRaw) => {
      const id = normalizeAlbumId(albumIdRaw);
      const sec = normalizeSecret(secretRaw);
      if (!id) return;
      const safePath = `/${encodeURIComponent(id)}`;
      // If we're staying on the same album path and only changing the hash,
      // the browser won't reload the document. We need a reload to retry with the new secret.
      if (location.pathname === safePath) {
        const cur = normalizeSecret((location.hash || '').replace(/^#/, ''));
        if (cur === sec) return;
        if (sec) location.hash = `#${sec}`;
        else location.hash = '';
        location.reload();
        return;
      }

      location.href = sec ? `${safePath}#${sec}` : safePath;
    };

    const renderStatusCard = ({ title, message, content } = {}) => {
      clearStatus();
      if (!statusEl) return;
      const t = String(title || '').trim();
      const m = String(message || '').trim();
      const contentNodes = Array.isArray(content) ? content : (content ? [content] : []);
      if (!t && !m && contentNodes.length === 0) return;

      const card = document.createElement('div');
      card.className = 'status-card';

      if (t) {
        const h = document.createElement('h1');
        h.textContent = t;
        card.appendChild(h);
      }
      if (m) {
        const p = document.createElement('p');
        p.textContent = m;
        card.appendChild(p);
      }
      for (const n of contentNodes) {
        if (!n) continue;
        card.appendChild(n);
      }

      statusEl.appendChild(card);
    };

    const setStatusText = (message) => renderStatusCard({ message });

    const makeAlbumAccessForm = ({ albumIdValue = '', secretValue = '' } = {}) => {
      const albumInput = el('input', {
        type: 'text',
        value: normalizeAlbumId(albumIdValue),
        placeholder: 'albumId',
        autocomplete: 'off',
        style: 'width:100%;padding:10px 12px;border:1px solid rgba(0,0,0,.15);border-radius:10px;'
      });
      const secretInput = el('input', {
        type: 'text',
        value: normalizeSecret(secretValue),
        placeholder: 'secret',
        autocomplete: 'off',
        style: 'width:100%;padding:10px 12px;border:1px solid rgba(0,0,0,.15);border-radius:10px;'
      });

      const submitBtn = el(
        'button',
        {
          type: 'submit',
          style: 'margin-top:12px;appearance:none;border:1px solid rgba(0,0,0,.12);border-radius:10px;padding:10px 14px;font-weight:600;cursor:pointer;background:#2c3e50;color:#fff;'
        },
        'Open album'
      );

      return el(
        'form',
        {
          onsubmit: (e) => {
            e.preventDefault();
            navigateToAlbum(albumInput.value, secretInput.value);
          },
          style: 'margin-top:12px;display:grid;gap:10px;max-width:520px;'
        },
        el('div', null, albumInput),
        el('div', null, secretInput),
        submitBtn
      );
    };

    const setEmptyAlbumStatus = () => {
      renderStatusCard({
        title: 'Album is empty for now',
        message: 'This is the correct link — photos haven’t been uploaded here yet'
      });
      // Auto refresh every 5 minutes (only while album is empty).
      __autoRefreshTimeout = setTimeout(() => location.reload(), AUTO_REFRESH_MS);
    };

    // Link to the current page including secret (hash), so user can copy/share it.
    if (logoLinkEl) {
      const selfHref = `${location.pathname}${location.search || ''}${location.hash || ''}`;
      logoLinkEl.setAttribute('href', selfHref || '#');
    }

    if (!albumId) {
      renderStatusCard({
        title: 'Open an album',
        message: 'Enter albumId and secret to continue',
        content: makeAlbumAccessForm({ albumIdValue: '', secretValue: '' })
      });
      return;
    }
    if (!secret) {
      renderStatusCard({
        title: 'Secret is missing',
        message: 'Enter secret to continue',
        content: makeAlbumAccessForm({ albumIdValue: albumId, secretValue: '' })
      });
      return;
    }

    setStatusText('Loading...');

    async function fetchAlbumOnce(turnstileToken) {
      const url = `/api/album/${encodeURIComponent(albumId)}`;
      const t0 = __ompNow();
      __ompLog('album request -> send', {
        url,
        albumId,
        hasTurnstileToken: Boolean(turnstileToken),
      });
      const controller = new AbortController();
      const timeoutMs = 15000;
      const timeout = setTimeout(() => controller.abort(new Error('Request timeout')), timeoutMs);
      try {
        const resp = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ secret, turnstileToken: String(turnstileToken || '') }),
          signal: controller.signal
        });
        __ompLog('album request <- response', {
          url,
          status: resp.status,
          ok: resp.ok,
          dtMs: Number((__ompNow() - t0).toFixed(1)),
        });
        return resp;
      } finally {
        clearTimeout(timeout);
      }
    }

    async function getTurnstileTokenOnce() {
      if (!TURNSTILE_SITE_KEY || TURNSTILE_SITE_KEY === 'YOUR_TURNSTILE_SITE_KEY') return '';
      try {
        __ompLog('turnstile: start');
        // Wait for Turnstile script to load (poll with timeout)
        await new Promise((resolve) => {
          const startedAt = Date.now();
          const tick = () => {
            if (typeof turnstile !== 'undefined') return resolve();
            if (Date.now() - startedAt > 3000) return resolve(); // 3s timeout
            setTimeout(tick, 50);
          };
          tick();
        });

        if (typeof turnstile === 'undefined') {
          __ompLog('turnstile: script not ready (timeout)');
          return '';
        }

        __ompLog('turnstile: script ready');

        const modal = document.getElementById('turnstile-modal');

        // 1) Try invisible/offscreen first (no UI)
        __ompLog('turnstile: invisible execute -> start');
        const invisibleToken = await new Promise((resolve) => {
          let resolved = false;
          const overallTimeout = setTimeout(() => {
            if (resolved) return;
            resolved = true;
            __ompLog('turnstile: invisible execute -> timeout');
            resolve('');
          }, 2000);

          const widgetId = turnstile.render('#turnstile-widget-invisible', {
            sitekey: TURNSTILE_SITE_KEY,
            callback: (t) => {
              if (resolved) return;
              resolved = true;
              clearTimeout(overallTimeout);
              __ompLog('turnstile: invisible -> passed');
              resolve(t);
            },
            'error-callback': () => {
              if (resolved) return;
              resolved = true;
              clearTimeout(overallTimeout);
              __ompLog('turnstile: invisible -> error');
              resolve('');
            },
            size: 'invisible',
            execution: 'execute',
            appearance: 'interaction-only',
          });

          try { turnstile.reset(widgetId); } catch {}
          try { turnstile.execute(widgetId); } catch { __ompLog('turnstile: invisible execute -> exception'); resolve(''); }
        });
        if (invisibleToken) return invisibleToken;

        // 2) Fall back to interactive modal
        __ompLog('turnstile: modal -> show');
        if (modal) modal.style.display = 'flex';
        const visibleToken = await new Promise((resolve) => {
          let resolved = false;
          const timeout = setTimeout(() => {
            if (resolved) return;
            resolved = true;
            __ompLog('turnstile: modal -> timeout');
            resolve('');
          }, 20000);

          const widgetId = turnstile.render('#turnstile-widget-visible', {
            sitekey: TURNSTILE_SITE_KEY,
            callback: (t) => {
              if (resolved) return;
              resolved = true;
              clearTimeout(timeout);
              __ompLog('turnstile: modal -> passed');
              resolve(t);
            },
            'error-callback': () => {
              if (resolved) return;
              resolved = true;
              clearTimeout(timeout);
              __ompLog('turnstile: modal -> error');
              resolve('');
            },
            size: 'compact',
          });

          try { turnstile.reset(widgetId); } catch {}
        });
        __ompLog('turnstile: modal -> hide');
        if (modal) modal.style.display = 'none';
        return visibleToken || '';
      } catch {
        const modal = document.getElementById('turnstile-modal');
        if (modal) modal.style.display = 'none';
        __ompLog('turnstile: exception');
        return '';
      }
    }

    // Fast path: try without Turnstile. If server requires it, we'll get 403 and retry once.
    let resp = await fetchAlbumOnce('');
    if (resp.status === 403) {
      const token = await getTurnstileTokenOnce();
      resp = await fetchAlbumOnce(token);
    }

    if (resp.status === 404) {
      renderStatusCard({
        title: 'Album not found',
        message: 'Please enter a correct albumId and secret',
        content: makeAlbumAccessForm({ albumIdValue: albumId, secretValue: secret })
      });
      return;
    }
    if (resp.status === 403) {
      renderStatusCard({
        title: 'Access denied',
        message: 'Access denied. Please enter a new secret',
        content: makeAlbumAccessForm({ albumIdValue: albumId, secretValue: secret })
      });
      return;
    }
    if (!resp.ok) {
      setStatusText(`Error: ${resp.status}`);
      return;
    }

    const data = await resp.json();
    const files = Array.isArray(data.files) ? data.files : [];

    const baseTitle = 'OhMyPhoto';
    const albumTitle = data.title || baseTitle;

    if (titleEl) titleEl.textContent = albumTitle;
    document.title = albumTitle === baseTitle ? baseTitle : `${albumTitle} | ${baseTitle}`;

    if (files.length) {
      clearStatus();
    } else {
      setEmptyAlbumStatus();
    }

    if (!gridEl) return;
    gridEl.innerHTML = '';

    __lightboxItems = files.map((f) => ({
      name: String(f.name || ''),
      fullSrc: String(f.photoUrl || '')
    }));

    for (let i = 0; i < files.length; i++) {
      const f = files[i];
      const item = document.createElement('div');
      item.className = 'gallery-item';

      const img = document.createElement('img');
      img.loading = 'lazy';
      img.alt = 'Photography';
      img.src = String(f.previewUrl || f.photoUrl || '');
      img.dataset.index = String(i);
      img.onclick = () => openLightboxByIndex(i);

      item.appendChild(img);
      gridEl.appendChild(item);
    }

    // Lightbox close behavior
    const lb = document.getElementById('lightbox');
    if (lb) {
      lb.onclick = (e) => {
        // close when clicking overlay/background (not when clicking image/nav)
        if (e && e.target === lb) closeLightbox();
      };
    }

    document.addEventListener('keydown', (e) => {
      const lb = document.getElementById('lightbox');
      if (!lb || lb.style.display !== 'block') return;
      if (e.key === 'Escape') closeLightbox();
      else if (e.key === 'ArrowLeft') previousImage(e);
      else if (e.key === 'ArrowRight') nextImage(e);
    });
  }

  const run = () => {
    main().catch((err) => {
      const msg = (err && err.name === 'AbortError')
        ? 'Request timed out. Try again.'
        : String(err && (err.stack || err.message || err));
      renderFallbackStatus(msg);
    });
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => {
      __ompLog('DOMContentLoaded -> run()');
      run();
    });
  } else {
    __ompLog('readyState != loading -> run()');
    run();
  }
})();


