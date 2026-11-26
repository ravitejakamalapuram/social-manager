/**
 * Meta sign-in and Graph API helpers, shared by the Instagram and Facebook adapters.
 *
 * Needs two Script Properties from a Meta developer app: META_APP_ID and META_APP_SECRET, with
 * https://script.google.com/macros/d/<script id>/usercallback in the app's "Valid OAuth Redirect URIs".
 * Then run connectMeta() in the editor and open the link it logs. The callback keeps a Page token that
 * does not expire, the Page id and the id of the Instagram professional account linked to that Page.
 *
 * More than one Page: each extra Page (with its Instagram account) is an "account" with a short name, the
 * same as extra YouTube channels. Its Page token, Page id and Instagram id are kept beside the main ones
 * (META_PAGE_ID_<NAME> and so on), and a call that sends "account" uses them.
 */

const GRAPH_VERSION = 'v24.0';
const GRAPH = `https://graph.facebook.com/${GRAPH_VERSION}`;
const META_SCOPES = [
  'pages_show_list', 'pages_read_engagement', 'pages_manage_posts', 'business_management',
  'instagram_basic', 'instagram_content_publish',
  // Views and reach of posts, for the stats action. Accounts connected before these were added get null views until connectMeta() is run again.
  'instagram_manage_insights', 'read_insights',
  // Reading and answering comments, for the comments and reply actions. Also needs connectMeta() run again.
  'instagram_manage_comments', 'pages_read_user_content', 'pages_manage_engagement',
];

/**
 * Logs the sign-in link. Open it, pick the Page and its Instagram account, press Continue.
 * With a name, it connects that extra account; match (a Page name or id, or an Instagram @username) picks
 * the Page when the sign-in shares more than one.
 */
function connectMeta(account, match) {
  const name = accountName_(typeof account === 'string' ? account : '');
  const p = props_();
  if (!p.getProperty('META_APP_ID') || !p.getProperty('META_APP_SECRET')) {
    throw new Error('Add the META_APP_ID and META_APP_SECRET script properties first (see the FAQ).');
  }
  const state = ScriptApp.newStateToken().withMethod('metaCallback').withArgument('account', name)
    .withArgument('match', typeof match === 'string' ? match : '').withTimeout(600).createToken();
  const q = { client_id: p.getProperty('META_APP_ID'), redirect_uri: ytRedirectUri_(), response_type: 'code', state };
  // Apps that use Facebook Login for Business name a configuration instead of a list of permissions.
  if (p.getProperty('META_CONFIG_ID')) q.config_id = p.getProperty('META_CONFIG_ID'); else q.scope = META_SCOPES.join(',');
  const url = `https://www.facebook.com/${GRAPH_VERSION}/dialog/oauth?${Object.keys(q).map((k) => `${k}=${encodeURIComponent(q[k])}`).join('&')}`;
  console.log(`Open this link, pick the Page${name ? ` for the account "${name}"` : ''} and its Instagram account, and press Continue (valid 10 minutes):\n${url}`);
  return url;
}

/**
 * The same from the editor, which can't pass arguments: put the account name in the Script Property
 * META_CONNECT_ACCOUNT (and the Page or @username in META_CONNECT_MATCH), run this, and open the link it logs.
 */
function connectMetaAccount() {
  const p = props_();
  const name = p.getProperty('META_CONNECT_ACCOUNT');
  if (!name) throw new Error('Add the script property META_CONNECT_ACCOUNT with the account name first, like "second", and META_CONNECT_MATCH with its @username.');
  return connectMeta(name, p.getProperty('META_CONNECT_MATCH') || '');
}

/**
 * The Page the sign-in shared that this account should use: match first, then the one it had. With nothing
 * stored yet, the main account takes the first Page and an extra one takes the only Page; otherwise null.
 */
