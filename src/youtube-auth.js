/**
 * YouTube sign-in. The script's own Google sign-in can only post as the account's personal channel,
 * so a brand channel needs its own OAuth sign-in, where Google asks which channel to use.
 *
 * Needs two Script Properties from a Google Cloud OAuth client (type "Web application", redirect URI
 * https://script.google.com/macros/d/<script id>/usercallback): YT_CLIENT_ID and YT_CLIENT_SECRET.
 * Then run connectYouTube() in the editor and open the link it logs. Without them, the script's own
 * sign-in is used.
 */

const YT_SCOPES = ['https://www.googleapis.com/auth/youtube.upload', 'https://www.googleapis.com/auth/youtube.force-ssl'];

/** Logs the sign-in link. Open it, pick the channel, press Allow. */
function connectYouTube() {
  const p = props_();
  if (!p.getProperty('YT_CLIENT_ID') || !p.getProperty('YT_CLIENT_SECRET')) {
    throw new Error('Add the YT_CLIENT_ID and YT_CLIENT_SECRET script properties first (see the FAQ).');
  }
  const state = ScriptApp.newStateToken().withMethod('youTubeCallback').withTimeout(600).createToken();
  const q = {
    client_id: p.getProperty('YT_CLIENT_ID'), redirect_uri: ytRedirectUri_(), response_type: 'code',
    scope: YT_SCOPES.join(' '), access_type: 'offline', prompt: 'consent select_account', state,
  };
  const url = `https://accounts.google.com/o/oauth2/v2/auth?${Object.keys(q).map((k) => `${k}=${encodeURIComponent(q[k])}`).join('&')}`;
  console.log(`Open this link, pick the channel, and press Allow (valid 10 minutes):\n${url}`);
  return url;
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
  p.setProperty('YT_REFRESH_TOKEN', t.refresh_token);
  CacheService.getScriptCache().put('YT_ACCESS', t.access_token, 3000);
  let who = '';
  try { who = YouTube.whoami().title; } catch (err) { who = `(could not read the channel: ${err.message})`; }
  return HtmlService.createHtmlOutput(`Connected. Social Manager now posts to the YouTube channel: ${who}. You can close this tab.`);
}

function ytRedirectUri_() {
  return `https://script.google.com/macros/d/${ScriptApp.getScriptId()}/usercallback`;
}

/** Access token for YouTube calls: the channel sign-in if there is one, else the script's own. */
function youTubeToken_() {
  const p = props_();
  const refresh = p.getProperty('YT_REFRESH_TOKEN');
  if (!refresh) return ScriptApp.getOAuthToken();
  const cache = CacheService.getScriptCache();
  const hit = cache.get('YT_ACCESS');
  if (hit) return hit;
  const r = UrlFetchApp.fetch('https://oauth2.googleapis.com/token', {
    method: 'post', muteHttpExceptions: true,
    payload: { client_id: p.getProperty('YT_CLIENT_ID'), client_secret: p.getProperty('YT_CLIENT_SECRET'), refresh_token: refresh, grant_type: 'refresh_token' },
  });
  const t = JSON.parse(r.getContentText());
  if (!t.access_token) throw new ApiError('upstream', `YouTube sign-in failed (${t.error || r.getResponseCode()}); run connectYouTube() again`, { status: r.getResponseCode(), retry: false });
  cache.put('YT_ACCESS', t.access_token, Math.min(Number(t.expires_in || 3600) - 300, 3000));
  return t.access_token;
}
