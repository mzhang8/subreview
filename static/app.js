/* subreview — client.
 *
 * This file never decides what a subtitle looks like. Every position, wrap
 * and font size in the overlay comes from subrender, the same code that writes
 * the ASS file, running in the page under Pyodide (static/web/). This file's
 * job is to keep the video, the cue list and that overlay pointing at the same
 * cue, and to make timing edits cheap enough to do a hundred times an hour.
 */

const $  = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

const S = {
  path: null,
  meta: {},
  style: null,
  cues: [],            // {start,end,pinyin,hanzi,english,n, _del}
  layouts: [],         // parallel to cues, from subrender
  renderTimings: [],   // parallel; null = the renderer would drop this cue
  renderNotes: [],
  rows: [],            // parallel; the DOM node for each cue
  sel: -1,
  playing: -1,
  dirty: false,
  previewMode: 'playhead',
  // Our subtitles sit on an opaque backdrop, directly over the line burned
  // into the picture. Checking that a cue's Chinese matches what the episode
  // actually shows therefore means getting the overlay out of the way.
  overlayOff: false,
};

const el = {};
let video, overlay;

/* ---------------------------------------------------------------------- */
/* formatting                                                              */
/* ---------------------------------------------------------------------- */

/** MM:SS.cc — centiseconds, because the transcripts store two decimals. */
function tc(t) {
  if (!isFinite(t)) t = 0;
  const sign = t < 0 ? '-' : '';
  const cs = Math.round(Math.abs(t) * 100);
  const m = Math.floor(cs / 6000);
  const s = Math.floor((cs % 6000) / 100);
  const c = cs % 100;
  return `${sign}${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(c).padStart(2, '0')}`;
}

const round2 = (n) => Math.round(n * 100) / 100;

/* ---------------------------------------------------------------------- */
/* transport                                                               */
/* ---------------------------------------------------------------------- */

function seekBy(delta) {
  if (!video.duration) return;
  seekTo(video.currentTime + delta);
}

function seekTo(t) {
  if (!video.duration) return;
  video.currentTime = Math.max(0, Math.min(t, video.duration - 0.001));
  tick();
}

function togglePlay() {
  if (!video.src) return;
  video.paused ? video.play() : video.pause();
}

/** Play just the selected cue, then stop at its end. */
let stopAt = null;
function playCue(i) {
  const c = S.cues[i];
  if (!c) return;
  seekTo(c.start);
  stopAt = c.end;
  video.play();
}

/* ---------------------------------------------------------------------- */
/* showing and hiding the overlay                                          */
/* ---------------------------------------------------------------------- */

/* Two independent switches can hide it, and they answer different questions.
 * `S.overlayOff` is the header's, and means "let me watch this episode as it
 * came". A cue's own `_bare` means "I am checking this line against the one
 * burned into the picture" — so it stays on, through as many replays as that
 * takes, until it is turned off again. Both default to showing the overlay,
 * and `_bare` is per cue: leaving one flagged does not affect the next. */

/** Whether the overlay should be hidden while cue `i` is the one on show. */
function overlayHidden(i) {
  return S.overlayOff || !!(i >= 0 && S.cues[i] && S.cues[i]._bare);
}

function applyOverlay(i = previewIndex()) {
  overlay.classList.toggle('off', overlayHidden(i));
  if (!el.overlayBtn) return;
  el.overlayBtn.classList.toggle('on', S.overlayOff);
  el.overlayBtn.textContent = S.overlayOff ? '◌ Overlay off' : '◉ Overlay on';
}

function toggleOverlay() {
  S.overlayOff = !S.overlayOff;
  applyOverlay();
  toast(S.overlayOff
    ? 'Overlay hidden for every cue — you are reading the burned-in subtitle now. H brings it back.'
    : 'Overlay back.');
}

/** Flip cue `i` between our subtitle and the one burned into the picture. */
function toggleOriginal(i) {
  const c = S.cues[i];
  if (!c) return;
  c._bare = !c._bare;
  paintOriginalBtn(i);
  applyOverlay();
  paintRow(i);
}

function paintOriginalBtn(i) {
  const b = editorFor(i)?.querySelector('[data-act="original"]');
  if (!b) return;
  const on = !!S.cues[i]._bare;
  b.classList.toggle('on', on);
  b.textContent = on ? '◉ original' : '◌ original';
}

/* ---------------------------------------------------------------------- */
/* the overlay — a videoW x videoH canvas scaled onto the video rect       */
/* ---------------------------------------------------------------------- */

function fitOverlay() {
  const st = S.style;
  if (!st) return;
  const frameBox = $('#frame').getBoundingClientRect();
  const box = video.getBoundingClientRect();
  const vw = video.videoWidth || st.videoW;
  const vh = video.videoHeight || st.videoH;
  if (!box.width || !box.height) return;

  // The <video> letterboxes with object-fit: contain; find the real picture.
  const fit = Math.min(box.width / vw, box.height / vh);
  const w = vw * fit;
  const h = vh * fit;
  const left = box.left - frameBox.left + (box.width - w) / 2;
  const top = box.top - frameBox.top + (box.height - h) / 2;

  overlay.style.width = st.videoW + 'px';
  overlay.style.height = st.videoH + 'px';
  overlay.style.transform = `translate(${left}px, ${top}px) scale(${w / st.videoW})`;
}

