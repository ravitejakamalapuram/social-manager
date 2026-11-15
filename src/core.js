/**
 * Shared pieces with no Google services in them: errors, ids, input checks and the platform list.
 */

const API_VERSION = '1.0.0';
const NAME_RE = /^[a-z0-9-]{1,40}$/;
const JOB_STATUSES = ['queued', 'running', 'done', 'failed', 'cancelled'];
const MAX_ATTEMPTS = 3;
// Each upload chunk is read from Drive and sent to the platform in one request.
// It must stay under Apps Script's 50 MB fetch limit and be a multiple of 256 KB.
let CHUNK_BYTES = 20 * 1024 * 1024;
// A worker run stops starting new work after this long, well inside Apps Script's 6 minute limit.
let WORK_BUDGET_MS = 4 * 60 * 1000;

class ApiError extends Error {
  constructor(code, message, details) {
    super(message);
    this.code = code;
    this.details = details;
  }
}

/** Every publishing platform. Adding Instagram later means one new file and one line here. */
function platforms_() {
  return { youtube: YouTube, linkedin: LinkedIn };
}

function adapterFor_(name) {
  const a = platforms_()[name];
  if (!a) throw new ApiError('invalid', `Unknown platform "${name}". Platforms: ${Object.keys(platforms_()).join(', ')}`);
  return a;
}

// ---------- input checks used by the adapters ----------

function optText_(v, field, max) {
  if (v === undefined || v === null || v === '') return null;
  if (typeof v !== 'string') throw new ApiError('invalid', `${field} must be text`);
  if (v.length > max) throw new ApiError('invalid', `${field} is ${v.length} characters; the limit is ${max}`);
  return v;
}

function optBool_(v, field) {
  if (v === undefined || v === null) return null;
  if (typeof v !== 'boolean') throw new ApiError('invalid', `${field} must be true or false`);
  return v;
}

/** A file the service reads: {"driveFileId": "..."}. */
function optFile_(v, field) {
  if (v === undefined || v === null) return null;
  if (!v || typeof v !== 'object' || typeof v.driveFileId !== 'string' || !v.driveFileId) {
    throw new ApiError('invalid', `${field} must look like {"driveFileId": "..."}`);
  }
  return { driveFileId: v.driveFileId };
}

function optFutureTime_(v, field, now) {
  if (v === undefined || v === null || v === '') return null;
  const d = new Date(v);
  if (typeof v !== 'string' || isNaN(d.getTime())) throw new ApiError('invalid', `${field} must be an ISO time like 2026-11-20T14:00:00Z`);
  if (d.getTime() < now.getTime() + 15 * 60 * 1000) throw new ApiError('invalid', `${field} must be at least 15 minutes in the future`);
  return d.toISOString();
}

// ---------- jobs ----------

function newJobId_(now, rand) {
  return `j-${now.toISOString().replace(/\D/g, '').slice(0, 12)}-${rand}`;
}

/** What callers see: everything except the adapter's private working state. */
function presentJob_(job) {
  const s = job.state || {};
  const out = {
    id: job.id, key: job.key || null, platform: job.platform, status: job.status, title: job.title,
    attempts: job.attempts || 0, notBefore: job.notBefore || null, createdAt: job.createdAt, updatedAt: job.updatedAt,
    caller: job.caller, result: job.result || null, error: job.error || null,
  };
  if (job.status === 'queued' || job.status === 'running') {
    out.progress = { step: s.step || null, uploadedBytes: s.offset || 0, totalBytes: s.size || null };
  }
  return out;
}

/** The oldest queued job that is allowed to run now. A job left "running" by a crashed run counts as queued after 10 minutes. */
function pickNextJob_(jobs, now) {
  const t = now.getTime();
  return jobs
    .filter((j) => (j.status === 'queued' && (!j.notBefore || new Date(j.notBefore).getTime() <= t))
      || (j.status === 'running' && new Date(j.updatedAt).getTime() < t - 10 * 60 * 1000))
    .sort((a, b) => (a.createdAt < b.createdAt ? -1 : 1))[0] || null;
}

/** Decides what happens to a job after a step throws. */
function afterError_(job, err, now) {
  const retry = err && err.details && err.details.retry;
  const message = String(err && err.message ? err.message : err);
  if (retry === 'quota') {
    // Daily quota resets at midnight Pacific time; try again in an hour rather than computing it exactly.
    return { status: 'queued', notBefore: new Date(now.getTime() + 60 * 60 * 1000).toISOString(), error: `Waiting for quota: ${message}` };
  }
  const attempts = (job.attempts || 0) + 1;
  if (retry === 'transient' && attempts < MAX_ATTEMPTS) {
    return { status: 'queued', attempts, notBefore: new Date(now.getTime() + 5 * 60 * 1000).toISOString(), error: `Will retry: ${message}` };
  }
  return { status: 'failed', attempts, error: message };
}
