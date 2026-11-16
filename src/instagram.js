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

  /** Followers and the newest posts with likes, comments, views and reach (views need instagram_manage_insights). */
  stats(limit) {
    const c = metaConfig_(true);
    const me = metaGet_(`/${c.igId}`, { fields: 'followers_count', access_token: c.token });
    const media = metaGet_(`/${c.igId}/media`, { fields: 'id,permalink,caption,timestamp,like_count,comments_count', limit, access_token: c.token }).data || [];
    const ins = metaInsightsEach_(media, (m) => metaGet_(`/${m.id}/insights`, { metric: 'views,reach', access_token: c.token }));
    return {
      followers: me.followers_count == null ? null : me.followers_count,
      posts: media.map((m, i) => ({
        url: m.permalink, title: firstLine_(m.caption), at: m.timestamp, likes: m.like_count == null ? null : m.like_count,
        comments: m.comments_count == null ? null : m.comments_count, views: ins[i] && metaMetric_(ins[i], 'views'), reach: ins[i] && metaMetric_(ins[i], 'reach'),
      })),
    };
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

  /**
   * A failed upload leaves the container unusable ("not in the status to upload a video"), so the
   * next try starts again with a fresh container instead of resuming into the old one.
   * Meta often answers the last chunk of a Reel with ProcessingFailedError although the bytes arrived
   * and the container goes on to FINISHED; then the process step decides, checking every byte arrived.
   */
  upload(p, s, ctx, c) {
    if (!s.containerId) IG_STEPS.container(p, s, ctx, c);
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

  /** Instagram processes the video before it can be published; this usually takes under a minute. */
  process(p, s, ctx, c) {
    if (!s.processSince) { s.processSince = Date.now(); ctx.save(); }
    for (;;) {
      const r = metaGet_(`/${s.containerId}`, { fields: 'status_code,status,video_status', access_token: c.token });
      if (r.status_code === 'FINISHED' || r.status_code === 'PUBLISHED') {
        const got = r.video_status && r.video_status.uploading_phase ? Number(r.video_status.uploading_phase.bytes_transferred) : null;
        if (s.uploadDoubt && got !== s.size) {
          throw new ApiError('upstream', `Instagram refused the upload (ProcessingFailedError) and has ${got} of ${s.size} bytes, so nothing was posted`);
        }
        return 'next';
      }
      if (s.uploadDoubt && Date.now() - s.processSince > 15 * 60 * 1000) {
        throw new ApiError('upstream', 'Instagram refused the upload (ProcessingFailedError) and the video did not finish processing within 15 minutes');
      }
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
