const test = require('node:test');
const assert = require('node:assert/strict');
const { load } = require('./fakes.cjs');

const future = () => new Date(Date.now() + 2 * 24 * 3600 * 1000).toISOString();
const bytes = (n) => Array.from({ length: n }, (_, i) => i % 100);

function setup() {
  const t = load();
  t.google.files.vid = { name: 'a.mp4', mime: 'video/mp4', bytes: bytes(10) };
  t.google.files.img = { name: 'a.jpg', mime: 'image/jpeg', bytes: bytes(3) };
  t.google.files.srt = { name: 'a.srt', mime: 'text/plain', bytes: [...Buffer.from('1\n00:00:00,000 --> 00:00:01,000\nHi\n')] };
  t.run('CHUNK_BYTES = 4');
  return t;
}

const post = (extra) => Object.assign({
  action: 'publish', platform: 'youtube', video: { driveFileId: 'vid' },
  title: 'How tides work', description: 'Why the sea rises twice a day.', tags: ['tides', 'moon'],
}, extra);

test('auth and method checks', () => {
  const { call, admin } = setup();
  assert.equal(call('GET', { action: 'health' }).ok, true);
  assert.equal(call('GET', { action: 'list' }).error.code, 'unauthorized');
  assert.equal(call('GET', post({ token: admin })).error.code, 'method_not_allowed');
  assert.equal(call('POST', { action: 'run', token: admin }).ok, true);
});

test('validation explains what is wrong', () => {
  const { call, admin } = setup();
  const bad = (extra) => call('POST', post(Object.assign({ token: admin }, extra))).error.message;
  assert.match(bad({ platform: 'tiktok' }), /Unknown platform/);
  assert.match(bad({ video: null }), /driveFileId/);
  assert.match(bad({ title: '' }), /title is required/);
  assert.match(bad({ title: 'x'.repeat(101) }), /limit is 100/);
  assert.match(bad({ publishAt: future(), privacy: 'public' }), /must be private/);
  assert.match(bad({ publishAt: '2020-01-01T00:00:00Z' }), /future/);
  assert.match(bad({ tags: Array(60).fill('long tag here') }), /limit is 500/);
  assert.match(bad({ captions: [{ driveFileId: 'srt' }] }), /language is required/);
});

test('full upload: chunks, metadata, schedule, thumbnail, captions, playlist', () => {
  const { call, admin, google } = setup();
  const when = future();
  const q = call('POST', post({
    token: admin, key: 'tides-1', publishAt: when, categoryId: 28, language: 'en', aiGenerated: false,
    thumbnail: { driveFileId: 'img' }, captions: [{ driveFileId: 'srt', language: 'en' }], playlists: ['Documentaries'],
  }));
  assert.equal(q.ok, true, JSON.stringify(q));
  assert.equal(q.job.status, 'queued');
  // Same key again: no second job.
  const again = call('POST', post({ token: admin, key: 'tides-1' }));
  assert.equal(again.existing, true);
  assert.equal(again.job.id, q.job.id);

  const r = call('POST', { action: 'run', token: admin });
  assert.equal(r.ran.length, 1);
  const job = call('GET', { action: 'get', token: admin, key: 'tides-1' }).job;
  assert.equal(job.status, 'done', JSON.stringify(job));
  const v = google.videos.v1;
  assert.deepEqual(v.bytes, google.files.vid.bytes);
  assert.equal(google.calls.filter((c) => c.startsWith('put /session')).length, 3); // 10 bytes in chunks of 4
  assert.equal(v.snippet.categoryId, '28');
  assert.equal(v.status.privacyStatus, 'private');
  assert.equal(v.status.publishAt, when);
  assert.equal(v.status.selfDeclaredMadeForKids, false);
  assert.ok(google.thumbnails.v1);
  assert.match(google.captions[0], /"language":"en"[\s\S]*Hi/);
  assert.deepEqual(google.playlistItems[0], { playlistId: 'PLdocs', resourceId: { kind: 'youtube#video', videoId: 'v1' } });
  assert.equal(job.result.url, 'https://youtu.be/v1');
  assert.deepEqual(job.result.warnings, []);
});

test('a dropped chunk is retried later and the upload carries on where it stopped', () => {
  const { call, admin, google, sheet } = setup();
  google.fail['put /session'] = { skip: 1, times: 1, code: 503, reason: 'backendError' };
  const id = call('POST', post({ token: admin })).job.id;
  call('POST', { action: 'run', token: admin });
  let job = call('GET', { action: 'get', token: admin, id }).job;
  assert.equal(job.status, 'queued');
  assert.match(job.error, /Will retry/);
  assert.equal(job.progress.uploadedBytes, 4);
  sheet.rows[1][sheet.rows[0].indexOf('notBefore')] = ''; // pretend the wait is over
  call('POST', { action: 'run', token: admin });
  job = call('GET', { action: 'get', token: admin, id }).job;
  assert.equal(job.status, 'done', JSON.stringify(job));
  assert.deepEqual(google.videos.v1.bytes, google.files.vid.bytes);
  assert.equal(Object.keys(google.sessions).length, 1);
});

