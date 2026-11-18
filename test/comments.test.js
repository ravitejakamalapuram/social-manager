const test = require('node:test');
const assert = require('node:assert/strict');
const { load } = require('./fakes.cjs');

const top = (id, author, text, replies) => ({
  id, snippet: { videoId: 'v9', totalReplyCount: (replies || []).length, topLevelComment: { snippet: { authorDisplayName: author, authorChannelId: { value: author === 'me' ? 'UC1' : 'UCx' }, textDisplay: text, publishedAt: '2026-11-17T14:00:00Z', likeCount: 0 } } },
  replies: { comments: replies || [] },
});

test('comments: lists viewers\' comments with the video title and whether we replied', () => {
  const { call, admin, google } = load();
  google.videos.v9 = { id: 'v9', snippet: { title: 'Lasers' }, status: {} };
  google.threads = [
    top('c1', 'Pat', 'How can light push?'),
    top('c2', 'Sam', 'Cool', [{ snippet: { authorChannelId: { value: 'UC1' } } }]),
    top('c3', 'me', 'What do you think?'),
  ];
  const r = call('GET', { action: 'comments', token: admin, platform: 'youtube' });
  assert.equal(r.ok, true);
  assert.deepEqual(r.comments.map((c) => [c.id, c.replied, c.videoTitle]), [['c1', false, 'Lasers'], ['c2', true, 'Lasers']]);
  assert.match(r.comments[0].url, /v=v9&lc=c1/);
});

test('reply: posts once, and the same text again returns the first reply', () => {
  const { call, admin, google } = load();
  const a = call('POST', { action: 'reply', token: admin, platform: 'youtube', commentId: 'c1', text: 'Thanks!' });
  assert.equal(a.ok, true);
  assert.equal(a.reply.existing, false);
  const b = call('POST', { action: 'reply', token: admin, platform: 'youtube', commentId: 'c1', text: 'Thanks!' });
  assert.equal(b.reply.existing, true);
  assert.equal(google.ytReplies.length, 1);
  assert.equal(call('GET', { action: 'reply', token: admin, platform: 'youtube', commentId: 'c1', text: 'x' }).error.code, 'method_not_allowed');
  assert.equal(call('POST', { action: 'reply', token: admin, platform: 'youtube', text: 'x' }).error.code, 'invalid');
});