/** '#RRGGBB' at `opacity` as a CSS colour. */
function rgba(hex, opacity) {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${n >> 16},${(n >> 8) & 255},${n & 255},${opacity})`;
}

/** One positioned piece of text, styled as its layer is in the ASS file. */
function textNode(item, layer) {
  const d = document.createElement('div');
  d.className = 'txt';
  d.textContent = item.t;
  d.style.left = item.x + 'px';
  d.style.top = item.y + 'px';
  d.style.fontSize = layer.size + 'px';
  d.style.fontFamily = `"${layer.font}", sans-serif`;
  d.style.color = layer.colour;
  d.style.fontWeight = layer.bold ? '700' : '400';
  if (layer.outline) {
    // libass strokes outward by the outline width; a CSS stroke is centred on
    // the glyph edge, so it is drawn twice as wide with the fill painted over.
    d.style.webkitTextStroke = `${layer.size * layer.outline * 2}px #000`;
    d.style.paintOrder = 'stroke fill';
  }
  if (layer.shadow) {
    // The ASS shadow is BackColour &H80000000, 50% black.
    const s = layer.size * layer.shadow;
    d.style.textShadow = `${s}px ${s}px 0 rgba(0,0,0,.5)`;
  }
  return d;
}

function drawPreview(i) {
  overlay.textContent = '';
  // Whether the overlay is hidden depends on which cue is on show, so it is
  // decided here, where that changes — not only when a switch is pressed.
  applyOverlay(i);
  const L = S.layouts[i];
  if (i < 0 || !L) return;
  const st = S.style;

  for (const b of L.bands) {
    const d = document.createElement('div');
    d.className = 'band';
    d.style.cssText =
      `left:${b.x}px;top:${b.y}px;width:${b.w}px;height:${b.h}px;` +
      `background:${rgba(st.box.colour, st.box.opacity)}`;
    overlay.appendChild(d);
  }
  for (const t of L.py) overlay.appendChild(textNode(t, st.py));
  for (const t of L.zh) overlay.appendChild(textNode(t, st.zh));
  for (const t of L.en) overlay.appendChild(textNode(t, st.en));
}

/* ---------------------------------------------------------------------- */
/* which cue is on screen                                                  */
/* ---------------------------------------------------------------------- */

let cueHint = 0;

function cueAt(t) {
  const n = S.cues.length;
  if (!n) return -1;
  const hit = (i) => {
    const c = S.cues[i];
    return c && !c._del && t >= c.start && t < c.end;
  };
  // Playback walks forwards, so the answer is nearly always right here.
  for (let d = 0; d < 4; d++) {
    if (hit(cueHint + d)) return (cueHint += d);
    if (hit(cueHint - d)) return (cueHint -= d);
  }
  for (let i = 0; i < n; i++) if (hit(i)) return (cueHint = i);
  return -1;
}

function previewIndex() {
  if (S.previewMode === 'selected' && S.sel >= 0) return S.sel;
  return S.playing;
}

function tick() {
  const t = video.currentTime || 0;
  el.now.textContent = tc(t);
  el.seek.value = video.duration ? (t / video.duration) * 100 : 0;

  if (stopAt !== null && t >= stopAt) {
    video.pause();
    stopAt = null;
  }

  const at = cueAt(t);
  if (at !== S.playing) {
    const prev = S.playing;
    S.playing = at;
    if (prev >= 0 && S.rows[prev]) S.rows[prev].classList.remove('playing');
    if (at >= 0 && S.rows[at]) {
      S.rows[at].classList.add('playing');
      if (el.follow.checked && at !== S.sel && !video.paused) {
        S.rows[at].scrollIntoView({ block: 'nearest', behavior: 'smooth' });
      }
    }
    paintNowPlaying();
    if (S.previewMode === 'playhead') drawPreview(at);
  }
}

function loop() {
  if (!video.paused) tick();
  requestAnimationFrame(loop);
}

function paintNowPlaying() {
  const i = S.playing;
  if (i < 0) {
    el.npBody.textContent = '—';
    return;
  }
  const c = S.cues[i];
  el.npBody.innerHTML =
    `<span class="num">${c.n == null ? 'new' : '#' + c.n}</span><b></b> <span class="sep"></span>`;
  el.npBody.querySelector('b').textContent = c.hanzi;
  el.npBody.querySelector('.sep').textContent = c.english ? '· ' + c.english : '';
}

/* ---------------------------------------------------------------------- */
/* the cue list                                                            */
/* ---------------------------------------------------------------------- */

/** What the cue's number will be once the marked cues are dropped. */
function projectedNumbers() {
  const out = new Array(S.cues.length).fill(null);
  let n = 0;
  S.cues.forEach((c, i) => {
    if (c._del) return;
    out[i] = ++n;
  });
  return out;
}

