/**
 * Meta sign-in and Graph API helpers, shared by the Instagram and Facebook adapters.
 *
 * Needs two Script Properties from a Meta developer app: META_APP_ID and META_APP_SECRET, with
 * https://script.google.com/macros/d/<script id>/usercallback in the app's "Valid OAuth Redirect URIs".
 * Then run connectMeta() in the editor and open the link it logs. The callback keeps a Page token that
 * does not expire, the Page id and the id of the Instagram professional account linked to that Page.
 */

const GRAPH_VERSION = 'v24.0';
const GRAPH = `https://graph.facebook.com/${GRAPH_VERSION}`;
const META_SCOPES = [
  'pages_show_list', 'pages_read_engagement', 'pages_manage_posts', 'business_management',
  'instagram_basic', 'instagram_content_publish',
];

/** Logs the sign-in link. Open it, pick the Page and its Instagram account, press Continue. */
function connectMeta() {
  const p = props_();
  if (!p.getProperty('META_APP_ID') || !p.getProperty('META_APP_SECRET')) {
    throw new Error('Add the META_APP_ID and META_APP_SECRET script properties first (see the FAQ).');
  }
  const state = ScriptApp.newStateToken().withMethod('metaCallback').withTimeout(600).createToken();
  const q = { client_id: p.getProperty('META_APP_ID'), redirect_uri: ytRedirectUri_(), response_type: 'code', state };
  // Apps that use Facebook Login for Business name a configuration instead of a list of permissions.
  if (p.getProperty('META_CONFIG_ID')) q.config_id = p.getProperty('META_CONFIG_ID'); else q.scope = META_SCOPES.join(',');
  const url = `https://www.facebook.com/${GRAPH_VERSION}/dialog/oauth?${Object.keys(q).map((k) => `${k}=${encodeURIComponent(q[k])}`).join('&')}`;
  console.log(`Open this link, pick the Page and Instagram account, and press Continue (valid 10 minutes):\n${url}`);
  return url;
}

function metaCallback(req) {
  try {
    const p = props_();
    const app = { client_id: p.getProperty('META_APP_ID'), client_secret: p.getProperty('META_APP_SECRET') };
    const short = metaGet_('/oauth/access_token', Object.assign({ redirect_uri: ytRedirectUri_(), code: req.parameter.code }, app));
    // A Page token read with a long-lived user token never expires.
    const long = metaGet_('/oauth/access_token', Object.assign({ grant_type: 'fb_exchange_token', fb_exchange_token: short.access_token }, app));
    const pages = metaGet_('/me/accounts', { fields: 'id,name,access_token,instagram_business_account{id,username}', access_token: long.access_token }).data || [];
    const want = p.getProperty('META_PAGE_ID');
    const page = pages.find((x) => x.id === want) || pages[0];
    if (!page) return HtmlService.createHtmlOutput('Sign-in worked, but no Facebook Page was shared. Run connectMeta() again and tick your Page.');
    p.setProperties({ META_PAGE_ID: page.id, META_PAGE_TOKEN: page.access_token });
    const ig = page.instagram_business_account;
    if (ig) p.setProperty('META_IG_ID', ig.id); else p.deleteProperty('META_IG_ID');
    const igText = ig ? `Instagram: @${ig.username}.` : 'No Instagram professional account is linked to this Page, so Instagram posts will fail until one is.';
    return HtmlService.createHtmlOutput(`Connected. Facebook Page: ${page.name}. ${igText} You can close this tab.`);
  } catch (err) {
    return HtmlService.createHtmlOutput(`Sign-in failed: ${err.message}`);
  }
}

function metaConfig_(needIg) {
  const p = props_();
  const c = { token: p.getProperty('META_PAGE_TOKEN'), pageId: p.getProperty('META_PAGE_ID'), igId: p.getProperty('META_IG_ID') };
  if (!c.token || !c.pageId) throw new ApiError('not_connected', 'Meta is not connected yet; run connectMeta() (see the FAQ)');
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
  if (r.getResponseCode() !== 200) throw metaError_(r);
  return JSON.parse(r.getContentText() || '{}');
}

function metaError_(r) {
  const code = r.getResponseCode();
  const text = String(r.getContentText() || '');
  let e = {};
  // The Graph API puts errors under "error"; the upload host (rupload) uses "debug_info".
  try { const b = JSON.parse(text); e = b.error || b.debug_info || {}; } catch (err) { e = {}; }
  const reason = e.error_user_msg || e.message || '';
  const message = reason || text.slice(0, 300);
  let retry = false;
  // 4, 17, 32, 613: rate limits. 2 and is_transient: Meta's own temporary errors. An error with no
  // reason at all (seen right after an Instagram container is made) has passed on the next try.
  if ([4, 17, 32, 613].includes(e.code)) retry = 'quota';
  else if (code >= 500 || e.is_transient || e.retriable || e.code === 2 || (!reason && !e.code)) retry = 'transient';
  return new ApiError('upstream', `Meta answered ${code}${e.code ? ` (code ${e.code}${e.error_subcode ? `/${e.error_subcode}` : ''})` : ''}: ${message}`, { status: code, reason: e.code || null, retry });
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
