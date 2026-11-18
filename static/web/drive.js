/* Google Drive, over its REST API, with a token from Google Identity Services.
 *
 * Nothing here is a secret. The OAuth client ID identifies the app, not you;
 * the access token is issued to whoever signs in, lives only in this tab's
 * memory and expires within the hour. Someone else opening the page would be
 * signing in to their own Drive, if the OAuth app let them in at all.
 */

const GIS = 'https://accounts.google.com/gsi/client';
export const FOLDER = 'application/vnd.google-apps.folder';
const FIELDS = 'id,name,mimeType,parents,size,modifiedTime,version';

/** A token issued with at least this long to run is good for the next call. */
const SLACK_MS = 2 * 60 * 1000;

export class SignInNeeded extends Error {
  constructor() {
    super('The Google sign-in has expired. Press Reconnect at the top, then try again.');
  }
}

/** Google's sign-in library, fetched ahead of the click that needs it. */
export function loadSignIn() {
  return globalThis.google?.accounts?.oauth2 ? Promise.resolve() : loadScript(GIS);
}

function loadScript(src) {
  return new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = src;
    s.onload = resolve;
    s.onerror = () => reject(new Error('could not reach ' + src));
    document.head.appendChild(s);
  });
}

/** Drive query strings quote with ' and escape with \. */
const quote = (s) => `'${s.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;

export class Drive {
  /**
   * `dev` replaces Google with a stand-in for the test harness: a base URL
   * for the API and a fixed token, so no sign-in happens.
   */
  constructor({ clientId, scope, dev = null }) {
    this.clientId = clientId;
    this.scope = scope;
    this.base = dev?.base || 'https://www.googleapis.com';
    this.dev = !!dev?.token;
    this.token = dev?.token || null;
    this.expires = this.dev ? Infinity : 0;
    this.onExpire = () => {};
    this.client = null;
    this.pending = null;
  }

  get fresh() {
    return !!this.token && Date.now() < this.expires - SLACK_MS;
  }

  /**
   * Ask Google for a token. Opens a popup, so it must be called straight from
   * a click or a key press — before any `await` — or the browser blocks it.
   * After the first consent the popup closes itself.
   */
  signIn() {
    if (this.dev) {
      this.expires = Infinity;
      return Promise.resolve();
    }
    if (this.pending) return this.pending.promise;
    if (!globalThis.google?.accounts?.oauth2) {
      return Promise.reject(new Error('Google sign-in has not loaded yet. Try again in a moment.'));
    }
    this.client ||= google.accounts.oauth2.initTokenClient({
      client_id: this.clientId,
      scope: this.scope,
      callback: (r) => {
        const p = this.pending;
        this.pending = null;
        if (r.error) return p?.reject(new Error(r.error_description || r.error));
        this.token = r.access_token;
        this.expires = Date.now() + Number(r.expires_in) * 1000;
        p?.resolve();
      },
      error_callback: (e) => {
        const p = this.pending;
        this.pending = null;
        p?.reject(new Error(e.type === 'popup_closed'
          ? 'The Google sign-in window was closed.'
          : 'Google sign-in failed: ' + (e.message || e.type)));
      },
    });
    let resolve, reject;
    const promise = new Promise((a, b) => { resolve = a; reject = b; });
    this.pending = { promise, resolve, reject };
    this.client.requestAccessToken();
    return promise;
  }

  /** A token for the next call, renewing a stale one if we are inside a gesture. */
  ready() {
    return this.fresh ? Promise.resolve() : this.signIn();
  }

  async request(method, path, { query = {}, body, type, as = 'json', upload = false, signal } = {}) {
    if (!this.fresh) {
      this.onExpire();
      throw new SignInNeeded();
    }
    const url = new URL((upload ? '/upload' : '') + '/drive/v3' + path, this.base);
    for (const [k, v] of Object.entries(query)) url.searchParams.set(k, v);
    const headers = { Authorization: 'Bearer ' + this.token };
    if (type) headers['Content-Type'] = type;
    const r = await fetch(url, { method, headers, body, signal, cache: 'no-store' });
    if (r.status === 401) {
      this.expires = 0;
      this.onExpire();
      throw new SignInNeeded();
    }
    if (!r.ok) {
      let msg = r.statusText;
      try { msg = (await r.json()).error.message; } catch {}
      throw new Error(`Google Drive: ${msg} (${r.status})`);
    }
    return as === 'response' ? r : as === 'text' ? r.text() : r.json();
  }

  // -- reading ---------------------------------------------------------- //

  meta(id, fields = FIELDS) {
    return this.request('GET', `/files/${id}`, { query: { fields, supportsAllDrives: 'true' } });
  }

  /** Every file and folder directly inside `folderId`. */
  async children(folderId, extra = '') {
    const out = [];
    let pageToken = '';
    do {
      const query = {
        q: `${quote(folderId)} in parents and trashed = false${extra}`,
        fields: `nextPageToken,files(${FIELDS})`,
        pageSize: '1000',
        supportsAllDrives: 'true',
        includeItemsFromAllDrives: 'true',
      };
      if (pageToken) query.pageToken = pageToken;
      const r = await this.request('GET', '/files', { query });
      out.push(...r.files);
      pageToken = r.nextPageToken || '';
    } while (pageToken);
    return out;
  }

  /** The file called `name` in `folderId`, or null. Asks Drive, not a cache. */
  async find(folderId, name, { folder = false } = {}) {
    const kind = folder ? ` and mimeType = ${quote(FOLDER)}` : ` and mimeType != ${quote(FOLDER)}`;
    const hits = await this.children(folderId, ` and name = ${quote(name)}${kind}`);
    return hits[0] || null;
  }

  text(id) {
    return this.request('GET', `/files/${id}`, { query: { alt: 'media' }, as: 'text' });
  }

  /** The whole file as a Blob, reporting (bytes so far, total) as it arrives. */
  async blob(id, type, onProgress = () => {}, signal) {
    const r = await this.request('GET', `/files/${id}`, { query: { alt: 'media' }, as: 'response', signal });
    const total = Number(r.headers.get('Content-Length')) || 0;
    const reader = r.body.getReader();
    const chunks = [];
    let got = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      got += value.length;
      onProgress(got, total);
    }
    return new Blob(chunks, { type });
  }

  // -- writing ---------------------------------------------------------- //

  /** Replace a file's contents. Drive keeps the old one as a revision. */
  update(id, text, type) {
    return this.request('PATCH', `/files/${id}`, {
      upload: true,
      query: { uploadType: 'media', fields: FIELDS, supportsAllDrives: 'true' },
      body: text,
      type: type + '; charset=utf-8',
    });
  }

  async create(folderId, name, text, type) {
    const f = await this.request('POST', '/files', {
      query: { fields: FIELDS, supportsAllDrives: 'true' },
      body: JSON.stringify({ name, parents: [folderId], mimeType: type }),
      type: 'application/json',
    });
    return this.update(f.id, text, type);
  }

  folder(parentId, name) {
    return this.request('POST', '/files', {
      query: { fields: FIELDS, supportsAllDrives: 'true' },
      body: JSON.stringify({ name, parents: [parentId], mimeType: FOLDER }),
      type: 'application/json',
    });
  }

  copy(id, folderId, name) {
    return this.request('POST', `/files/${id}/copy`, {
      query: { fields: FIELDS, supportsAllDrives: 'true' },
      body: JSON.stringify({ name, parents: [folderId] }),
      type: 'application/json',
    });
  }
}