function tagsFor(i) {
  const c = S.cues[i];
  if (c._del) return [];
  const L = S.layouts[i];
  const rt = S.renderTimings[i];
  const out = [];

  if (!(c.end > c.start)) out.push(['bad', 'end ≤ start']);
  if (L) {
    if (L.zhRows > 1) out.push(['rows', `${L.zhRows} lines`]);
    else if (L.fill > 0.9) out.push(['tight', `${Math.round(L.fill * 100)}% wide`]);
  }
  if (c._bare) out.push(['bare', 'original']);
  if (!c.hanzi.trim()) out.push(['bad', 'no hanzi']);
  if (!c.english.trim()) out.push(['bad', 'no English']);

  if (!rt) {
    out.push(['drop', 'dropped at render']);
  } else {
    if (Math.abs(rt.start - c.start) > 0.005) out.push(['drop', `start → ${tc(rt.start)}`]);
    if (Math.abs(rt.end - c.end) > 0.005) out.push(['time', `end → ${tc(rt.end)}`]);
  }
  return out;
}

function buildList() {
  el.list.textContent = '';
  const frag = document.createDocumentFragment();
  S.rows = S.cues.map((_, i) => {
    const row = document.createElement('div');
    row.className = 'cue';
    row.dataset.i = i;
    row.innerHTML =
      '<div class="n"></div>' +
      '<div class="main">' +
      '<div class="meta"><span class="t"></span><span class="d"></span>' +
      '<span class="tags"></span></div>' +
      '<div class="hz"></div><div class="en"></div></div>';
    frag.appendChild(row);
    return row;
  });
  el.list.appendChild(frag);
  paintAll();
}

function paintRow(i, nums) {
  const row = S.rows[i];
  if (!row) return;
  const c = S.cues[i];
  const newN = (nums || projectedNumbers())[i];

  row.classList.toggle('marked', !!c._del);
  row.classList.toggle('sel', i === S.sel);

  const nEl = row.querySelector('.n');
  nEl.textContent = c.n == null ? 'new' : c.n;
  if (!c._del && newN !== c.n) {
    const b = document.createElement('span');
    b.className = 'renum';
    b.textContent = '→' + newN;
    nEl.appendChild(b);
  }

  row.querySelector('.t').textContent = `${tc(c.start)} → ${tc(c.end)}`;
  row.querySelector('.d').textContent = (c.end - c.start).toFixed(2) + 's';
  row.querySelector('.hz').textContent = c.hanzi;
  row.querySelector('.en').textContent = c.english;

  const tags = row.querySelector('.tags');
  tags.textContent = '';
  for (const [kind, label] of tagsFor(i)) {
    const s = document.createElement('span');
    s.className = 'tag ' + kind;
    s.textContent = label;
    tags.appendChild(s);
  }
  applyFilter(i, row);
}

function paintAll() {
  const nums = projectedNumbers();
  for (let i = 0; i < S.cues.length; i++) paintRow(i, nums);
  paintCounts();
  paintTicks();
}

function paintCounts() {
  const marked = S.cues.filter((c) => c._del).length;
  const keep = S.cues.length - marked;
  el.counts.textContent = marked
    ? `${keep} cues · ${marked} marked for removal`
    : `${keep} cues`;
}

function paintNotes() {
  el.notes.textContent = '';
  for (const n of S.renderNotes) {
    const d = document.createElement('div');
    d.className = 'note' + (n.includes('CHECK THIS') ? ' check' : '');
    d.textContent = n;
    el.notes.appendChild(d);
  }
}

function paintTicks() {
  if (!video.duration) return;
  el.ticks.textContent = '';
  S.cues.forEach((c, i) => {
    if (c._del || !tagsFor(i).length) return;
    const t = document.createElement('i');
    t.style.left = (c.start / video.duration) * 100 + '%';
    if (i === S.sel) t.className = 'sel';
    el.ticks.appendChild(t);
  });
}

/* ---- filtering --------------------------------------------------------- */

function applyFilter(i, row) {
  const q = el.search.value.trim().toLowerCase();
  const c = S.cues[i];
  let show = true;
  if (q) {
    show =
      (c.n != null && String(c.n) === q) ||
      c.hanzi.toLowerCase().includes(q) ||
      c.english.toLowerCase().includes(q) ||
      (S.layouts[i]?.pinyinLine || '').toLowerCase().includes(q);
  }
  // `original` is a view you chose, not something wrong with the cue, so it
  // must not smuggle a clean cue through the issues filter.
  if (show && el.issuesOnly.checked && !c._del) {
    show = tagsFor(i).some(([kind]) => kind !== 'bare');
  }
  row.classList.toggle('hidden', !show && i !== S.sel);
}

function refilter() {
  S.rows.forEach((row, i) => applyFilter(i, row));
}

/* ---------------------------------------------------------------------- */
/* selection and the inline editor                                         */
/* ---------------------------------------------------------------------- */

function select(i, { seek = true } = {}) {
  if (i === S.sel) return;
  const prev = S.sel;
  S.sel = i;
  if (prev >= 0 && S.rows[prev]) {
    S.rows[prev].classList.remove('sel');
    S.rows[prev].querySelector('.editor')?.remove();
    paintRow(prev);
  }
  if (i < 0) return;

  const row = S.rows[i];
  row.classList.add('sel');
  row.classList.remove('hidden');
  openEditor(i);
  row.scrollIntoView({ block: 'nearest' });
  paintTicks();

  if (seek) {
    stopAt = null;
    seekTo(S.cues[i].start);
  }
  if (S.previewMode === 'selected') drawPreview(i);
}

