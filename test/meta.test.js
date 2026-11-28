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

test('instagram: firstComment is posted under the new Reel, and hashtags in it are refused', () => {
  const t = setup();
  const q = t.call('POST', { action: 'publish', token: t.admin, platform: 'instagram', video: { driveFileId: 'vid' }, caption: 'Tides', firstComment: 'What would you ask a tide?' });
  assert.equal(q.ok, true, JSON.stringify(q));
  runAll(t);
  const job = t.call('GET', { action: 'get', token: t.admin, id: q.job.id }).job;
  assert.equal(job.status, 'done', JSON.stringify(job));
  assert.deepEqual(t.google.meta.replies, [{ to: job.result.mediaId, text: 'What would you ask a tide?' }]);
  const bad = t.call('POST', { action: 'publish', token: t.admin, platform: 'instagram', video: { driveFileId: 'vid' }, caption: 'Tides', firstComment: 'Nice #tides' });
  assert.match(bad.error.message, /hashtags/);
});

test('instagram: collaborators go to Instagram as a list of usernames; more than 3 are refused', () => {
  const t = setup();
  const q = t.call('POST', { action: 'publish', token: t.admin, platform: 'instagram', video: { driveFileId: 'vid' }, caption: 'Tides', collaborators: ['@other.account'] });
  assert.equal(q.ok, true, JSON.stringify(q));
  runAll(t);
  assert.equal(t.call('GET', { action: 'get', token: t.admin, id: q.job.id }).job.status, 'done');
  assert.equal(t.google.meta.uploads.c1.params.collaborators, '["other.account"]');
  const bad = t.call('POST', { action: 'publish', token: t.admin, platform: 'instagram', video: { driveFileId: 'vid' }, caption: 'Tides', collaborators: ['a', 'b', 'c', 'd'] });
  assert.match(bad.error.message, /collaborators/);
});

