// In-memory stand-ins for the Apps Script services and the Drive and YouTube APIs, so the code runs end to end in Node.
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

function fakeSheet(header) {
  const rows = [header.slice()];
  const range = (r, c, nr, nc) => ({
    getValues: () => Array.from({ length: nr }, (_, i) => Array.from({ length: nc }, (_, j) => ((rows[r - 1 + i] || [])[c - 1 + j] ?? ''))),
    setValues: (v) => v.forEach((row, i) => { rows[r - 1 + i] = rows[r - 1 + i] || []; row.forEach((x, j) => { rows[r - 1 + i][c - 1 + j] = x; }); }),
    createTextFinder: (text) => ({
      matchEntireCell: () => ({
        findNext: () => {
          for (let i = 0; i < nr; i++) if (String((rows[r - 1 + i] || [])[c - 1]) === text) return { getRow: () => r + i };
          return null;
        },
      }),
    }),
  });
  return { rows, getLastRow: () => rows.length, getRange: range, appendRow: (row) => rows.push(row.slice()) };
}

const res = (code, body, headers, bytes) => ({
  getResponseCode: () => code,
  getContentText: () => (typeof body === 'string' ? body : JSON.stringify(body || {})),
  getHeaders: () => headers || {},
  getContent: () => bytes || [],
});
const err = (code, reason) => res(code, { error: { message: reason, errors: [{ reason }] } });

/** Fake Drive + YouTube. `fail` lets a test make one kind of call fail. */
function fakeGoogle() {
  const g = {
    meta: { uploads: {}, published: [] }, files: {}, videos: {}, sessions: {}, thumbnails: {}, captions: [], playlistItems: [],
    playlists: [{ id: 'PLdocs', snippet: { title: 'Documentaries' } }],
    calls: [], fail: {}, li: { parts: [], status: [] },
  };
  g.fetch = (url, p) => {
    const u = new URL(url);
    const m = (p.method || 'get').toLowerCase();
    g.calls.push(`${m} ${u.pathname}`);
    for (const [k, f] of Object.entries(g.fail)) {
      if (!`${m} ${u.pathname}`.includes(k)) continue;
      if (f.skip > 0) { f.skip--; continue; }
      if (f.times > 0) { f.times--; return err(f.code, f.reason); }
    }
    const fileId = u.pathname.split('/files/')[1];
    if (u.host === 'www.googleapis.com' && fileId) {
      const f = g.files[decodeURIComponent(fileId)];
      if (!f) return err(404, 'notFound');
      if (u.searchParams.get('alt') !== 'media') return res(200, { name: f.name, size: String(f.bytes.length), mimeType: f.mime });
      const range = p.headers.Range;
      if (!range) return res(200, '', {}, f.bytes);
      const [a, b] = range.replace('bytes=', '').split('-').map(Number);
      return res(206, '', {}, f.bytes.slice(a, b + 1));
    }
    if (u.pathname === '/upload/youtube/v3/videos') {
      const sid = `s${Object.keys(g.sessions).length + 1}`;
      g.sessions[sid] = { meta: JSON.parse(p.payload), size: Number(p.headers['X-Upload-Content-Length']), got: [] };
      return res(200, '', { Location: `https://upload.example/session/${sid}` });
    }
    if (u.host === 'upload.example') {
      const s = g.sessions[u.pathname.split('/').pop()];
      const [, a, b, total] = /bytes (\d+)-(\d+)\/(\d+)/.exec(p.headers['Content-Range']).map(Number);
      if (a !== s.got.length) return err(400, 'badOffset');
      s.got.push(...p.payload);
      if (s.got.length < total) return res(308, '', { Range: `bytes=0-${b}` });
      const id = `v${Object.keys(g.videos).length + 1}`;
      g.videos[id] = { id, snippet: s.meta.snippet, status: Object.assign({ uploadStatus: 'uploaded' }, s.meta.status, g.locked ? { privacyStatus: 'private' } : {}), bytes: s.got };
      return res(201, { id });
    }
    if (u.pathname === '/youtube/v3/videos' && m === 'get') {
      const v = g.videos[u.searchParams.get('id')];
      return res(200, { items: v ? [{ id: v.id, snippet: v.snippet, status: v.status }] : [] });
    }
    if (u.pathname === '/youtube/v3/videos' && m === 'put') {
      const body = JSON.parse(p.payload);
      Object.assign(g.videos[body.id], { snippet: body.snippet, status: body.status });
      return res(200, body);
    }
    if (u.pathname === '/upload/youtube/v3/thumbnails/set') { g.thumbnails[u.searchParams.get('videoId')] = p.payload; return res(200, {}); }
    if (u.pathname === '/upload/youtube/v3/captions') { g.captions.push(Buffer.from(p.payload).toString('utf8')); return res(200, {}); }
    if (u.pathname === '/youtube/v3/playlists') return res(200, { items: g.playlists });
    if (u.pathname === '/youtube/v3/playlistItems') { g.playlistItems.push(JSON.parse(p.payload).snippet); return res(200, {}); }
    if (u.host === 'api.linkedin.com' || u.host === 'li-upload.example') return fakeLinkedIn(g, u, m, p);
    if (u.host === 'graph.facebook.com' || u.host === 'rupload.facebook.com') return fakeMeta(g, u, m, p);
    if (u.pathname === '/youtube/v3/channels') return res(200, { items: [{ id: 'UC1', snippet: { title: 'My channel' } }] });
    return err(500, `unhandled ${m} ${url}`);
  };
  return g;
}