function openEditor(i) {
  const row = S.rows[i];
  const c = S.cues[i];
  row.querySelector('.editor')?.remove();

  const ed = document.createElement('div');
  ed.className = 'editor';
  ed.innerHTML = `
    <div class="times">
      <label>start <input class="in-start" type="text" inputmode="decimal"></label>
      <button class="grab" data-grab="start" title="Set start to the playhead (I)">⇱ here</button>
      <span class="arrow">→</span>
      <label>end <input class="in-end" type="text" inputmode="decimal"></label>
      <button class="grab" data-grab="end" title="Set end to the playhead (O)">⇲ here</button>
      <button data-act="playcue" title="Play just this cue (Enter)">▶ cue</button>
      <button data-act="original" class="toggle" title="Hide the overlay for this cue, so playing it shows the subtitle burned into the picture. Stays on until you press it again (Shift+Enter toggles and replays)">◌ original</button>
    </div>
    <div class="fieldrow"><span>hz</span><textarea class="in-hz" rows="1" spellcheck="false"></textarea></div>
    <div class="py"></div>
    <div class="fieldrow"><span>en</span><textarea class="in-en" rows="1"></textarea></div>
    <div class="actions">
      <button data-act="split" title="Break this cue in two at the playhead (S)">⑃ split here</button>
      <button data-act="add" title="Add an empty cue after this one (N)">+ cue below</button>
      <button data-act="mark" class="danger"></button>
      <span class="hint">Esc leaves the field · ⌘S saves</span>
    </div>`;
  row.querySelector('.main').appendChild(ed);

  ed.querySelector('.in-start').value = c.start.toFixed(2);
  ed.querySelector('.in-end').value = c.end.toFixed(2);
  ed.querySelector('.in-hz').value = c.hanzi;
  ed.querySelector('.in-en').value = c.english;
  ed.querySelector('.py').textContent = S.layouts[i]?.pinyinLine || '';
  ed.querySelector('[data-act="mark"]').textContent = c._del
    ? 'Restore this cue'
    : 'Mark for removal';
  paintOriginalBtn(i);

  $$('textarea', ed).forEach(autosize);
}

function autosize(ta) {
  ta.style.height = 'auto';
  ta.style.height = ta.scrollHeight + 'px';
}

function editorFor(i) {
  return S.rows[i]?.querySelector('.editor') || null;
}

function syncEditorTimes(i) {
  const ed = editorFor(i);
  if (!ed) return;
  const c = S.cues[i];
  const a = ed.querySelector('.in-start');
  const b = ed.querySelector('.in-end');
  if (document.activeElement !== a) a.value = c.start.toFixed(2);
  if (document.activeElement !== b) b.value = c.end.toFixed(2);
}

/* ---------------------------------------------------------------------- */
/* mutations                                                               */
/* ---------------------------------------------------------------------- */

function markDirty() {
  S.dirty = true;
  el.dirty.hidden = false;
  el.save.disabled = false;
}

/** Push the next cue's start along so an extended end never overlaps it.
 *
 * Only ever moves that start later, and only when there is a real overlap —
 * shortening a cue leaves its neighbour where it is. Cues already marked for
 * removal are skipped, since they are on their way out of the file.
 */
function cascadeOverlap(i) {
  const c = S.cues[i];
  let j = i + 1;
  while (j < S.cues.length && S.cues[j]._del) j++;
  if (j >= S.cues.length) return;

  const next = S.cues[j];
  if (c.end <= next.start) return;

  next.start = c.end;
  markDirty();
  paintRow(j);
  syncEditorTimes(j);
  const label = next.n == null ? 'the next cue' : 'cue ' + next.n;
  if (next.start >= next.end) {
    toast(`${label} now starts at or after its own end — fix its end.`, 'bad');
  } else {
    toast(`${label} start moved to ${tc(next.start)} to clear the overlap.`);
  }
}

/* Rewinding is idempotent, so it can chase keystrokes — and since it always
   targets the cue's own start, typing into either box settles on one seek.
   The overlap cascade rewrites a second cue, so it waits for a commit. */
let startSeekTimer = null;
function queueStartSeek(t, delay = 500) {
  clearTimeout(startSeekTimer);
  startSeekTimer = setTimeout(() => seekTo(t), delay);
}

function setTime(i, field, value) {
  const c = S.cues[i];
  const v = round2(Math.max(0, value));
  if (c[field] === v) return;

  // Any timing edit rewinds to the cue's start, which parks the playhead
  // inside the cue — so a second press of O would otherwise set the end to
  // the start and invert the cue. A button or key must never be able to do
  // that; free typing still can, and gets flagged by the tag instead.
  if (field === 'end' && v <= c.start) {
    toast(`That would end the cue at or before ${tc(c.start)}, where it starts.`, 'bad');
    return;
  }
  if (field === 'start' && v >= c.end) {
    toast(`That would start the cue at or after ${tc(c.end)}, where it ends.`, 'bad');
    return;
  }

  c[field] = v;
  markDirty();
  syncEditorTimes(i);
  paintRow(i);
  if (field === 'end') cascadeOverlap(i);
  seekTo(c.start);   // rewind so you can replay the cue and hear the fit
  queueTimings();
  tick();   // the cue may have just moved under or out from the playhead
}

