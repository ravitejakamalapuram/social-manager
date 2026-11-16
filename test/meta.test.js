const test = require('node:test');
const assert = require('node:assert/strict');
const { load } = require('./fakes.cjs');

const future = () => new Date(Date.now() + 2 * 24 * 3600 * 1000).toISOString();

function setup(connected = true) {
  const t = load();
  t.google.files.vid = { name: 'a.mp4', mime: 'video/mp4', bytes: Array.from({ length: 10 }, (_, i) => i) };
  t.run('CHUNK_BYTES = 4');
  if (connected) Object.assign(t.store, { META_PAGE_TOKEN: 'page-token', META_PAGE_ID: 'page1', META_IG_ID: 'ig1' });
  return t;
}

const runAll = (t) => { for (let i = 0; i < 5; i++) t.call('POST', { action: 'run', token: t.admin }); };

test('instagram: container, chunked upload, waits for processing, publishes once', () => {
  const t = setup();
  const q = t.call('POST', { action: 'publish', token: t.admin, platform: 'instagram', video: { driveFileId: 'vid' }, caption: 'Tides #science', coverAtMs: 1500 });
  assert.equal(q.ok, true, JSON.stringify(q));
  assert.equal(q.job.title, 'Tides #science');
  runAll(t);
  const job = t.call('GET', { action: 'get', token: t.admin, id: q.job.id }).job;
  assert.equal(job.status, 'done', JSON.stringify(job));
  assert.equal(job.result.url, 'https://www.instagram.com/reel/m1/');
  const c = t.google.meta.uploads.c1;
  assert.deepEqual(c.got, t.google.files.vid.bytes);
  assert.equal(c.params.media_type, 'REELS');
  assert.equal(c.params.thumb_offset, '1500');
  assert.equal(t.google.meta.published.length, 1);
});

test('instagram: a processing error fails the job with the reason', () => {
  const t = setup();
  t.google.meta.igStatus = 'ERROR';
  const q = t.call('POST', { action: 'publish', token: t.admin, platform: 'instagram', video: { driveFileId: 'vid' } });
  runAll(t);
  const job = t.call('GET', { action: 'get', token: t.admin, id: q.job.id }).job;
  assert.equal(job.status, 'failed');
  assert.match(job.error, /could not process/);
  assert.equal(t.google.meta.published.length, 0);
});

test('instagram: publishAt holds the job in the queue', () => {
  const t = setup();
  const when = future();
  const q = t.call('POST', { action: 'publish', token: t.admin, platform: 'instagram', video: { driveFileId: 'vid' }, publishAt: when });
  assert.equal(q.job.notBefore, when);
  runAll(t);
  assert.equal(t.call('GET', { action: 'get', token: t.admin, id: q.job.id }).job.status, 'queued');
});

test('facebook: reel upload, finish with description, reads back the link', () => {
  const t = setup();
  const q = t.call('POST', { action: 'publish', token: t.admin, platform: 'facebook', video: { driveFileId: 'vid' }, description: 'How tides work' });
  runAll(t);
  const job = t.call('GET', { action: 'get', token: t.admin, id: q.job.id }).job;
  assert.equal(job.status, 'done', JSON.stringify(job));
  assert.equal(job.result.url, 'https://www.facebook.com/reel/r1');
  const r = t.google.meta.uploads.r1;
  assert.deepEqual(r.got, t.google.files.vid.bytes);
  assert.equal(r.finish.video_state, 'PUBLISHED');
  assert.equal(r.finish.description, 'How tides work');
});

test('facebook: scheduled and draft states', () => {
  const t = setup();
  const when = future();
  t.call('POST', { action: 'publish', token: t.admin, platform: 'facebook', video: { driveFileId: 'vid' }, publishAt: when });
  runAll(t);
  const f = t.google.meta.uploads.r1.finish;
  assert.equal(f.video_state, 'SCHEDULED');
  assert.equal(Number(f.scheduled_publish_time), Math.floor(new Date(when).getTime() / 1000));
  const bad = t.call('POST', { action: 'publish', token: t.admin, platform: 'facebook', video: { driveFileId: 'vid' }, publishAt: when, state: 'draft' });
  assert.match(bad.error.message, /not both/);
});

