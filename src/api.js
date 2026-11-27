/**
 * Web app entry points and the API actions.
 *
 * Every call: GET ?action=...&token=... or POST with a JSON body {"action": ..., "token": ..., ...}.
 * Apps Script always answers HTTP 200, so success or failure is in the body:
 *   {"ok": true, ...}  or  {"ok": false, "error": {"code": "...", "message": "...", "details": {...}}}
 */

function doGet(e) { return handle_(e, 'GET'); }
function doPost(e) { return handle_(e, 'POST'); }

const ROUTES = {
  health: { auth: false, fn: health_ },
  platforms: { fn: platformsInfo_ },
  video: { fn: videoInfo_ },
  channel: { fn: (req) => adapterFor_(req.platform || 'youtube').whoami() },
  stats: { fn: (req) => stats_(req) },
  comments: { fn: (req) => comments_(req) },
  reply: { write: true, fn: reply_ },
  publish: { write: true, fn: publish_ },
  connectYouTube: { write: true, admin: true, fn: (req) => ({ url: connectYouTube(req.account || ''), account: req.account || null }) },
  connectMeta: { write: true, admin: true, fn: (req) => ({ url: connectMeta(req.account || '', req.match || ''), account: req.account || null }) },
  connectThreads: { write: true, admin: true, fn: (req) => ({ url: connectThreads(req.account || ''), account: req.account || null }) },
  get: { fn: (req) => ({ job: presentJob_(jobByIdOrKey_(req)) }) },
  list: { fn: list_ },
  retry: { write: true, fn: retry_ },
  cancel: { write: true, fn: cancel_ },
  run: { write: true, admin: true, fn: () => runQueue_() },
  deploy: { write: true, admin: true, fn: (req) => deployLatest_(req.force === true, req.ref) },
  createToken: { write: true, admin: true, fn: createToken_ },
  revokeToken: { write: true, admin: true, fn: revokeToken_ },
  listTokens: { admin: true, fn: listTokens_ },
};

function handle_(e, method) {
  try {
    const req = parseRequest_(e, method);
    const route = ROUTES[req.action || 'health'];
    if (!route) throw new ApiError('unknown_action', `Unknown action "${req.action}". Actions: ${Object.keys(ROUTES).join(', ')}`);
    if (route.write && method !== 'POST') throw new ApiError('method_not_allowed', `${req.action} needs POST`);
    const caller = route.auth === false ? null : authenticate_(req.token);
    if (route.admin && !caller.admin) throw new ApiError('forbidden', 'This action needs an admin token.');
    ACCOUNT = accountName_(req.account);
    return json_(Object.assign({ ok: true }, route.fn(req, caller)));
  } catch (err) {
    if (err instanceof ApiError) {
      return json_({ ok: false, error: { code: err.code, message: err.message, details: err.details || null } });
    }
    console.error(err && err.stack ? err.stack : err);
    return json_({ ok: false, error: { code: 'internal', message: String(err && err.message ? err.message : err), details: null } });
  }
}

function parseRequest_(e, method) {
  const req = Object.assign({}, (e && e.parameter) || {});
  if (method === 'POST' && e && e.postData && e.postData.contents) {
    let body;
    try { body = JSON.parse(e.postData.contents); } catch (err) { throw new ApiError('bad_json', 'The POST body must be JSON.'); }
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new ApiError('bad_json', 'The POST body must be a JSON object.');
    Object.assign(req, body);
  }
  return req;
}

function json_(o) {
  return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON);
}

// ---------- auth: tokens are stored only as SHA-256 hashes in Script Properties ----------

function sha256Hex_(s) {
  return Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, String(s), Utilities.Charset.UTF_8)
    .map((b) => ((b + 256) % 256).toString(16).padStart(2, '0')).join('');
}

function tokens_() {
  return JSON.parse(props_().getProperty('TOKENS') || '{}');
}

function authenticate_(token) {
  if (!token) throw new ApiError('unauthorized', 'token is required');
  const entry = tokens_()[sha256Hex_(token)];
  if (!entry) throw new ApiError('unauthorized', 'Unknown or revoked token');
  return entry;
}