/** Fake LinkedIn: userinfo, Videos API (4-byte parts here), Posts API. */
function fakeLinkedIn(g, u, m, p) {
  const li = g.li;
  if (u.pathname === '/v2/userinfo') return res(200, { sub: 'abc', name: 'Pat Doe' });
  if (u.searchParams.get('action') === 'initializeUpload') {
    const r = JSON.parse(p.payload).initializeUploadRequest;
    li.init = r;
    const parts = [];
    for (let a = 0; a < r.fileSizeBytes; a += 4) parts.push({ firstByte: a, lastByte: Math.min(a + 4, r.fileSizeBytes) - 1, uploadUrl: `https://li-upload.example/part/${parts.length}` });
    return res(200, { value: { video: 'urn:li:video:V1', uploadToken: 'tok', uploadInstructions: parts, thumbnailUploadUrl: r.uploadThumbnail ? 'https://li-upload.example/thumb' : undefined } });
  }
  if (u.host === 'li-upload.example') {
    if (u.pathname === '/thumb') { li.thumb = p.payload; return res(201, ''); }
    li.parts.push(...p.payload);
    return res(200, '', { ETag: `"e${u.pathname.split('/').pop()}"` });
  }
  if (u.searchParams.get('action') === 'finalizeUpload') { li.finalize = JSON.parse(p.payload).finalizeUploadRequest; return res(200, ''); }
  if (u.pathname.startsWith('/rest/videos/')) return res(200, { status: li.status.shift() || 'AVAILABLE' });
  if (u.pathname === '/rest/posts') { li.post = JSON.parse(p.payload); li.headers = p.headers; return res(201, '', { 'x-restli-id': 'urn:li:share:7' }); }
  return err(500, `unhandled linkedin ${m} ${u}`);
}

