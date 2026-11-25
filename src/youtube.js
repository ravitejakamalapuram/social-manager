/**
 * YouTube adapter. Uploads a video from Drive with a resumable upload (any size, in chunks, across
 * several worker runs if needed), or edits a video already on YouTube, then sets the thumbnail,
 * captions and playlists. Every step records what it finished, so a retry never repeats work.
 */

const YT = 'https://www.googleapis.com/youtube/v3';
const YT_UPLOAD = 'https://www.googleapis.com/upload/youtube/v3';
const YT_PRIVACY = ['private', 'unlisted', 'public'];

const YouTube = {
  name: 'youtube',

  /** Checks a publish request and returns the clean version that is stored on the job. */
  validate(p, now) {
    const video = optFile_(p.video, 'video');
    const videoId = optText_(p.videoId, 'videoId', 20);
    if (!video && !videoId) throw new ApiError('invalid', 'Send video: {"driveFileId": ...} to upload, or videoId to edit a video already on YouTube');
    if (video && videoId) throw new ApiError('invalid', 'Send video or videoId, not both');

    const title = optText_(p.title, 'title', 100);
    if (video && !title) throw new ApiError('invalid', 'title is required for an upload');
    if (title && /[<>]/.test(title)) throw new ApiError('invalid', 'title cannot contain < or >');
    const description = optText_(p.description, 'description', 5000);
    if (description && /[<>]/.test(description)) throw new ApiError('invalid', 'description cannot contain < or >');

    let tags = null;
    if (p.tags !== undefined && p.tags !== null) {
      if (!Array.isArray(p.tags) || p.tags.some((t) => typeof t !== 'string')) throw new ApiError('invalid', 'tags must be a list of text');
      tags = p.tags.map((t) => t.trim()).filter(Boolean);
      // YouTube counts a tag with a space as if it had quotes around it, plus a comma between tags.
      const len = tags.reduce((n, t) => n + t.length + (t.includes(' ') ? 2 : 0), 0) + Math.max(tags.length - 1, 0);
      if (len > 500) throw new ApiError('invalid', `tags add up to ${len} characters; the limit is 500`);
    }

    const categoryId = p.categoryId === undefined || p.categoryId === null ? null : String(p.categoryId);
    if (categoryId && !/^\d+$/.test(categoryId)) throw new ApiError('invalid', 'categoryId must be a number like 28');

    const publishAt = optFutureTime_(p.publishAt, 'publishAt', now);
    let privacy = optText_(p.privacy, 'privacy', 10);
    if (privacy && !YT_PRIVACY.includes(privacy)) throw new ApiError('invalid', `privacy must be one of ${YT_PRIVACY.join(', ')}`);
    if (publishAt && privacy && privacy !== 'private') {
      throw new ApiError('invalid', 'A scheduled video must be private until publishAt; leave privacy out or send "private"');
    }
    if (publishAt) privacy = 'private';
    if (video && !privacy) privacy = 'private';

    let captions = [];
    if (p.captions !== undefined && p.captions !== null) {
      if (!Array.isArray(p.captions)) throw new ApiError('invalid', 'captions must be a list');
      captions = p.captions.map((c, i) => {
        const f = optFile_(c, `captions[${i}]`);
        const language = optText_(c.language, `captions[${i}].language`, 20);
        if (!language) throw new ApiError('invalid', `captions[${i}].language is required, like "en"`);
        return { driveFileId: f.driveFileId, language, name: optText_(c.name, `captions[${i}].name`, 150) || '' };
      });
    }

    let playlists = [];
    if (p.playlists !== undefined && p.playlists !== null) {
      if (!Array.isArray(p.playlists) || p.playlists.some((x) => typeof x !== 'string' || !x)) throw new ApiError('invalid', 'playlists must be a list of playlist ids or exact playlist titles');
      playlists = p.playlists;
    }

    return {
      video, videoId, title, description, tags, categoryId: categoryId || (video ? '22' : null),
      language: optText_(p.language, 'language', 20),
      madeForKids: video ? optBool_(p.madeForKids, 'madeForKids') === true : optBool_(p.madeForKids, 'madeForKids'),
      aiGenerated: optBool_(p.aiGenerated, 'aiGenerated'),
      privacy, publishAt,
      thumbnail: optFile_(p.thumbnail, 'thumbnail'),
      captions, playlists,
    };
  },

  steps(post) {
    return [post.video ? 'upload' : 'edit', 'thumbnail', 'captions', 'playlists', 'check'];
  },

  run(step, job, ctx) {
    return YT_STEPS[step](job.post, job.state, ctx);
  },

  /** The channel the service posts to. */
  whoami() {
    const r = googleJson_('get', `${YT}/channels?part=snippet&mine=true`);
    const c = (r.items || [])[0];
    if (!c) throw new ApiError('not_found', 'This Google account has no YouTube channel');
    return { id: c.id, title: c.snippet.title, url: `https://www.youtube.com/channel/${c.id}` };
  },

  /** Subscribers, total channel views and the newest uploads with views, likes and comments. YouTube has no reach, so that is null. */
  stats(limit) {
    const c = (googleJson_('get', `${YT}/channels?part=statistics,contentDetails&mine=true`).items || [])[0];
    if (!c) throw new ApiError('not_found', 'This Google account has no YouTube channel');
    const st = c.statistics || {};
    const num = (v) => (v == null ? null : Number(v));
    const ids = (googleJson_('get', `${YT}/playlistItems?part=contentDetails&playlistId=${c.contentDetails.relatedPlaylists.uploads}&maxResults=${Math.min(limit, 50)}`).items || [])
      .map((i) => i.contentDetails.videoId);
    const videos = ids.length ? googleJson_('get', `${YT}/videos?part=snippet,statistics&id=${ids.join(',')}`).items || [] : [];
    return {
      followers: st.hiddenSubscriberCount ? null : num(st.subscriberCount),
      channelViews: num(st.viewCount),
      posts: videos.map((v) => ({
        url: `https://youtu.be/${v.id}`, title: v.snippet.title, at: v.snippet.publishedAt,
        likes: num(v.statistics && v.statistics.likeCount), comments: num(v.statistics && v.statistics.commentCount),
        views: num(v.statistics && v.statistics.viewCount), reach: null,
      })),
    };
  },

  /** Newest top-level comments on the channel's videos, minus the channel's own, with whether the channel replied. */
  comments(limit) {
    const me = YouTube.whoami().id;
    const r = googleJson_('get', `${YT}/commentThreads?part=snippet,replies&allThreadsRelatedToChannelId=${me}&order=time&maxResults=${limit}&textFormat=plainText`);
    const items = (r.items || []).filter((t) => ytAuthor_(t.snippet.topLevelComment) !== me);
    const ids = [...new Set(items.map((t) => t.snippet.videoId))];
    const titles = {};
    if (ids.length) (googleJson_('get', `${YT}/videos?part=snippet&id=${ids.join(',')}`).items || []).forEach((v) => { titles[v.id] = v.snippet.title; });
    return {
      comments: items.map((t) => {
        const c = t.snippet.topLevelComment.snippet;
        return {
          id: t.id, author: c.authorDisplayName, text: c.textDisplay, at: c.publishedAt, likes: c.likeCount,
          videoId: t.snippet.videoId, videoTitle: titles[t.snippet.videoId] || '',
          url: `https://www.youtube.com/watch?v=${t.snippet.videoId}&lc=${t.id}`,
          replies: t.snippet.totalReplyCount,
          replied: ((t.replies && t.replies.comments) || []).some((x) => ytAuthor_(x) === me),
        };
      }),
    };
  },

  /** Replies to a top-level comment. Sending the same text again returns the first reply instead of posting twice. */
  reply(commentId, text) {
    const me = YouTube.whoami().id;
    const mine = (googleJson_('get', `${YT}/comments?part=snippet&parentId=${encodeURIComponent(commentId)}&maxResults=100&textFormat=plainText`).items || [])
      .find((x) => ytAuthor_(x) === me && x.snippet.textOriginal === text);
    const c = mine || googleJson_('post', `${YT}/comments?part=snippet`, { json: { snippet: { parentId: commentId, textOriginal: text } } });
    return { reply: { id: c.id, commentId, text: c.snippet.textOriginal, existing: !!mine } };
  },
};

