/**
 * Facebook adapter: posts a video from Drive as a Reel on the connected Facebook Page (see src/meta.js).
 * It can publish now, schedule with publishAt, or leave the Reel as a draft with "state": "draft".
 */

const FB_STATES = ['published', 'draft'];

const Facebook = {
  name: 'facebook',

  validate(p, now) {
    const video = optFile_(p.video, 'video');
    if (!video) throw new ApiError('invalid', 'Send video: {"driveFileId": ...}');
    const state = optText_(p.state, 'state', 20) || 'published';
    if (!FB_STATES.includes(state)) throw new ApiError('invalid', `state must be one of ${FB_STATES.join(', ')}`);
    const publishAt = optFutureTime_(p.publishAt, 'publishAt', now);
    if (publishAt && state === 'draft') throw new ApiError('invalid', 'Send publishAt or "state": "draft", not both');
    const description = optText_(p.description, 'description', 5000);
    return {
      video, description, state, publishAt,
      title: optText_(p.title, 'title', 100) || (description || '').split('\n')[0].slice(0, 100),
    };
  },

  steps() {
    return ['start', 'upload', 'finish', 'check'];
  },

  run(step, job, ctx) {
    return FB_STEPS[step](job.post, job.state, ctx, metaConfig_(false));
  },

  whoami() {
    const c = metaConfig_(false);
    const r = metaGet_(`/${c.pageId}`, { fields: 'name,link', access_token: c.token });
    return { id: c.pageId, title: r.name, url: r.link || `https://www.facebook.com/${c.pageId}` };
  },
};

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
    metaFileSize_(p, s);
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
