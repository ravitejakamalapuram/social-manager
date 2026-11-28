/**
 * Facebook adapter: posts a video from Drive as a Reel on the connected Facebook Page (see src/meta.js).
 * It can publish now, schedule with publishAt, or leave the Reel as a draft with "state": "draft".
 */

const FB_STATES = ['published', 'draft'];

const Facebook = {
  name: 'facebook',
  /** Text caps are our own (Meta documents none for Reels). seconds: Page Reels published through the API run 3 to 90 s. */
  limits: { title: 100, description: 5000, seconds: 90 },

  validate(p, now) {
    const video = optFile_(p.video, 'video');
    if (!video) throw new ApiError('invalid', 'Send video: {"driveFileId": ...}');
    const state = optText_(p.state, 'state', 20) || 'published';
    if (!FB_STATES.includes(state)) throw new ApiError('invalid', `state must be one of ${FB_STATES.join(', ')}`);
    const publishAt = optFutureTime_(p.publishAt, 'publishAt', now);
    if (publishAt && state === 'draft') throw new ApiError('invalid', 'Send publishAt or "state": "draft", not both');
    const description = optText_(p.description, 'description', Facebook.limits.description);
    return {
      thumbnail: optFile_(p.thumbnail, 'thumbnail'),
      video, description, state, publishAt,
      title: optText_(p.title, 'title', Facebook.limits.title) || (description || '').split('\n')[0].slice(0, Facebook.limits.title),
    };
  },

  steps() {
    return ['start', 'upload', 'finish', 'check', 'cover'];
  },

  run(step, job, ctx) {
    return FB_STEPS[step](job.post, job.state, ctx, metaConfig_(false));
  },

  /** Page followers and the newest Reels with likes, comments and plays (plays need read_insights). */
  stats(limit) {
    const c = metaConfig_(false);
    const page = metaGet_(`/${c.pageId}`, { fields: 'followers_count,fan_count', access_token: c.token });
    const reels = metaGet_(`/${c.pageId}/video_reels`, {
      fields: 'id,permalink_url,description,created_time,likes.summary(true).limit(0),comments.summary(true).limit(0)', limit, access_token: c.token,
    }).data || [];
    const ins = metaInsightsEach_(reels, (v) => metaGet_(`/${v.id}/video_insights`, { metric: 'blue_reels_play_count,post_impressions_unique', access_token: c.token }));
    const total = (x) => (x && x.summary && x.summary.total_count != null ? x.summary.total_count : null);
    const followers = page.followers_count != null ? page.followers_count : page.fan_count;
    return {
      followers: followers == null ? null : followers,
      posts: reels.map((v, i) => ({
        url: /^https?:/.test(v.permalink_url || '') ? v.permalink_url : `https://www.facebook.com${v.permalink_url || `/reel/${v.id}`}`,
        title: firstLine_(v.description), at: v.created_time, likes: total(v.likes), comments: total(v.comments),
        views: ins[i] && metaMetric_(ins[i], 'blue_reels_play_count'), reach: ins[i] && metaMetric_(ins[i], 'post_impressions_unique'),
      })),
    };
  },

  /** Newest comments on the Page's newest Reels, minus the Page's own, with whether the Page replied (needs pages_read_user_content). */
  comments(limit) {
    const c = metaConfig_(false);
    const reels = (metaGet_(`/${c.pageId}/video_reels`, {
      fields: 'id,permalink_url,description,comments.summary(true).limit(0)', limit: 25, access_token: c.token,
    }).data || []).filter((v) => v.comments && v.comments.summary && v.comments.summary.total_count);
    const out = [];
    reels.forEach((v) => {
      const list = metaGet_(`/${v.id}/comments`, {
        fields: 'id,message,from,created_time,like_count,comments{from,message}', filter: 'toplevel', order: 'reverse_chronological', limit: 50, access_token: c.token,
      }).data || [];
      list.filter((x) => !(x.from && x.from.id === c.pageId)).forEach((x) => {
        const replies = (x.comments && x.comments.data) || [];
        out.push({
          id: x.id, author: (x.from && x.from.name) || 'Facebook user', text: x.message, at: x.created_time, likes: x.like_count == null ? 0 : x.like_count,
          videoId: v.id, videoTitle: firstLine_(v.description),
          url: /^https?:/.test(v.permalink_url || '') ? v.permalink_url : `https://www.facebook.com${v.permalink_url || `/reel/${v.id}`}`,
          replies: replies.length, replied: replies.some((r) => r.from && r.from.id === c.pageId),
        });
      });
    });
    out.sort((a, b) => String(b.at).localeCompare(String(a.at)));
    return { comments: out.slice(0, limit) };
  },

  /** Replies to a comment as the Page. Sending the same text again returns the first reply instead of posting twice. */
  reply(commentId, text) {
    const c = metaConfig_(false);
    const id = encodeURIComponent(commentId);
    const mine = (metaGet_(`/${id}/comments`, { fields: 'id,message,from', limit: 100, access_token: c.token }).data || [])
      .find((x) => x.from && x.from.id === c.pageId && x.message === text);
    const r = mine || metaPost_(`/${id}/comments`, { message: text, access_token: c.token });
    return { reply: { id: r.id, commentId, text, existing: !!mine } };
  },

  whoami() {
    const c = metaConfig_(false);
    const r = metaGet_(`/${c.pageId}`, { fields: 'name,link', access_token: c.token });
    return { id: c.pageId, title: r.name, url: r.link || `https://www.facebook.com/${c.pageId}` };
  },
};