function ytAuthor_(c) {
  return c && c.snippet && c.snippet.authorChannelId && c.snippet.authorChannelId.value;
}

function ytSnippet_(p, base) {
  const s = {};
  ['title', 'description', 'tags', 'categoryId', 'defaultLanguage', 'defaultAudioLanguage'].forEach((k) => {
    if (base && base[k] !== undefined) s[k] = base[k];
  });
  if (p.title) s.title = p.title;
  if (p.description !== null) s.description = p.description;
  if (p.tags) s.tags = p.tags;
  if (p.categoryId) s.categoryId = p.categoryId;
  if (p.language) { s.defaultLanguage = p.language; s.defaultAudioLanguage = p.language; }
  return s;
}

function ytStatus_(p, base) {
  const s = {};
  ['privacyStatus', 'publishAt', 'embeddable', 'license', 'publicStatsViewable', 'selfDeclaredMadeForKids', 'containsSyntheticMedia'].forEach((k) => {
    if (base && base[k] !== undefined) s[k] = base[k];
  });
  if (p.privacy) s.privacyStatus = p.privacy;
  if (p.publishAt) s.publishAt = p.publishAt;
  else if (p.privacy && p.privacy !== 'private') delete s.publishAt;
  if (p.madeForKids !== null) s.selfDeclaredMadeForKids = p.madeForKids;
  if (p.aiGenerated !== null) s.containsSyntheticMedia = p.aiGenerated;
  return s;
}