function nudge(field, delta) {
  if (S.sel < 0) return;
  setTime(S.sel, field, S.cues[S.sel][field] + delta);
}

function toggleMark(i) {
  const c = S.cues[i];
  c._del = !c._del;
  markDirty();
  paintAll();
  if (i === S.sel) openEditor(i);
  queueTimings();
  if (c._del && S.playing === i) {
    S.playing = -1;
    if (S.previewMode === 'playhead') drawPreview(-1);
  }
}

/* Inserting shifts every index after the insertion point, and the rows carry
   their index in data-i, so the list is rebuilt rather than patched. It is a
   one-off action on a few hundred rows — cheap enough not to optimise. */
function insertCue(i, cue, { seek = false, focus = false } = {}) {
  const at = i + 1;
  S.cues.splice(at, 0, cue);
  S.layouts.splice(at, 0, null);
  S.renderTimings.splice(at, 0, null);
  markDirty();

  S.sel = -1;
  S.playing = -1;
  cueHint = 0;
  buildList();
  select(at, { seek });
  tick();                 // recompute what is on screen at the playhead
  queueLayout(at);
  queueTimings();
  if (focus) {
    const hz = editorFor(at)?.querySelector('.in-hz');
    if (hz) { hz.focus(); }
  }
  return at;
}

function blankCue(start, end) {
  return {
    n: null, start: round2(start), end: round2(end),
    pinyin: '', hanzi: '', english: '', _del: false,
  };
}

/** A new empty cue after `i`, sitting in whatever gap follows it. */
function addCueBelow(i) {
  const c = S.cues[i];
  const next = S.cues.slice(i + 1).find((x) => !x._del);
  const start = c.end;
  let end = start + 1.5;
  if (next) end = Math.min(end, Math.max(start + 0.3, next.start));
  insertCue(i, blankCue(start, end), { seek: true, focus: true });
  toast('New cue added. Its number is assigned when you save.');
}

/** Break cue `i` in two at the playhead. */
async function splitCue(i) {
  const c = S.cues[i];
  const t = round2(video.currentTime);
  if (!(t > c.start && t < c.end)) {
    toast('Move the playhead inside this cue first, then split.', 'bad');
    return;
  }
  const frac = (t - c.start) / (c.end - c.start);
  let parts;
  try {
    parts = await api.split({ hanzi: c.hanzi, english: c.english, frac });
  } catch (e) {
    toast(e.message, 'bad');
    return;
  }
  const second = blankCue(t, c.end);
  second.hanzi = parts.b.hanzi;
  second.english = parts.b.english;

  c.end = t;
  c.hanzi = parts.a.hanzi;
  c.english = parts.a.english;
  // Neither half is the line the OCR read any more, so its agreement score and
  // rejected variants no longer describe what is here. Let them go.
  delete c.ocr;

  insertCue(i, second, { seek: false });
  queueLayout(i);            // the first half's text changed too
  toast('Split at ' + tc(t) + ' — check where the text divided.');
}

/* Debounced round-trips. Layout is per-cue and fires while typing; the
   render-timing pass covers the whole file, so it waits a little longer. */
const layoutTimers = new Map();
let timingTimer = null;

function queueLayout(i) {
  // Per-cue timers: editing A and clicking straight into B must not cancel
  // A's pending refresh, or A keeps a stale preview and a stale pinyin line.
  clearTimeout(layoutTimers.get(i));
  layoutTimers.set(i, setTimeout(async () => {
    layoutTimers.delete(i);
    const c = S.cues[i];
    try {
      const r = await api.layout({
        meta: S.meta,
        cues: [{ hanzi: c.hanzi, english: c.english }],
      });
      S.layouts[i] = r.layouts[0];
      const ed = editorFor(i);
      if (ed) ed.querySelector('.py').textContent = S.layouts[i].pinyinLine;
      paintRow(i);
      if (previewIndex() === i) drawPreview(i);
    } catch (e) {
      toast(e.message);
    }
  }, 140));
}

function queueTimings() {
  clearTimeout(timingTimer);
  timingTimer = setTimeout(recomputeTimings, 400);
}

async function recomputeTimings() {
  const keep = [];
  const map = [];
  S.cues.forEach((c, i) => {
    if (c._del) return;
    keep.push({ start: c.start, end: c.end, hanzi: c.hanzi, english: c.english });
    map.push(i);
  });
  try {
    const r = await api.timings({ meta: S.meta, cues: keep });
    const out = new Array(S.cues.length).fill(null);
    r.renderTimings.forEach((t, j) => { out[map[j]] = t; });
    S.renderTimings = out;
    S.renderNotes = r.renderNotes;
    paintAll();
    paintNotes();
  } catch (e) {
    toast(e.message);
  }
}

/* ---------------------------------------------------------------------- */
/* loading and saving                                                      */
/* ---------------------------------------------------------------------- */

/* The back end: Google Drive for the files, subrender for everything else.
   Set by start() once the page is connected. */
let api = null;

