/**
 * Jobs live in the "Jobs" tab of the Social Manager spreadsheet, one row each, so the owner can read them.
 */

const JOB_COLS = ['id', 'key', 'platform', 'status', 'title', 'attempts', 'notBefore', 'createdAt', 'updatedAt', 'caller', 'result', 'error', 'post', 'state'];
const JSON_COLS = ['result', 'post', 'state'];

function props_() {
  return PropertiesService.getScriptProperties();
}

function jobsSheet_() {
  const id = props_().getProperty('SHEET_ID');
  if (!id) throw new ApiError('not_set_up', 'Run setup() in the Apps Script editor first');
  return SpreadsheetApp.openById(id).getSheetByName('Jobs');
}

function withLock_(fn) {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(20000)) throw new ApiError('busy', 'The service is busy; try again in a few seconds', { retry: 'transient' });
  try { return fn(); } finally { lock.releaseLock(); }
}

function rowToJob_(row) {
  const j = {};
  JOB_COLS.forEach((c, i) => {
    const v = row[i];
    j[c] = JSON_COLS.includes(c) ? (v ? JSON.parse(v) : null) : (v === '' ? null : v);
  });
  j.attempts = Number(j.attempts || 0);
  j.state = j.state || {};
  return j;
}

function jobToRow_(j) {
  return JOB_COLS.map((c) => {
    const v = j[c];
    if (JSON_COLS.includes(c)) return v ? JSON.stringify(v) : '';
    return v === null || v === undefined ? '' : v;
  });
}

function allJobs_() {
  const sh = jobsSheet_();
  const n = sh.getLastRow() - 1;
  if (n < 1) return [];
  return sh.getRange(2, 1, n, JOB_COLS.length).getValues().filter((r) => r[0]).map(rowToJob_);
}

function findJob_(id) {
  const sh = jobsSheet_();
  const n = sh.getLastRow() - 1;
  if (n < 1) return null;
  const hit = sh.getRange(2, 1, n, 1).createTextFinder(String(id)).matchEntireCell(true).findNext();
  if (!hit) return null;
  return { row: hit.getRow(), job: rowToJob_(sh.getRange(hit.getRow(), 1, 1, JOB_COLS.length).getValues()[0]) };
}

function jobOrThrow_(id) {
  const f = findJob_(id);
  if (!f) throw new ApiError('not_found', `No job ${id}`);
  return f;
}

function insertJob_(job) {
  jobsSheet_().appendRow(jobToRow_(job));
}

function saveJob_(job) {
  job.updatedAt = new Date().toISOString();
  withLock_(() => {
    const f = jobOrThrow_(job.id);
    jobsSheet_().getRange(f.row, 1, 1, JOB_COLS.length).setValues([jobToRow_(job)]);
  });
}
