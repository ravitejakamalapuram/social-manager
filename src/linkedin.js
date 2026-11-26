/**
 * LinkedIn adapter. Posts a video from Drive to the signed-in member's LinkedIn profile with the
 * self-serve "Share on LinkedIn" product (scope w_member_social): upload the video in 4 MB parts
 * (across several worker runs if needed), finalize it, wait until LinkedIn has processed it, then post it.
 *
 * Sign-in needs two Script Properties from the LinkedIn developer app: LI_CLIENT_ID and LI_CLIENT_SECRET,
 * with the redirect URL https://script.google.com/macros/d/<script id>/usercallback added to the app.
 * Run connectLinkedIn() in the editor and open the link it logs. LinkedIn tokens last 60 days and
 * self-serve apps get no refresh token, so the sign-in has to be repeated before LI_EXPIRES_AT.
 */

const LI = 'https://api.linkedin.com';
const LI_VERSION = '202610'; // LinkedIn retires each version after about a year; bump it when a newer one is out.
const LI_VISIBILITY = ['PUBLIC', 'CONNECTIONS', 'LOGGED_IN'];
const LI_SCOPES = ['openid', 'profile', 'w_member_social'];
let LI_MIN_BYTES = 75 * 1024;

const LinkedIn = {
  name: 'linkedin',

  validate(p) {
    const video = optFile_(p.video, 'video');
    if (!video) throw new ApiError('invalid', 'Send video: {"driveFileId": ...}');
    const text = optText_(p.text !== undefined ? p.text : p.description, 'text', 3000);
    const title = optText_(p.title, 'title', 200);
    let visibility = optText_(p.visibility, 'visibility', 20) || 'PUBLIC';
    visibility = visibility.toUpperCase();
    if (!LI_VISIBILITY.includes(visibility)) throw new ApiError('invalid', `visibility must be one of ${LI_VISIBILITY.join(', ')}`);
    if (p.publishAt) throw new ApiError('invalid', 'LinkedIn posts go out straight away; publishAt is not supported. Send the request at the time you want it posted.');
    return { video, title, text: text || '', visibility, thumbnail: optFile_(p.thumbnail, 'thumbnail') };
  },

  steps() {
    return ['upload', 'finalize', 'wait', 'post'];
  },

  run(step, job, ctx) {
    return LI_STEPS[step](job.post, job.state, ctx);
  },

  /** The member the service posts as, and when the sign-in runs out. */
  whoami() {
    const u = liJson_('get', `${LI}/v2/userinfo`, null, true);
    return { id: `urn:li:person:${u.sub}`, title: u.name, tokenExpiresAt: props_().getProperty('LI_EXPIRES_AT') || null };
  },
};

