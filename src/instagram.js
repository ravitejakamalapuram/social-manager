/**
 * Instagram adapter: posts a video from Drive as a Reel on the Instagram professional account linked
 * to the connected Facebook Page (see src/meta.js). Instagram has no private or scheduled posts in its
 * API, so publishAt makes the job wait in the queue until then.
 */

const Instagram = {
  name: 'instagram',
  /** Caption in characters; hashtags cut from 30 to 5 per post in December 2025. */
  limits: { caption: 2200, hashtags: 5, title: 100 },

  validate(p, now) {
    const video = igVideo_(p.video);
    const caption = optText_(p.caption, 'caption', Instagram.limits.caption);
    const tags = (caption || '').match(/(?<!\S)#[^\s#]+/g) || [];
    if (tags.length > Instagram.limits.hashtags) {
      throw new ApiError('invalid', `caption has ${tags.length} hashtags; Instagram allows at most ${Instagram.limits.hashtags} since December 2025`);
    }
    const coverMs = p.coverAtMs === undefined || p.coverAtMs === null ? null : Number(p.coverAtMs);
    if (coverMs !== null && !(coverMs >= 0)) throw new ApiError('invalid', 'coverAtMs must be a number of milliseconds into the video');
    const coverUrl = p.coverUrl === undefined || p.coverUrl === null ? null : p.coverUrl;
    if (coverUrl !== null && (typeof coverUrl !== 'string' || coverUrl.length > 2000 || !/^https:\/\/[^\s]+$/.test(coverUrl))) {
      throw new ApiError('invalid', 'coverUrl must be a public https link to a JPG');
    }
    const publishAt = optFutureTime_(p.publishAt, 'publishAt', now);
    return {
      video, caption, coverAtMs: coverMs, coverUrl, shareToFeed: optBool_(p.shareToFeed, 'shareToFeed') !== false,
      title: optText_(p.title, 'title', Instagram.limits.title) || (caption || '').split('\n')[0].slice(0, Instagram.limits.title),
      notBefore: publishAt,
    };
  },

  steps() {
    return ['container', 'upload', 'process', 'publish', 'check'];
  },

  run(step, job, ctx) {
    return IG_STEPS[step](job.post, job.state, ctx, metaConfig_(true));
  },

  /**
   * Followers and the newest posts with likes, comments, views and reach (views need instagram_manage_insights),
   * plus how each Reel was watched: skipRate (the share of first views that left in the first 3 seconds),
   * avgWatchTime, shares and saves, as Instagram reports them. The watch numbers are asked for on their own, so
   * when Instagram refuses them (skipRate is still "in development" there) views and reach still come back.
   */
  stats(limit) {
    const c = metaConfig_(true);
    const me = metaGet_(`/${c.igId}`, { fields: 'followers_count', access_token: c.token });
    const media = metaGet_(`/${c.igId}/media`, { fields: 'id,permalink,caption,timestamp,like_count,comments_count', limit, access_token: c.token }).data || [];
    const ins = metaInsightsEach_(media, (m) => metaGet_(`/${m.id}/insights`, { metric: 'views,reach', access_token: c.token }));
    const watch = metaInsightsEach_(media, (m) => metaGet_(`/${m.id}/insights`, { metric: 'reels_skip_rate,ig_reels_avg_watch_time,shares,saved', access_token: c.token }));
    const num = (r, name) => (r ? metaMetric_(r, name) : null);
    return {
      followers: me.followers_count == null ? null : me.followers_count,
      posts: media.map((m, i) => ({
        url: m.permalink, title: firstLine_(m.caption), at: m.timestamp, likes: m.like_count == null ? null : m.like_count,
        comments: m.comments_count == null ? null : m.comments_count, views: ins[i] && metaMetric_(ins[i], 'views'), reach: ins[i] && metaMetric_(ins[i], 'reach'),
        skipRate: num(watch[i], 'reels_skip_rate'), avgWatchTime: num(watch[i], 'ig_reels_avg_watch_time'), shares: num(watch[i], 'shares'), saves: num(watch[i], 'saved'),
      })),
    };
  },

  /** Newest comments on the newest Reels, minus the account's own, with whether the account replied (needs instagram_manage_comments). */
  comments(limit) {
    const c = metaConfig_(true);
    const me = metaGet_(`/${c.igId}`, { fields: 'username', access_token: c.token }).username;
    const media = (metaGet_(`/${c.igId}/media`, { fields: 'id,permalink,caption,comments_count', limit: 25, access_token: c.token }).data || [])
      .filter((m) => m.comments_count);
    const out = [];
    media.forEach((m) => {
      const list = metaGet_(`/${m.id}/comments`, { fields: 'id,text,username,timestamp,like_count,replies{username,text}', limit: 50, access_token: c.token }).data || [];
      list.filter((x) => x.username !== me).forEach((x) => {
        const replies = (x.replies && x.replies.data) || [];
        out.push({
          id: x.id, author: x.username, text: x.text, at: x.timestamp, likes: x.like_count == null ? 0 : x.like_count,
          videoId: m.id, videoTitle: firstLine_(m.caption), url: m.permalink, replies: replies.length,
          replied: replies.some((r) => r.username === me),
        });
      });
    });
    out.sort((a, b) => String(b.at).localeCompare(String(a.at)));
    return { comments: out.slice(0, limit) };
  },

  /** Replies to a comment. Sending the same text again returns the first reply instead of posting twice. */
  reply(commentId, text) {
    const c = metaConfig_(true);
    const me = metaGet_(`/${c.igId}`, { fields: 'username', access_token: c.token }).username;
    const id = encodeURIComponent(commentId);
    const mine = (metaGet_(`/${id}/replies`, { fields: 'id,text,username', limit: 100, access_token: c.token }).data || [])
      .find((x) => x.username === me && x.text === text);
    const r = mine || metaPost_(`/${id}/replies`, { message: text, access_token: c.token });
    return { reply: { id: r.id, commentId, text, existing: !!mine } };
  },

  whoami() {
    const c = metaConfig_(true);
    const r = metaGet_(`/${c.igId}`, { fields: 'username,name', access_token: c.token });
    return { id: c.igId, title: r.username, url: `https://www.instagram.com/${r.username}/` };
  },
};

/**
 * The video: {"driveFileId": ...}, {"url": "https://..."} or both. With a url, Instagram fetches the video
 * itself, which is the dependable way; the Drive file is then only the fallback.
 */
function igVideo_(v) {
  if (!v || typeof v !== 'object' || v.url === undefined || v.url === null) {
    const file = optFile_(v, 'video');
    if (!file) throw new ApiError('invalid', 'Send video: {"driveFileId": ...} or {"url": "https://..."}');
    return file;
  }
  if (typeof v.url !== 'string' || v.url.length > 2000 || !/^https:\/\/[^\s]+$/.test(v.url)) {
    throw new ApiError('invalid', 'video.url must be a public https link to the video file');
  }
  const out = { url: v.url };
  if (v.driveFileId !== undefined && v.driveFileId !== null) out.driveFileId = optFile_({ driveFileId: v.driveFileId }, 'video').driveFileId;
  return out;
}

// How long the process step waits for Instagram before it starts again with a new container.
let IG_DOUBT_MS = 10 * 60 * 1000; // after the upload host refused the upload
let IG_PROCESS_MS = 20 * 60 * 1000; // after a clean upload or a link
// How long one worker run keeps checking before it lets other jobs go first.
let IG_POLL_MS = 40 * 1000;

/** Forgets the container, so the job's next try starts again from the container step. */
function igStartOver_(s, ctx) {
  ['containerId', 'uploadUrl', 'byUrl', 'uploadDoubt', 'processSince', 'size'].forEach((k) => { delete s[k]; });
  s.offset = 0;
  s.stepIndex = 0;
  ctx.save();
}

const IG_STEPS = {
  /** With a video link Instagram fetches the file itself; without one the upload step sends it from Drive. */
  container(p, s, ctx, c) {
    if (s.containerId) return 'next';
    const byUrl = !!p.video.url && !s.urlFailed;
    const r = metaPost_(`/${c.igId}/media`, Object.assign({
      media_type: 'REELS', caption: p.caption, share_to_feed: String(p.shareToFeed), thumb_offset: p.coverAtMs, access_token: c.token,
    }, p.coverUrl ? { cover_url: p.coverUrl } : {}, byUrl ? { video_url: p.video.url } : { upload_type: 'resumable' }));
    s.containerId = r.id;
    s.byUrl = byUrl;
    s.uploadUrl = byUrl ? null : r.uri || `https://rupload.facebook.com/ig-api-upload/${GRAPH_VERSION}/${r.id}`;
    delete s.processSince;
    delete s.uploadDoubt;
    ctx.save();
    return 'next';
  },

  /**
   * A failed upload leaves the container unusable ("not in the status to upload a video"), so the
   * next try starts again with a fresh container instead of resuming into the old one.
   * Meta's upload host answers about two in three whole Reel uploads with ProcessingFailedError. A few of
   * those containers still go on to FINISHED, so the process step waits for that; most never do, and
   * then the job starts again with a new container.
   */
  upload(p, s, ctx, c) {
    if (!s.containerId) IG_STEPS.container(p, s, ctx, c);
    if (s.byUrl) return 'next';
    metaFileSize_(p, s);
    try {
      return metaSendFile_(p, s, ctx, s.uploadUrl, c.token);
    } catch (err) {
      if (/ProcessingFailedError/.test(err.message) && s.offset + CHUNK_BYTES >= s.size) {
        s.offset = s.size;
        s.uploadDoubt = true;
        ctx.save();
        return 'next';
      }
      delete s.containerId;
      delete s.uploadUrl;
      s.offset = 0;
      ctx.save();
      throw err;
    }
  },

  /**
   * Instagram processes the video before it can be published; this usually takes under a minute.
   * A container that will never finish (a link Instagram could not fetch, an upload that never arrived)
   * is dropped and the job tries again from the start, up to MAX_ATTEMPTS times.
   */
  process(p, s, ctx, c) {
    if (!s.containerId) { igStartOver_(s, ctx); throw new ApiError('upstream', 'The Instagram container was lost; starting again', { retry: 'transient' }); }
    if (!s.processSince) { s.processSince = Date.now(); ctx.save(); }
    const began = Date.now();
    for (;;) {
      let r;
      try {
        // video_status exists only on an uploaded container; asking a linked one for it is an error (100/2207065).
        r = metaGet_(`/${s.containerId}`, { fields: s.byUrl ? 'status_code,status' : 'status_code,status,video_status', access_token: c.token });
      } catch (err) {
        // Meta deletes a container whose upload never arrived; asking for it then answers code 100, subcode 33.
        if (!err.details || err.details.reason !== 100 || err.details.subcode !== 33) throw err;
        igStartOver_(s, ctx);
        throw new ApiError('upstream', `Instagram dropped the container before the video arrived; starting again (${err.message})`, { retry: 'transient' });
      }
      if (r.status_code === 'FINISHED' || r.status_code === 'PUBLISHED') {
        // After a ProcessingFailedError, FINISHED is Instagram's own word that the video is ready; its
        // bytes_transferred counter can read 0 by then, so it is only noted, and publish decides.
        if (s.uploadDoubt) ctx.warn(`Upload answered ProcessingFailedError; Instagram still finished processing (${JSON.stringify(r.video_status || null).slice(0, 200)})`);
        return 'next';
      }
      if (r.status_code === 'ERROR' || r.status_code === 'EXPIRED') {
        const why = `${r.status_code}): ${r.status || 'no reason given'}`;
        if (s.byUrl && p.video.driveFileId) {
          s.urlFailed = why;
          igStartOver_(s, ctx);
          throw new ApiError('upstream', `Instagram could not take the video from its link (${why}. Uploading the Drive file instead`, { retry: 'transient' });
        }
        throw new ApiError('upstream', `Instagram could not process the video (${why}. Reels must be MP4/MOV, 3 s to 15 min, 9:16 works best.`);
      }
      const limit = s.uploadDoubt ? IG_DOUBT_MS : IG_PROCESS_MS;
      if (Date.now() - s.processSince > limit) {
        const what = s.uploadDoubt ? 'Instagram refused the upload (ProcessingFailedError) and' : 'Instagram';
        igStartOver_(s, ctx);
        throw new ApiError('upstream', `${what} did not finish processing the video within ${Math.round(limit / 60000)} minutes; starting again with a new container`, { retry: 'transient' });
      }
      if (ctx.outOfTime()) return 'pause';
      if (Date.now() - began > IG_POLL_MS) return 'wait'; // other jobs go first; the worker comes back to this one
      Utilities.sleep(10 * 1000);
    }
  },

  publish(p, s, ctx, c) {
    if (s.videoId) return 'next';
    s.videoId = metaPost_(`/${c.igId}/media_publish`, { creation_id: s.containerId, access_token: c.token }).id;
    ctx.save();
    return 'next';
  },

  check(p, s, ctx, c) {
    const r = metaGet_(`/${s.videoId}`, { fields: 'permalink,shortcode,timestamp', access_token: c.token });
    if (s.urlFailed) ctx.warn(`Instagram could not take the video from its link (${s.urlFailed}; the file was uploaded from Drive instead`);
    ctx.result({ mediaId: s.videoId, url: r.permalink || null, publishedAt: r.timestamp || null });
    return 'next';
  },
};