function pickMetaPage_(pages, account, match, current) {
  const m = String(match || '').replace(/^@/, '').toLowerCase();
  if (m) return pages.find((x) => x.id === m || String(x.name || '').toLowerCase() === m
    || (x.instagram_business_account && String(x.instagram_business_account.username || '').toLowerCase() === m)) || null;
  const had = pages.find((x) => x.id === current);
  if (had) return had;
  if (current) return null; // its Page wasn't shared: never switch to another one silently
  if (account && pages.length > 1) return null; // an extra account never guesses between Pages
  return pages[0];
}

function metaCallback(req) {
  try {
    const p = props_();
    const prm = req.parameter || {};
    ACCOUNT = accountName_(prm.account || '');
    const app = { client_id: p.getProperty('META_APP_ID'), client_secret: p.getProperty('META_APP_SECRET') };
    const short = metaGet_('/oauth/access_token', Object.assign({ redirect_uri: ytRedirectUri_(), code: prm.code }, app));
    // A Page token read with a long-lived user token never expires.
    const long = metaGet_('/oauth/access_token', Object.assign({ grant_type: 'fb_exchange_token', fb_exchange_token: short.access_token }, app));
    const pages = metaGet_('/me/accounts', { fields: 'id,name,access_token,instagram_business_account{id,username}', access_token: long.access_token }).data || [];
    if (!pages.length) return HtmlService.createHtmlOutput('Sign-in worked, but no Facebook Page was shared. Run connectMeta() again and tick your Page.');
    const page = pickMetaPage_(pages, ACCOUNT, prm.match, p.getProperty(accountKey_('META_PAGE_ID')));
    if (!page) {
      const names = pages.map((x) => x.name + (x.instagram_business_account ? ` (@${x.instagram_business_account.username})` : '')).join(', ');
      return HtmlService.createHtmlOutput(`Sign-in worked, but it isn't clear which Page is ${ACCOUNT ? `the account "${ACCOUNT}"` : 'meant'}. Shared: ${names}. Run connectMeta again with match set to one of them.`);
    }
    p.setProperties({ [accountKey_('META_PAGE_ID')]: page.id, [accountKey_('META_PAGE_TOKEN')]: page.access_token });
    const ig = page.instagram_business_account;
    if (ig) p.setProperty(accountKey_('META_IG_ID'), ig.id); else p.deleteProperty(accountKey_('META_IG_ID'));
    const igText = ig ? `Instagram: @${ig.username}.` : 'No Instagram professional account is linked to this Page, so Instagram posts will fail until one is.';
    const mainId = p.getProperty('META_PAGE_ID');
    const mainText = ACCOUNT && mainId && !pages.some((x) => x.id === mainId)
      ? ' Warning: the main Page was not ticked, so Meta may stop its posts. Run connectMeta again and tick every Page.' : '';
    return HtmlService.createHtmlOutput(`Connected${ACCOUNT ? ` as the account "${ACCOUNT}"` : ''}. Facebook Page: ${page.name}. ${igText}${mainText} You can close this tab.`);
  } catch (err) {
    return HtmlService.createHtmlOutput(`Sign-in failed: ${err.message}`);
  }
}

function metaConnected_(account) {
  return !account || !!props_().getProperty(accountKey_('META_PAGE_TOKEN', account));
}

function metaConfig_(needIg) {
  const p = props_();
  const c = { token: p.getProperty(accountKey_('META_PAGE_TOKEN')), pageId: p.getProperty(accountKey_('META_PAGE_ID')), igId: p.getProperty(accountKey_('META_IG_ID')) };
  if (!c.token || !c.pageId) {
    throw new ApiError('not_connected', ACCOUNT ? `The Meta account "${ACCOUNT}" is not connected; call connectMeta with that account first`
      : 'Meta is not connected yet; run connectMeta() (see the FAQ)', ACCOUNT ? { retry: false } : undefined);
  }
  if (needIg && !c.igId) throw new ApiError('not_connected', 'No Instagram professional account is linked to the Facebook Page; link one, then run connectMeta() again');
  return c;
}

function metaQuery_(params) {
  return Object.keys(params).filter((k) => params[k] !== null && params[k] !== undefined)
    .map((k) => `${k}=${encodeURIComponent(params[k])}`).join('&');
}

