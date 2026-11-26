const test = require('node:test');
const assert = require('node:assert/strict');
const { load } = require('./fakes.cjs');

const DAY = 86400000;
function setup(daysLeft = 59, renewedDaysAgo = 1) {
  const t = load();
  Object.assign(t.store, {
    THREADS_TOKEN: 'th-token', THREADS_USER_ID: 'tu1',
    THREADS_EXPIRES_AT: new Date(Date.now() + daysLeft * DAY).toISOString(),
    THREADS_RENEWED_AT: new Date(Date.now() - renewedDaysAgo * DAY).toISOString(),
  });
  return t;
}
const post = (t, extra) => t.call('POST', Object.assign({ action: 'publish', token: t.admin, platform: 'threads', video: { url: 'https://x.example/v.mp4' }, text: 'Why is the sea salty? #science' }, extra));
const runAll = (t) => { for (let i = 0; i < 5; i++) t.call('POST', { action: 'run', token: t.admin }); };

test('threads: container from the link, waits for processing, publishes once', () => {
  const t = setup();
  const q = post(t);
  assert.equal(q.ok, true, JSON.stringify(q));
  runAll(t);
  const job = t.call('GET', { action: 'get', token: t.admin, id: q.job.id }).job;
  assert.equal(job.status, 'done', JSON.stringify(job));
  assert.equal(job.result.url, 'https://www.threads.net/@howto/post/tm1');
  const c = t.google.th.containers.tc1;
  assert.equal(c.params.media_type, 'VIDEO');
  assert.equal(c.params.video_url, 'https://x.example/v.mp4');
  assert.equal(c.params.text, 'Why is the sea salty? #science');
  assert.deepEqual(t.google.th.published, ['tc1']);
  assert.equal(t.google.th.refreshed, 0);
});

test('threads: a container that fails is made again', () => {
  const t = setup();
  t.google.th = { containers: {}, published: [], refreshed: 0, fail: true };
  const q = post(t);
  runAll(t);
  const waiting = t.call('GET', { action: 'get', token: t.admin, id: q.job.id }).job;
  assert.match(waiting.error, /Will retry: Threads could not take the video \(ERROR: FAILED_DOWNLOADING_VIDEO\)/);
  t.sheet.rows[1][t.sheet.rows[0].indexOf('notBefore')] = ''; // pretend the wait is over
  runAll(t);
  const job = t.call('GET', { action: 'get', token: t.admin, id: q.job.id }).job;
  assert.equal(job.status, 'done', JSON.stringify(job));
  assert.deepEqual(t.google.th.published, ['tc2']);
});

test('threads: checks the link and the 500 limit with emojis as bytes', () => {
  const t = setup();
  assert.match(post(t, { video: { driveFileId: 'vid' } }).error.message, /public link/);
  assert.equal(post(t, { text: '#a #b' }).ok, true); // Threads uses the first as the topic tag
  assert.equal(post(t, { text: 'a'.repeat(500) }).ok, true);
  assert.match(post(t, { text: 'a'.repeat(497) + '🌊' }).error.message, /501 characters/);
  assert.equal(post(t, { text: 'అ'.repeat(500) }).ok, true);
  assert.match(post(t, { text: 'a'.repeat(498) + '⏰' }).error.message, /501 characters/);
  assert.equal(post(t, { text: 'a'.repeat(499) + '\u{20000}' }).ok, true);
  const limits = t.call('GET', { action: 'platforms', token: t.admin }).limits.threads;
  assert.equal(limits.text, 500);
});

test('threads: renews a token with under 50 days left, not one renewed today', () => {
  const t = setup(40, 2);
  assert.equal(t.call('GET', { action: 'channel', token: t.admin, platform: 'threads' }).title, 'howto');
  assert.equal(t.google.th.refreshed, 1);
  assert.equal(t.store.THREADS_TOKEN, 'th-new');
  const u = setup(40, 0.5);
  u.call('GET', { action: 'channel', token: u.admin, platform: 'threads' });
  assert.equal((u.google.th || { refreshed: 0 }).refreshed, 0);
});

test('threads: stats and not-connected errors', () => {
  const t = setup();
  const s = t.call('GET', { action: 'stats', token: t.admin, platform: 'threads' });
  assert.equal(s.followers, 12);
  assert.equal(s.posts[0].views, 10);
  assert.equal(s.posts[0].comments, 8);
  assert.equal(s.posts[0].title, 'Tides');
  const none = load();
  assert.equal(none.call('GET', { action: 'channel', token: none.admin, platform: 'threads' }).error.code, 'not_connected');
  assert.equal(post(t, { account: 'second' }).error.code, 'not_connected');
});