async function loadEpisodes() {
  const { episodes } = await api.episodes();
  el.episode.textContent = '';
  const groups = new Map();
  for (const e of episodes) {
    if (!groups.has(e.group)) groups.set(e.group, []);
    groups.get(e.group).push(e);
  }
  for (const [group, items] of groups) {
    const parent = group
      ? Object.assign(document.createElement('optgroup'), { label: group })
      : el.episode;
    for (const e of items) {
      const o = document.createElement('option');
      o.value = e.path;
      o.textContent = (e.hasVideo ? '' : '⚠ ') + e.name;
      parent.appendChild(o);
    }
    if (group) el.episode.appendChild(parent);
  }
  return episodes;
}

async function loadDoc(path) {
  if (S.dirty && !confirm('Discard unsaved changes to this transcript?')) {
    el.episode.value = S.path;
    return;
  }
  el.loading.hidden = false;
  el.app.hidden = true;

  let d;
  try {
    d = await api.doc(path);
  } catch (e) {
    if (!S.path) throw e;           // nothing open to go back to
    el.loading.hidden = true;
    el.app.hidden = false;
    el.episode.value = S.path;
    toast(e.message, 'bad', 7000);
    return;
  }

  S.path = d.path;
  S.meta = d.meta;
  S.style = d.style;
  S.layouts = d.layouts;
  S.renderTimings = d.renderTimings;
  S.renderNotes = d.renderNotes;
  S.cues = d.cues.map((c, i) => ({
    n: c.n ?? i + 1,
    start: Number(c.start) || 0,
    end: Number(c.end) || 0,
    pinyin: c.pinyin || '',
    hanzi: c.hanzi || '',
    english: c.english || '',
    _del: false,
    // Carried through untouched so save() can write it back. On a
    // burned-in-subtitle transcript this records how many frames agreed on the reading and what
    // the ones that disagreed said instead — the only record of where the line
    // came from, and nothing can recover it once dropped.
    ...(c.ocr ? { ocr: c.ocr } : {}),
  }));
  S.sel = -1;
  S.playing = -1;
  cueHint = 0;
  S.dirty = false;
  el.dirty.hidden = true;
  el.save.disabled = true;
  el.generate.disabled = false;

  document.title = d.name + ' — subreview';
  el.episode.value = d.path;
  localStorage.setItem('subreview.last', d.path);

  stopAt = null;
  // The header switch is a preference and survives changing episode. A cue's
  // own flag does not: the cues themselves have just been rebuilt.
  applyOverlay();
  showVideo(d.video);

  buildList();
  paintNotes();
  drawPreview(-1);
  el.loading.hidden = true;
  el.app.hidden = false;
  fitOverlay();
}

/* A <video> cannot send the sign-in header Drive wants, so the file is
   fetched whole instead — in the background, so the cue list is usable
   meanwhile. Once held, reopening the episode hands over its URL at once. */
let videoAsk = 0;

async function showVideo(v) {
  const ask = ++videoAsk;
  const note = $('#novideo');
  // Dropping the attribute alone leaves the last episode's frame up.
  const unload = () => { video.removeAttribute('src'); video.load(); };
  if (!v) {
    unload();
    note.textContent = 'No video found for this transcript.';
    note.hidden = false;
    return;
  }
  let url = v.url;
  if (!url) {
    unload();
    note.textContent = 'Fetching the video…';
    note.hidden = false;
    try {
      url = await v.fetch((got, total) => {
        if (ask !== videoAsk) return;
        const mb = (n) => (n / 1048576).toFixed(0);
        note.textContent = total
          ? `Fetching the video… ${mb(got)} of ${mb(total)} MB`
          : `Fetching the video… ${mb(got)} MB`;
      });
    } catch (e) {
      if (ask === videoAsk && e.name !== 'AbortError') note.textContent = 'Could not fetch the video: ' + e.message;
      return;
    }
    if (ask !== videoAsk) return;   // another episode was opened meanwhile
  }
  note.hidden = true;
  video.src = url;
  video.load();
}

/** Resolves true once the file on disk holds what is on screen. */
async function save() {
  if (!S.path) return false;
  el.save.disabled = true;
  const cues = [];
  S.cues.forEach((c, i) => {
    if (c._del) return;
    cues.push({
      start: c.start,
      end: c.end,
      // pinyin is derived, never authored — always write what the renderer
      // would derive from the current hanzi.
      pinyin: S.layouts[i]?.pinyinLine ?? c.pinyin,
      hanzi: c.hanzi,
      english: c.english,
      // Carried through untouched. On a burned-in-subtitle transcript this block records
      // how many frames agreed on the reading and what the ones that disagreed
      // said instead — provenance the review pass has no business discarding.
      ...(c.ocr ? { ocr: c.ocr } : {}),
    });
  });
  try {
    const r = await api.save({ path: S.path, meta: S.meta, cues });
    toast(
      `Saved ${r.cues} cues` + (r.backup ? ' · original backed up to .bak' : ''),
      'good'
    );
    S.dirty = false;
    const scrollTop = el.list.scrollTop;
    await loadDoc(S.path);
    el.list.scrollTop = scrollTop;
    return true;
  } catch (e) {
    el.save.disabled = false;
    toast(e.message, 'bad');
    return false;
  }
}

/** Render the saved transcript to .ass as the folder's subreview.json says.
 *  What is rendered is the file in Drive, so unsaved edits are saved first. */