/** Creates a token for a named client. The plain token is returned once and never stored. */
function issueToken_(name, admin) {
  if (!NAME_RE.test(String(name || ''))) throw new ApiError('invalid', 'name must be lowercase letters, digits or dashes (max 40)');
  const all = tokens_();
  if (Object.keys(all).some((h) => all[h].name === name)) throw new ApiError('conflict', `A token named ${name} exists; revoke it first`);
  const token = Utilities.getUuid().replace(/-/g, '') + Utilities.getUuid().replace(/-/g, '');
  all[sha256Hex_(token)] = { name, admin: !!admin, createdAt: new Date().toISOString() };
  props_().setProperty('TOKENS', JSON.stringify(all));
  return token;
}

function createToken_(req) {
  return withLock_(() => ({ name: req.name, admin: req.admin === true, token: issueToken_(req.name, req.admin === true) }));
}

function revokeToken_(req, caller) {
  return withLock_(() => {
    const all = tokens_();
    const hashes = Object.keys(all).filter((h) => all[h].name === req.name);
    if (!hashes.length) throw new ApiError('not_found', `No token named ${req.name}`);
    if (req.name === caller.name) throw new ApiError('invalid', 'You cannot revoke the token you are calling with');
    hashes.forEach((h) => { delete all[h]; });
    props_().setProperty('TOKENS', JSON.stringify(all));
    return { revoked: req.name };
  });
}

function listTokens_() {
  const all = tokens_();
  return { tokens: Object.keys(all).map((h) => all[h]) };
}

// ---------- jobs ----------

function health_() {
  return { service: 'social-media-publisher', version: API_VERSION, platforms: Object.keys(platforms_()), time: new Date().toISOString() };
}

/** Followers and the newest posts' numbers on one platform, for platforms whose adapter has stats(). */
function stats_(req) {
  const name = String(req.platform || '');
  const a = adapterFor_(name);
  if (typeof a.stats !== 'function') throw new ApiError('invalid', `${name} has no stats yet. Platforms with stats: ${Object.keys(platforms_()).filter((k) => platforms_()[k].stats).join(', ')}`);
  const limit = Math.min(Math.max(Number(req.limit) || 25, 1), 100);
  return Object.assign({ platform: name }, a.stats(limit));
}

function comments_(req) {
  const name = String(req.platform || '');
  const a = adapterFor_(name);
  if (typeof a.comments !== 'function') throw new ApiError('invalid', `${name} has no comments yet. Platforms with comments: ${Object.keys(platforms_()).filter((k) => platforms_()[k].comments).join(', ')}`);
  const limit = Math.min(Math.max(Number(req.limit) || 20, 1), 100);
  return Object.assign({ platform: name }, a.comments(limit));
}

function reply_(req) {
  const name = String(req.platform || '');
  const a = adapterFor_(name);
  if (typeof a.reply !== 'function') throw new ApiError('invalid', `${name} cannot reply to comments yet`);
  const commentId = optText_(req.commentId, 'commentId', 200);
  const text = optText_(req.text, 'text', 10000);
  if (!commentId || !text) throw new ApiError('invalid', 'Send commentId and text');
  return Object.assign({ platform: name }, a.reply(commentId, text));
}

function platformsInfo_() {
  const all = platforms_();
  const limits = {};
  Object.keys(all).forEach((k) => { limits[k] = all[k].limits || {}; });
  return { platforms: Object.keys(all), limits };
}

/** A Drive video's name, size and length, read from Drive's metadata, so a caller can check lengths without downloading. */
function videoInfo_(req) {
  const id = optText_(req.driveFileId, 'driveFileId', 200);
  if (!id) throw new ApiError('invalid', 'Send driveFileId');
  const m = driveMeta_(id);
  const v = m.videoMediaMetadata || {};
  return { video: { driveFileId: id, name: m.name, size: Number(m.size), seconds: v.durationMillis != null ? Number(v.durationMillis) / 1000 : null } };
}

/**
 * Refuses a video longer than the platform takes (the adapter's limits.seconds), using Drive's metadata.
 * When Drive has not measured the video yet, the post goes ahead and the platform has the last word.
 */
