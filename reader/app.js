/* O le Tusi a Mamona — Interlinear (web reader / PWA)
 *
 * A browser port of the SwiftUI reader. Chapter data is fetched one file at a
 * time from docs/data/ch/, so the initial paint doesn't wait on the whole
 * corpus; the service worker separately precaches all of it for offline use.
 *
 * Routing is hash-based because GitHub Pages serves static files only and can't
 * rewrite deep paths to index.html.
 */
(() => {
  'use strict';

  const BASE = new URL('.', location.href).href;
  const $ = (id) => document.getElementById(id);

  const view = $('view');
  const state = {
    index: null,
    diacritics: null,
    chapterCache: new Map(),
    settings: loadSettings(),
    highlights: loadJSON('bom.highlights', {}),
  };

  // ---------------------------------------------------------------- settings

  function loadJSON(key, fallback) {
    try {
      return JSON.parse(localStorage.getItem(key)) ?? fallback;
    } catch {
      return fallback;
    }
  }

  function loadSettings() {
    const s = loadJSON('bom.settings', {});
    return {
      scale: typeof s.scale === 'number' ? s.scale : 1,
      diacritics: !!s.diacritics,
      gloss: s.gloss !== false,
    };
  }

  function saveSettings() {
    localStorage.setItem('bom.settings', JSON.stringify(state.settings));
    applySettings();
  }

  function applySettings() {
    document.documentElement.style.setProperty('--scale', state.settings.scale);
    document.body.classList.toggle('no-gloss', !state.settings.gloss);
    $('font-scale').value = state.settings.scale;
    $('toggle-diacritics').checked = state.settings.diacritics;
    $('toggle-gloss').checked = state.settings.gloss;
  }

  // ------------------------------------------------------------------ diacritics

  /* Ports ScriptureLibrary.splitAffixes: the glottal ’ and hyphen count as
     intra-word, so `a’u,` splits to ("", "a’u", ","). */
  const WORD_CHAR = /[\p{L}\p{N}’-]/u;

  function splitAffixes(token) {
    const chars = [...token];
    let first = -1;
    let last = -1;
    chars.forEach((ch, i) => {
      if (WORD_CHAR.test(ch)) {
        if (first === -1) first = i;
        last = i;
      }
    });
    if (first === -1) return ['', '', token];
    return [
      chars.slice(0, first).join(''),
      chars.slice(first, last + 1).join(''),
      chars.slice(last + 1).join(''),
    ];
  }

  function matchCapitalization(original, marked) {
    const head = [...original][0];
    if (!head || head !== head.toUpperCase() || head === head.toLowerCase()) return marked;
    return marked.charAt(0).toUpperCase() + marked.slice(1);
  }

  function markedSamoan(token, wordKey) {
    const d = state.diacritics;
    if (!d) return token;
    const [prefix, core, suffix] = splitAffixes(token);
    if (!core) return token;
    const replacement =
      (wordKey && d.exceptions[wordKey]) || d.types[core.toLowerCase()];
    if (!replacement) return token;
    return prefix + matchCapitalization(core, replacement) + suffix;
  }

  function displaySm(token, wordKey) {
    return state.settings.diacritics ? markedSamoan(token, wordKey) : token;
  }

  // ------------------------------------------------------------------ grouping

  /* Direct port of groupIdiomSpans in WordUnitView.swift. A `·` gloss means
     "this word's English continues into the next word", so a run of dots plus
     the following real gloss renders as one cell. */
  function groupIdiomSpans(words) {
    const out = [];
    let i = 0;
    while (i < words.length) {
      if (words[i].en === '·') {
        let end = i;
        while (end < words.length && words[end].en === '·') end += 1;
        if (end < words.length) {
          out.push({
            index: i,
            sm: words.slice(i, end + 1).map((w) => w.sm),
            en: words[end].en,
          });
          i = end + 1;
          continue;
        }
      }
      out.push({ index: i, sm: [words[i].sm], en: words[i].en });
      i += 1;
    }
    return out;
  }

  // ------------------------------------------------------------------- data

  async function getJSON(path) {
    const res = await fetch(new URL(path, BASE));
    if (!res.ok) throw new Error(`${res.status} ${path}`);
    return res.json();
  }

  async function getChapter(bookId, num) {
    const key = `${bookId}-${num}`;
    if (!state.chapterCache.has(key)) {
      state.chapterCache.set(key, getJSON(`data/ch/${key}.json`));
    }
    return state.chapterCache.get(key);
  }

  const bookById = (id) => state.index.books.find((b) => b.id === id);

  // ----------------------------------------------------------------- render

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text != null) node.textContent = text;
    return node;
  }

  function renderUnit(item, verseKey) {
    const wordKey = `${verseKey}|${item.index}`;
    const unit = el('span', 'unit');
    unit.dataset.key = wordKey;

    const sm = el('span', 'sm');
    sm.textContent = item.sm
      .map((word, offset) => displaySm(word, `${verseKey}|${item.index + offset}`))
      .join(' ');
    unit.append(sm);

    if (item.en) unit.append(el('span', 'en', item.en));
    if (state.highlights[wordKey]) unit.classList.add('hl');

    unit.addEventListener('click', () => {
      if (state.highlights[wordKey]) delete state.highlights[wordKey];
      else state.highlights[wordKey] = 1;
      unit.classList.toggle('hl');
      localStorage.setItem('bom.highlights', JSON.stringify(state.highlights));
    });
    return unit;
  }

  function renderVerse(verse, bookId, num) {
    const verseKey = `${bookId}|${num}|${verse.n}`;
    const row = el('div', 'verse');
    row.append(el('span', 'verse-num', String(verse.n)));
    for (const item of groupIdiomSpans(verse.w)) row.append(renderUnit(item, verseKey));
    return row;
  }

  /* Headings and colophons carry their own interlinear word arrays, so they
     render through the same pipeline as verses — just without a verse number. */
  function renderBlock(block, className, keyPrefix) {
    const wrap = el('div', className);
    const line = el('div', 'verse');
    line.style.borderBottom = 'none';
    for (const item of groupIdiomSpans(block.words || [])) {
      line.append(renderUnit(item, keyPrefix));
    }
    wrap.append(line);
    if (block.en) wrap.append(el('p', 'en', block.en));
    return wrap;
  }

  /* The notice required by the Standard Scripture License Agreement, in the same
     three registers the app's landing page uses: the verbatim English (the
     wording the license prescribes), the official Samoan, and a word-by-word
     interlinear. The strings come from data/index.json, which build_web_data.py
     lifts straight out of BookListView.swift so the two can't diverge. */
  function disclaimer() {
    const source = state.index && state.index.disclaimer;
    const wrap = el('div', 'disclaimer');
    if (!source) return wrap;

    wrap.append(el('p', 'disclaimer-en', source.english));
    wrap.append(el('div', 'hairline'));
    wrap.append(el('p', 'disclaimer-sm', source.samoan));
    wrap.append(el('div', 'hairline'));

    const flow = el('div', 'disclaimer-gloss');
    for (const [sm, en] of source.gloss) {
      const cell = el('span', 'gloss-cell');
      cell.append(el('span', 'sm', sm));
      cell.append(el('span', 'en', en));
      flow.append(cell);
    }
    wrap.append(flow);
    return wrap;
  }

  /* The navy cover plate from BookListView.BookCover — tapping it opens the
     library, exactly as in the app. */
  function bookCover() {
    const titles = [
      ['O LE TUSI', 'The Book'],
      ['A MAMONA', 'of Mormon'],
    ];
    const subtitles = [
      ['O se tasi molimau', 'Another testimony'],
      ['a Iesu Keriso', 'of Jesus Christ'],
    ];

    const cover = el('button', 'cover');
    cover.setAttribute('aria-label', 'Tatala le tusi');
    cover.append(el('div', 'cover-rule'));

    const title = el('div', 'cover-title');
    for (const [sm, en] of titles) {
      const cell = el('div', 'cover-cell');
      cell.append(el('span', 'sm', sm));
      cell.append(el('span', 'en', en));
      title.append(cell);
    }
    cover.append(title);

    const sub = el('div', 'cover-sub');
    for (const [sm, en] of subtitles) {
      const cell = el('div', 'cover-cell');
      cell.append(el('span', 'sm', sm));
      cell.append(el('span', 'en', en));
      sub.append(cell);
    }
    cover.append(sub);
    cover.append(el('div', 'cover-rule'));

    cover.addEventListener('click', () => toggleDrawer(true));
    return cover;
  }

  /* Resumes at the furthest chapter reached, or the first chapter if the reader
     hasn't started. Mirrors ContinueReadingButton. */
  function continueButton() {
    const last = localStorage.getItem('bom.last');
    const match = last && last.match(/^#\/b\/([^/]+)\/(\d+)/);
    let bookId = state.index.books[0].id;
    let num = state.index.books[0].chapters[0];
    if (match && bookById(match[1])) {
      bookId = match[1];
      num = Number(match[2]);
    }

    const btn = el('button', 'continue');
    btn.append(el('span', 'continue-kicker', "Fa’aauau le Faitau · Continue reading from"));
    btn.append(el('span', 'continue-ref', `${bookById(bookId).nameEn} ${num}`));
    btn.addEventListener('click', () => {
      location.hash = `#/b/${bookId}/${num}`;
    });
    return btn;
  }

  async function showChapter(bookId, num) {
    const book = bookById(bookId);
    if (!book) return showHome();

    view.replaceChildren(el('p', 'loading', 'O loo utaina…'));
    let chapter;
    try {
      chapter = await getChapter(bookId, num);
    } catch {
      view.replaceChildren(el('p', 'loading', 'Le mafai ona maua le mataupu.'));
      return;
    }

    $('title').textContent = `${book.nameSm} ${num}`;
    document.title = `${book.nameSm} ${num} — O le Tusi a Mamona`;

    const frag = document.createDocumentFragment();
    frag.append(el('h2', 'book-title', book.nameSm));
    frag.append(el('p', 'chapter-num', `Mataupu ${num}`));

    if (chapter.colophon) {
      frag.append(renderBlock(chapter.colophon, 'colophon', `${bookId}|${num}|colophon`));
    }
    if (chapter.heading) {
      frag.append(renderBlock(chapter.heading, 'heading', `${bookId}|${num}|heading`));
    }
    for (const verse of chapter.verses) frag.append(renderVerse(verse, bookId, num));

    view.replaceChildren(frag);
    window.scrollTo(0, 0);
    updatePager(book, num);
    localStorage.setItem('bom.last', `#/b/${bookId}/${num}`);
  }

  async function showFront(id) {
    view.replaceChildren(el('p', 'loading', 'O loo utaina…'));
    let section;
    try {
      section = await getJSON(`data/front/${id}.json`);
    } catch {
      return showHome();
    }
    $('title').textContent = section.titleSm;
    document.title = `${section.titleSm} — O le Tusi a Mamona`;

    const frag = document.createDocumentFragment();
    frag.append(el('h2', 'book-title', section.titleSm));
    frag.append(el('div', 'front-body', section.sm || ''));
    if (section.en) frag.append(el('div', 'front-body en', section.en));
    view.replaceChildren(frag);
    window.scrollTo(0, 0);
    $('pager').hidden = true;
  }

  /* Matches BookListView: the cover is the way in, a continue-reading button
     under it, and the license notice below. No book list here — that lives in
     the library drawer, as it does in the app. */
  function showHome() {
    $('title').textContent = 'O le Tusi a Mamona';
    document.title = 'O le Tusi a Mamona — Interlinear';
    $('pager').hidden = true;

    const frag = document.createDocumentFragment();
    const home = el('div', 'home');
    home.append(bookCover());
    home.append(continueButton());
    home.append(disclaimer());
    frag.append(home);
    view.replaceChildren(frag);
    window.scrollTo(0, 0);
  }

  // ----------------------------------------------------------------- pager

  function flatChapters() {
    const out = [];
    for (const book of state.index.books) {
      for (const num of book.chapters) out.push({ id: book.id, num });
    }
    return out;
  }

  function updatePager(book, num) {
    const all = flatChapters();
    const at = all.findIndex((c) => c.id === book.id && c.num === num);
    const prev = all[at - 1];
    const next = all[at + 1];

    $('pager').hidden = false;
    $('pager-label').textContent = `${book.nameSm} ${num}`;
    $('btn-prev').disabled = !prev;
    $('btn-next').disabled = !next;
    $('btn-prev').onclick = () => prev && (location.hash = `#/b/${prev.id}/${prev.num}`);
    $('btn-next').onclick = () => next && (location.hash = `#/b/${next.id}/${next.num}`);
  }

  // ----------------------------------------------------------------- drawer

  function buildDrawer() {
    const body = $('drawer-body');
    body.replaceChildren();

    for (const section of state.index.frontmatter) {
      const btn = el('button', 'drawer-book', section.titleSm);
      btn.addEventListener('click', () => {
        location.hash = `#/front/${section.id}`;
        toggleDrawer(false);
      });
      body.append(btn);
    }

    for (const book of state.index.books) {
      const group = el('div', 'drawer-body-group');
      const btn = el('button', 'drawer-book');
      btn.append(document.createTextNode(book.nameSm));
      btn.append(document.createElement('br'));
      btn.append(el('span', 'en', book.nameEn));

      const grid = el('div', 'chapter-grid');
      grid.hidden = true;
      for (const num of book.chapters) {
        const chip = el('button', 'chapter-chip', String(num));
        chip.addEventListener('click', () => {
          location.hash = `#/b/${book.id}/${num}`;
          toggleDrawer(false);
        });
        grid.append(chip);
      }
      btn.addEventListener('click', () => {
        grid.hidden = !grid.hidden;
      });
      group.append(btn, grid);
      body.append(group);
    }
  }

  function toggleDrawer(open) {
    $('drawer').hidden = !open;
    $('drawer-scrim').hidden = !open;
  }

  // ----------------------------------------------------------------- search

  /* Searches every chapter file. After the service worker's precache completes
     these all come from the cache, so it stays fast and works offline; before
     that it streams over the network with a progress line. */
  let searchToken = 0;

  async function runSearch(query) {
    const token = ++searchToken;
    const needle = query.trim().toLowerCase();
    const results = $('search-results');
    const note = $('search-note');
    results.replaceChildren();
    if (needle.length < 2) {
      note.textContent = "Sa'ili i upu Samoa ma fa'aliliuga fa'aPeretania.";
      return;
    }

    const all = flatChapters();
    let hits = 0;
    let scanned = 0;

    for (const { id, num } of all) {
      if (token !== searchToken) return;
      let chapter;
      try {
        chapter = await getChapter(id, num);
      } catch {
        continue;
      }
      scanned += 1;
      if (scanned % 10 === 0) {
        note.textContent = `O loo su'e… ${scanned}/${all.length} — ${hits} maua`;
      }

      for (const verse of chapter.verses) {
        const sm = verse.w.map((w) => w.sm).join(' ');
        const en = verse.w.map((w) => w.en).filter((g) => g && g !== '·').join(' ');
        if (!sm.toLowerCase().includes(needle) && !en.toLowerCase().includes(needle)) {
          continue;
        }
        hits += 1;
        results.append(searchResult(id, num, verse, sm, needle));
        if (hits >= 200) {
          note.textContent = `200+ maua — fa'apitoa lau su'esu'ega.`;
          return;
        }
      }
    }
    if (token === searchToken) {
      note.textContent = hits ? `${hits} maua` : 'Leai se mea na maua.';
    }
  }

  function searchResult(bookId, num, verse, sm, needle) {
    const book = bookById(bookId);
    const btn = el('button', 'result');
    btn.append(el('span', 'ref', `${book.nameSm} ${num}:${verse.n}`));

    const snip = el('span', 'snip');
    const at = sm.toLowerCase().indexOf(needle);
    if (at === -1) {
      snip.textContent = sm.slice(0, 120);
    } else {
      const from = Math.max(0, at - 40);
      snip.append(document.createTextNode((from ? '…' : '') + sm.slice(from, at)));
      const mark = document.createElement('mark');
      mark.textContent = sm.slice(at, at + needle.length);
      snip.append(mark);
      snip.append(document.createTextNode(sm.slice(at + needle.length, at + needle.length + 60) + '…'));
    }
    btn.append(snip);
    btn.addEventListener('click', () => {
      $('search').hidden = true;
      location.hash = `#/b/${bookId}/${num}`;
    });
    return btn;
  }

  // ------------------------------------------------------------------ router

  function route() {
    const hash = location.hash || '#/';
    const chapter = hash.match(/^#\/b\/([^/]+)\/(\d+)/);
    const front = hash.match(/^#\/front\/(.+)/);
    $('btn-back').hidden = hash === '#/';

    if (chapter) return showChapter(chapter[1], Number(chapter[2]));
    if (front) return showFront(decodeURIComponent(front[1]));
    return showHome();
  }

  // ------------------------------------------------------------- offline SW

  function registerServiceWorker() {
    const stateEl = $('offline-state');
    const noteEl = $('offline-note');
    if (!('serviceWorker' in navigator)) {
      stateEl.textContent = 'N/A';
      noteEl.textContent = 'Offline storage needs a browser with service workers.';
      return;
    }

    navigator.serviceWorker
      .register(new URL('sw.js', BASE))
      .then(() => {
        stateEl.textContent = 'O loo utaina…';
        noteEl.textContent =
          'Downloading all 239 chapters for offline reading. Keep this tab open until it finishes — about 10 MB.';
      })
      .catch(() => {
        stateEl.textContent = 'Failed';
        noteEl.textContent = 'Service worker registration failed.';
      });

    navigator.serviceWorker.addEventListener('message', (event) => {
      const data = event.data || {};
      if (data.type === 'precache-progress') {
        stateEl.textContent = `${data.done}/${data.total}`;
      } else if (data.type === 'precache-done') {
        stateEl.textContent = 'Ua sauni';
        noteEl.textContent =
          'All chapters are stored on this device. The reader now works with no connection.';
      }
    });
  }

  // -------------------------------------------------------------------- init

  function wireUI() {
    $('btn-library').addEventListener('click', () => toggleDrawer(true));
    $('drawer-scrim').addEventListener('click', () => toggleDrawer(false));
    $('btn-back').addEventListener('click', () => {
      location.hash = '#/';
    });

    $('btn-settings').addEventListener('click', () => {
      $('settings').hidden = false;
    });
    $('btn-settings-close').addEventListener('click', () => {
      $('settings').hidden = true;
    });
    $('settings').addEventListener('click', (e) => {
      if (e.target === $('settings')) $('settings').hidden = true;
    });

    $('font-scale').addEventListener('input', (e) => {
      state.settings.scale = Number(e.target.value);
      saveSettings();
    });
    $('toggle-gloss').addEventListener('change', (e) => {
      state.settings.gloss = e.target.checked;
      saveSettings();
    });
    $('toggle-diacritics').addEventListener('change', async (e) => {
      state.settings.diacritics = e.target.checked;
      if (state.settings.diacritics && !state.diacritics) {
        try {
          state.diacritics = await getJSON('data/diacritics.json');
        } catch {
          state.diacritics = null;
        }
      }
      saveSettings();
      route();
    });

    $('btn-search').addEventListener('click', () => {
      $('search').hidden = false;
      $('search-input').focus();
    });
    $('btn-search-close').addEventListener('click', () => {
      $('search').hidden = true;
    });
    $('search').addEventListener('click', (e) => {
      if (e.target === $('search')) $('search').hidden = true;
    });

    let debounce;
    $('search-input').addEventListener('input', (e) => {
      clearTimeout(debounce);
      const value = e.target.value;
      debounce = setTimeout(() => runSearch(value), 250);
    });

    window.addEventListener('hashchange', route);
  }

  async function init() {
    applySettings();
    wireUI();
    registerServiceWorker();

    try {
      state.index = await getJSON('data/index.json');
    } catch {
      view.replaceChildren(el('p', 'loading', 'Le mafai ona maua le tusi.'));
      return;
    }
    if (state.settings.diacritics) {
      try {
        state.diacritics = await getJSON('data/diacritics.json');
      } catch {
        state.diacritics = null;
      }
    }

    buildDrawer();
    // No auto-resume to the last chapter: the app opens on its landing page, and
    // that page carries the license notice. Returning readers get there in one
    // tap via the continue button instead.
    route();
  }

  init();
})();
