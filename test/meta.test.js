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

test('instagram: with a video link, Instagram fetches the file and nothing is uploaded', () => {
  const t = setup();
  const q = t.call('POST', { action: 'publish', token: t.admin, platform: 'instagram', video: { url: 'https://example.com/a.mp4', driveFileId: 'vid' }, caption: 'Tides' });
  assert.equal(q.ok, true, JSON.stringify(q));
  runAll(t);
  const job = t.call('GET', { action: 'get', token: t.admin, id: q.job.id }).job;
  assert.equal(job.status, 'done', JSON.stringify(job));
  const c = t.google.meta.uploads.c1;
  assert.equal(c.params.video_url, 'https://example.com/a.mp4');
  assert.equal(c.params.upload_type, undefined);
  assert.deepEqual(c.got, []);
  assert.equal(t.google.meta.published.length, 1);
});

test('instagram: a link Instagram cannot fetch falls back to uploading the Drive file', () => {
  const t = setup();
  t.google.meta.urlStatus = 'ERROR';
  const q = t.call('POST', { action: 'publish', token: t.admin, platform: 'instagram', video: { url: 'https://example.com/a.mp4', driveFileId: 'vid' } });
  runAll(t);
  const waiting = t.call('GET', { action: 'get', token: t.admin, id: q.job.id }).job;
  assert.equal(waiting.status, 'queued', JSON.stringify(waiting));
  assert.match(waiting.error, /Will retry: Instagram could not take the video from its link \(ERROR\): Error: Media upload has failed with error code 2207052/);
  t.sheet.rows[1][t.sheet.rows[0].indexOf('notBefore')] = ''; // pretend the wait is over
  runAll(t);
  const job = t.call('GET', { action: 'get', token: t.admin, id: q.job.id }).job;
  assert.equal(job.status, 'done', JSON.stringify(job));
  assert.equal(t.google.meta.uploads.c2.params.upload_type, 'resumable');
  assert.deepEqual(t.google.meta.uploads.c2.got, t.google.files.vid.bytes);
  assert.equal(t.google.meta.published.length, 1);
  assert.match(job.result.warnings[0], /could not take the video from its link/);
});

test('instagram: a link with no Drive file fails with Instagram\'s reason', () => {
  const t = setup();
  t.google.meta.urlStatus = 'ERROR';
  const q = t.call('POST', { action: 'publish', token: t.admin, platform: 'instagram', video: { url: 'https://example.com/a.mp4' } });
  runAll(t);
  const job = t.call('GET', { action: 'get', token: t.admin, id: q.job.id }).job;
  assert.equal(job.status, 'failed');
  assert.match(job.error, /could not process the video \(ERROR\): Error: Media upload has failed with error code 2207052/);
  assert.equal(t.call('POST', { action: 'publish', token: t.admin, platform: 'instagram', video: { url: 'http://example.com/a.mp4' } }).error.code, 'invalid');
});

test('instagram: a refused upload that never finishes starts again with a new container', () => {
  const t = setup();
  t.run('CHUNK_BYTES = 16; IG_DOUBT_MS = -1');
  t.google.meta.processingFailed = true;
  t.google.meta.igStatus = 'IN_PROGRESS';
  const q = t.call('POST', { action: 'publish', token: t.admin, platform: 'instagram', video: { driveFileId: 'vid' } });
  t.call('POST', { action: 'run', token: t.admin });
  const waiting = t.call('GET', { action: 'get', token: t.admin, id: q.job.id }).job;
  assert.equal(waiting.status, 'queued', JSON.stringify(waiting));
  assert.match(waiting.error, /Will retry: Instagram refused the upload \(ProcessingFailedError\) and did not finish/);
  // The next try makes a new container and uploads again; this time Instagram takes it.
  Object.assign(t.google.meta, { processingFailed: false, igStatus: null });
  t.sheet.rows[1][t.sheet.rows[0].indexOf('notBefore')] = '';
  runAll(t);
  const job = t.call('GET', { action: 'get', token: t.admin, id: q.job.id }).job;
  assert.equal(job.status, 'done', JSON.stringify(job));
  assert.deepEqual(t.google.meta.uploads.c2.got, t.google.files.vid.bytes);
  assert.equal(t.google.meta.published[0].container, 'c2');
});

test('instagram: a container Meta has deleted starts the job again', () => {
  const t = setup();
  t.google.meta.gone = ['c1'];
  const q = t.call('POST', { action: 'publish', token: t.admin, platform: 'instagram', video: { driveFileId: 'vid' } });
  t.call('POST', { action: 'run', token: t.admin });
  assert.match(t.call('GET', { action: 'get', token: t.admin, id: q.job.id }).job.error, /Will retry: Instagram dropped the container/);
  t.sheet.rows[1][t.sheet.rows[0].indexOf('notBefore')] = '';
  runAll(t);
  assert.equal(t.call('GET', { action: 'get', token: t.admin, id: q.job.id }).job.status, 'done');
});

test('worker: a job waiting on Instagram lets the jobs behind it run first', () => {
  const t = setup();
  t.run('IG_POLL_MS = -1; WAIT_MS = 60000; WORK_BUDGET_MS = 1000');
  t.google.meta.igStatus = 'IN_PROGRESS';
  const ig = t.call('POST', { action: 'publish', token: t.admin, platform: 'instagram', video: { driveFileId: 'vid' } });
  const fb = t.call('POST', { action: 'publish', token: t.admin, platform: 'facebook', video: { driveFileId: 'vid' }, description: 'Tides' });
  t.call('POST', { action: 'run', token: t.admin });
  t.call('POST', { action: 'run', token: t.admin });
  assert.equal(t.call('GET', { action: 'get', token: t.admin, id: fb.job.id }).job.status, 'done');
  const waiting = t.call('GET', { action: 'get', token: t.admin, id: ig.job.id }).job;
  assert.equal(waiting.status, 'queued');
  assert.ok(waiting.notBefore);
});
