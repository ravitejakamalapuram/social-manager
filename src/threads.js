/**
 * Threads adapter: posts a video to a Threads profile with the Threads API (graph.threads.net).
 *
 * Threads only fetches videos from a public link, so a post needs video: {"url": "https://..."}; there is
 * no upload from Drive. Sign-in needs two Script Properties from the Meta app's Threads use case:
 * THREADS_APP_ID and THREADS_APP_SECRET (the Threads ones, not META_APP_ID), with
 * https://script.google.com/macros/d/<script id>/usercallback in its "Redirect Callback URLs".
 * Run connectThreads() in the editor (or the connectThreads action) and open the link it logs.
 *
 * Threads tokens last 60 days and can be renewed without signing in again: every use renews a token that
 * is more than a day old once it has under 50 days left, so a profile that posts or reads stats at least
 * every few weeks never runs out. Extra profiles are "accounts", the same as extra YouTube channels.
 */

const THREADS = 'https://graph.threads.net';
const THREADS_GRAPH = `${THREADS}/v1.0`;
const THREADS_SCOPES = ['threads_basic', 'threads_content_publish', 'threads_manage_insights'];
const THREADS_DAY_MS = 24 * 3600 * 1000;
let THREADS_POLL_MS = 40 * 1000;
let THREADS_PROCESS_MS = 20 * 60 * 1000;

