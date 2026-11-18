/* The renderer, in the page.
 *
 * subrender is plain Python, loaded into Pyodide. The only piece that cannot
 * come along is CoreText, which it uses on a Mac, so text widths come from
 * a canvas instead (subrender/measure.py reaches for `subreviewMeasure` when
 * CoreText will not import). On a Mac the browser measures with the same
 * system fonts; `missingFonts` reports when that is not true.
 */

const PYODIDE = 'https://cdn.jsdelivr.net/pyodide/v0.27.7/full/';
const SUBRENDER = ['__init__', 'ass', 'chinese', 'config', 'layout', 'measure',
                   'review', 'style', 'timing'];
// Built from PyPI's jieba 0.42.1 and pypinyin 0.55.0. jieba ships only as a
// source tarball; this wheel leaves out its paddle model, keyword extraction
// and part-of-speech tagger, none of which subrender imports.
const WHEELS = ['jieba-0.42.1-py3-none-any.whl', 'pypinyin-0.55.0-py2.py3-none-any.whl'];

const here = (path) => new URL(path, import.meta.url).href;

// CoreText's default fallback order on macOS, for characters the named font
// lacks: hanzi typed into the English go to PingFang SC, a stray ‚ or − in the
// Chinese to Helvetica. Left to itself Chrome would pick differently, and the
// widths with it.
const CASCADE = ['Helvetica', 'Lucida Grande', 'Apple Symbols', 'PingFang SC',
                 'PingFang TC', 'PingFang HK', 'Hiragino Sans', 'Hiragino Sans GB',
                 'Apple SD Gothic Neo'].map((f) => `"${f}"`).join(', ');

let ctx = null;
let lastFont = '';
function canvas() {
  return (ctx ||= document.createElement('canvas').getContext('2d'));
}

// CoreText picks a font per character, so in "what真 real" the space after 真
// stays in Helvetica Neue; Chrome would carry PingFang on through it. Measuring
// each CJK and non-CJK stretch on its own gets CoreText's choice back.
const RUNS = /[\u2e80-\u9fff\uf900-\ufaff\ufe30-\ufe4f\uff00-\uffef]+|[^\u2e80-\u9fff\uf900-\ufaff\ufe30-\ufe4f\uff00-\uffef]+/g;

function runWidth(c, text, size) {
  // Canvas sums in single precision. CoreText's widths are whole font units —
  // 1/1000 em for Helvetica Neue, Hiragino and PingFang, 1/2048 for the
  // Helvetica that fills in odd symbols — so snap back onto whichever grid
  // the measurement sits on.
  // The 1000 grid wins whenever it is within the float error a string this
  // long can pick up, which grows with every glyph summed.
  const raw = c.measureText(text).width;
  const tol = Math.max(1e-4, 4e-7 * raw * text.length);
  for (const upem of [1000, 2048]) {
    const snapped = (Math.round((raw * upem) / size) * size) / upem;
    if (Math.abs(snapped - raw) < tol) return snapped;
  }
  return raw;
}

/** Advance width of `text` in `font` at `size` px — CoreText's job on a Mac. */
globalThis.subreviewMeasure = (text, font, size) => {
  const c = canvas();
  // Regular weight, as CTFontCreateWithName gives subrender on a Mac: the
  // bold English is measured unbolded there too.
  const f = `${size}px "${font}", ${CASCADE}`;
  if (f !== lastFont) { c.font = f; lastFont = f; }
  let w = 0;
  for (const run of text.match(RUNS) || []) w += runWidth(c, run, size);
  return w;
};

/** Which of `fonts` this browser does not have, and so would substitute. */
export function missingFonts(fonts) {
  const c = canvas();
  const sample = 'mmmwwwlli 汉字拼音 0123';
  const width = (f) => { c.font = f; return c.measureText(sample).width; };
  lastFont = '';
  return [...new Set(fonts)].filter((font) =>
    ['monospace', 'serif'].every((g) => width(`40px ${g}`) === width(`40px "${font}", ${g}`)));
}

function loadScript(src) {
  return new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = src;
    s.onload = resolve;
    s.onerror = () => reject(new Error('could not load ' + src));
    document.head.appendChild(s);
  });
}

// The status line has to paint before the next long synchronous step.
const breathe = () => new Promise((r) => setTimeout(r, 30));

/** Python tracebacks are long; the last line is the message. */
function pyError(e) {
  const lines = String(e.message || e).trim().split('\n');
  return new Error(lines[lines.length - 1]);
}

export async function loadEngine(status = () => {}) {
  status('Loading Python…');
  if (!globalThis.loadPyodide) await loadScript(PYODIDE + 'pyodide.js');
  const py = await loadPyodide({ indexURL: PYODIDE });

  status('Loading jieba and pypinyin…');
  await py.loadPackage(WHEELS.map((w) => here('wheels/' + w)));

  const root = '/home/pyodide/subreview';
  py.FS.mkdirTree(root + '/subrender');
  const fetchText = async (url) => {
    const r = await fetch(url, { cache: 'no-cache' });
    if (!r.ok) throw new Error(`could not load ${url} (${r.status})`);
    return r.text();
  };
  await Promise.all([
    ...SUBRENDER.map(async (n) =>
      py.FS.writeFile(`${root}/subrender/${n}.py`, await fetchText(here(`../../subrender/${n}.py`)))),
    (async () => py.FS.writeFile(`${root}/engine.py`, await fetchText(here('engine.py'))))(),
  ]);

  status('Loading the dictionary…');
  await breathe();
  py.runPython(`import sys; sys.path.insert(0, ${JSON.stringify(root)})`);
  const mod = py.pyimport('engine');
  mod.warm();

  const call = (fn, ...args) => {
    try {
      return JSON.parse(mod[fn](...args));
    } catch (e) {
      throw pyError(e);
    }
  };
  return {
    doc: (docText, configText, configName) => call('doc', docText, configText, configName),
    layout: (body) => call('layout', JSON.stringify(body)),
    timings: (body) => call('timings', JSON.stringify(body)),
    split: (body) => call('split', JSON.stringify(body)),
    transcript: (meta, cues) => call('transcript', JSON.stringify({ meta, cues })),
    render: (docText, configText, configName, stem) =>
      call('render', docText, configText, configName, stem),
  };
}
