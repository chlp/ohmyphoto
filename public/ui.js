import { createZipWriter } from './zip.js';

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

  // ---------------------------------------------------------------------------
  // Lightbox: buttons + keyboard (Esc, arrows) + horizontal swipe, counter, file name,
  // download link, neighbours preloaded. `items` = [{ name, fullSrc }].
  // ---------------------------------------------------------------------------
  let __lightboxIndex = -1;
  let __lightboxItems = [];
  let __lightboxReturnFocus = null;
  const __preloaded = new Set();

  const lbEl = () => document.getElementById('lightbox');
  const displayName = (name) => String(name || '').replace(/\.jpe?g$/i, '');

  function preloadImage(idx) {
    const it = __lightboxItems[idx];
    if (!it || !it.fullSrc || __preloaded.has(it.fullSrc)) return;
    __preloaded.add(it.fullSrc);
    const im = new Image();
    im.decoding = 'async';
    im.src = it.fullSrc;
  }

  function showLightboxIndex(i) {
    const it = __lightboxItems[i];
    const img = document.getElementById('lightbox-img');
    if (!it || !img) return;
    __lightboxIndex = i;
    img.src = it.fullSrc || '';
    img.alt = displayName(it.name);
    const counter = document.getElementById('lightbox-counter');
    if (counter) counter.textContent = `${i + 1} / ${__lightboxItems.length}`;
    const nameEl = document.getElementById('lightbox-name');
    if (nameEl) nameEl.textContent = it.name || '';
    const dl = document.getElementById('lightbox-download');
    if (dl) {
      dl.href = it.fullSrc || '#';
      dl.setAttribute('download', it.name || 'photo.jpg');
      dl.setAttribute('aria-label', `Download ${it.name || 'photo'}`);
    }
    const n = __lightboxItems.length;
    if (n > 1) {
      preloadImage((i + 1) % n);
      preloadImage((i - 1 + n) % n);
    }
  }

  function openLightboxByIndex(idx) {
    if (!Array.isArray(__lightboxItems) || __lightboxItems.length === 0) return;
    const i = Number(idx);
    if (!Number.isFinite(i) || i < 0 || i >= __lightboxItems.length) return;
    const lb = lbEl();
    if (!lb) return;
    __lightboxReturnFocus = document.activeElement;
    showLightboxIndex(i);
    lb.style.display = 'block';
    document.body.style.overflow = 'hidden';
    const closeBtn = document.getElementById('lightbox-close');
    if (closeBtn) closeBtn.focus({ preventScroll: true });
  }

  function closeLightbox() {
    const lb = lbEl();
    if (lb) lb.style.display = 'none';
    document.body.style.overflow = 'auto';
    __lightboxIndex = -1;
    const img = document.getElementById('lightbox-img');
    if (img) img.src = '';
    const f = __lightboxReturnFocus;
    __lightboxReturnFocus = null;
    if (f && typeof f.focus === 'function' && document.contains(f)) f.focus({ preventScroll: true });
  }

  function previousImage(e) {
    if (e && e.stopPropagation) e.stopPropagation();
    if (!__lightboxItems.length) return;
    showLightboxIndex((__lightboxIndex - 1 + __lightboxItems.length) % __lightboxItems.length);
  }

  function nextImage(e) {
    if (e && e.stopPropagation) e.stopPropagation();
    if (!__lightboxItems.length) return;
    showLightboxIndex((__lightboxIndex + 1) % __lightboxItems.length);
  }

  function isLightboxOpen() {
    const lb = lbEl();
    return Boolean(lb && lb.style.display === 'block');
  }

  /** Wire buttons, overlay click, keyboard and swipe once; safe to call before items exist. */
  function initLightbox() {
    const lb = lbEl();
    if (!lb || lb.dataset.wired === '1') return;
    lb.dataset.wired = '1';
    const closeBtn = document.getElementById('lightbox-close');
    const prevBtn = document.getElementById('lightbox-prev');
    const nextBtn = document.getElementById('lightbox-next');
    if (closeBtn) closeBtn.onclick = (e) => { e.stopPropagation(); closeLightbox(); };
    if (prevBtn) prevBtn.onclick = previousImage;
    if (nextBtn) nextBtn.onclick = nextImage;
    // close when clicking the backdrop or the empty area around the image (not the image/controls)
    lb.addEventListener('click', (e) => {
      const t = e.target;
      if (t === lb || (t && t.classList && t.classList.contains('lightbox-content'))) closeLightbox();
    });
    document.addEventListener('keydown', (e) => {
      if (!isLightboxOpen()) return;
      if (e.key === 'Escape') closeLightbox();
      else if (e.key === 'ArrowLeft') previousImage(e);
      else if (e.key === 'ArrowRight') nextImage(e);
      else if (e.key === 'Home') showLightboxIndex(0);
      else if (e.key === 'End') showLightboxIndex(__lightboxItems.length - 1);
    });
    // horizontal swipe (touch / pen / mouse drag); ignored while the user pinch-zooms (2 pointers)
    let swipe = null;
    let pointers = 0;
    lb.addEventListener('pointerdown', (e) => {
      pointers += 1;
      if (pointers > 1 || (e.target && e.target.closest && e.target.closest('button, a'))) { swipe = null; return; }
      swipe = { x: e.clientX, y: e.clientY, t: Date.now() };
    });
    const endPointer = (e) => {
      pointers = Math.max(0, pointers - 1);
      if (!swipe || e.type === 'pointercancel') { swipe = null; return; }
      const dx = e.clientX - swipe.x;
      const dy = e.clientY - swipe.y;
      const fast = Date.now() - swipe.t < 600;
      swipe = null;
      if (Math.abs(dx) < 48 || Math.abs(dx) < Math.abs(dy) * 1.5) return;
      if (!fast && Math.abs(dx) < 96) return;
      if (dx < 0) nextImage(); else previousImage();
    };
    lb.addEventListener('pointerup', endPointer);
    lb.addEventListener('pointercancel', endPointer);
  }

  // Kept on window for backwards compatibility with any external markup.
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


  // ---------------------------------------------------------------------------
  // Client-side "download all as ZIP".
  //
  // The Worker never builds archives (Workers Free: 10 ms CPU, 50 subrequests per request), so
  // the browser fetches every signed original and streams a STORE (no compression) ZIP either
  // straight to disk (File System Access API, Chromium) or into an in-memory Blob (fallback).
  // Whether the feature is available for an album is decided by the server (`data.zip`,
  // see src/utils/albumZip.js) and only displayed here.
  // ---------------------------------------------------------------------------

  function formatBytes(n) {
    const v = Number(n) || 0;
    if (v >= 1024 * 1024 * 1024) return `${(v / (1024 * 1024 * 1024)).toFixed(2)} GB`;
    if (v >= 1024 * 1024) return `${(v / (1024 * 1024)).toFixed(v >= 100 * 1024 * 1024 ? 0 : 1)} MB`;
    if (v >= 1024) return `${Math.round(v / 1024)} KB`;
    return `${v} B`;
  }

  /** Human-readable reason why the ZIP download is not offered for this album. */
  function zipUnavailableMessage(zip) {
    const z = zip || {};
    const files = `${z.fileCount} photo${z.fileCount === 1 ? '' : 's'}`;
    switch (z.reason) {
      case 'too_many_files':
        return `Download as ZIP is not available for this album: it has ${files}, and the archive download is limited to ${z.maxFiles} photos.`;
      case 'too_large':
        return `Download as ZIP is not available for this album: the originals total ${formatBytes(z.totalBytes)}, and the archive download is limited to ${formatBytes(z.maxBytes)}.`;
      case 'size_unknown':
        return 'Download as ZIP is not available for this album yet: photo sizes have not been recorded. Please ask the photographer to run "Verify files" for this album.';
      case 'disabled':
        return 'Download as ZIP is disabled on this site.';
      case 'empty':
        return 'There are no photos to download yet.';
      default:
        return 'Download as ZIP is not available for this album.';
    }
  }

  /**
   * Pick a sink for the archive: the File System Access API streams to disk (Chromium); otherwise
   * chunks are collected into a Blob and saved through a temporary <a download>.
   * Must be called from a user gesture (the save dialog requires it). Returns null if cancelled.
   */
  async function openZipSink(fileName) {
    if (typeof window.showSaveFilePicker === 'function') {
      let handle;
      try {
        handle = await window.showSaveFilePicker({
          suggestedName: fileName,
          types: [{ description: 'ZIP archive', accept: { 'application/zip': ['.zip'] } }]
        });
      } catch (err) {
        if (err && err.name === 'AbortError') return null; // user cancelled
        // Anything else (e.g. picker not allowed in this context): fall back to Blob below.
        handle = null;
      }
      if (handle) {
        const writable = await handle.createWritable();
        return {
          kind: 'file',
          write: (bytes) => writable.write(bytes),
          close: () => writable.close(),
          abort: () => writable.abort().catch(() => {})
        };
      }
    }
    const parts = [];
    return {
      kind: 'blob',
      write: (bytes) => { parts.push(bytes.slice()); },
      close: () => {
        const blob = new Blob(parts, { type: 'application/zip' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = fileName;
        document.body.appendChild(a);
        a.click();
        a.remove();
        setTimeout(() => URL.revokeObjectURL(url), 60000);
      },
      abort: () => { parts.length = 0; }
    };
  }

  async function fetchWithRetry429(url, signal) {
    for (let attempt = 0; ; attempt++) {
      const resp = await fetch(url, { signal, credentials: 'same-origin' });
      if (resp.status !== 429 || attempt >= 2) return resp;
      const retryAfter = Math.min(60, Math.max(1, Number(resp.headers.get('Retry-After')) || 5));
      __ompLog('zip: rate limited, waiting', { retryAfterS: retryAfter });
      await new Promise((resolve, reject) => {
        const t = setTimeout(resolve, retryAfter * 1000);
        signal.addEventListener('abort', () => { clearTimeout(t); reject(signal.reason || new Error('Aborted')); }, { once: true });
      });
    }
  }

  /**
   * Download every original of `files` into one ZIP.
   * @param {{ files: Array<{name: string, photoUrl: string}>, fileName: string, maxBytes: number,
   *           signal: AbortSignal, onProgress: (p: {done: number, total: number, bytes: number}) => void }} opts
   * @returns {Promise<{ cancelled: boolean, bytes: number }>}
   */
  async function downloadAlbumZip({ files, fileName, maxBytes, signal, onProgress }) {
    const sink = await openZipSink(fileName);
    if (!sink) return { cancelled: true, bytes: 0 };

    const zip = createZipWriter(sink);
    let bytes = 0;
    try {
      for (let i = 0; i < files.length; i++) {
        if (signal.aborted) throw signal.reason || new DOMException('Aborted', 'AbortError');
        const f = files[i];
        onProgress({ done: i, total: files.length, bytes });
        const resp = await fetchWithRetry429(f.photoUrl, signal);
        if (!resp.ok || !resp.body) throw new Error(`Could not download ${f.name} (HTTP ${resp.status})`);

        await zip.beginFile(f.name);
        const reader = resp.body.getReader();
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          bytes += value.length;
          if (maxBytes > 0 && bytes > maxBytes) {
            throw new Error(`The archive exceeded the ${formatBytes(maxBytes)} limit and was cancelled.`);
          }
          await zip.writeChunk(value);
          onProgress({ done: i, total: files.length, bytes });
        }
        await zip.endFile();
      }
      onProgress({ done: files.length, total: files.length, bytes });
      await zip.finish();
      await sink.close();
      return { cancelled: false, bytes };
    } catch (err) {
      await sink.abort();
      throw err;
    }
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

    // Visitors get a link like https://site/<album>#<code>; the form speaks in those terms.
    const makeAlbumAccessForm = ({ albumIdValue = '', secretValue = '' } = {}) => {
      const albumInput = el('input', {
        type: 'text', id: 'access-album',
        value: normalizeAlbumId(albumIdValue),
        placeholder: 'e.g. 2025.06.01-summer-lake',
        autocomplete: 'off', autocapitalize: 'none', spellcheck: 'false'
      });
      const secretInput = el('input', {
        type: 'text', id: 'access-code',
        value: normalizeSecret(secretValue),
        placeholder: 'the part of the link after #',
        autocomplete: 'off', autocapitalize: 'none', spellcheck: 'false'
      });
      const submitBtn = el('button', { type: 'submit', class: 'access-btn' }, 'Open album');
      return el(
        'form',
        {
          class: 'access-form',
          onsubmit: (e) => {
            e.preventDefault();
            navigateToAlbum(albumInput.value, secretInput.value);
          }
        },
        el('div', null, el('label', { for: 'access-album' }, 'Album (the part of the link after the site name)'), albumInput),
        el('div', null, el('label', { for: 'access-code' }, 'Access code'), secretInput),
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

    const toolbarEl = document.getElementById('toolbar');

    /**
     * "Download all as ZIP" button. The server decides availability (`zip.available` + `zip.reason`);
     * an unavailable button stays visible and explains why when clicked, so the visitor is never
     * left guessing where the download went.
     */
    const renderZipToolbar = ({ albumId: id, files: albumFiles, zip }) => {
      if (!toolbarEl) return;
      toolbarEl.textContent = '';
      toolbarEl.removeAttribute('data-visible');
      if (!zip || zip.reason === 'disabled' || zip.reason === 'empty' || !albumFiles.length) return;

      const label = zip.available
        ? `Download all as ZIP (${zip.fileCount} photo${zip.fileCount === 1 ? '' : 's'}, ${formatBytes(zip.totalBytes)})`
        : 'Download all as ZIP';
      const note = el('span', { class: 'album-note' });
      const btn = el('button', { type: 'button', class: 'album-btn', 'aria-disabled': zip.available ? null : 'true' }, label);
      const cancelBtn = el('button', { type: 'button', class: 'album-btn secondary', style: 'display:none;' }, 'Cancel');
      toolbarEl.append(btn, cancelBtn, note);
      toolbarEl.setAttribute('data-visible', '1');

      if (!zip.available) {
        note.className = 'album-note warn';
        note.textContent = zip.reason === 'too_many_files'
          ? `Not available: more than ${zip.maxFiles} photos`
          : zip.reason === 'too_large'
            ? `Not available: larger than ${formatBytes(zip.maxBytes)}`
            : 'Not available';
        btn.onclick = () => {
          note.textContent = zipUnavailableMessage(zip);
          __ompLog('zip: unavailable', zip);
        };
        return;
      }

      let controller = null;
      cancelBtn.onclick = () => { if (controller) controller.abort(new DOMException('Cancelled', 'AbortError')); };
      btn.onclick = async () => {
        if (controller) return; // already running
        controller = new AbortController();
        btn.setAttribute('aria-disabled', 'true');
        cancelBtn.style.display = '';
        note.className = 'album-note';
        note.textContent = 'Preparing archive…';
        const t0 = __ompNow();
        __ompLog('zip: start', { fileCount: albumFiles.length, totalBytes: zip.totalBytes });
        try {
          const r = await downloadAlbumZip({
            files: albumFiles.map((f) => ({ name: String(f.name || ''), photoUrl: String(f.photoUrl || '') })),
            fileName: `${id}.zip`,
            maxBytes: Number(zip.maxBytes) || 0,
            signal: controller.signal,
            onProgress: ({ done, total, bytes }) => {
              note.textContent = `Preparing archive… ${done} / ${total} photos, ${formatBytes(bytes)}`;
            }
          });
          if (r.cancelled) {
            note.textContent = '';
          } else {
            note.textContent = `Done: ${albumFiles.length} photos, ${formatBytes(r.bytes)}. Check your downloads.`;
            __ompLog('zip: done', { bytes: r.bytes, dtMs: Number((__ompNow() - t0).toFixed(1)) });
          }
        } catch (err) {
          if (err && err.name === 'AbortError') {
            note.textContent = 'Download cancelled.';
          } else {
            note.className = 'album-note warn';
            note.textContent = `Download failed: ${String((err && err.message) || err)}`;
            __ompLog('zip: failed', String((err && err.message) || err));
          }
        } finally {
          controller = null;
          btn.removeAttribute('aria-disabled');
          cancelBtn.style.display = 'none';
        }
      };
    };

    // Link to the current page including secret (hash), so user can copy/share it.
    if (logoLinkEl) {
      const selfHref = `${location.pathname}${location.search || ''}${location.hash || ''}`;
      logoLinkEl.setAttribute('href', selfHref || '#');
    }

    if (!albumId) {
      renderStatusCard({
        title: 'Open an album',
        message: 'Paste the link you received into the address bar, or enter its parts below.',
        content: makeAlbumAccessForm({ albumIdValue: '', secretValue: '' })
      });
      return;
    }
    if (!secret) {
      renderStatusCard({
        title: 'This link is incomplete',
        message: 'The access code (the part after # in your link) is missing. Open the full link you received, or enter the code below.',
        content: makeAlbumAccessForm({ albumIdValue: albumId, secretValue: '' })
      });
      return;
    }

    setStatusText('Loading...');

    // The inline <head> script may have already started the first (token-less) request.
    function takeEarlyAlbumFetch() {
      const p = window.__ohmyphotoAlbumFetch;
      const key = window.__ohmyphotoAlbumFetchKey;
      window.__ohmyphotoAlbumFetch = null;
      window.__ohmyphotoAlbumFetchKey = null;
      if (!p || typeof p.then !== 'function') return null;
      if (key !== `${albumId}#${secret}`) return null;
      return p;
    }

    async function fetchAlbumOnce(turnstileToken) {
      const url = `/api/album/${encodeURIComponent(albumId)}`;
      const t0 = __ompNow();
      const early = turnstileToken ? null : takeEarlyAlbumFetch();
      __ompLog(early ? 'album request -> reuse early fetch' : 'album request -> send', {
        url,
        albumId,
        hasTurnstileToken: Boolean(turnstileToken),
      });
      const controller = new AbortController();
      const timeoutMs = 15000;
      const timeout = setTimeout(() => controller.abort(new Error('Request timeout')), timeoutMs);
      try {
        const started = early || fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ secret, turnstileToken: String(turnstileToken || '') }),
          signal: controller.signal
        });
        const resp = await Promise.race([
          started,
          new Promise((_, reject) => controller.signal.addEventListener('abort', () => reject(controller.signal.reason || new Error('Request timeout'))))
        ]);
        __ompLog('album request <- response', {
          url,
          status: resp.status,
          ok: resp.ok,
          dtMs: Number((__ompNow() - t0).toFixed(1)),
          serverTiming: resp.headers.get('Server-Timing') || '',
          ompIndex: resp.headers.get('X-OhMyPhoto-Index') || '',
          ompFileCount: resp.headers.get('X-OhMyPhoto-FileCount') || '',
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
      // Tell the visitor why the wait is longer than usual instead of a silent "Loading...".
      setStatusText('Checking that you are not a robot, this takes a few seconds...');
      const token = await getTurnstileTokenOnce();
      setStatusText('Loading...');
      resp = await fetchAlbumOnce(token);
    }

    if (resp.status === 404) {
      renderStatusCard({
        title: 'We could not find this album',
        message: 'Check the link you received. If the album was renamed or removed, ask the photographer for a new link.',
        content: makeAlbumAccessForm({ albumIdValue: albumId, secretValue: secret })
      });
      return;
    }
    if (resp.status === 403) {
      renderStatusCard({
        title: 'This access code does not work',
        message: 'Make sure you opened the complete link (the code is the part after #). If the code was changed recently, ask the photographer for a new link.',
        content: makeAlbumAccessForm({ albumIdValue: albumId, secretValue: secret })
      });
      return;
    }
    if (resp.status === 429) {
      setStatusText('Too many requests from your network right now. Please wait a minute and reload the page.');
      return;
    }
    if (!resp.ok) {
      setStatusText(`Something went wrong (error ${resp.status}). Please try again in a moment.`);
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

    renderZipToolbar({ albumId, files, zip: data.zip });

    if (!gridEl) return;
    gridEl.innerHTML = '';

    __lightboxItems = files.map((f) => ({
      name: String(f.name || ''),
      fullSrc: String(f.photoUrl || '')
    }));

    initLightbox();

    const EAGER_IMAGES = 8;
    const HIGH_PRIORITY_IMAGES = 4;
    // A preview that fails (typically 429 from the per-IP image limit when many people share a
    // network, or a flaky connection) is retried a few times with a growing delay. The `r`
    // parameter is ignored by the signature and only makes the browser skip its failed-entry cache.
    const RETRY_DELAYS_MS = [2000, 6000, 15000];
    for (let i = 0; i < files.length; i++) {
      const f = files[i];
      const item = document.createElement('div');
      item.className = 'gallery-item';

      const img = document.createElement('img');
      // First screen: load eagerly with high priority; the rest lazily.
      img.loading = i < EAGER_IMAGES ? 'eager' : 'lazy';
      if (i < HIGH_PRIORITY_IMAGES) img.fetchPriority = 'high';
      img.decoding = 'async';
      img.alt = displayName(f.name);
      const src = String(f.previewUrl || f.photoUrl || '');
      img.src = src;
      img.dataset.index = String(i);
      let attempt = 0;
      img.onerror = () => {
        if (attempt >= RETRY_DELAYS_MS.length) return;
        const delay = RETRY_DELAYS_MS[attempt++];
        setTimeout(() => { img.src = `${src}&r=${attempt}`; }, delay);
      };
      img.onclick = () => openLightboxByIndex(i);

      item.appendChild(img);
      gridEl.appendChild(item);
    }
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