test('out of time mid-upload: the job goes back in the queue and resumes', () => {
  const { call, admin, google, run } = setup();
  run('WORK_BUDGET_MS = -1');
  const id = call('POST', post({ token: admin })).job.id;
  call('POST', { action: 'run', token: admin });
  let job = call('GET', { action: 'get', token: admin, id }).job;
  assert.equal(job.status, 'queued');
  assert.equal(job.progress.step, 'upload');
  run('WORK_BUDGET_MS = 60000');
  call('POST', { action: 'run', token: admin });
  job = call('GET', { action: 'get', token: admin, id }).job;
  assert.equal(job.status, 'done');
  assert.equal(Object.keys(google.sessions).length, 1);
});

test('quota errors wait; extras that fail become warnings, not failures', () => {
  const { call, admin, google, sheet } = setup();
  google.fail['post /upload/youtube/v3/videos'] = { times: 1, code: 403, reason: 'quotaExceeded' };
  google.fail['thumbnails'] = { times: 1, code: 403, reason: 'forbidden' };
  const id = call('POST', post({ token: admin, thumbnail: { driveFileId: 'img' }, playlists: ['Nope'] })).job.id;
  call('POST', { action: 'run', token: admin });
  let job = call('GET', { action: 'get', token: admin, id }).job;
  assert.equal(job.status, 'queued');
  assert.match(job.error, /quota/);
  assert.equal(job.attempts, 0);
  sheet.rows[1][sheet.rows[0].indexOf('notBefore')] = '';
  call('POST', { action: 'run', token: admin });
  job = call('GET', { action: 'get', token: admin, id }).job;
  assert.equal(job.status, 'done');
  assert.equal(job.result.warnings.length, 2);
  assert.match(job.result.warnings.join(' '), /thumbnail[\s\S]*Nope/);
});

test('YouTube keeping an upload private (unaudited API project) is reported as a warning', () => {
  const { call, admin, google } = setup();
  google.locked = true;
  const id = call('POST', post({ token: admin, privacy: 'public' })).job.id;
  call('POST', { action: 'run', token: admin });
  const job = call('GET', { action: 'get', token: admin, id }).job;
  assert.equal(job.status, 'done');
  assert.equal(job.result.privacy, 'private');
  assert.match(job.result.warnings[0], /audited/);
});

test('edit: privacy and schedule on an existing video, keeping its other fields', () => {
  const { call, admin, google } = setup();
  google.videos.old = { id: 'old', snippet: { title: 'T', description: 'D', categoryId: '28', tags: ['a'] }, status: { privacyStatus: 'private', embeddable: true } };
  const when = future();
  const id = call('POST', { action: 'publish', token: admin, platform: 'youtube', videoId: 'old', publishAt: when }).job.id;
  call('POST', { action: 'run', token: admin });
  assert.equal(call('GET', { action: 'get', token: admin, id }).job.status, 'done');
  assert.deepEqual(google.videos.old.snippet, { title: 'T', description: 'D', categoryId: '28', tags: ['a'] });
  assert.equal(google.videos.old.status.publishAt, when);
  assert.equal(google.videos.old.status.embeddable, true);
});

test('retry, cancel and list', () => {
  const { call, admin, google } = setup();
  google.fail['files/missing'] = { times: 9, code: 404, reason: 'notFound' };
  const bad = call('POST', post({ token: admin, video: { driveFileId: 'missing' } })).job.id;
  const later = call('POST', post({ token: admin, title: 'Second' })).job.id;
  assert.equal(call('POST', { action: 'cancel', token: admin, id: later }).job.status, 'cancelled');
  call('POST', { action: 'run', token: admin });
  assert.equal(call('GET', { action: 'get', token: admin, id: bad }).job.status, 'failed');
  assert.equal(call('POST', { action: 'cancel', token: admin, id: bad }).error.code, 'invalid');
  google.files.missing = google.files.vid;
  google.fail['files/missing'].times = 0;
  assert.equal(call('POST', { action: 'retry', token: admin, id: bad }).job.status, 'queued');
  call('POST', { action: 'run', token: admin });
  assert.equal(call('GET', { action: 'get', token: admin, id: bad }).job.status, 'done');
  assert.equal(call('GET', { action: 'list', token: admin, status: 'cancelled' }).jobs.length, 1);
  assert.equal(call('GET', { action: 'list', token: admin }).jobs.length, 2);
});
