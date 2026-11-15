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
  channel: { fn: (req) => adapterFor_(req.platform || 'youtube').whoami() },
  publish: { write: true, fn: publish_ },
  get: { fn: (req) => ({ job: presentJob_(jobByIdOrKey_(req)) }) },
  list: { fn: list_ },
  retry: { write: true, fn: retry_ },
  cancel: { write: true, fn: cancel_ },
  run: { write: true, admin: true, fn: () => runQueue_() },
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
  return { service: 'social-manager', version: API_VERSION, platforms: Object.keys(platforms_()), time: new Date().toISOString() };
}

function platformsInfo_() {
  return { platforms: Object.keys(platforms_()) };
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
  const key = optText_(req.key, 'key', 100);
  return withLock_(() => {
    if (key) {
      const prior = allJobs_().find((j) => j.key === key && j.status !== 'cancelled');
      if (prior) return { job: presentJob_(prior), existing: true };
    }
    const iso = now.toISOString();
    const job = {
      id: newJobId_(now, Utilities.getUuid().slice(0, 4)), key, platform: adapter.name, status: 'queued',
      title: post.title || post.videoId || '', attempts: 0, notBefore: null, createdAt: iso, updatedAt: iso,
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
