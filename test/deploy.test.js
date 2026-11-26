const test = require('node:test');
const assert = require('node:assert/strict');
const { load } = require('./fakes.cjs');

const SHA = 'a'.repeat(40);

/** A fake GitHub raw host and Apps Script API; `code` maps a ref ("main" or a SHA) to the bundle it serves. */
function fakeDeploy(run, code) {
  const g = run('globalThis');
  const seen = [];
  g.ScriptApp.getScriptId = () => 'script1';
  g.UrlFetchApp.fetch = (url, p) => {
    seen.push(`${(p && p.method) || 'get'} ${url}`);
    const m = url.match(/^https:\/\/raw\.githubusercontent\.com\/[^/]+\/[^/]+\/([^/]+)\/(.+)$/);
    const res = (c, body) => ({ getResponseCode: () => c, getContentText: () => (typeof body === 'string' ? body : JSON.stringify(body)), getHeaders: () => ({}) });
    if (m) return res(200, m[2] === 'dist/Code.js' ? code[m[1]] : '{}');
    if (url.endsWith('/versions')) return res(200, { versionNumber: 7 });
    if (url.endsWith('/deployments')) return res(200, { deployments: [] });
    return res(200, {});
  };
  return seen;
}

test('deploy: a commit SHA deploys that exact commit, and the hourly run then leaves it alone', () => {
  const { call, admin, run } = load();
  const seen = fakeDeploy(run, { [SHA]: 'new', main: 'stale' });
  const r = call('POST', { action: 'deploy', token: admin, ref: SHA });
  assert.equal(r.ok, true);
  assert.equal(r.deployed, true);
  assert.ok(seen.some((s) => s.includes(`/${SHA}/dist/Code.js`)));
  const hourly = run('deployLatest_(false)');
  assert.equal(hourly.deployed, false);
  assert.match(hourly.reason, /last 15 minutes/);
});

test('deploy: rejects a ref that is not a full commit SHA', () => {
  const { call, admin, run } = load();
  fakeDeploy(run, {});
  const r = call('POST', { action: 'deploy', token: admin, ref: 'main/../x' });
  assert.equal(r.error.code, 'invalid');
});