const LI_STEPS = {
  upload(p, s, ctx) {
    if (!s.size) {
      const m = driveMeta_(p.video.driveFileId);
      s.size = Number(m.size);
      if (s.size < LI_MIN_BYTES || s.size > 500 * 1024 * 1024) throw new ApiError('invalid', `LinkedIn takes videos from 75 KB to 500 MB; this one is ${s.size} bytes`);
    }
    if (!s.uploadToken) {
      s.author = liAuthor_();
      const r = liJson_('post', `${LI}/rest/videos?action=initializeUpload`, {
        initializeUploadRequest: { owner: s.author, fileSizeBytes: s.size, uploadCaptions: false, uploadThumbnail: !!p.thumbnail },
      }).value;
      s.videoUrn = r.video;
      s.uploadToken = r.uploadToken || '';
      s.parts = r.uploadInstructions.map((x) => ({ a: x.firstByte, b: x.lastByte, url: x.uploadUrl }));
      s.thumbUrl = r.thumbnailUploadUrl || null;
      s.etags = [];
      s.offset = 0;
      ctx.save();
    }
    while (s.etags.length < s.parts.length) {
      if (ctx.outOfTime()) return 'pause';
      const part = s.parts[s.etags.length];
      const r = UrlFetchApp.fetch(part.url, {
        method: 'put', muteHttpExceptions: true, contentType: 'application/octet-stream',
        payload: driveRange_(p.video.driveFileId, part.a, part.b),
      });
      if (r.getResponseCode() >= 300) throw liError_(r);
      s.etags.push(String(header_(r, 'ETag')).replace(/"/g, ''));
      s.offset = part.b + 1;
      ctx.save();
    }
    if (s.thumbUrl && !s.thumbDone) {
      ctx.optional('thumbnail', () => {
        const m = driveMeta_(p.thumbnail.driveFileId);
        const r = UrlFetchApp.fetch(s.thumbUrl, {
          method: 'put', muteHttpExceptions: true, contentType: m.mimeType || 'image/jpeg',
          headers: { 'media-type-family': 'STILLIMAGE' }, payload: driveBytes_(p.thumbnail.driveFileId),
        });
        if (r.getResponseCode() >= 300) throw liError_(r);
      });
      s.thumbDone = true;
    }
    return 'next';
  },

  finalize(p, s) {
    liJson_('post', `${LI}/rest/videos?action=finalizeUpload`, {
      finalizeUploadRequest: { video: s.videoUrn, uploadToken: s.uploadToken, uploadedPartIds: s.etags },
    });
    return 'next';
  },

  /** LinkedIn processes the video before it can be posted; that usually takes under a minute. */
  wait(p, s) {
    for (let i = 0; i < 6; i++) {
      const v = liJson_('get', `${LI}/rest/videos/${encodeURIComponent(s.videoUrn)}`);
      if (v.status === 'AVAILABLE') return 'next';
      if (v.status === 'PROCESSING_FAILED') throw new ApiError('upstream', `LinkedIn could not process the video: ${v.processingFailureReason || 'no reason given'}`);
      Utilities.sleep(10 * 1000);
    }
    return 'pause';
  },

  post(p, s, ctx) {
    if (!s.postUrn) {
      const r = liFetch_('post', `${LI}/rest/posts`, {
        author: s.author,
        commentary: liText_(p.text),
        visibility: p.visibility,
        distribution: { feedDistribution: 'MAIN_FEED', targetEntities: [], thirdPartyDistributionChannels: [] },
        content: { media: { id: s.videoUrn, title: p.title || undefined } },
        lifecycleState: 'PUBLISHED',
        isReshareDisabledByAuthor: false,
      });
      if (r.getResponseCode() !== 201) throw liError_(r);
      s.postUrn = header_(r, 'x-restli-id');
      ctx.save();
    }
    ctx.result({ postUrn: s.postUrn, videoUrn: s.videoUrn, url: `https://www.linkedin.com/feed/update/${s.postUrn}/`, visibility: p.visibility });
    const left = liDaysLeft_();
    if (left !== null && left < 10) ctx.warn(`The LinkedIn sign-in runs out in ${left} days; run connectLinkedIn() again.`);
    return 'next';
  },
};

/**
 * LinkedIn's post text is "little text": these characters must be backslash-escaped or the post is
 * cut short. #words are turned into real hashtags.
 */
function liText_(t) {
  return String(t || '').split(/(#[\p{L}\p{N}_]+)/u).map((part, i) => (i % 2
    ? `{hashtag|\\#|${part.slice(1)}}`
    : part.replace(/[\\|{}@[\]()<>#*_~]/g, (c) => `\\${c}`))).join('');
}

function liAuthor_() {
  const p = props_();
  let id = p.getProperty('LI_PERSON');
  if (!id) { id = LinkedIn.whoami().id; p.setProperty('LI_PERSON', id); }
  return id;
}

function liDaysLeft_() {
  const at = props_().getProperty('LI_EXPIRES_AT');
  return at ? Math.floor((new Date(at).getTime() - Date.now()) / 86400000) : null;
}

function liFetch_(method, url, json, plain) {
  const token = props_().getProperty('LI_ACCESS_TOKEN');
  if (!token) throw new ApiError('invalid', 'LinkedIn is not connected; run connectLinkedIn() in the script editor (see the FAQ)');
  const headers = { Authorization: `Bearer ${token}` };
  if (!plain) { headers['LinkedIn-Version'] = LI_VERSION; headers['X-Restli-Protocol-Version'] = '2.0.0'; }
  const o = { method, muteHttpExceptions: true, headers };
  if (json) { o.contentType = 'application/json'; o.payload = JSON.stringify(json); }
  return UrlFetchApp.fetch(url, o);
}

function liJson_(method, url, json, plain) {
  const r = liFetch_(method, url, json, plain);
  if (r.getResponseCode() >= 300) throw liError_(r);
  const text = r.getContentText();
  return text ? JSON.parse(text) : {};
}

function liError_(r) {
  const code = r.getResponseCode();
  let message = '';
  try { message = JSON.parse(r.getContentText()).message || ''; } catch (err) { message = String(r.getContentText()).slice(0, 300); }
  if (code === 401) message = `${message} (the LinkedIn sign-in has run out or was revoked; run connectLinkedIn() again)`;
  let retry = false;
  if (code === 429) retry = 'quota';
  else if (code >= 500) retry = 'transient';
  return new ApiError('upstream', `LinkedIn answered ${code}: ${message}`, { status: code, retry });
}

// ---------- sign-in ----------

/** Logs the LinkedIn sign-in link. Open it and press Allow. */
function connectLinkedIn() {
  const p = props_();
  if (!p.getProperty('LI_CLIENT_ID') || !p.getProperty('LI_CLIENT_SECRET')) {
    throw new Error('Add the LI_CLIENT_ID and LI_CLIENT_SECRET script properties first (see the FAQ).');
  }
  const state = ScriptApp.newStateToken().withMethod('linkedInCallback').withTimeout(600).createToken();
  const q = { response_type: 'code', client_id: p.getProperty('LI_CLIENT_ID'), redirect_uri: ytRedirectUri_(), scope: LI_SCOPES.join(' '), state };
  const url = `https://www.linkedin.com/oauth/v2/authorization?${Object.keys(q).map((k) => `${k}=${encodeURIComponent(q[k])}`).join('&')}`;
  console.log(`Open this link and press Allow (valid 10 minutes):\n${url}`);
  return url;
}

function linkedInCallback(req) {
  const p = props_();
  const r = UrlFetchApp.fetch('https://www.linkedin.com/oauth/v2/accessToken', {
    method: 'post', muteHttpExceptions: true,
    payload: {
      grant_type: 'authorization_code', code: req.parameter.code, redirect_uri: ytRedirectUri_(),
      client_id: p.getProperty('LI_CLIENT_ID'), client_secret: p.getProperty('LI_CLIENT_SECRET'),
    },
  });
  const t = JSON.parse(r.getContentText());
  if (!t.access_token) return HtmlService.createHtmlOutput(`Sign-in failed: ${String(t.error_description || t.error || r.getResponseCode())}`);
  p.setProperty('LI_ACCESS_TOKEN', t.access_token);
  p.setProperty('LI_EXPIRES_AT', new Date(Date.now() + Number(t.expires_in || 0) * 1000).toISOString());
  p.deleteProperty('LI_PERSON');
  let who = '';
  try { who = LinkedIn.whoami().title; } catch (err) { who = `(could not read the profile: ${err.message})`; }
  return HtmlService.createHtmlOutput(`Connected. Social Media Publisher now posts to LinkedIn as: ${who}. The sign-in lasts until ${p.getProperty('LI_EXPIRES_AT')}. You can close this tab.`);
}
