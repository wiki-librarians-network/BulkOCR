/**
 * ws-ocr.js – BulkOCR for Malayalam Wikisource Index pages
 *
 * Author:  Manoj K (User:Manojk)
 *          Wiki Librarians Network, as part of the Grandham Project Initiative
 * Version: 1.0
 *
 * OCR every page of a Wikisource Index with Google OCR (Wikimedia OCR service),
 * strip watermarks, and save as "Not proofread" – semi-automatic review,
 * fully automatic, or dry run.
 *
 * Install: paste into Special:MyPage/common.js, or host it as User:Manojk/ws-ocr.js
 * and add to common.js:
 *   mw.loader.load('//ml.wikisource.org/w/index.php?title=User:Manojk/ws-ocr.js&action=raw&ctype=text/javascript');
 *
 * Pipeline (no clicking of editor widgets, everything goes through APIs):
 *   Index page → list Page: titles + quality (ProofreadPage API; fallback: file page count)
 *     → for each page: thumbnail URL of the scan page (imageinfo + iiurlparam=pageN-WIDTHpx)
 *     → Google OCR via ocr.wmcloud.org (same backend as the editor's OCR button)
 *     → watermark regexes
 *     → (semi mode: you review/edit) → save as level 1 "Not proofread".
 * Pages already Proofread / Validated / Problematic are never touched.
 */

