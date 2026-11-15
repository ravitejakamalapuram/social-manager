const test = require('node:test');
const assert = require('node:assert/strict');
const { load } = require('./fakes.cjs');

function setup() {
  const t = load();
  t.google.files.vid = { name: 'a.mp4', mime: 'video/mp4', bytes: Array.from({ length: 10 }, (_, i) => i) };
  t.google.files.img = { name: 'a.jpg', mime: 'image/jpeg', bytes: [1, 2, 3] };
  t.run('LI_MIN_BYTES = 1');
  t.store.LI_ACCESS_TOKEN = 'li-token';
  t.store.LI_EXPIRES_AT = new Date(Date.now() + 5 * 86400000).toISOString();
  return t;
}

const post = (admin, extra) => Object.assign({
  action: 'publish', platform: 'linkedin', token: admin, video: { driveFileId: 'vid' },
  title: 'How tides work', text: 'Why the sea rises (twice) a day. #science #Tides',
}, extra);

test('linkedin: uploads parts, finalizes, waits for processing, then posts', () => {
  const { call, admin, google } = setup();
  google.li.status = ['PROCESSING'];
  assert.equal(call('POST', post(admin, { thumbnail: { driveFileId: 'img' } })).ok, true);
  const job = call('POST', { action: 'run', token: admin }).ran[0];
  assert.equal(job.status, 'done', job.error);
  assert.deepEqual(google.li.parts, Array.from({ length: 10 }, (_, i) => i));
  assert.deepEqual(google.li.finalize.uploadedPartIds, ['e0', 'e1', 'e2']);
  assert.equal(google.li.init.owner, 'urn:li:person:abc');
  assert.deepEqual(google.li.thumb, [1, 2, 3]);
  assert.equal(google.li.post.content.media.id, 'urn:li:video:V1');
  assert.equal(google.li.post.commentary, 'Why the sea rises \\(twice\\) a day. {hashtag|\\#|science} {hashtag|\\#|Tides}');
  assert.equal(google.li.headers['LinkedIn-Version'].length, 6);
  assert.equal(job.result.url, 'https://www.linkedin.com/feed/update/urn:li:share:7/');
  assert.match(job.result.warnings[0], /runs out in 4 days/);
});

test('linkedin: checks the request and the sign-in', () => {
  const { call, admin, store } = setup();
  assert.match(call('POST', post(admin, { visibility: 'secret' })).error.message, /visibility/);
  assert.match(call('POST', post(admin, { publishAt: '2030-01-01T00:00:00Z' })).error.message, /publishAt/);
  delete store.LI_ACCESS_TOKEN;
  call('POST', post(admin));
  const job = call('POST', { action: 'run', token: admin }).ran[0];
  assert.equal(job.status, 'failed');
  assert.match(job.error, /connectLinkedIn/);
});