/** Fake Meta Graph API: Instagram containers and Facebook Page Reels. */
function fakeMeta(g, u, m, p) {
  const meta = g.meta;
  const parts = u.pathname.split('/').filter(Boolean).slice(1); // drop the version
  if (u.host === 'rupload.facebook.com') {
    const id = parts[parts.length - 1];
    const up = meta.uploads[id];
    if (meta.failNextUpload) { meta.failNextUpload = false; return res(400, {}); }
    if (Number(p.headers.offset) !== up.got.length) return res(400, { error: { code: 100, message: 'bad offset' } });
    up.got.push(...p.payload);
    // Meta's spurious answer on a whole upload: the bytes arrive, yet it says the request failed.
    if (meta.processingFailed) return res(400, { debug_info: { retriable: false, type: 'ProcessingFailedError', message: 'Request processing failed' } });
    return res(200, { success: true });
  }
  const q = m === 'get' ? Object.fromEntries(u.searchParams) : Object.fromEntries(new URLSearchParams(p.payload));
  if (q.access_token !== 'page-token') return res(400, { error: { code: 190, message: 'Invalid OAuth access token' } });
  if (parts[1] === 'media' && m === 'post') {
    const id = `c${Object.keys(meta.uploads).length + 1}`;
    meta.uploads[id] = { kind: 'ig', params: q, got: [], polls: 0 };
    return res(200, { id, uri: `https://rupload.facebook.com/ig-api-upload/v24.0/${id}` });
  }
  if (parts[1] === 'media_publish') {
    const id = `m${meta.published.length + 1}`;
    meta.published.push({ id, container: q.creation_id });
    return res(200, { id });
  }
  if (parts[1] === 'video_reels' && q.upload_phase === 'start') {
    const id = `r${Object.keys(meta.uploads).length + 1}`;
    meta.uploads[id] = { kind: 'fb', got: [], polls: 0 };
    return res(200, { video_id: id, upload_url: `https://rupload.facebook.com/video-upload/v24.0/${id}` });
  }
  if (parts[1] === 'video_reels' && q.upload_phase === 'finish') { meta.uploads[q.video_id].finish = q; return res(200, { success: true }); }
  if (parts[0] === 'ig1' && parts[1] === 'media') return res(200, { data: [{ id: 'm7', permalink: 'https://www.instagram.com/reel/m7/', caption: 'Why Hubble is falling\n#space', timestamp: '2026-11-15T00:00:00+0000', like_count: 40, comments_count: 3 }, { id: 'm8', permalink: 'p8', caption: 'B', like_count: 1, comments_count: 0 }] });
  if (parts[1] === 'insights') return meta.noInsights ? res(400, { error: { code: 10, message: 'needs instagram_manage_insights' } }) : res(200, { data: [{ name: 'views', values: [{ value: 812 }] }, { name: 'reach', values: [{ value: 700 }] }] });
  if (parts[0] === 'page1' && parts[1] === 'video_reels') return res(200, { data: [{ id: 'v1', permalink_url: '/reel/v1', description: 'Mangroves', created_time: '2026-11-15T00:00:00+0000', likes: { summary: { total_count: 9 } }, comments: { summary: { total_count: 1 } } }] });
  if (parts[1] === 'video_insights') return res(200, { data: [{ name: 'blue_reels_play_count', values: [{ value: 150 }] }] });
  if (parts[0] === 'ig1' && q.fields === 'followers_count') return res(200, { followers_count: 41 });
  if (parts[0] === 'page1' && q.fields === 'followers_count,fan_count') return res(200, { followers_count: 3 });
  const up = meta.uploads[parts[0]];
  if (up && up.kind === 'ig') {
    if (meta.gone && meta.gone.includes(parts[0])) return res(400, { error: { code: 100, error_subcode: 33, message: `Unsupported get request. Object with ID '${parts[0]}' does not exist` } });
    if (up.params.video_url && /video_status/.test(q.fields)) return res(400, { error: { code: 100, error_subcode: 2207065, message: 'video_status is not a valid parameter for the media type' } });
    if (up.params.video_url) return res(200, { status_code: up.polls++ < 1 ? 'IN_PROGRESS' : meta.urlStatus || 'FINISHED', status: meta.urlStatus === 'ERROR' ? 'Error: Media upload has failed with error code 2207052' : undefined });
    return res(200, { status_code: up.polls++ < 1 ? 'IN_PROGRESS' : meta.igStatus || 'FINISHED', video_status: { uploading_phase: { bytes_transferred: meta.igBytes != null ? meta.igBytes : up.got.length } } });
  }
  if (up && up.kind === 'fb') return res(200, { status: { video_status: up.polls++ < 1 ? 'processing' : 'ready' }, permalink_url: `/reel/${parts[0]}` });
  if (parts[0].startsWith('m')) return res(200, { permalink: `https://www.instagram.com/reel/${parts[0]}/`, timestamp: '2026-11-15T00:00:00+0000' });
  if (parts[0] === 'ig1') return res(200, { username: 'howto' });
  if (parts[0] === 'page1') return res(200, { name: 'How To', link: 'https://www.facebook.com/howto' });
  return res(500, { error: { code: 1, message: `unhandled ${m} ${u}` } });
}

function load() {
  const store = {};
  const google = fakeGoogle();
  const ctx = vm.createContext({
    console: { log() {}, error() {} },
    ScriptApp: { getOAuthToken: () => 'oauth' },
    UrlFetchApp: { fetch: google.fetch },
    PropertiesService: { getScriptProperties: () => ({ getProperty: (k) => store[k] ?? null, setProperty: (k, v) => { store[k] = String(v); }, deleteProperty: (k) => { delete store[k]; } }) },
    LockService: { getScriptLock: () => ({ tryLock: () => true, releaseLock: () => {} }) },
    ContentService: { MimeType: { JSON: 'json' }, createTextOutput: (s) => ({ setMimeType: () => ({ body: s }) }) },
    Utilities: {
      DigestAlgorithm: { SHA_256: 'sha256' },
      Charset: { UTF_8: 'utf8' },
      computeDigest: (alg, s) => [...crypto.createHash('sha256').update(s, 'utf8').digest()].map((b) => (b > 127 ? b - 256 : b)),
      getUuid: () => crypto.randomUUID(),
      sleep: () => {},
      newBlob: (str) => ({ getBytes: () => [...Buffer.from(str, 'utf8')] }),
    },
  });
  for (const f of ['core', 'google', 'youtube', 'youtube-auth', 'meta', 'instagram', 'facebook', 'linkedin', 'store', 'worker', 'api']) {
    vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'src', `${f}.js`), 'utf8'), ctx, { filename: `${f}.js` });
  }
  vm.runInContext('WAIT_MS = 0', ctx); // a waiting job is due again at once, so tests don't sit out the wait
  const sheet = fakeSheet(vm.runInContext('JOB_COLS', ctx));
  ctx.SpreadsheetApp = { openById: () => ({ getSheetByName: () => sheet }) };
  store.SHEET_ID = 'fake';
  const admin = vm.runInContext("issueToken_('admin', true)", ctx);
  const call = (method, body) => {
    const e = method === 'GET' ? { parameter: body } : { parameter: {}, postData: { contents: JSON.stringify(body) } };
    return JSON.parse(ctx[method === 'GET' ? 'doGet' : 'doPost'](e).body);
  };
  const run = (code) => vm.runInContext(code, ctx);
  return { call, admin, google, sheet, run, store };
}

module.exports = { load };
