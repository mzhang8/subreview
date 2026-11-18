/* The browser build's back end: transcripts and videos in Google Drive.
 *
 * Answers app.js's calls: listing episodes, opening one, relayout, split,
 * timings, save and generate. The files live in two Drive folders:
 *
 *   subtitles  read and written — the *.translated.json files, any
 *              subreview.json, and the .ass files Generate writes beside them
 *   videos     only ever read — matched to a transcript by name, as on disk
 *
 * Every write goes through `writable`, which refuses any folder that is not
 * the subtitles folder or one inside it.
 */

import { Drive, FOLDER, loadSignIn } from './drive.js';
import { loadEngine, missingFonts } from './engine.js';

const SETTINGS = 'subreview.drive';
// Full Drive access is the only scope that can rewrite a file this app did not
// create. The app itself only looks inside the two folders below.
const SCOPE = 'https://www.googleapis.com/auth/drive';
const VIDEO_TYPES = { '.mp4': 'video/mp4', '.m4v': 'video/mp4', '.mov': 'video/quicktime',
                      '.webm': 'video/webm', '.mkv': 'video/x-matroska' };
const CONFIG_NAME = 'subreview.json';

const $ = (sel) => document.querySelector(sel);

function stripSuffix(name) {
  for (const suffix of ['.translated.json', '.json']) {
    if (name.endsWith(suffix)) return name.slice(0, -suffix.length);
  }
  return name;
}

/** A folder ID from whatever was pasted: an ID, or a Drive folder link. */
function folderId(input) {
  const s = (input || '').trim();
  const m = s.match(/\/folders\/([\w-]+)/) || s.match(/[?&]id=([\w-]+)/);
  return m ? m[1] : s;
}