async function generate() {
  if (!S.path || el.generate.disabled) return;
  if (S.dirty && !(await save())) return;
  el.generate.disabled = true;
  el.generate.textContent = 'Generating…';
  try {
    const r = await api.generate({ path: S.path });
    console.log(r.log.join('\n'));
    // The renderer's own summary: what changed, and every file it wrote.
    // Each file with just its folder: always the transcript's own.
    const lines = r.log.map((l) =>
      l.replace(/^((?:wrote|unchanged)\s+)(?:.*\/)?([^/]+\/[^/]+)$/, '$1$2'));
    toast('Generated\n' + lines.join('\n'), 'good', 7000);
  } catch (e) {
    toast('Generate failed: ' + e.message, 'bad', 7000);
  } finally {
    el.generate.disabled = false;
    el.generate.innerHTML = 'Generate <kbd>⇧⌘S</kbd>';
  }
}

/* ---------------------------------------------------------------------- */
/* toast                                                                   */
/* ---------------------------------------------------------------------- */

let toastTimer = null;
function toast(msg, kind = '', ms = 3200) {
  let t = $('#toast');
  if (!t) {
    t = document.createElement('div');
    t.id = 'toast';
    document.body.appendChild(t);
  }
  t.textContent = msg;
  t.className = 'show ' + kind;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.className = ''), ms);
}

/* ---------------------------------------------------------------------- */
/* wiring                                                                  */
/* ---------------------------------------------------------------------- */

function isTyping() {
  const a = document.activeElement;
  return a && (a.tagName === 'TEXTAREA' || a.tagName === 'INPUT' || a.tagName === 'SELECT');
}