test('instagram: coverUrl goes to Instagram as cover_url; a non-https cover is refused', () => {
  const t = setup();
  const six = t.call('POST', { action: 'publish', token: t.admin, platform: 'instagram', video: { driveFileId: 'vid' }, caption: 'Tides #a #b #c #d #e #f' });
  assert.match(six.error.message, /6 hashtags; Instagram allows at most 5/);
  const bad = t.call('POST', { action: 'publish', token: t.admin, platform: 'instagram', video: { driveFileId: 'vid' }, coverUrl: 'http://x/c.jpg' });
  assert.equal(bad.ok, false);
  assert.match(bad.error.message, /coverUrl/);
  const q = t.call('POST', { action: 'publish', token: t.admin, platform: 'instagram', video: { driveFileId: 'vid' }, coverUrl: 'https://x.example/c.jpg' });
  assert.equal(q.ok, true, JSON.stringify(q));
  runAll(t);
  assert.equal(t.google.meta.uploads.c1.params.cover_url, 'https://x.example/c.jpg');
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

test('facebook: a file that fits one fetch goes up in one request, since Reels refuse a part', () => {
  const t = setup();
  t.google.meta.wholeOnly = true;
  const q = t.call('POST', { action: 'publish', token: t.admin, platform: 'facebook', video: { driveFileId: 'vid' }, description: 'Tides' });
  runAll(t);
  const job = t.call('GET', { action: 'get', token: t.admin, id: q.job.id }).job;
  assert.equal(job.status, 'done', JSON.stringify(job));
  assert.deepEqual(t.google.meta.uploads.r1.got, t.google.files.vid.bytes);
});

test('facebook: thumbnail becomes the Reel cover; a refusal is a warning and the Reel still posts', () => {
  const t = setup();
  t.google.files.img = { name: 'a.jpg', mime: 'image/jpeg', bytes: [1, 2, 3] };
  const q = t.call('POST', { action: 'publish', token: t.admin, platform: 'facebook', video: { driveFileId: 'vid' }, description: 'Tides', thumbnail: { driveFileId: 'img' } });
  assert.equal(q.ok, true, JSON.stringify(q));
  runAll(t);
  const job = t.call('GET', { action: 'get', token: t.admin, id: q.job.id }).job;
  assert.equal(job.status, 'done', JSON.stringify(job));
  assert.deepEqual(t.google.meta.covers, [{ video: job.result.videoId, preferred: 'true', bytes: [1, 2, 3], mime: 'image/jpeg' }]);

  t.google.meta.noCover = true;
  const q2 = t.call('POST', { action: 'publish', token: t.admin, platform: 'facebook', video: { driveFileId: 'vid' }, description: 'Tides', thumbnail: { driveFileId: 'img' } });
  runAll(t);
  const job2 = t.call('GET', { action: 'get', token: t.admin, id: q2.job.id }).job;
  assert.equal(job2.status, 'done', JSON.stringify(job2));
  assert.match(job2.result.warnings.join(' '), /cover/);

  t.google.meta.noCover = false;
  t.google.meta.coverDown = true;
  const q3 = t.call('POST', { action: 'publish', token: t.admin, platform: 'facebook', video: { driveFileId: 'vid' }, description: 'Tides', thumbnail: { driveFileId: 'img' } });
  runAll(t);
  assert.equal(t.call('GET', { action: 'get', token: t.admin, id: q3.job.id }).job.status, 'done');
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
  assert.deepEqual(ig.posts[0], { url: 'https://www.instagram.com/reel/m7/', title: 'Why Hubble is falling', at: '2026-11-15T00:00:00+0000', likes: 40, comments: 3, views: 812, reach: 700, skipRate: 61.5, avgWatchTime: 9200, shares: 4, saves: 2 });
  const fb = t.call('GET', { action: 'stats', token: t.admin, platform: 'facebook' });
  assert.equal(fb.followers, 3);
  assert.deepEqual(fb.posts[0], { url: 'https://www.facebook.com/reel/v1', title: 'Mangroves', at: '2026-11-15T00:00:00+0000', likes: 9, comments: 1, views: 150, reach: null });
  assert.equal(t.call('GET', { action: 'stats', token: t.admin, platform: 'linkedin' }).error.code, 'invalid');
});

test('stats: without the insights permission, views are null and likes still come back', () => {
  const t = setup();
  t.google.meta.noInsights = true;
  const ig = t.call('GET', { action: 'stats', token: t.admin, platform: 'instagram' });
  assert.equal(ig.ok, true, JSON.stringify(ig));
  assert.equal(ig.posts[0].views, null);
  assert.equal(ig.posts[1].likes, 1);
});

test('stats: when Instagram refuses the watch numbers, views and reach still come back', () => {
  const t = setup();
  t.google.meta.noWatch = true;
  const ig = t.call('GET', { action: 'stats', token: t.admin, platform: 'instagram' });
  assert.equal(ig.ok, true, JSON.stringify(ig));
  assert.equal(ig.posts[0].views, 812);
  assert.equal(ig.posts[0].skipRate, null);
  assert.equal(ig.posts[0].shares, null);
});

test('stats: one post Instagram refuses the watch numbers for does not blank the posts after it', () => {
  const t = setup();
  t.google.meta.noWatchFor = ['m7'];
  const ig = t.call('GET', { action: 'stats', token: t.admin, platform: 'instagram' });
  assert.equal(ig.posts[0].skipRate, null);
  assert.equal(ig.posts[0].views, 812);
  assert.equal(ig.posts[1].skipRate, 61.5);
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

test('a second Page is a Meta account with its own sign-in; the main one is untouched', () => {
  const t = setup();
  const p = (extra) => t.call('POST', Object.assign({ action: 'publish', token: t.admin, platform: 'instagram', video: { driveFileId: 'vid' } }, extra));
  assert.equal(p({ account: 'Bad Name' }).error.code, 'invalid');
  assert.equal(p({ account: 'second' }).error.code, 'not_connected');
  Object.assign(t.store, { META_PAGE_TOKEN_SECOND: 'page-token', META_PAGE_ID_SECOND: 'page2', META_IG_ID_SECOND: 'ig2' });
  const q = p({ account: 'second', key: 'k-second' });
  assert.equal(q.ok, true, JSON.stringify(q));
  runAll(t);
  assert.equal(t.call('GET', { action: 'get', token: t.admin, id: q.job.id }).job.status, 'done');
  assert.equal(t.google.meta.uploads.c1.igUser, 'ig2');
  const main = p({ key: 'k-main' });
  runAll(t);
  assert.equal(t.call('GET', { action: 'get', token: t.admin, id: main.job.id }).job.status, 'done');
  assert.equal(t.google.meta.uploads.c2.igUser, 'ig1');
});

test('connectMeta picks the Page by match, else the one it had; an extra account never guesses between Pages', () => {
  const t = setup();
  const pages = [
    { id: 'page1', name: 'How To', instagram_business_account: { id: 'ig1', username: 'howto' } },
    { id: 'page2', name: 'Second Page', instagram_business_account: { id: 'ig2', username: 'second_insta' } },
  ];
  t.run(`PAGES = ${JSON.stringify(pages)}`);
  assert.equal(t.run(`pickMetaPage_(PAGES, 'second', '@Second_Insta', null).id`), 'page2');
  assert.equal(t.run(`pickMetaPage_(PAGES, 'second', 'second page', null).id`), 'page2');
  assert.equal(t.run(`pickMetaPage_(PAGES, 'second', '', 'page2').id`), 'page2');
  assert.equal(t.run(`pickMetaPage_(PAGES, 'second', '', null)`), null);
  assert.equal(t.run(`pickMetaPage_(PAGES, '', '', 'page1').id`), 'page1');
  assert.equal(t.run(`pickMetaPage_(PAGES, '', '', null).id`), 'page1'); // first connect: nothing stored yet
  assert.equal(t.run(`pickMetaPage_(PAGES, '', '', 'gone')`), null); // never switch the main Page silently
});

test('connectMetaAccount reads the account and match from Script Properties, for the editor', () => {
  const t = setup();
  t.run('connectMeta = (a, m) => [a, m].join("|")');
  assert.throws(() => t.run('connectMetaAccount()'), /META_CONNECT_ACCOUNT/);
  Object.assign(t.store, { META_CONNECT_ACCOUNT: 'second', META_CONNECT_MATCH: '@second_insta' });
  assert.equal(t.run('connectMetaAccount()'), 'second|@second_insta');
  delete t.store.META_CONNECT_MATCH;
  assert.equal(t.run('connectMetaAccount()'), 'second|');
});

test('video length: each platform takes its own maximum, read from Drive without downloading', () => {
  const t = setup();
  t.google.files.long = { name: 'b.mp4', mime: 'video/mp4', bytes: [1, 2, 3], ms: 150000 };
  const pub = (platform, extra) => t.call('POST', Object.assign({ action: 'publish', token: t.admin, platform, video: { driveFileId: 'long' } }, extra));
  assert.equal(pub('instagram', { caption: 'A 2.5 minute sloka' }).ok, true); // Instagram takes up to 15 min
  const fb = pub('facebook', { description: 'A 2.5 minute sloka' });
  assert.equal(fb.ok, false);
  assert.match(fb.error.message, /150 s; facebook takes at most 90 s/);
  const info = t.call('GET', { action: 'video', token: t.admin, driveFileId: 'long' });
  assert.deepEqual(info.video, { driveFileId: 'long', name: 'b.mp4', size: 3, seconds: 150 });
  // Not measured by Drive yet: no length, and the post is not refused.
  assert.equal(t.call('GET', { action: 'video', token: t.admin, driveFileId: 'vid' }).video.seconds, null);
  assert.equal(pub('facebook', { description: 'x', video: { driveFileId: 'vid' } }).ok, true);
  const lim = t.call('GET', { action: 'platforms', token: t.admin }).limits;
  assert.equal(lim.instagram.seconds, 900);
  assert.equal(lim.facebook.seconds, 90);
});