function metaFetch_(method, path, params) {
  const url = path.startsWith('https://') ? path : `${GRAPH}${path}`;
  const r = method === 'get'
    ? UrlFetchApp.fetch(`${url}?${metaQuery_(params)}`, { method: 'get', muteHttpExceptions: true })
    : UrlFetchApp.fetch(url, { method: 'post', muteHttpExceptions: true, payload: metaQuery_(params), contentType: 'application/x-www-form-urlencoded' });
  const code = r.getResponseCode();
  if (code >= 200 && code < 300) return JSON.parse(r.getContentText() || '{}');
  throw metaError_(r);
}

function metaGet_(path, params) { return metaFetch_('get', path, params); }
function metaPost_(path, params) { return metaFetch_('post', path, params); }

/** Sends bytes to Meta's upload host (rupload.facebook.com), resuming at `offset`. */
function metaUpload_(url, token, bytes, offset, size) {
  const r = UrlFetchApp.fetch(url, {
    method: 'post', muteHttpExceptions: true, payload: bytes, contentType: 'application/octet-stream',
    headers: { Authorization: `OAuth ${token}`, offset: String(offset), file_size: String(size) },
  });
  if (r.getResponseCode() !== 200) throw metaError_(r, true);
  return JSON.parse(r.getContentText() || '{}');
}

/** raw: keep the whole answer in the message (the upload host's short messages hide the useful fields). */
function metaError_(r, raw) {
  const code = r.getResponseCode();
  const text = String(r.getContentText() || '');
  let e = {};
  // The Graph API puts errors under "error"; the upload host (rupload) uses "debug_info".
  try { const b = JSON.parse(text); e = b.error || b.debug_info || {}; } catch (err) { e = {}; }
  const reason = e.error_user_msg || e.message || '';
  const message = raw || !reason ? text.slice(0, 500) : reason;
  let retry = false;
  // 4, 17, 32, 613: rate limits. 2 and is_transient: Meta's own temporary errors. An error with no
  // reason at all (seen right after an Instagram container is made) has passed on the next try.
  if ([4, 17, 32, 613].includes(e.code)) retry = 'quota';
  else if (code >= 500 || e.is_transient || e.retriable || e.code === 2 || (!reason && !e.code)) retry = 'transient';
  return new ApiError('upstream', `Meta answered ${code}${e.code ? ` (code ${e.code}${e.error_subcode ? `/${e.error_subcode}` : ''})` : ''}: ${message}`, { status: code, reason: e.code || null, subcode: e.error_subcode || null, retry });
}

/** Uploads a Drive file to a rupload URL in CHUNK_BYTES parts, recording progress in s.offset. */
function metaSendFile_(p, s, ctx, url, token) {
  while (s.offset < s.size) {
    if (ctx.outOfTime()) return 'pause';
    const end = Math.min(s.offset + CHUNK_BYTES, s.size) - 1;
    metaUpload_(url, token, driveRange_(p.video.driveFileId, s.offset, end), s.offset, s.size);
    s.offset = end + 1;
    ctx.save();
  }
  return 'next';
}

function metaFileSize_(p, s) {
  if (s.size) return;
  const m = driveMeta_(p.video.driveFileId);
  s.size = Number(m.size);
  if (!s.size) throw new ApiError('invalid', 'The video file in Drive is empty');
  s.offset = 0;
}

/**
 * Calls fn for each post until one fails, then gives null for the rest: a missing insights permission
 * fails every call the same way, so one failure is enough to stop asking.
 */
function metaInsightsEach_(posts, fn) {
  let ok = true;
  return posts.map((p) => {
    if (!ok) return null;
    try { return fn(p); } catch (e) { ok = false; console.log(`Meta insights: ${e.message}`); return null; }
  });
}

/** The value of one metric in an insights answer, or null. */
function metaMetric_(r, name) {
  const m = (r.data || []).find((x) => x.name === name);
  const v = m && m.values && m.values[0] ? m.values[0].value : m && m.total_value ? m.total_value.value : null;
  return v == null ? null : Number(v);
}

const firstLine_ = (s) => String(s || '').split('\n')[0].slice(0, 100);