/** Local time as YYYYmmdd-HHMMSS, for naming .ass backups. */
function stamp(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-` +
         `${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

function readSettings() {
  try { return JSON.parse(localStorage.getItem(SETTINGS)) || {}; } catch { return {}; }
}

function writeSettings(s) {
  try { localStorage.setItem(SETTINGS, JSON.stringify(s)); } catch {}
}

/** For the test harness only: a stand-in Drive, no Google sign-in. */
function devSettings() {
  try { return JSON.parse(localStorage.getItem('subreview.dev')); } catch { return null; }
}

/* ---------------------------------------------------------------------- */
/* a folder and everything under it                                        */
/* ---------------------------------------------------------------------- */

class Tree {
  constructor(root) {
    this.root = root;
    this.folders = new Map([[root.id, { ...root, parent: null, path: '' }]]);
    this.files = new Map();
  }

  /** List the whole tree, one level at a time, each level in parallel. */
  static async walk(drive, root) {
    const t = new Tree(root);
    let level = [root.id];
    while (level.length) {
      const lists = await Promise.all(level.map((id) => drive.children(id)));
      level = [];
      for (const items of lists) {
        for (const f of items) {
          if (f.mimeType === FOLDER) { t.addFolder(f); level.push(f.id); }
          else t.addFile(f);
        }
      }
    }
    return t;
  }

  addFolder(f) {
    const parent = this.folders.get(f.parents?.[0]);
    this.folders.set(f.id, { ...f, parent: parent?.id ?? null,
                             path: parent?.path ? `${parent.path}/${f.name}` : f.name });
  }

  addFile(f) {
    this.files.set(f.id, { ...f, parent: f.parents?.[0] ?? null });
  }

  /** "subs/reviewed/name", for messages: the folder you would look in. */
  label(folderId, name) {
    const path = this.folders.get(folderId)?.path;
    return [this.root.name, path, name].filter(Boolean).join('/');
  }

  /** The files in one folder, as of the last listing. */
  in(folderId) {
    return [...this.files.values()].filter((f) => f.parent === folderId);
  }

  /** Folders from `folderId` up to the root, nearest first. */
  *upwards(folderId) {
    for (let f = this.folders.get(folderId); f; f = this.folders.get(f.parent)) yield f;
  }
}

/* ---------------------------------------------------------------------- */

export async function webApi({ toast }) {
  const dev = devSettings();
  let connecting = false;
  // The renderer loads while you fill in the form; its progress shows until
  // Connect is pressed, and then the connection's own does.
  const engineReady = loadEngine((msg) => { if (!connecting) status(msg); });
  engineReady.then(() => { if (!connecting) status(''); },
                   (e) => { if (!connecting) status('Could not load the renderer: ' + e.message); });
  const signInReady = dev ? Promise.resolve() : loadSignIn();
  signInReady.catch(() => {});

  let drive, subs, videos, engine;
  const versions = new Map();        // file id -> Drive version when loaded

  function status(msg) {
    const s = $('#setupStatus');
    if (s) s.textContent = msg;
  }

  /* -- connecting ------------------------------------------------------- */

  async function connect(settings) {
    drive = new Drive({ clientId: settings.clientId, scope: SCOPE, dev });
    drive.onExpire = () => { $('#reconnect').hidden = false; };
    await drive.signIn();

    status('Opening the two folders…');
    const [s, v] = await Promise.all([drive.meta(settings.subs), drive.meta(settings.videos)]);
    for (const [f, what] of [[s, 'subtitles'], [v, 'videos']]) {
      if (f.mimeType !== FOLDER) throw new Error(`The ${what} link is to a file, not a folder.`);
    }
    status('Reading the folder contents…');
    [subs, videos] = await Promise.all([Tree.walk(drive, s), Tree.walk(drive, v)]);

    status('Loading the renderer…');
    engine = await engineReady;
    return s.name;
  }

  function showSetup() {
    return new Promise((resolve) => {
      const saved = readSettings();
      $('#loading').hidden = true;
      $('#setup').hidden = false;
      $('#setClient').value = saved.clientId || '';
      $('#setSubs').value = saved.subs || '';
      $('#setVideos').value = saved.videos || '';

      const go = () => {
        const settings = {
          clientId: $('#setClient').value.trim(),
          subs: folderId($('#setSubs').value),
          videos: folderId($('#setVideos').value),
        };
        if (!dev && !settings.clientId) return status('Paste the OAuth client ID first.');
        if (!settings.subs || !settings.videos) return status('Both folders are needed.');
        if (settings.subs === settings.videos) {
          return status('Use two different folders: the videos one is never written to.');
        }
        writeSettings(settings);
        $('#connect').disabled = true;
        connecting = true;
        // signIn opens Google's popup, so it runs inside this click.
        connect(settings).then((name) => {
          $('#setup').hidden = true;
          $('#driveBtn').hidden = false;
          $('#driveBtn').textContent = 'Drive: ' + name;
          resolve();
        }, (e) => {
          $('#connect').disabled = false;
          connecting = false;
          status(e.message);
        });
      };
      $('#connect').onclick = go;
      $('#setup').onsubmit = (ev) => { ev.preventDefault(); go(); };
      signInReady.catch((e) => status('Could not load Google sign-in: ' + e.message));
      if (dev) go();
    });
  }

  $('#reconnect').addEventListener('click', () => {
    drive.signIn().then(() => {
      $('#reconnect').hidden = true;
      toast('Reconnected to Google Drive.', 'good');
    }, (e) => toast(e.message, 'bad'));
  });
  // Changing folders means connecting afresh, which is what a reload does.
  $('#driveBtn').addEventListener('click', () => location.reload());

  /* -- finding things --------------------------------------------------- */

  function transcript(id) {
    const f = subs.files.get(id);
    if (!f) throw new Error('That transcript is no longer in the subtitles folder.');
    return f;
  }

  function writable(folderId) {
    if (!subs.folders.has(folderId)) {
      throw new Error('Refusing to write outside the subtitles folder.');
    }
  }

  /** By name: beside the transcript, then anywhere in the videos folder. */
  function videoFor(f, source) {
    const stems = [stripSuffix(f.name)];
    // meta.source is a path on the machine that made the transcript; its file
    // name may still be the one in the videos folder.
    if (source) stems.push(source.split(/[\\/]/).pop().replace(/\.[^.]+$/, ''));
    const pools = [subs.in(f.parent), [...videos.files.values()]];
    for (const stem of stems) {
      for (const pool of pools) {
        for (const ext of Object.keys(VIDEO_TYPES)) {
          const hit = pool.find((v) => v.name === stem + ext);
          if (hit) return hit;
        }
      }
    }
    return null;
  }

  /** The nearest subreview.json at or above the transcript, as config.find does. */
  async function recipe(f) {
    for (const folder of subs.upwards(f.parent)) {
      const cfg = subs.in(folder.id).find((x) => x.name === CONFIG_NAME);
      if (cfg) return { text: await drive.text(cfg.id), label: subs.label(folder.id, CONFIG_NAME) };
    }
    return { text: null, label: null };
  }

  /* -- the video -------------------------------------------------------- */

  // One episode's video is held in memory at a time; a save reloads the
  // transcript but must not fetch the same 50 MB again.
  let held = null;                   // { id, url }
  let fetching = null;               // { id, promise, abort }

  function videoUrl(v, onProgress) {
    if (held?.id === v.id) return Promise.resolve(held.url);
    if (fetching?.id === v.id) return fetching.promise;
    fetching?.abort.abort();
    const abort = new AbortController();
    const ext = v.name.slice(v.name.lastIndexOf('.'));
    const promise = drive.blob(v.id, VIDEO_TYPES[ext] || 'video/mp4', onProgress, abort.signal)
      .then((blob) => {
        if (held) URL.revokeObjectURL(held.url);
        held = { id: v.id, url: URL.createObjectURL(blob) };
        return held.url;
      })
      .finally(() => { if (fetching?.promise === promise) fetching = null; });
    fetching = { id: v.id, promise, abort };
    return promise;
  }

  /* -- writing ---------------------------------------------------------- */

  /** Put `text` at folder/name, keeping what it replaces, as config._install does. */
  async function install(folderId, name, text) {
    writable(folderId);
    const label = subs.label(folderId, name);
    const target = await drive.find(folderId, name);
    if (target) {
      if ((await drive.text(target.id)) === text) return `unchanged  ${label}`;
      let backups = await drive.find(folderId, 'backups', { folder: true });
      if (!backups) {
        backups = await drive.folder(folderId, 'backups');
        subs.addFolder(backups);
      }
      const keep = `${name.replace(/\.ass$/, '')}.${stamp()}.ass`;
      if (!(await drive.find(backups.id, keep))) await drive.copy(target.id, backups.id, keep);
      await drive.update(target.id, text, 'text/plain');
    } else {
      subs.addFile(await drive.create(folderId, name, text, 'text/plain'));
    }
    return `wrote      ${label}`;
  }

  /* -- the calls app.js makes ------------------------------------------- */

  return {
    async start() {
      await showSetup();
    },

    async episodes() {
      const found = [...subs.files.values()]
        .filter((f) => f.name.endsWith('.translated.json'))
        .map((f) => ({ f, group: subs.folders.get(f.parent)?.path ?? '' }))
        .sort((a, b) => a.group.toLowerCase().localeCompare(b.group.toLowerCase()) ||
                        a.f.name.toLowerCase().localeCompare(b.f.name.toLowerCase()));
      return {
        episodes: found.map(({ f, group }) => ({
          path: f.id,
          name: stripSuffix(f.name),
          group,
          hasVideo: !!videoFor(f),
        })),
      };
    },

    async doc(id) {
      const f = transcript(id);
      const [text, info, cfg] = await Promise.all([drive.text(id), drive.meta(id, 'version'), recipe(f)]);
      versions.set(id, info.version);
      const d = engine.doc(text, cfg.text, cfg.label);

      const missing = missingFonts([d.style.zh.font, d.style.py.font, d.style.en.font]);
      $('#banner').hidden = !missing.length;
      $('#banner').title = $('#banner').textContent = missing.length
        ? `This browser has no ${missing.join(' or ')}, so it measures with a substitute: ` +
          'the preview and any .ass generated here will not wrap the way the Mac does.'
        : '';

      const v = videoFor(f, d.meta.source);
      return {
        path: id,
        name: stripSuffix(f.name),
        ...d,
        video: v && {
          path: videos.label(v.parent, v.name),
          url: held?.id === v.id ? held.url : null,
          fetch: (onProgress) => videoUrl(v, onProgress),
        },
        backupExists: subs.in(f.parent).some((x) => x.name === f.name + '.bak'),
      };
    },

    async layout(body) { return engine.layout(body); },
    async split(body) { return engine.split(body); },
    async timings(body) { return engine.timings(body); },

    async save({ path: id, meta, cues }) {
      // First, while this is still the click or ⌘S that asked for it: an
      // hour-old token is renewed with a popup, which needs that gesture.
      await drive.ready();
      const f = transcript(id);
      writable(f.parent);

      const now = await drive.meta(id, 'version');
      if (versions.has(id) && now.version !== versions.get(id) &&
          !confirm(`${f.name} has changed in Google Drive since you opened it — ` +
                   'perhaps saved from another computer. Overwrite it with what is on screen?')) {
        throw new Error('Not saved. Reload the episode to see the other changes.');
      }

      const { text, cues: count } = engine.transcript(meta, cues);
      // The first save keeps the file as it was.
      let backup = null;
      if (!(await drive.find(f.parent, f.name + '.bak'))) {
        subs.addFile(await drive.copy(id, f.parent, f.name + '.bak'));
        backup = subs.label(f.parent, f.name + '.bak');
      }
      const saved = await drive.update(id, text, 'application/json');
      versions.set(id, saved.version);
      return { ok: true, cues: count, backup };
    },

    async generate({ path: id }) {
      await drive.ready();
      const f = transcript(id);
      writable(f.parent);
      // What was saved, not the page's copy.
      const [text, cfg] = await Promise.all([drive.text(id), recipe(f)]);
      const { notes, files } = engine.render(text, cfg.text, cfg.label, stripSuffix(f.name));
      const log = notes.map((n) => 'timing: ' + n);
      for (const [name, ass] of files) log.push(await install(f.parent, name, ass));
      return { ok: true, log, config: cfg.label };
    },
  };
}