const Threads = {
  name: 'threads',
  /** text counts emojis as their UTF-8 bytes (Threads' rule); one topic tag (hashtag) per post. */
  limits: { text: 500, hashtags: 1, title: 100 },

  validate(p, now) {
    const v = p.video;
    if (!v || typeof v !== 'object' || typeof v.url !== 'string' || v.url.length > 2000 || !/^https:\/\/[^\s]+$/.test(v.url)) {
      throw new ApiError('invalid', 'Send video: {"url": "https://..."}. Threads only fetches videos from a public link.');
    }
    const text = p.text !== undefined ? p.text : p.caption;
    if (text !== undefined && text !== null && typeof text !== 'string') throw new ApiError('invalid', 'text must be text');
    const len = threadsLength_(text || '');
    if (len > Threads.limits.text) throw new ApiError('invalid', `text is ${len} characters (emojis count as their UTF-8 bytes); the limit is ${Threads.limits.text}`);
    const tags = (text || '').match(/(?<!\S)#[^\s#]+/g) || [];
    if (tags.length > Threads.limits.hashtags) throw new ApiError('invalid', `text has ${tags.length} hashtags; Threads takes one topic tag per post`);
    return {
      video: { url: v.url }, text: text || '',
      title: optText_(p.title, 'title', Threads.limits.title) || (text || '').split('\n')[0].slice(0, Threads.limits.title),
      notBefore: optFutureTime_(p.publishAt, 'publishAt', now),
    };
  },

  steps() {
    return ['container', 'process', 'publish', 'check'];
  },

  run(step, job, ctx) {
    return THREADS_STEPS[step](job.post, job.state, ctx, threadsConfig_());
  },

  /** Followers and the newest posts with views, likes, replies, reposts, quotes and shares (threads_manage_insights). */
  stats(limit) {
    const c = threadsConfig_();
    const posts = threadsGet_(`/${c.userId}/threads`, { fields: 'id,permalink,text,timestamp', limit, access_token: c.token }).data || [];
    let followers = null;
    try {
      followers = metaMetric_(threadsGet_(`/${c.userId}/threads_insights`, { metric: 'followers_count', access_token: c.token }), 'followers_count');
    } catch (e) { console.log(`Threads followers: ${e.message}`); }
    const ins = metaInsightsEach_(posts, (m) => threadsGet_(`/${m.id}/insights`, { metric: 'views,likes,replies,reposts,quotes,shares', access_token: c.token }));
    const num = (r, name) => (r ? metaMetric_(r, name) : null);
    return {
      followers,
      posts: posts.map((m, i) => ({
        url: m.permalink || null, title: firstLine_(m.text), at: m.timestamp, views: num(ins[i], 'views'), likes: num(ins[i], 'likes'),
        comments: num(ins[i], 'replies'), reposts: num(ins[i], 'reposts'), quotes: num(ins[i], 'quotes'), shares: num(ins[i], 'shares'),
      })),
    };
  },

  whoami() {
    const c = threadsConfig_();
    const r = threadsGet_('/me', { fields: 'id,username', access_token: c.token });
    return { id: r.id, title: r.username, url: `https://www.threads.net/@${r.username}`, tokenExpiresAt: c.expiresAt || null };
  },
};

/** Threads' length rule: emojis count as their UTF-8 bytes, every other character as one. */
function threadsLength_(s) {
  let n = 0;
  for (const ch of String(s)) {
    const c = ch.codePointAt(0);
    const emoji = c >= 0x1f000 || (c >= 0x2600 && c <= 0x27bf) || (c >= 0x2b00 && c <= 0x2bff) || c === 0xfe0f || c === 0x200d;
    n += emoji ? utf8Bytes_(ch) : 1;
  }
  return n;
}

// ---------- sign-in ----------

/** Logs the sign-in link. Open it while signed in to the Threads profile, and press Allow. */
function connectThreads(account) {
  const name = accountName_(typeof account === 'string' ? account : '');
  const p = props_();
  if (!p.getProperty('THREADS_APP_ID') || !p.getProperty('THREADS_APP_SECRET')) {
    throw new Error('Add the THREADS_APP_ID and THREADS_APP_SECRET script properties first (see the FAQ).');
  }
  const state = ScriptApp.newStateToken().withMethod('threadsCallback').withArgument('account', name).withTimeout(600).createToken();
  const q = { client_id: p.getProperty('THREADS_APP_ID'), redirect_uri: ytRedirectUri_(), scope: THREADS_SCOPES.join(','), response_type: 'code', state };
  const url = `https://threads.net/oauth/authorize?${metaQuery_(q)}`;
  console.log(`Open this link signed in to the Threads profile${name ? ` for the account "${name}"` : ''} and press Allow (valid 10 minutes):\n${url}`);
  return url;
}

/** For an extra profile from the editor: set the script property THREADS_CONNECT_ACCOUNT, run this, open the link. */
function connectThreadsAccount() {
  const name = props_().getProperty('THREADS_CONNECT_ACCOUNT');
  if (!name) throw new Error('Add the script property THREADS_CONNECT_ACCOUNT with the account name first, like "second".');
  return connectThreads(name);
}

function threadsCallback(req) {
  try {
    const p = props_();
    const prm = req.parameter || {};
    ACCOUNT = accountName_(prm.account || '');
    const app = { client_id: p.getProperty('THREADS_APP_ID'), client_secret: p.getProperty('THREADS_APP_SECRET') };
    const short = threadsFetch_('post', `${THREADS}/oauth/access_token`, Object.assign({ grant_type: 'authorization_code', redirect_uri: ytRedirectUri_(), code: prm.code }, app));
    const long = threadsFetch_('get', `${THREADS}/access_token`, { grant_type: 'th_exchange_token', client_secret: app.client_secret, access_token: short.access_token });
    threadsStore_(long, String(short.user_id));
    const who = Threads.whoami();
    return HtmlService.createHtmlOutput(`Connected${ACCOUNT ? ` as the account "${ACCOUNT}"` : ''}. Social Media Publisher now posts to Threads as @${who.title}. You can close this tab.`);
  } catch (err) {
    return HtmlService.createHtmlOutput(`Sign-in failed: ${err.message}`);
  }
}

function threadsStore_(t, userId) {
  const now = Date.now();
  const v = {
    [accountKey_('THREADS_TOKEN')]: t.access_token,
    [accountKey_('THREADS_EXPIRES_AT')]: new Date(now + Number(t.expires_in || 60 * 86400) * 1000).toISOString(),
    [accountKey_('THREADS_RENEWED_AT')]: new Date(now).toISOString(),
  };
  if (userId) v[accountKey_('THREADS_USER_ID')] = userId;
  props_().setProperties(v);
}

function threadsConnected_(account) {
  return !account || !!props_().getProperty(accountKey_('THREADS_TOKEN', account));
}

/** The token and profile id, renewing a token with under 50 days left (Threads renews only tokens over a day old). */
function threadsConfig_() {
  const p = props_();
  const c = { token: p.getProperty(accountKey_('THREADS_TOKEN')), userId: p.getProperty(accountKey_('THREADS_USER_ID')), expiresAt: p.getProperty(accountKey_('THREADS_EXPIRES_AT')) };
  const what = ACCOUNT ? `The Threads account "${ACCOUNT}"` : 'Threads';
  if (!c.token || !c.userId) throw new ApiError('not_connected', `${what} is not connected yet; run connectThreads (see the FAQ)`, { retry: false });
  const now = Date.now();
  const left = c.expiresAt ? Date.parse(c.expiresAt) - now : Infinity;
  if (left <= 0) throw new ApiError('not_connected', `${what} sign-in ran out on ${c.expiresAt}; run connectThreads again`, { retry: false });
  const renewed = Date.parse(p.getProperty(accountKey_('THREADS_RENEWED_AT')) || 0);
  if (left < 50 * THREADS_DAY_MS && now - renewed > THREADS_DAY_MS) {
    try {
      const t = threadsFetch_('get', `${THREADS}/refresh_access_token`, { grant_type: 'th_refresh_token', access_token: c.token });
      threadsStore_(t);
      c.token = t.access_token;
      c.expiresAt = p.getProperty(accountKey_('THREADS_EXPIRES_AT'));
    } catch (e) { console.log(`Threads token renewal failed (the old one still works until ${c.expiresAt}): ${e.message}`); }
  }
  return c;
}

function threadsFetch_(method, path, params) {
  return metaFetch_(method, path.startsWith('https://') ? path : `${THREADS_GRAPH}${path}`, params);
}
function threadsGet_(path, params) { return threadsFetch_('get', path, params); }
function threadsPost_(path, params) { return threadsFetch_('post', path, params); }

// ---------- posting ----------

function threadsStartOver_(s, ctx) {
  ['containerId', 'processSince'].forEach((k) => { delete s[k]; });
  s.stepIndex = 0;
  ctx.save();
}

const THREADS_STEPS = {
  container(p, s, ctx, c) {
    if (s.containerId) return 'next';
    s.containerId = threadsPost_(`/${c.userId}/threads`, { media_type: 'VIDEO', video_url: p.video.url, text: p.text || null, access_token: c.token }).id;
    delete s.processSince;
    ctx.save();
    return 'next';
  },

  /** Threads fetches and processes the video before it can be published; Meta suggests waiting about 30 s. */
  process(p, s, ctx, c) {
    if (!s.containerId) { threadsStartOver_(s, ctx); throw new ApiError('upstream', 'The Threads container was lost; starting again', { retry: 'transient' }); }
    if (!s.processSince) { s.processSince = Date.now(); ctx.save(); }
    const began = Date.now();
    for (;;) {
      const r = threadsGet_(`/${s.containerId}`, { fields: 'status,error_message', access_token: c.token });
      if (r.status === 'FINISHED' || r.status === 'PUBLISHED') return 'next';
      if (r.status === 'ERROR' || r.status === 'EXPIRED') {
        threadsStartOver_(s, ctx);
        throw new ApiError('upstream', `Threads could not take the video (${r.status}: ${r.error_message || 'no reason given'}). Videos must be MP4/MOV, at most 5 minutes and 1 GB, at a public link.`, { retry: 'transient' });
      }
      if (Date.now() - s.processSince > THREADS_PROCESS_MS) {
        threadsStartOver_(s, ctx);
        throw new ApiError('upstream', `Threads did not finish processing the video within ${Math.round(THREADS_PROCESS_MS / 60000)} minutes; starting again`, { retry: 'transient' });
      }
      if (ctx.outOfTime()) return 'pause';
      if (Date.now() - began > THREADS_POLL_MS) return 'wait';
      Utilities.sleep(10 * 1000);
    }
  },

  publish(p, s, ctx, c) {
    if (s.mediaId) return 'next';
    s.mediaId = threadsPost_(`/${c.userId}/threads_publish`, { creation_id: s.containerId, access_token: c.token }).id;
    ctx.save();
    return 'next';
  },

  check(p, s, ctx, c) {
    const r = threadsGet_(`/${s.mediaId}`, { fields: 'permalink,timestamp', access_token: c.token });
    const left = c.expiresAt ? Math.floor((Date.parse(c.expiresAt) - Date.now()) / THREADS_DAY_MS) : null;
    if (left !== null && left < 10) ctx.warn(`The Threads sign-in runs out in ${left} days and could not be renewed; run connectThreads again.`);
    ctx.result({ mediaId: s.mediaId, url: r.permalink || null, publishedAt: r.timestamp || null });
    return 'next';
  },
};