test('not connected: the job fails with a clear message, and channel says so', () => {
  const t = setup(false);
  const q = t.call('POST', { action: 'publish', token: t.admin, platform: 'facebook', video: { driveFileId: 'vid' } });
  runAll(t);
  assert.match(t.call('GET', { action: 'get', token: t.admin, id: q.job.id }).job.error, /connectMeta/);
  assert.match(t.call('GET', { action: 'channel', token: t.admin, platform: 'instagram' }).error.message, /connectMeta/);
});

test('channel shows the connected accounts', () => {
  const t = setup();
  assert.equal(t.call('GET', { action: 'channel', token: t.admin, platform: 'instagram' }).title, 'howto');
  assert.equal(t.call('GET', { action: 'channel', token: t.admin, platform: 'facebook' }).title, 'How To');
});

test('instagram: an upload error with no reason is retried, not failed', () => {
  const t = setup();
  t.google.meta.failNextUpload = true;
  const q = t.call('POST', { action: 'publish', token: t.admin, platform: 'instagram', video: { driveFileId: 'vid' } });
  t.call('POST', { action: 'run', token: t.admin });
  const job = t.call('GET', { action: 'get', token: t.admin, id: q.job.id }).job;
  assert.equal(job.status, 'queued', JSON.stringify(job));
  assert.match(job.error, /Will retry: Meta answered 400/);
  // The retry uploads into a new container, since Meta refuses more bytes on the old one.
  t.sheet.rows[1][t.sheet.rows[0].indexOf('notBefore')] = ''; // pretend the wait is over
  runAll(t);
  const done = t.call('GET', { action: 'get', token: t.admin, id: q.job.id }).job;
  assert.equal(done.status, 'done', JSON.stringify(done));
  assert.deepEqual(t.google.meta.uploads.c2.got, t.google.files.vid.bytes);
});

test('stats: followers and per-post numbers for instagram and facebook', () => {
  const t = setup();
  const ig = t.call('GET', { action: 'stats', token: t.admin, platform: 'instagram' });
  assert.equal(ig.ok, true, JSON.stringify(ig));
  assert.equal(ig.followers, 41);
  assert.deepEqual(ig.posts[0], { url: 'https://www.instagram.com/reel/m7/', title: 'Why Hubble is falling', at: '2026-11-15T00:00:00+0000', likes: 40, comments: 3, views: 812, reach: 700 });
  const fb = t.call('GET', { action: 'stats', token: t.admin, platform: 'facebook' });
  assert.equal(fb.followers, 3);
  assert.deepEqual(fb.posts[0], { url: 'https://www.facebook.com/reel/v1', title: 'Mangroves', at: '2026-11-15T00:00:00+0000', likes: 9, comments: 1, views: 150, reach: null });
  assert.equal(t.call('GET', { action: 'stats', token: t.admin, platform: 'youtube' }).error.code, 'invalid');
});

test('stats: without the insights permission, views are null and likes still come back', () => {
  const t = setup();
  t.google.meta.noInsights = true;
  const ig = t.call('GET', { action: 'stats', token: t.admin, platform: 'instagram' });
  assert.equal(ig.ok, true, JSON.stringify(ig));
  assert.equal(ig.posts[0].views, null);
  assert.equal(ig.posts[1].likes, 1);
});

test('instagram: a ProcessingFailedError on a complete upload still publishes once the container finishes', () => {
  const t = setup();
  t.run('CHUNK_BYTES = 16');
  t.google.meta.processingFailed = true;
  const q = t.call('POST', { action: 'publish', token: t.admin, platform: 'instagram', video: { driveFileId: 'vid' } });
  runAll(t);
  const job = t.call('GET', { action: 'get', token: t.admin, id: q.job.id }).job;
  assert.equal(job.status, 'done', JSON.stringify(job));
  assert.equal(t.google.meta.published.length, 1);
});
