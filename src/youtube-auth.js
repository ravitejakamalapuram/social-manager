/**
 * YouTube sign-in. The script's own Google sign-in can only post as the account's personal channel,
 * so a brand channel needs its own OAuth sign-in, where Google asks which channel to use.
 *
 * Needs two Script Properties from a Google Cloud OAuth client (type "Web application", redirect URI
 * https://script.google.com/macros/d/<script id>/usercallback): YT_CLIENT_ID and YT_CLIENT_SECRET.
 * Then run connectYouTube() in the editor and open the link it logs. Without them, the script's own
 * sign-in is used.
 *
 * More than one channel: each extra channel is an "account" with a short name ("second"). Its sign-in is
 * kept beside the main one, and a call that sends "account" uses it. The main channel needs no name.
 */

/** The account the current API call or job works as; '' is the main channel. */
let YT_ACCOUNT = '';

function ytAccountName_(v) {
  if (v === undefined || v === null || v === '') return '';
  if (typeof v !== 'string' || !/^[a-z0-9-]{1,30}$/.test(v)) throw new ApiError('invalid', 'account must be a short name of small letters, digits or dashes, like "second"');
  return v;
}

function ytKey_(k, account) {
  const a = account === undefined ? YT_ACCOUNT : account;
  return a ? `${k}_${a.toUpperCase().replace(/-/g, '_')}` : k;
}

function ytAccountConnected_(account) {
  return !account || !!props_().getProperty(ytKey_('YT_REFRESH_TOKEN', account));
}

const YT_SCOPES = ['https://www.googleapis.com/auth/youtube.upload', 'https://www.googleapis.com/auth/youtube.force-ssl'];

/** Logs the sign-in link. Open it, pick the channel, press Allow. With a name, it connects that extra account. */
function connectYouTube(account) {
  const name = ytAccountName_(typeof account === 'string' ? account : '');
  const p = props_();
  if (!p.getProperty('YT_CLIENT_ID') || !p.getProperty('YT_CLIENT_SECRET')) {
    throw new Error('Add the YT_CLIENT_ID and YT_CLIENT_SECRET script properties first (see the FAQ).');
  }
  const state = ScriptApp.newStateToken().withMethod('youTubeCallback').withArgument('account', name).withTimeout(600).createToken();
  const q = {
    client_id: p.getProperty('YT_CLIENT_ID'), redirect_uri: ytRedirectUri_(), response_type: 'code',
    scope: YT_SCOPES.join(' '), access_type: 'offline', prompt: 'consent select_account', state,
  };
  const url = `https://accounts.google.com/o/oauth2/v2/auth?${Object.keys(q).map((k) => `${k}=${encodeURIComponent(q[k])}`).join('&')}`;
  console.log(`Open this link, pick the channel, and press Allow (valid 10 minutes):\n${url}`);
  return url;
}

/**
 * The same from the editor, which can't pass a name: put the account name in the Script Property
 * YT_CONNECT_ACCOUNT, run this, and open the link it logs.
 */
function connectYouTubeAccount() {
  const name = props_().getProperty('YT_CONNECT_ACCOUNT');
  if (!name) throw new Error('Add the script property YT_CONNECT_ACCOUNT with the account name first, like "second".');
  return connectYouTube(name);
}

function youTubeCallback(req) {
  const p = props_();
  const r = UrlFetchApp.fetch('https://oauth2.googleapis.com/token', {
    method: 'post', muteHttpExceptions: true,
    payload: {
      code: req.parameter.code, client_id: p.getProperty('YT_CLIENT_ID'), client_secret: p.getProperty('YT_CLIENT_SECRET'),
      redirect_uri: ytRedirectUri_(), grant_type: 'authorization_code',
    },
  });
  const t = JSON.parse(r.getContentText());
  if (!t.refresh_token) return HtmlService.createHtmlOutput(`Sign-in failed: ${String(t.error_description || t.error || r.getResponseCode())}`);
  YT_ACCOUNT = ytAccountName_((req.parameter && req.parameter.account) || '');
  p.setProperty(ytKey_('YT_REFRESH_TOKEN'), t.refresh_token);
  CacheService.getScriptCache().put(ytKey_('YT_ACCESS'), t.access_token, 3000);
  let who = '';
  try { who = YouTube.whoami().title; } catch (err) { who = `(could not read the channel: ${err.message})`; }
  return HtmlService.createHtmlOutput(`Connected${YT_ACCOUNT ? ` as the account "${YT_ACCOUNT}"` : ''}. Social Media Publisher now posts to the YouTube channel: ${who}. You can close this tab.`);
}

function ytRedirectUri_() {
  return `https://script.google.com/macros/d/${ScriptApp.getScriptId()}/usercallback`;
}

/** Access token for YouTube calls: the channel sign-in if there is one, else the script's own. */
function youTubeToken_() {
  const p = props_();
  const refresh = p.getProperty(ytKey_('YT_REFRESH_TOKEN'));
  if (!refresh && YT_ACCOUNT) throw new ApiError('not_connected', `The YouTube account "${YT_ACCOUNT}" is not connected; call connectYouTube with that account first`, { retry: false });
  if (!refresh) return ScriptApp.getOAuthToken();
  const cache = CacheService.getScriptCache();
  const hit = cache.get(ytKey_('YT_ACCESS'));
  if (hit) return hit;
  const r = UrlFetchApp.fetch('https://oauth2.googleapis.com/token', {
    method: 'post', muteHttpExceptions: true,
    payload: { client_id: p.getProperty('YT_CLIENT_ID'), client_secret: p.getProperty('YT_CLIENT_SECRET'), refresh_token: refresh, grant_type: 'refresh_token' },
  });
  const t = JSON.parse(r.getContentText());
  if (!t.access_token) throw new ApiError('upstream', `YouTube sign-in failed (${t.error || r.getResponseCode()}); run connectYouTube() again`, { status: r.getResponseCode(), retry: false });
  cache.put(ytKey_('YT_ACCESS'), t.access_token, Math.min(Number(t.expires_in || 3600) - 300, 3000));
  return t.access_token;
}
