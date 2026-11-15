/**
 * Instagram adapter: posts a video from Drive as a Reel on the Instagram professional account linked
 * to the connected Facebook Page (see src/meta.js). Instagram has no private or scheduled posts in its
 * API, so publishAt makes the job wait in the queue until then.
 */

const Instagram = {
  name: 'instagram',

  validate(p, now) {
    const video = optFile_(p.video, 'video');
    if (!video) throw new ApiError('invalid', 'Send video: {"driveFileId": ...}');
    const caption = optText_(p.caption, 'caption', 2200);
    if (caption && (caption.match(/#/g) || []).length > 30) throw new ApiError('invalid', 'Instagram allows at most 30 hashtags');
    const coverMs = p.coverAtMs === undefined || p.coverAtMs === null ? null : Number(p.coverAtMs);
    if (coverMs !== null && !(coverMs >= 0)) throw new ApiError('invalid', 'coverAtMs must be a number of milliseconds into the video');
    const publishAt = optFutureTime_(p.publishAt, 'publishAt', now);
    return {
      video, caption, coverAtMs: coverMs, shareToFeed: optBool_(p.shareToFeed, 'shareToFeed') !== false,
      title: optText_(p.title, 'title', 100) || (caption || '').split('\n')[0].slice(0, 100),
      notBefore: publishAt,
    };
  },

  steps() {
    return ['container', 'upload', 'process', 'publish', 'check'];
  },

  run(step, job, ctx) {
    return IG_STEPS[step](job.post, job.state, ctx, metaConfig_(true));
  },

  whoami() {
    const c = metaConfig_(true);
    const r = metaGet_(`/${c.igId}`, { fields: 'username,name', access_token: c.token });
    return { id: c.igId, title: r.username, url: `https://www.instagram.com/${r.username}/` };
  },
};

const IG_STEPS = {
  container(p, s, ctx, c) {
    if (s.containerId) return 'next';
    const r = metaPost_(`/${c.igId}/media`, {
      media_type: 'REELS', upload_type: 'resumable', caption: p.caption, share_to_feed: String(p.shareToFeed),
      thumb_offset: p.coverAtMs, access_token: c.token,
    });
    s.containerId = r.id;
    s.uploadUrl = r.uri || `https://rupload.facebook.com/ig-api-upload/${GRAPH_VERSION}/${r.id}`;
    ctx.save();
    return 'next';
  },

  upload(p, s, ctx, c) {
    metaFileSize_(p, s);
    return metaSendFile_(p, s, ctx, s.uploadUrl, c.token);
  },

  /** Instagram processes the video before it can be published; this usually takes under a minute. */
  process(p, s, ctx, c) {
    for (;;) {
      const r = metaGet_(`/${s.containerId}`, { fields: 'status_code,status', access_token: c.token });
      if (r.status_code === 'FINISHED' || r.status_code === 'PUBLISHED') return 'next';
      if (r.status_code === 'ERROR' || r.status_code === 'EXPIRED') {
        throw new ApiError('upstream', `Instagram could not process the video (${r.status_code}): ${r.status || 'no reason given'}. Reels must be MP4/MOV, 3 s to 15 min, 9:16 works best.`);
      }
      if (ctx.outOfTime()) return 'pause';
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
    ctx.result({ mediaId: s.videoId, url: r.permalink || null, publishedAt: r.timestamp || null });
    return 'next';
  },
};