// Under Apps Script's 50 MB fetch limit, with room for the request around the bytes.
let FB_WHOLE_BYTES = 45 * 1024 * 1024;

const FB_STEPS = {
  start(p, s, ctx, c) {
    if (s.reelId) return 'next';
    const r = metaPost_(`/${c.pageId}/video_reels`, { upload_phase: 'start', access_token: c.token });
    s.reelId = r.video_id;
    s.uploadUrl = r.upload_url || `https://rupload.facebook.com/video-upload/${GRAPH_VERSION}/${r.video_id}`;
    ctx.save();
    return 'next';
  },

  upload(p, s, ctx, c) {
    if (!s.reelId) FB_STEPS.start(p, s, ctx, c);  // a refused whole upload starts again with a new Reel
    metaFileSize_(p, s);
    // Reels uploads refuse a part of the file ("Partial request (did not match length of file)"), so a file that
    // fits in one fetch goes in one request; only a larger one is sent in parts.
    if (s.offset === 0 && s.size <= FB_WHOLE_BYTES) {
      try {
        metaUpload_(s.uploadUrl, c.token, driveRange_(p.video.driveFileId, 0, s.size - 1), 0, s.size);
      } catch (e) {  // a refused upload may hold a part already; the retry starts a new Reel instead
        delete s.reelId;
        delete s.uploadUrl;
        ctx.save();
        throw e;
      }
      s.offset = s.size;
      ctx.save();
      return 'next';
    }
    return metaSendFile_(p, s, ctx, s.uploadUrl, c.token);
  },

  finish(p, s, ctx, c) {
    if (s.videoId) return 'next';
    metaPost_(`/${c.pageId}/video_reels`, {
      upload_phase: 'finish', video_id: s.reelId, access_token: c.token,
      video_state: p.publishAt ? 'SCHEDULED' : p.state.toUpperCase(),
      scheduled_publish_time: p.publishAt ? Math.floor(new Date(p.publishAt).getTime() / 1000) : null,
      description: p.description, title: p.title || null,
    });
    s.videoId = s.reelId;
    ctx.save();
    return 'next';
  },

  /**
   * Sets the Reel's cover from a Drive image (POST /{video-id}/thumbnails with is_preferred, Meta's "custom cover
   * photo" for Reels). Runs after processing, since a thumbnail can only go on a video the Page already has.
   */
  cover(p, s, ctx, c) {
    if (!p.thumbnail || s.coverDone) return 'next';
    ctx.afterPublish('cover', () => {
      const m = driveMeta_(p.thumbnail.driveFileId);
      if (Number(m.size) > 10 * 1024 * 1024) throw new ApiError('invalid', 'The cover is over Facebook\'s 10 MB limit');
      const r = UrlFetchApp.fetch(`${GRAPH}/${s.videoId}/thumbnails`, {
        method: 'post', muteHttpExceptions: true,
        payload: { access_token: c.token, is_preferred: 'true', source: Utilities.newBlob(driveBytes_(p.thumbnail.driveFileId), m.mimeType || 'image/jpeg', 'cover.jpg') },
      });
      if (r.getResponseCode() < 200 || r.getResponseCode() >= 300) throw metaError_(r);
    });
    s.coverDone = true;
    ctx.save();
    return 'next';
  },

  /** Waits for Facebook to finish processing, so a broken video shows up as a failed job. */
  check(p, s, ctx, c) {
    for (;;) {
      const r = metaGet_(`/${s.videoId}`, { fields: 'status,permalink_url', access_token: c.token });
      const st = r.status || {};
      const phases = [st.uploading_phase, st.processing_phase, st.publishing_phase].filter(Boolean);
      const bad = phases.find((x) => x.status === 'error');
      if (st.video_status === 'error' || bad) {
        throw new ApiError('upstream', `Facebook could not process the Reel: ${(bad && bad.errors && bad.errors[0] && bad.errors[0].message) || 'no reason given'}`);
      }
      if (st.video_status === 'ready' || (st.publishing_phase && st.publishing_phase.status === 'complete') || p.state === 'draft' || p.publishAt) {
        const link = r.permalink_url ? (r.permalink_url.startsWith('http') ? r.permalink_url : `https://www.facebook.com${r.permalink_url}`) : `https://www.facebook.com/reel/${s.videoId}`;
        ctx.result({ videoId: s.videoId, url: link, state: p.publishAt ? 'scheduled' : p.state, publishAt: p.publishAt || null, videoStatus: st.video_status || null });
        return 'next';
      }
      if (ctx.outOfTime()) return 'pause';
      Utilities.sleep(10 * 1000);
    }
  },
};