const YT_STEPS = {
  upload(p, s, ctx) {
    if (s.videoId) return 'next';
    if (!s.size) {
      const m = driveMeta_(p.video.driveFileId);
      s.size = Number(m.size);
      s.mime = m.mimeType || 'video/mp4';
      if (!s.size) throw new ApiError('invalid', 'The video file in Drive is empty');
    }
    if (!s.session) {
      const r = google_('post', `${YT_UPLOAD}/videos?uploadType=resumable&part=snippet,status`, {
        json: { snippet: ytSnippet_(p), status: ytStatus_(p) },
        headers: { 'X-Upload-Content-Length': String(s.size), 'X-Upload-Content-Type': s.mime },
      });
      if (r.getResponseCode() !== 200) throw upstreamError_(r);
      s.session = header_(r, 'Location');
      s.offset = 0;
      ctx.save();
    }
    while (s.offset < s.size) {
      if (ctx.outOfTime()) return 'pause';
      const end = Math.min(s.offset + CHUNK_BYTES, s.size) - 1;
      const r = google_('put', s.session, {
        payload: driveRange_(p.video.driveFileId, s.offset, end),
        contentType: s.mime,
        headers: { 'Content-Range': `bytes ${s.offset}-${end}/${s.size}` },
      });
      const code = r.getResponseCode();
      if (code === 200 || code === 201) {
        s.videoId = JSON.parse(r.getContentText()).id;
        s.offset = s.size;
        ctx.save();
        break;
      }
      if (code === 308) {
        const range = header_(r, 'Range'); // "bytes=0-12345": what YouTube has so far
        s.offset = range ? Number(String(range).split('-')[1]) + 1 : 0;
        ctx.save();
        continue;
      }
      if (code === 404 || code === 410) {
        // The upload session expired (they last about a week); start the upload again.
        delete s.session;
        s.offset = 0;
        ctx.save();
        throw new ApiError('upstream', 'The upload session expired; starting the upload again', { retry: 'transient' });
      }
      throw upstreamError_(r);
    }
    return 'next';
  },

  edit(p, s) {
    if (s.videoId) return 'next';
    const r = googleJson_('get', `${YT}/videos?part=snippet,status&id=${encodeURIComponent(p.videoId)}`);
    const v = (r.items || [])[0];
    if (!v) throw new ApiError('not_found', `No video ${p.videoId} on this channel`);
    googleJson_('put', `${YT}/videos?part=snippet,status`, {
      json: { id: p.videoId, snippet: ytSnippet_(p, v.snippet), status: ytStatus_(p, v.status) },
    });
    s.videoId = p.videoId;
    return 'next';
  },

  thumbnail(p, s, ctx) {
    if (!p.thumbnail || s.thumbnailDone) return 'next';
    ctx.optional('thumbnail', () => {
      const m = driveMeta_(p.thumbnail.driveFileId);
      if (Number(m.size) > 2 * 1024 * 1024) throw new ApiError('invalid', 'The thumbnail is over YouTube\'s 2 MB limit');
      const r = google_('post', `${YT_UPLOAD}/thumbnails/set?videoId=${encodeURIComponent(s.videoId)}&uploadType=media`, {
        payload: driveBytes_(p.thumbnail.driveFileId), contentType: m.mimeType || 'image/jpeg',
      });
      if (r.getResponseCode() !== 200) throw upstreamError_(r);
    });
    s.thumbnailDone = true;
    return 'next';
  },

  captions(p, s, ctx) {
    s.captionsDone = s.captionsDone || [];
    p.captions.forEach((c, i) => {
      if (s.captionsDone.includes(i)) return;
      ctx.optional(`captions ${c.language}`, () => {
        const boundary = `pub${Date.now()}`;
        const head = `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify({ snippet: { videoId: s.videoId, language: c.language, name: c.name, isDraft: false } })}\r\n--${boundary}\r\nContent-Type: application/octet-stream\r\n\r\n`;
        const body = Utilities.newBlob(head).getBytes()
          .concat(driveBytes_(c.driveFileId))
          .concat(Utilities.newBlob(`\r\n--${boundary}--`).getBytes());
        const r = google_('post', `${YT_UPLOAD}/captions?part=snippet&uploadType=multipart`, { payload: body, contentType: `multipart/related; boundary=${boundary}` });
        if (r.getResponseCode() !== 200) throw upstreamError_(r);
      });
      s.captionsDone.push(i);
      ctx.save();
    });
    return 'next';
  },

  playlists(p, s, ctx) {
    s.playlistsDone = s.playlistsDone || [];
    const todo = p.playlists.filter((x) => !s.playlistsDone.includes(x));
    if (!todo.length) return 'next';
    let mine = null;
    todo.forEach((want) => {
      ctx.optional(`playlist ${want}`, () => {
        if (!mine) mine = ytMyPlaylists_();
        let hit = mine.find((pl) => pl.id === want) || mine.find((pl) => pl.title === want);
        if (!hit && /^PL[\w-]{10,}$/.test(want)) throw new ApiError('not_found', `No playlist with id "${want}" on this channel`);
        if (!hit) { // a title the channel doesn't have yet: make it as a public playlist
          const made = googleJson_('post', `${YT}/playlists?part=snippet,status`, {
            json: { snippet: { title: want }, status: { privacyStatus: 'public' } },
          });
          hit = { id: made.id, title: want };
          mine.push(hit);
        }
        googleJson_('post', `${YT}/playlistItems?part=snippet`, {
          json: { snippet: { playlistId: hit.id, resourceId: { kind: 'youtube#video', videoId: s.videoId } } },
        });
      });
      s.playlistsDone.push(want);
      ctx.save();
    });
    return 'next';
  },

  /** Reads the video back, so the result shows what YouTube actually did. */
  check(p, s, ctx) {
    const r = googleJson_('get', `${YT}/videos?part=status,snippet&id=${encodeURIComponent(s.videoId)}`);
    const v = (r.items || [])[0];
    if (!v) throw new ApiError('upstream', `YouTube does not list video ${s.videoId}`, { retry: 'transient' });
    const st = v.status || {};
    if (p.privacy && st.privacyStatus !== p.privacy) {
      ctx.warn(`Asked for ${p.privacy} but YouTube set ${st.privacyStatus}. Check the channel in YouTube Studio (see the FAQ).`);
    }
    if (p.publishAt && !st.publishAt) ctx.warn('Asked for a scheduled time but YouTube did not keep it. Check the video in YouTube Studio.');
    ctx.result({
      videoId: s.videoId,
      url: `https://youtu.be/${s.videoId}`,
      studioUrl: `https://studio.youtube.com/video/${s.videoId}/edit`,
      title: v.snippet && v.snippet.title,
      privacy: st.privacyStatus,
      publishAt: st.publishAt || null,
      uploadStatus: st.uploadStatus || null,
    });
    return 'next';
  },
};

function ytMyPlaylists_() {
  const out = [];
  let page = '';
  do {
    const r = googleJson_('get', `${YT}/playlists?part=snippet&mine=true&maxResults=50${page ? `&pageToken=${page}` : ''}`);
    (r.items || []).forEach((pl) => out.push({ id: pl.id, title: pl.snippet.title }));
    page = r.nextPageToken || '';
  } while (page);
  return out;
}