function wire() {
  video = $('#video');
  overlay = $('#overlay');
  Object.assign(el, {
    app: $('#app'), loading: $('#loading'), episode: $('#episode'),
    counts: $('#counts'), dirty: $('#dirty'), save: $('#save'),
    generate: $('#generate'),
    list: $('#list'), notes: $('#notes'), npBody: $('#npBody'),
    now: $('#now'), dur: $('#dur'), seek: $('#seek'), ticks: $('#ticks'),
    follow: $('#follow'), search: $('#search'), issuesOnly: $('#issuesOnly'),
    play: $('#play'), overlayBtn: $('#overlayBtn'),
  });

  el.episode.addEventListener('change', () => loadDoc(el.episode.value));
  el.save.addEventListener('click', save);
  el.generate.addEventListener('click', generate);
  $('#help').addEventListener('click', () => $('#helpDialog').showModal());
  el.overlayBtn.addEventListener('click', toggleOverlay);
  applyOverlay();

  // -- transport ---------------------------------------------------------
  $$('#transport [data-seek]').forEach((b) =>
    b.addEventListener('click', () => { stopAt = null; seekBy(+b.dataset.seek); })
  );
  el.play.addEventListener('click', togglePlay);
  el.seek.addEventListener('input', () => {
    stopAt = null;
    if (video.duration) seekTo((el.seek.value / 100) * video.duration);
  });

  video.addEventListener('loadedmetadata', () => {
    el.dur.textContent = '/ ' + tc(video.duration);
    fitOverlay();
    paintTicks();
    tick();
  });
  video.addEventListener('seeked', tick);
  video.addEventListener('timeupdate', tick);
  video.addEventListener('play', () => (el.play.textContent = '❚❚'));
  video.addEventListener('pause', () => (el.play.textContent = '▶'));
  video.addEventListener('error', () => {
    if (video.getAttribute('src')) toast('The browser could not play this video file.', 'bad');
  });

  new ResizeObserver(fitOverlay).observe($('#stage'));

  // -- preview mode ------------------------------------------------------
  $$('#previewMode button').forEach((b) =>
    b.addEventListener('click', () => {
      $$('#previewMode button').forEach((x) => x.classList.toggle('on', x === b));
      S.previewMode = b.dataset.mode;
      drawPreview(previewIndex());
    })
  );

  // -- filters -----------------------------------------------------------
  el.search.addEventListener('input', refilter);
  el.issuesOnly.addEventListener('change', refilter);

  // -- the cue list (delegated: one listener for every row) --------------
  el.list.addEventListener('click', (ev) => {
    const row = ev.target.closest('.cue');
    if (!row) return;
    const i = +row.dataset.i;

    const grab = ev.target.closest('[data-grab]');
    if (grab) { setTime(i, grab.dataset.grab, video.currentTime); return; }

    const act = ev.target.closest('[data-act]');
    if (act) {
      if (act.dataset.act === 'mark') toggleMark(i);
      if (act.dataset.act === 'playcue') playCue(i);
      if (act.dataset.act === 'original') toggleOriginal(i);
      if (act.dataset.act === 'add') addCueBelow(i);
      if (act.dataset.act === 'split') splitCue(i);
      return;
    }
    if (ev.target.closest('.editor')) return;  // clicks inside the fields
    select(i);
  });

  el.list.addEventListener('input', (ev) => {
    const row = ev.target.closest('.cue');
    if (!row) return;
    const i = +row.dataset.i;
    const t = ev.target;

    if (t.classList.contains('in-start') || t.classList.contains('in-end')) {
      const v = parseFloat(t.value);
      if (!isNaN(v)) {
        const field = t.classList.contains('in-start') ? 'start' : 'end';
        S.cues[i][field] = round2(Math.max(0, v));
        markDirty();
        paintRow(i);
        queueTimings();
        queueStartSeek(S.cues[i].start);
      }
      return;
    }
    if (t.classList.contains('in-hz') || t.classList.contains('in-en')) {
      // Newlines aren't part of this format; the renderer would fold them
      // into a space anyway.
      if (t.value.includes('\n')) {
        const pos = t.selectionStart;
        t.value = t.value.replace(/\n/g, ' ');
        t.setSelectionRange(pos, pos);
      }
      S.cues[i][t.classList.contains('in-hz') ? 'hanzi' : 'english'] = t.value;
      autosize(t);
      markDirty();
      queueLayout(i);
      queueTimings();
      // Same rewind as a timing edit. Longer debounce, because rewriting a
      // translation pauses far more often than typing a timestamp does.
      queueStartSeek(S.cues[i].start, 900);
    }
  });

  el.list.addEventListener('change', (ev) => {
    const t = ev.target;
    if (t.classList.contains('in-start') || t.classList.contains('in-end')) {
      const i = +t.closest('.cue').dataset.i;
      // Half-typed values pass through `input`; only a committed one may move
      // the neighbouring cue, or typing "95" would drag it along via "9".
      if (t.classList.contains('in-end')) { cascadeOverlap(i); queueTimings(); }
      syncEditorTimes(i);
    }
  });

  // -- keyboard ----------------------------------------------------------
  document.addEventListener('keydown', (ev) => {
    const meta = ev.metaKey || ev.ctrlKey;

    if (meta && ev.key.toLowerCase() === 's') {
      ev.preventDefault();
      if (ev.shiftKey) generate(); else save();
      return;
    }
    if (ev.key === 'Escape') {
      if (isTyping()) { ev.preventDefault(); document.activeElement.blur(); }
      return;
    }
    if (meta || ev.altKey) return;
    if (isTyping()) return;
    if ($('#helpDialog').open) return;

    const K = ev.key;
    const jump = (d) => { ev.preventDefault(); stopAt = null; seekBy(d); };

    switch (K) {
      case ' ':  ev.preventDefault(); stopAt = null; togglePlay(); return;
      case '<':  return jump(-1);
      case '>':  return jump(1);
      case ',':  return jump(-0.1);
      case '.':  return jump(0.1);
      case 'ArrowLeft':  return jump(-1);
      case 'ArrowRight': return jump(1);
      case 'j': case 'J': return jump(-5);
      case 'l': case 'L': return jump(5);
      case 'h': case 'H': ev.preventDefault(); toggleOverlay(); return;
      case '?': ev.preventDefault(); $('#helpDialog').showModal(); return;
    }

    // Everything below needs a selected cue.
    if (K === 'ArrowUp' || K === 'ArrowDown') {
      ev.preventDefault();
      const dir = K === 'ArrowDown' ? 1 : -1;
      const start = S.sel < 0 ? (S.playing < 0 ? 0 : S.playing) : S.sel + dir;
      for (let i = start; i >= 0 && i < S.cues.length; i += dir) {
        if (!S.rows[i].classList.contains('hidden')) { select(i); break; }
      }
      return;
    }
    if (S.sel < 0) return;

    switch (K) {
      case 'Enter':
        ev.preventDefault();
        // Shift flips this cue between our subtitle and the burned-in one and
        // replays it either way, so holding it down alternates the two.
        if (ev.shiftKey) toggleOriginal(S.sel);
        playCue(S.sel);
        break;
      case 'i': case 'I': ev.preventDefault(); setTime(S.sel, 'start', video.currentTime); break;
      case 'o': case 'O': ev.preventDefault(); setTime(S.sel, 'end', video.currentTime); break;
      case '[': ev.preventDefault(); nudge('start', -0.05); break;
      case ']': ev.preventDefault(); nudge('start', 0.05); break;
      case '{': ev.preventDefault(); nudge('end', -0.05); break;
      case '}': ev.preventDefault(); nudge('end', 0.05); break;
      case 'n': case 'N': ev.preventDefault(); addCueBelow(S.sel); break;
      case 's': case 'S': ev.preventDefault(); splitCue(S.sel); break;
      case 'Delete': case 'Backspace': ev.preventDefault(); toggleMark(S.sel); break;
    }
  });

  window.addEventListener('beforeunload', (ev) => {
    if (S.dirty) { ev.preventDefault(); ev.returnValue = ''; }
  });

  requestAnimationFrame(loop);
}

/* ---------------------------------------------------------------------- */

(async function start() {
  wire();
  try {
    const { webApi } = await import(new URL('static/web/web.js', document.baseURI).href);
    api = await webApi({ toast });
    await api.start();
    el.loading.hidden = false;
    const episodes = await loadEpisodes();
    if (!episodes.length) {
      el.loading.textContent = 'No *.translated.json files found in the transcripts directory.';
      return;
    }
    const last = localStorage.getItem('subreview.last');
    const pick = episodes.find((e) => e.path === last) || episodes[0];
    await loadDoc(pick.path);
  } catch (e) {
    el.loading.textContent = 'Failed to start: ' + e.message;
  }
})();
