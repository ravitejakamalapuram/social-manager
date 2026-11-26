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

test('stats: YouTube returns subscribers, channel views and each upload\'s numbers', () => {
  const { call, admin, google } = load();
  google.videos.v9 = { id: 'v9', snippet: { title: 'Lasers', publishedAt: '2026-11-20T08:00:00Z' }, status: {}, statistics: { viewCount: '900', likeCount: '30', commentCount: '2' } };
  const r = call('GET', { action: 'stats', token: admin, platform: 'youtube' });
  assert.equal(r.ok, true);
  assert.equal(r.followers, 120);
  assert.equal(r.channelViews, 5000);
  assert.deepEqual(r.posts, [{ url: 'https://youtu.be/v9', title: 'Lasers', at: '2026-11-20T08:00:00Z', likes: 30, comments: 2, views: 900, reach: null, engagedViews: null }]);
});

test('stats: YouTube adds engaged views from Analytics, and still answers when Analytics refuses', () => {
  const { call, admin, google } = load();
  google.videos.v9 = { id: 'v9', snippet: { title: 'Lasers', publishedAt: '2026-11-20T08:00:00Z' }, status: {}, statistics: { viewCount: '900', likeCount: '30', commentCount: '2' } };
  google.engaged = [['v9', 210], ['other', 5]];
  assert.equal(call('GET', { action: 'stats', token: admin, platform: 'youtube' }).posts[0].engagedViews, 210);
  google.noAnalytics = true;
  const r = call('GET', { action: 'stats', token: admin, platform: 'youtube' });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.posts[0].engagedViews, null);
  assert.equal(r.posts[0].views, 900);
});

function metaLoad() {
  const t = load();
  Object.assign(t.store, { META_PAGE_TOKEN: 'page-token', META_PAGE_ID: 'page1', META_IG_ID: 'ig1' });
  return t;
}

test('comments: Instagram lists viewers\' comments on Reels, minus our own, newest first', () => {
  const t = metaLoad();
  t.google.meta.comments = {
    m7: [
      { id: 'k1', text: 'How deep?', username: 'pat', timestamp: '2026-11-17T10:00:00+0000', replies: { data: [{ username: 'howto', text: 'About 10 m' }] } },
      { id: 'k2', text: 'Wow', username: 'sam', timestamp: '2026-11-18T10:00:00+0000' },
      { id: 'k3', text: 'Thanks all', username: 'howto', timestamp: '2026-11-18T11:00:00+0000' },
    ],
  };
  const r = t.call('GET', { action: 'comments', token: t.admin, platform: 'instagram' });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.deepEqual(r.comments.map((c) => [c.id, c.author, c.replied]), [['k2', 'sam', false], ['k1', 'pat', true]]);
  assert.equal(r.comments[0].videoTitle, 'Why Hubble is falling');
  assert.match(r.comments[0].url, /instagram\.com\/reel\/m7/);
});

test('reply: Instagram and Facebook post once, and the same text again returns the first reply', () => {
  for (const platform of ['instagram', 'facebook']) {
    const t = metaLoad();
    const a = t.call('POST', { action: 'reply', token: t.admin, platform, commentId: 'k1', text: 'Thanks!' });
    assert.equal(a.ok, true, JSON.stringify(a));
    assert.equal(a.reply.existing, false);
    const b = t.call('POST', { action: 'reply', token: t.admin, platform, commentId: 'k1', text: 'Thanks!' });
    assert.equal(b.reply.existing, true);
    assert.equal(t.google.meta.replies.length, 1);
  }
});

test('comments: Facebook lists comments on the Page\'s Reels and spots the Page\'s replies', () => {
  const t = metaLoad();
  t.google.meta.comments = {
    v1: [
      { id: 'f1', message: 'Where is this?', from: { id: 'u1', name: 'Ana' }, created_time: '2026-11-18T09:00:00+0000', comments: { data: [{ from: { id: 'page1' }, message: 'Kerala' }] } },
      { id: 'f2', message: 'Posted by us', from: { id: 'page1', name: 'How To' }, created_time: '2026-11-18T09:30:00+0000' },
      { id: 'f3', message: 'Nice', created_time: '2026-11-18T08:00:00+0000' },
    ],
  };
  const r = t.call('GET', { action: 'comments', token: t.admin, platform: 'facebook' });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.deepEqual(r.comments.map((c) => [c.id, c.author, c.replied]), [['f1', 'Ana', true], ['f3', 'Facebook user', false]]);
  assert.equal(r.comments[0].videoTitle, 'Mangroves');
});
