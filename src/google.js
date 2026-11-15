/**
 * Small helpers for calling Google REST APIs as the script owner (Drive and YouTube).
 */

function google_(method, url, opts) {
  const o = opts || {};
  const params = {
    method,
    muteHttpExceptions: true,
    headers: Object.assign({ Authorization: `Bearer ${ScriptApp.getOAuthToken()}` }, o.headers || {}),
  };
  if (o.json !== undefined) {
    params.contentType = 'application/json; charset=UTF-8';
    params.payload = JSON.stringify(o.json);
  } else if (o.payload !== undefined) {
    params.payload = o.payload;
    if (o.contentType) params.contentType = o.contentType;
  }
  return UrlFetchApp.fetch(url, params);
}

/** Calls an API and returns its JSON, or throws an ApiError that says whether a retry can help. */
function googleJson_(method, url, opts) {
  const r = google_(method, url, opts);
  const code = r.getResponseCode();
  if (code >= 200 && code < 300) {
    const text = r.getContentText();
    return text ? JSON.parse(text) : {};
  }
  throw upstreamError_(r);
}

function upstreamError_(r) {
  const code = r.getResponseCode();
  let reason = '';
  let message = '';
  try {
    const e = JSON.parse(r.getContentText()).error || {};
    reason = (e.errors && e.errors[0] && e.errors[0].reason) || e.status || '';
    message = e.message || '';
  } catch (err) {
    message = String(r.getContentText()).slice(0, 300);
  }
  let retry = false;
  if (['quotaExceeded', 'uploadLimitExceeded', 'dailyLimitExceeded'].includes(reason)) retry = 'quota';
  else if (code >= 500 || code === 429 || ['rateLimitExceeded', 'userRateLimitExceeded', 'backendError'].includes(reason)) retry = 'transient';
  return new ApiError('upstream', `Google answered ${code}${reason ? ` (${reason})` : ''}: ${message}`, { status: code, reason, retry });
}

function header_(r, name) {
  const h = r.getHeaders() || {};
  const k = Object.keys(h).find((x) => x.toLowerCase() === name.toLowerCase());
  return k ? h[k] : null;
}

// ---------- Drive ----------

const DRIVE = 'https://www.googleapis.com/drive/v3/files';

function driveMeta_(id) {
  return googleJson_('get', `${DRIVE}/${encodeURIComponent(id)}?fields=name,size,mimeType&supportsAllDrives=true`);
}

/** Bytes start..end (inclusive) of a Drive file, so files larger than 50 MB can be read in parts. */
function driveRange_(id, start, end) {
  const r = google_('get', `${DRIVE}/${encodeURIComponent(id)}?alt=media&supportsAllDrives=true`, { headers: { Range: `bytes=${start}-${end}` } });
  if (r.getResponseCode() !== 206 && r.getResponseCode() !== 200) throw upstreamError_(r);
  return r.getContent();
}

function driveBytes_(id) {
  const r = google_('get', `${DRIVE}/${encodeURIComponent(id)}?alt=media&supportsAllDrives=true`);
  if (r.getResponseCode() !== 200) throw upstreamError_(r);
  return r.getContent();
}