(function () {
  'use strict';

  const mw = window.mw;
  if (!mw || !mw.config) return;
  const nsIds = mw.config.get('wgNamespaceIds') || {};
  const nsNames = mw.config.get('wgFormattedNamespaces') || {};
  // Find a namespace id by any of its names (canonical, local or alias)
  function nsIdByName(...names) {
    for (const n of names) {
      const k = n.toLowerCase().replace(/ /g, '_');
      if (nsIds[k] !== undefined) return nsIds[k];
    }
    for (const [id, name] of Object.entries(nsNames)) {
      if (names.includes(name)) return +id;
    }
    return undefined;
  }
  // ml.wikisource: Index/സൂചിക = 104, Page/താൾ = 106
  const INDEX_NS = nsIdByName('Index', 'സൂചിക') ?? 104;
  const PAGE_NS = nsIdByName('Page', 'താൾ') ?? 106;
  const isIndex = mw.config.get('wgCanonicalNamespace') === 'Index' ||
    (INDEX_NS !== undefined && mw.config.get('wgNamespaceNumber') === INDEX_NS) ||
    /^(സൂചിക|Index):/.test(mw.config.get('wgPageName'));
  if (!isIndex || mw.config.get('wgAction') !== 'view') return;
  console.log('[BulkOCR] loaded on Index page', { INDEX_NS, PAGE_NS });
  if (window.__wsOcrLoaded) return;
  window.__wsOcrLoaded = true;

  mw.loader.using(['mediawiki.api', 'mediawiki.util']).then(init);

  /* ───────────────────────── constants & settings ───────────────────────── */

  const OCR_API = 'https://ocr.wmcloud.org/api.php';
  const LS_SETTINGS = 'wsocr:settings';
  const LS_PROGRESS = 'wsocr:progress:' + mw.config.get('wgPageName');

  // Line-anchored where the text could legitimately appear in a book
  // (e.g. a mention of an award from Kerala Sahitya Akademi must survive).
  const DEFAULT_PATTERNS = [
    'Digitized\\s+[Bb]y\\s+Kerala\\s+Sahitya\\s+Akademi[^\\n]*',
    'Kerala\\s+Sahitya\\s+Akademi\\s+[Dd]igitized[^\\n]*',
    '[Dd]igitized\\s+[Bb]y\\s+KSA[^\\n]*',
    '^[Dd]igitized\\s+[Bb]y[^\\n]*\\n?',
    '^\\s*(Kerala\\s+)?Sahitya\\s+Akademi\\s*$',
    '^_+\\s*$'
  ].join('\n');

  const DEFAULTS = {
    mode: 'semi',          // semi | auto | dry
    policy: 'skip',        // skip = only missing pages; fill = missing + "without text"/"not proofread"
    langs: 'ml',
    width: 1920,
    delay: 4,              // seconds between pages in auto/dry mode
    summary: 'Created Using BulkOCR Tool #ocrmlwikisource',
    clean: true,
    patterns: DEFAULT_PATTERNS
  };

  let settings = loadSettings();
  function loadSettings() {
    try { return Object.assign({}, DEFAULTS, JSON.parse(localStorage.getItem(LS_SETTINGS) || '{}')); }
    catch (_) { return Object.assign({}, DEFAULTS); }
  }
  function saveSettings() {
    try { localStorage.setItem(LS_SETTINGS, JSON.stringify(settings)); } catch (_) {}
  }
  function loadProgress() {
    try { return +localStorage.getItem(LS_PROGRESS) || 0; } catch (_) { return 0; }
  }
  function saveProgress(n) {
    try { localStorage.setItem(LS_PROGRESS, String(n)); } catch (_) {}
  }

  /* ───────────────────────── state ───────────────────────── */

  let api, user, pageNsName;
  let pages = [];
  const state = {
    running: false, paused: false, stop: false,
    queue: [], cache: new Map(), results: [], clean: null,
    counts: { saved: 0, skipped: 0, blank: 0, errors: 0 }
  };
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const el = id => document.getElementById('bocr-' + id);

  /* ───────────────────────── page list ───────────────────────── */

  function parsePageTitle(title) {
    const rest = title.replace(/^[^:]+:/, '');
    const m = rest.match(/^(.+)\/(\d+)$/);
    return m ? { file: m[1], num: +m[2] } : { file: rest, num: null };
  }

  function toPage(p, i) {
    const { file, num } = parsePageTitle(p.title);
    const exists = !p.missing;
    let quality = null;
    if (exists) quality = (p.proofread && typeof p.proofread.quality === 'number') ? p.proofread.quality : 99;
    return { title: p.title, file, num, key: num ?? i + 1, exists, quality };
  }

  async function listViaIndex(indexTitle) {
    const out = [];
    let cont = {};
    do {
      const r = await api.get(Object.assign({
        action: 'query', generator: 'proofreadpagesinindex', gprppiititle: indexTitle,
        prop: 'proofread', formatversion: 2
      }, cont));
      (r.query?.pages || []).forEach(p => out.push(p));
      cont = r.continue || null;
    } while (cont);
    return out;
  }

  async function listViaFile(indexTitle) {
    const file = indexTitle.replace(/^[^:]+:/, '');
    const r = await api.get({ action: 'query', titles: 'File:' + file, prop: 'imageinfo', iiprop: 'size', formatversion: 2 });
    const count = r.query?.pages?.[0]?.imageinfo?.[0]?.pagecount;
    if (!count) throw new Error('Could not determine page count of File:' + file);
    const titles = Array.from({ length: count }, (_, i) => `${pageNsName}:${file}/${i + 1}`);
    const out = [];
    for (let i = 0; i < titles.length; i += 50) {
      const b = await api.get({ action: 'query', titles: titles.slice(i, i + 50).join('|'), prop: 'proofread', formatversion: 2 });
      (b.query?.pages || []).forEach(p => out.push(p));
    }
    return out;
  }

  async function loadPages() {
    const indexTitle = mw.config.get('wgPageName').replace(/_/g, ' ');
    let raw = [];
    try { raw = await listViaIndex(indexTitle); } catch (_) {}
    if (!raw.length) raw = await listViaFile(indexTitle);
    const list = raw.map(toPage);
    list.sort((a, b) => (a.num ?? 0) - (b.num ?? 0) || a.title.localeCompare(b.title));
    list.forEach((p, i) => { if (p.num === null) p.key = i + 1; });
    return list;
  }

  function needsWork(p, s) {
    if (!p.exists) return true;
    return s.policy === 'fill' && p.quality <= 1;
  }

  /* ───────────────────────── image + OCR ───────────────────────── */

  async function imageUrl(p, width) {
    const params = {
      action: 'query', titles: 'File:' + p.file, prop: 'imageinfo',
      iiprop: 'url', iiurlwidth: width, formatversion: 2
    };
    if (p.num) params.iiurlparam = `page${p.num}-${width}px`;
    const r = await api.get(params);
    const ii = r.query?.pages?.[0]?.imageinfo?.[0];
    const url = ii?.thumburl || ii?.url;
    if (!url) throw new Error('No image for ' + p.title);
    return url;
  }

  async function runOcr(url, s) {
    const q = new URLSearchParams({ engine: 'google', image: url });
    s.langs.split(/[\s,]+/).filter(Boolean).forEach(l => q.append('langs[]', l));
    let lastErr;
    for (let a = 0; a < 3; a++) {
      try {
        const r = await fetch(OCR_API + '?' + q.toString());
        if (!r.ok) throw new Error('OCR HTTP ' + r.status);
        const j = await r.json();
        if (j.error) throw new Error('OCR: ' + j.error);
        return j.text || '';
      } catch (e) {
        lastErr = e;
        await sleep(3000 * (a + 1));
      }
    }
    throw lastErr;
  }

  function buildCleaner(s) {
    const tidy = t => t.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
    if (!s.clean) return tidy;
    const res = s.patterns.split('\n').map(l => l.trim()).filter(Boolean).map(src => {
      try { return new RegExp(src, 'gm'); }
      catch (_) { log('Invalid pattern ignored: ' + src, 'warn'); return null; }
    }).filter(Boolean);
    return t => { let x = t; for (const re of res) x = x.replace(re, ''); return tidy(x); };
  }

  async function fetchOcr(p) {
    const url = await imageUrl(p, settings.width);
    const raw = await runOcr(url, settings);
    return { url, raw, text: state.clean(raw) };
  }

  // cached so the next page can be OCR'd while you review / while saving
  function getOcr(p) {
    if (!state.cache.has(p.title)) {
      const pr = fetchOcr(p);
      pr.catch(() => {});
      state.cache.set(p.title, pr);
    }
    return state.cache.get(p.title);
  }
  function prefetch(i) { if (state.queue[i]) getOcr(state.queue[i]); }

  /* ───────────────────────── saving ───────────────────────── */

  async function currentQuality(title) {
    const r = await api.get({ action: 'query', titles: title, prop: 'proofread', formatversion: 2 });
    const pg = r.query?.pages?.[0];
    if (!pg || pg.missing) return null;
    return typeof pg.proofread?.quality === 'number' ? pg.proofread.quality : 99;
  }

  // ProofreadPage status labels used in the edit summary, same as the editor adds
  const LEVEL_LABEL = { 0: 'എഴുത്ത് ഇല്ലാത്തവ' };

  // level 1 = Not proofread (OCR text); level 0 = Without text (blank page)
  async function savePage(p, body, s, level = 1) {
    if (p.exists) {
      const q = await currentQuality(p.title);
      if (q === null) p.exists = false;
      else if (q >= 2) return 'protected';
      else if (level === 0 && q === 0) return 'unchanged';
    }
    const text = `<noinclude><pagequality level="${level}" user="${user}" /></noinclude>${body}<noinclude></noinclude>`;
    const summary = LEVEL_LABEL[level] ? `/* ${LEVEL_LABEL[level]} */ ${s.summary}` : s.summary;
    const params = {
      action: 'edit', title: p.title, text, summary,
      assert: 'user', watchlist: 'nochange', formatversion: 2
    };
    if (p.exists) params.nocreate = 1; else params.createonly = 1;

    for (let a = 0; a < 4; a++) {
      try {
        await api.postWithEditToken(params);
        p.exists = true; p.quality = level;
        return 'saved';
      } catch (code) {
        if (code === 'articleexists') return 'exists';
        if (['ratelimited', 'maxlag', 'readonly', 'http'].includes(code)) {
          const wait = 30 * (a + 1);
          log(`${code} – waiting ${wait}s…`, 'warn');
          await sleep(wait * 1000);
          continue;
        }
        throw new Error('Save failed: ' + code);
      }
    }
    throw new Error('Save failed after retries');
  }

  /* ───────────────────────── semi-auto review ───────────────────────── */

  function review(p, res) {
    const box = el('review');
    box.hidden = false;
    el('rv-title').textContent = p.title;
    el('rv-title').href = mw.util.getUrl(p.title, { action: 'edit' });
    el('rv-img').src = res.url;
    el('rv-imglink').href = res.url;
    const ta = el('rv-text');
    ta.value = res.text;
    ta.focus();
    ta.setSelectionRange(0, 0);
    ta.scrollTop = 0;

    return new Promise(resolve => {
      const done = action => {
        ['rv-save', 'rv-skip', 'rv-reocr', 'rv-blank'].forEach(id => { el(id).onclick = null; });
        ta.onkeydown = null;
        box.hidden = true;
        resolve({ action, text: ta.value });
      };
      el('rv-save').onclick = () => done('save');
      el('rv-skip').onclick = () => done('skip');
      el('rv-reocr').onclick = () => done('reocr');
      el('rv-blank').onclick = () => { ta.value = ''; done('save'); };
      ta.onkeydown = e => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); done('save'); } };
      state.cancelReview = () => done('stop');
    });
  }

  /* ───────────────────────── main loop ───────────────────────── */

  async function waitIfPaused() {
    while (state.paused && !state.stop) await sleep(300);
  }

  async function start() {
    if (state.running) return;
    readForm();
    const s = settings;
    const from = +el('from').value || 1;
    const to = +el('to').value || Infinity;
    state.queue = pages.filter(p => p.key >= from && p.key <= to && needsWork(p, s));
    if (!state.queue.length) { log('Nothing to do in this range with the current page filter.', 'warn'); return; }

    Object.assign(state, { running: true, paused: false, stop: false, cache: new Map(), results: [] });
    state.counts = { saved: 0, skipped: 0, blank: 0, errors: 0 };
    state.clean = buildCleaner(s);
    el('download').hidden = true;
    syncButtons();
    log(`Started: ${state.queue.length} pages · ${s.mode} · google/${s.langs} · ${s.width}px`);

    let consecutiveErrors = 0;
    for (let i = 0; i < state.queue.length; i++) {
      await waitIfPaused();
      if (state.stop) break;
      const p = state.queue[i];
      setProgress(i, p);
      prefetch(i + 1);

      try {
        const res = await getOcr(p);
        let body = res.text;

        if (s.mode === 'semi') {
          const d = await review(p, res);
          if (d.action === 'stop') break;
          if (d.action === 'reocr') { state.cache.delete(p.title); i--; continue; }
          if (d.action === 'skip') { state.counts.skipped++; log('Skipped', 'muted', p); continue; }
          body = d.text.trim();
        }

        if (!body) {
          state.counts.blank++;
          if (s.mode === 'dry') {
            log('Blank page (would be saved as എഴുത്ത് ഇല്ലാത്തവ)', 'muted', p);
          } else {
            const r = await savePage(p, '', s, 0);
            if (r === 'saved') log('Blank – saved as എഴുത്ത് ഇല്ലാത്തവ (Without text)', 'ok', p);
            else log(r === 'unchanged' ? 'Blank – already എഴുത്ത് ഇല്ലാത്തവ' : r === 'exists' ? 'Created by someone else meanwhile – skipped' : 'Already proofread – skipped', 'muted', p);
          }
        } else if (s.mode === 'dry') {
          state.results.push({ title: p.title, page: p.key, text: body });
          log(`OCR ok (${body.length} chars)`, 'ok', p);
        } else {
          const r = await savePage(p, body, s);
          if (r === 'saved') { state.counts.saved++; log('Saved', 'ok', p); }
          else { state.counts.skipped++; log(r === 'exists' ? 'Created by someone else meanwhile – skipped' : 'Already proofread – skipped', 'muted', p); }
        }
        saveProgress(p.key);
        consecutiveErrors = 0;
      } catch (e) {
        state.cache.delete(p.title);
        state.counts.errors++;
        consecutiveErrors++;
        log(e.message || String(e), 'err', p);
        if (consecutiveErrors >= 3) {
          state.paused = true;
          syncButtons();
          log('3 errors in a row – paused. Check the log, then Resume or Stop.', 'warn');
        }
      }

      if (s.mode !== 'semi' && i < state.queue.length - 1) await sleep(s.delay * 1000);
    }
    finish();
  }

  function finish() {
    const c = state.counts;
    state.running = false;
    state.paused = false;
    el('review').hidden = true;
    setProgress(state.queue.length, null);
    log(`Finished – saved ${c.saved}, skipped ${c.skipped}, blank ${c.blank}, errors ${c.errors}`, 'ok');
    if (state.results.length) el('download').hidden = false;
    syncButtons();
    refreshPages();
  }

  function downloadResults() {
    const txt = state.results.map(r => `==== ${r.title} ====\n${r.text}\n`).join('\n');
    const blob = new Blob([txt], { type: 'text/plain;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = mw.config.get('wgTitle').replace(/[\\/:*?"<>|]/g, '_') + '-ocr.txt';
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  }

  /* ───────────────────────── UI ───────────────────────── */

  const CSS = `
#bocr{position:fixed;top:60px;right:14px;z-index:1000;width:440px;max-height:calc(100vh - 80px);overflow:auto;
  background:var(--background-color-base,#fff);color:var(--color-base,#202122);
  border:1px solid var(--border-color-base,#a2a9b1);border-radius:8px;box-shadow:0 6px 24px rgba(0,0,0,.25);
  font:13px/1.5 sans-serif;padding:12px 14px}
#bocr[hidden]{display:none}
#bocr .h{display:flex;justify-content:space-between;align-items:center;font-weight:700;font-size:15px;margin-bottom:6px}
#bocr .x{cursor:pointer;border:none;background:none;font-size:18px;color:inherit}
#bocr .g{display:grid;grid-template-columns:auto 1fr auto 1fr;gap:6px 8px;align-items:center;margin:8px 0}
#bocr .g .w{grid-column:2 / 5}
#bocr input,#bocr select,#bocr textarea{font:inherit;padding:3px 5px;border:1px solid var(--border-color-base,#a2a9b1);
  border-radius:4px;background:var(--background-color-base,#fff);color:inherit;box-sizing:border-box;width:100%}
#bocr textarea{font-family:inherit;resize:vertical}
#bocr .btns{display:flex;gap:6px;flex-wrap:wrap;margin:8px 0}
#bocr button.b{padding:5px 11px;border-radius:4px;border:1px solid var(--border-color-base,#a2a9b1);cursor:pointer;
  background:var(--background-color-interactive-subtle,#f8f9fa);color:inherit;font:inherit}
#bocr button.p{background:#36c;border-color:#36c;color:#fff}
#bocr button:disabled{opacity:.45;cursor:default}
#bocr .bar{height:6px;background:var(--background-color-neutral,#eaecf0);border-radius:3px;overflow:hidden}
#bocr .bar div{height:100%;width:0;background:#36c;transition:width .3s}
#bocr .muted{color:var(--color-subtle,#72777d)}
#bocr .rv img{width:100%;max-height:300px;object-fit:contain;object-position:top;border:1px solid var(--border-color-subtle,#c8ccd1);background:#fff}
#bocr .rv textarea{height:260px;margin-top:6px;font-size:15px;line-height:1.6}
#bocr .log{max-height:180px;overflow:auto;border-top:1px solid var(--border-color-subtle,#c8ccd1);margin-top:8px;padding-top:6px;font-size:12px}
#bocr .log .ok{color:#14866d}#bocr .log .err{color:#d33}#bocr .log .warn{color:#ac6600}
#bocr details{margin:6px 0}#bocr details textarea{height:110px;font-family:monospace;font-size:12px}
`;

  function buildPanel() {
    mw.util.addCSS(CSS);
    const d = document.createElement('div');
    d.id = 'bocr';
    d.hidden = true;
    d.innerHTML = `
<div class="h"><span>📄 BulkOCR</span><button class="x" id="bocr-close" title="Close">×</button></div>
<div id="bocr-summary" class="muted">Loading page list…</div>

<div class="g">
  <label>From</label><input id="bocr-from" type="number" min="1">
  <label>To</label><input id="bocr-to" type="number" min="1">
  <label>Mode</label>
  <select id="bocr-mode" class="w">
    <option value="semi">Semi-automatic – review each page before saving</option>
    <option value="auto">Fully automatic – OCR and save</option>
    <option value="dry">Dry run – OCR only, download as .txt</option>
  </select>
  <label>Pages</label>
  <select id="bocr-policy" class="w">
    <option value="skip">Only pages that don't exist yet</option>
    <option value="fill">Also overwrite "Without text" / "Not proofread"</option>
  </select>
  <label>Langs</label><input id="bocr-langs" class="w" title="Google OCR language hint, e.g. ml (comma-separated for more)">
  <label>Width</label>
  <select id="bocr-width"><option>960</option><option>1280</option><option>1920</option><option>3840</option></select>
  <label>Delay s</label><input id="bocr-delay" type="number" min="1" step="1" title="Pause between pages in automatic/dry mode">
  <label>Summary</label><input id="bocr-summary-in" class="w">
</div>

<details>
  <summary>Watermark removal</summary>
  <label><input id="bocr-clean" type="checkbox" style="width:auto"> Remove lines matching these regexes (one per line, flags gm)</label>
  <textarea id="bocr-pats"></textarea>
  <button class="b" id="bocr-pats-reset" type="button">Reset to defaults</button>
</details>

<div class="btns">
  <button class="b p" id="bocr-start">▶ Start</button>
  <button class="b" id="bocr-pause" disabled>⏸ Pause</button>
  <button class="b" id="bocr-stop" disabled>⏹ Stop</button>
  <button class="b" id="bocr-resume-last" title="Set From to the page after the last one done">↪ From last</button>
  <button class="b" id="bocr-download" hidden>⬇ Download text</button>
</div>

<div class="bar"><div id="bocr-bar"></div></div>
<div id="bocr-status" class="muted" style="margin-top:3px"></div>

<div id="bocr-review" class="rv" hidden>
  <div style="margin:8px 0 4px"><a id="bocr-rv-title" target="_blank"></a>
    · <a id="bocr-rv-imglink" target="_blank">full image</a></div>
  <img id="bocr-rv-img" alt="">
  <textarea id="bocr-rv-text" lang="ml"></textarea>
  <div class="btns">
    <button class="b p" id="bocr-rv-save" title="Ctrl+Enter">💾 Save &amp; next</button>
    <button class="b" id="bocr-rv-skip">Skip</button>
    <button class="b" id="bocr-rv-reocr">🔄 Re-OCR</button>
    <button class="b" id="bocr-rv-blank" title="Save as എഴുത്ത് ഇല്ലാത്തവ (Without text)">⬜ Blank page</button>
  </div>
</div>

<div class="log" id="bocr-log"></div>`;
    document.body.appendChild(d);

    writeForm();
    el('close').onclick = () => { d.hidden = true; };
    el('start').onclick = () => { if (state.paused) { state.paused = false; syncButtons(); } else start(); };
    el('pause').onclick = () => { state.paused = true; syncButtons(); log('Paused', 'warn'); };
    el('stop').onclick = () => {
      state.stop = true; state.paused = false;
      if (state.cancelReview) state.cancelReview();
      log('Stopping after current page…', 'warn');
    };
    el('resume-last').onclick = () => {
      const last = loadProgress();
      if (last) { el('from').value = last + 1; log('From set to ' + (last + 1)); }
      else log('No saved progress for this index yet.', 'muted');
    };
    el('download').onclick = downloadResults;
    el('pats-reset').onclick = () => { el('pats').value = DEFAULT_PATTERNS; };
    window.addEventListener('beforeunload', e => { if (state.running) { e.preventDefault(); e.returnValue = ''; } });
    return d;
  }

  function writeForm() {
    const s = settings;
    el('mode').value = s.mode; el('policy').value = s.policy;
    el('langs').value = s.langs; el('width').value = String(s.width); el('delay').value = s.delay;
    el('summary-in').value = s.summary; el('clean').checked = s.clean; el('pats').value = s.patterns;
  }

  function readForm() {
    settings = {
      mode: el('mode').value, policy: el('policy').value,
      langs: el('langs').value.trim() || 'ml', width: +el('width').value || 1920,
      delay: Math.max(1, +el('delay').value || 4), summary: el('summary-in').value.trim() || DEFAULTS.summary,
      clean: el('clean').checked, patterns: el('pats').value
    };
    saveSettings();
  }

  function syncButtons() {
    el('start').disabled = state.running && !state.paused;
    el('start').textContent = state.paused ? '▶ Resume' : '▶ Start';
    el('pause').disabled = !state.running || state.paused;
    el('stop').disabled = !state.running;
    ['from', 'to', 'mode', 'policy', 'langs', 'width', 'clean', 'pats'].forEach(id => { el(id).disabled = state.running; });
  }

  function setProgress(i, p) {
    const n = state.queue.length || 1;
    el('bar').style.width = Math.round((i / n) * 100) + '%';
    const c = state.counts;
    el('status').textContent = p
      ? `${i + 1} / ${n} · ${p.title.replace(/^[^:]+:/, '')} · saved ${c.saved} · skipped ${c.skipped} · errors ${c.errors}`
      : `Done · ${n} pages processed`;
  }

  function log(msg, cls, p) {
    const box = el('log');
    if (!box) return;
    const row = document.createElement('div');
    row.className = cls || '';
    const t = new Date().toLocaleTimeString();
    if (p) {
      const a = document.createElement('a');
      a.href = mw.util.getUrl(p.title);
      a.target = '_blank';
      a.textContent = p.key;
      row.append(`${t} · p.`, a, ` – ${msg}`);
    } else {
      row.textContent = `${t} · ${msg}`;
    }
    box.appendChild(row);
    box.scrollTop = box.scrollHeight;
  }

  function summarize() {
    const missing = pages.filter(p => !p.exists).length;
    const byQ = q => pages.filter(p => p.exists && p.quality === q).length;
    el('summary').innerHTML =
      `<b>${pages.length}</b> pages · <b>${missing}</b> not created · ` +
      `${byQ(0)} without text · ${byQ(1)} not proofread · ${byQ(3)} proofread · ${byQ(4)} validated · ${byQ(2)} problematic`;
    if (!el('from').value && pages.length) el('from').value = pages[0].key;
    if (!el('to').value && pages.length) el('to').value = pages[pages.length - 1].key;
  }

  async function refreshPages() {
    try { pages = await loadPages(); summarize(); }
    catch (e) { el('summary').textContent = 'Could not load pages: ' + (e.message || e); }
  }

  /* ───────────────────────── init ───────────────────────── */

  function init() {
    api = new mw.Api();
    user = mw.config.get('wgUserName');
    pageNsName = nsNames[PAGE_NS] || 'താൾ';
    if (!user) { console.log('[BulkOCR] not logged in – log in to use BulkOCR'); return; }

    const panel = buildPanel();
    let loaded = false;
    const toggle = e => {
      if (e) e.preventDefault();
      panel.hidden = !panel.hidden;
      if (!loaded) { loaded = true; refreshPages(); }
    };

    // 1. Button at the top of the page content (works in every skin)
    const bar = document.createElement('div');
    bar.style.cssText = 'margin:8px 0 12px';
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.textContent = '📄 BulkOCR – OCR this book';
    btn.style.cssText = 'padding:6px 14px;border-radius:4px;border:1px solid #36c;background:#36c;color:#fff;cursor:pointer;font-size:14px';
    btn.onclick = toggle;
    bar.appendChild(btn);
    const content = document.getElementById('mw-content-text') || document.getElementById('content') || document.body;
    content.insertBefore(bar, content.firstChild);

    // 2. Menu links: "More" (p-cactions) and Tools (p-tb), whichever the skin has
    ['p-cactions', 'p-tb'].forEach(portlet => {
      const li = mw.util.addPortletLink(portlet, '#', 'BulkOCR', 'ca-bulkocr-' + portlet, 'OCR all pages of this index');
      if (li) (li.querySelector('a') || li).addEventListener('click', toggle);
    });
  }
})();