function checkVideoLength_(adapter, post) {
  const max = (adapter.limits || {}).seconds;
  if (!max || !post.video || !post.video.driveFileId) return;
  const s = driveVideoSeconds_(post.video.driveFileId);
  if (s != null && s > max) {
    throw new ApiError('invalid', `The video is ${Math.round(s * 10) / 10} s; ${adapter.name} takes at most ${max} s. Send a shorter version.`);
  }
}

function jobByIdOrKey_(req) {
  if (req.id) return jobOrThrow_(req.id).job;
  if (req.key) {
    const j = allJobs_().filter((x) => x.key === String(req.key) && x.status !== 'cancelled').pop();
    if (!j) throw new ApiError('not_found', `No job with key ${req.key}`);
    return j;
  }
  throw new ApiError('invalid', 'Send id or key');
}

/**
 * Queues a post. With a key, sending the same post again returns the first job instead of posting twice,
 * so a caller can safely retry after a timeout.
 */
function publish_(req, caller) {
  const adapter = adapterFor_(req.platform);
  const now = new Date();
  const post = adapter.validate(req, now);
  checkVideoLength_(adapter, post);
  if (adapter.name === 'youtube' && ACCOUNT) {
    if (!ytAccountConnected_(ACCOUNT)) throw new ApiError('not_connected', `The YouTube account "${ACCOUNT}" is not connected; call connectYouTube with that account first`);
    post.account = ACCOUNT;
  }
  if ((adapter.name === 'instagram' || adapter.name === 'facebook') && ACCOUNT) {
    if (!metaConnected_(ACCOUNT)) throw new ApiError('not_connected', `The Meta account "${ACCOUNT}" is not connected; call connectMeta with that account first`);
    post.account = ACCOUNT;
  }
  if (adapter.name === 'threads' && ACCOUNT) {
    if (!threadsConnected_(ACCOUNT)) throw new ApiError('not_connected', `The Threads account "${ACCOUNT}" is not connected; call connectThreads with that account first`);
    post.account = ACCOUNT;
  }
  const key = optText_(req.key, 'key', 100);
  return withLock_(() => {
    if (key) {
      const prior = allJobs_().find((j) => j.key === key && j.status !== 'cancelled');
      if (prior) return { job: presentJob_(prior), existing: true };
    }
    const iso = now.toISOString();
    const job = {
      id: newJobId_(now, Utilities.getUuid().slice(0, 4)), key, platform: adapter.name, status: 'queued',
      title: post.title || post.videoId || '', attempts: 0, notBefore: post.notBefore || null, createdAt: iso, updatedAt: iso,
      caller: caller.name, result: null, error: null, post, state: {},
    };
    insertJob_(job);
    return { job: presentJob_(job), existing: false };
  });
}

function list_(req) {
  if (req.status && !JOB_STATUSES.includes(req.status)) throw new ApiError('invalid', `status must be one of ${JOB_STATUSES.join(', ')}`);
  const limit = Math.min(Math.max(Number(req.limit) || 20, 1), 200);
  const jobs = allJobs_()
    .filter((j) => (!req.status || j.status === req.status) && (!req.platform || j.platform === req.platform))
    .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))
    .slice(0, limit);
  return { jobs: jobs.map(presentJob_) };
}

/** Puts a failed job back in the queue. It carries on from the step that failed, so nothing is posted twice. */
function retry_(req) {
  const job = jobOrThrow_(req.id).job;
  if (job.status !== 'failed') throw new ApiError('invalid', `Only a failed job can be retried; this one is ${job.status}`);
  Object.assign(job, { status: 'queued', attempts: 0, notBefore: null, error: null });
  saveJob_(job);
  return { job: presentJob_(job) };
}

function cancel_(req) {
  const job = jobOrThrow_(req.id).job;
  if (job.status !== 'queued') throw new ApiError('invalid', `Only a queued job can be cancelled; this one is ${job.status}`);
  if (job.state && job.state.videoId) throw new ApiError('invalid', 'This job already uploaded its video; delete it on the platform instead');
  job.status = 'cancelled';
  saveJob_(job);
  return { job: presentJob_(job) };
}
