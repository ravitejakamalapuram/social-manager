# Social Media Publisher FAQ

Short answers about what Social Media Publisher is and how to use it. If you are an AI agent starting work with Social Media Publisher, read this page first. It has everything you need to call the API.

---

## The basics

### What is Social Media Publisher?
Social Media Publisher posts your videos to social platforms for you, with no browser. You put the video in Google Drive and send one API call with the title, description, tags, thumbnail, captions, playlist and publish time. Social Media Publisher uploads it and sets everything up.

### Was it called Social Manager?
Yes. The repo was renamed from `social-manager` to `social-media-publisher` in November 2026. Nothing about the API, the `/exec` URL or the tokens changed. GitHub redirects the old repo links. An install made before the rename keeps its "Social Manager" Sheet and Apps Script project names, which is fine. If its `SOURCE_REPO` Script Property is set to the old name, change it to `ravitejakamalapuram/social-media-publisher` (or delete it to use the default).

### Which platforms does it support?
YouTube, Instagram Reels, Facebook Page Reels and LinkedIn (your personal profile). Each platform is one adapter file, so adding one doesn't change the others.

### What is it built on?
Free Google services, so there is nothing to host:

- A **Google Apps Script web app** is the API. It is one URL.
- A **Google Sheet** named "Social Media Publisher" (or "Social Manager" if it was set up before the rename) keeps one row per job, so you can see what happened.
- A **time trigger** runs the queue every 5 minutes.

### Where is the code?
In this repo. `src/` is the app, `test/` holds the tests, and `docs/` holds this FAQ.

### How does new code go live?
On merge. Every push to `main` runs the `deploy` GitHub Action, which calls the admin `deploy` action with the merged commit's SHA. The script fetches `dist/Code.js` and the manifest for that commit, updates its own code, makes a new version and points the web app at it. The URL never changes. The Action needs two repository secrets: `PUBLISHER_URL` (the `/exec` URL) and `PUBLISHER_ADMIN_TOKEN` (an admin token; run `createTokenForGitHub` in the editor to make one just for this).

The hourly self-update from `main` stays on as a fallback, so if the Action fails or the secrets are missing, new code still goes live within an hour. To deploy by hand, an admin calls `deploy`, or runs `deployLatest` in the editor (for 15 minutes after an Action deploy, the hourly run and `deployLatest` skip unless forced, so a stale read of `main` can't roll it back). If new code adds a permission, open the editor and run `setup` once to allow it.

---

## Calling the API

### What URL do I call?
The web app's `/exec` URL. The owner gives you the URL and a token. Neither is ever written in this repo.

### How do I make a call?
Send JSON with POST, and always include `action` and `token`:

```bash
curl -sL "$SOCIAL_URL" -d '{"action":"list","token":"'"$T"'"}'
```

- Use `curl -L`. Google answers a POST with a redirect, and `-L` follows it.
- Don't pass `-X POST`. It breaks the redirect.
- Reads also work as GET: `curl -sL "$SOCIAL_URL?action=list&token=$T"`.

### How do I know if a call worked?
The HTTP status is always 200. Look at the body: `{"ok": true, ...}` or `{"ok": false, "error": {"code": "...", "message": "..."}}`. The message says what to fix.

### Which actions are there?

| Action | What it does |
| --- | --- |
| `health` | Is it up? No token needed. |
| `platforms` | Lists the platforms and each one's text `limits` (see "Where are the text limits?"). |
| `channel` | Shows which YouTube channel it posts to. Send `"platform": "linkedin"` for the LinkedIn profile and when its sign-in runs out. |
| `publish` | Queues a post. Returns a job. |
| `get` | One job, by `id` or by your `key`. |
| `list` | Recent jobs, newest first. Filters: `status`, `platform`, `limit` (max 200). |
| `retry` | Puts a failed job back in the queue. It carries on from the step that failed. |
| `cancel` | Cancels a job that hasn't uploaded its video yet. |
| `stats` | Followers and the newest posts' numbers for one platform. See "How do I read followers, likes and views?" |
| `comments`, `reply` | Read the newest comments and answer one. See "How do I read and reply to comments?" |
| `connectYouTube` | Returns a sign-in link for an extra YouTube channel, by `account` name (admin). |
| `connectMeta` | Returns a sign-in link for an extra Facebook Page and its Instagram account, by `account` name (admin). |
| `run` | Works the queue now instead of waiting for the trigger (admin). |
| `deploy` | Pulls the latest code from GitHub `main` now (admin). Send `"ref": "<commit SHA>"` to deploy that exact commit, or `"force": true` to redeploy unchanged code. |
| `createToken`, `revokeToken`, `listTokens` | Manage tokens (admin). |

---

## Posting to YouTube

### How do I upload a video?
Put the MP4 in the owner's Google Drive, then:

```json
{
  "action": "publish",
  "token": "...",
  "platform": "youtube",
  "key": "my-video-1",
  "video": { "driveFileId": "..." },
  "title": "How tides work",
  "description": "Why the sea rises twice a day.",
  "tags": ["tides", "moon"],
  "categoryId": 28,
  "language": "en",
  "madeForKids": false,
  "aiGenerated": false,
  "publishAt": "2026-11-20T14:00:00Z",
  "thumbnail": { "driveFileId": "..." },
  "captions": [{ "driveFileId": "...", "language": "en", "name": "English" }],
  "playlists": ["Documentaries"]
}
```

Only `platform`, `video` and `title` are required. The answer is `{"ok": true, "job": {...}}` with `job.status` = `queued`.

### What does each field mean?
- `key`: your own name for the post. Sending the same key twice returns the first job instead of uploading twice, so retrying after a timeout is safe.
- `privacy`: `private` (the default), `unlisted` or `public`.
- `publishAt`: when YouTube makes the video public, in ISO time, at least 15 minutes ahead. The video stays private until then, so leave `privacy` out.
- `categoryId`: YouTube's number. 28 is Science & Technology, 27 is Education, 22 (the default) is People & Blogs.
- `language`: the video's language, like `en`.
- `madeForKids`: defaults to `false`.
- `aiGenerated`: YouTube's "altered or synthetic content" label. Left out, YouTube's default applies.
- `thumbnail`: a JPG or PNG in Drive, at most 2 MB. The channel must be phone-verified for custom thumbnails.
- `captions`: SRT files in Drive, one per language.
- `firstComment`: a comment the channel posts on its own video right after the upload, up to 2,000 characters. It needs `privacy` `public` or `unlisted`: a private or scheduled (`publishAt`) video takes no comments, and YouTube has no API to pin it. If the comment is refused the video still goes up, with a warning.
- `playlists`: playlist ids, or exact playlist titles. A title the channel doesn't have yet is made as a new public playlist.

Limits: title 100 characters, description 5,000 bytes (not characters: Telugu and other Indic letters take 3 bytes each and emoji 4, so a Telugu description fits about 1,600 letters), tags 500 in total. Titles and descriptions can't contain `<` or `>`.

### How do I change a video that is already on YouTube?
Send `videoId` instead of `video`. Only the fields you send change; everything else on the video stays as it was. This works for videos uploaded any way, including the YouTube app. Example, schedule an existing video:

```json
{ "action": "publish", "token": "...", "platform": "youtube", "videoId": "VIDEO_ID", "publishAt": "2026-11-20T14:00:00Z" }
```

### How do I know when it is done?
Call `get` with the job `id` or your `key` every minute or so. `status` goes `queued` → `running` → `done` (or `failed`). While it runs, `progress` shows the bytes uploaded. When done, `result` has `videoId`, `url`, `studioUrl`, `privacy` and `publishAt` as YouTube reports them, plus `warnings`.

### What are warnings?
Things that went wrong without stopping the post. A bad thumbnail, caption or playlist becomes a warning, and the video still goes up. Also, if YouTube set a different privacy than you asked for, it is a warning.

### How long does it take?
The queue runs every 5 minutes. A Short takes under a minute to upload. A big video uploads in 20 MB parts, and if it runs out of time it carries on in the next run. Admins can call `run` to start right away.

### What if something fails?
Network hiccups, and Meta errors that give no reason, are retried by themselves, up to 3 tries, 5 minutes apart. If YouTube's daily quota is used up, the job waits and tries again every hour. Anything else marks the job `failed` with the reason in `error`, starting with the step that failed (for example `upload step: ...`). Fix the cause and call `retry`: it continues from the failed step, so a finished upload is never repeated.

---

## Posting to LinkedIn

### How do I post a video to LinkedIn?
Send `publish` with `"platform": "linkedin"`, `video` (`{"driveFileId": ...}`, an MP4 of 75 KB to 500 MB and 3 seconds to 30 minutes), `text` (the post, up to 3,000 characters; `#words` become hashtags), and optional `title`, `thumbnail` and `visibility` (`PUBLIC`, the default, `CONNECTIONS` or `LOGGED_IN`). It posts straight away: LinkedIn has no private or scheduled posts, so `publishAt` is refused. The result has the post's `url`.

### Can it post to a LinkedIn company page?
Not yet. Posting as a page needs LinkedIn's Community Management API, which LinkedIn only grants to a verified organization after review. Today it posts as the person who signed in.

### How do I connect LinkedIn?
1. On developer.linkedin.com create an app (it must be linked to a LinkedIn page), add the products "Share on LinkedIn" and "Sign In with LinkedIn using OpenID Connect", and add the redirect URL `https://script.google.com/macros/d/<script id>/usercallback` under Auth.
2. In the script's Script properties add `LI_CLIENT_ID` and `LI_CLIENT_SECRET` from the app's Auth tab.
3. Run `connectLinkedIn` in the editor, open the link it logs and press Allow.

### Why does LinkedIn need signing in again?
LinkedIn sign-ins last 60 days and LinkedIn gives small apps no way to renew them. `channel` with `"platform": "linkedin"` shows `tokenExpiresAt`, and posts get a warning in the last 10 days. Run `connectLinkedIn` again before then; if LinkedIn still remembers you, it's one click.

## Posting to Instagram and Facebook

### How do I post a Reel to Instagram?
Send `publish` with `"platform": "instagram"`, `video` and an optional `caption` (up to 2,200 characters and 5 hashtags; Instagram cut the limit from 30 in December 2025). Optional: `coverUrl` is a public https link to a JPG used as the Reel's cover (the grid and Reels tab show it; it must stay up until the job is done), or `coverAtMs` picks a frame of the video instead (Instagram ignores it when `coverUrl` is sent), `shareToFeed: false` keeps it off the main grid, `publishAt` holds the job until that time, `firstComment` (up to 2,200 characters, no hashtags) is posted by the account on its own Reel once it is live, and `key` works as on YouTube. Instagram's API has no private posts, so a done job is public. The result has `mediaId` and `url`.

### Which way should I give Instagram the video?
Best is a public link: `video: {"url": "https://...", "driveFileId": "..."}`. Instagram then fetches the file itself. The link must be a direct https link to the MP4 that anyone can open, and it must stay up until the job is done. The Drive file is the fallback: if Instagram can't fetch the link, the job uploads the Drive file instead and says so in a warning. You can send only `url`, or only `driveFileId`.

With only `driveFileId` the job uploads the file to Meta's upload host. That host refuses about two in three whole Reel uploads with `ProcessingFailedError` (seen November 2026, with any encoding), so this way is slow and often fails.

### How do I post a Reel to a Facebook Page?
Send `publish` with `"platform": "facebook"`, `video` and an optional `description` and `title`. `thumbnail` (`{"driveFileId": ...}`, a JPG or PNG up to 10 MB) becomes the Reel's cover; if Facebook refuses it the Reel still posts, with a warning. Add `publishAt` to let Facebook schedule it, or `"state": "draft"` to keep it unpublished on the Page. The result has `videoId` and `url`.

### What video works for Reels?
MP4 with H.264 and AAC, 9:16, 3 seconds to 15 minutes for Instagram and 3 to 90 seconds for Facebook Reels. If Instagram or Facebook can't process the video, the job fails with their reason. 

### What happens when an Instagram upload fails?
When Meta's upload host answers `ProcessingFailedError`, the job waits up to 10 minutes: a few of those videos still finish processing, and then the job posts (with a warning). If not, the job starts again with a new container after 5 minutes. It tries 3 times, then fails and posts nothing. `retry` on a failed job starts from a new container too. While a job waits on Instagram, the jobs behind it carry on.

### How do I connect Instagram and Facebook?
One Meta developer app covers both. The Instagram account must be a professional (business or creator) account linked to the Facebook Page.
1. At [developers.facebook.com](https://developers.facebook.com/apps/) create an app with the use cases for managing a Page and Instagram content. Add `https://script.google.com/macros/d/<script id>/usercallback` to Facebook Login's "Valid OAuth Redirect URIs", add a privacy policy link ([PRIVACY.md](../PRIVACY.md)), and switch the app to Live.
2. In the script's Project Settings → Script properties, add `META_APP_ID` and `META_APP_SECRET` from the app's Basic settings. If the app uses Facebook Login for Business, also create a configuration (user access token, the permissions in `src/meta.js`) and add its id as `META_CONFIG_ID`.
3. Run `connectMeta` in the editor, open the link it logs, tick the Page and the Instagram account and press Continue.
The script keeps a Page token that doesn't expire. `channel` with `platform` `instagram` or `facebook` shows the connected accounts. Run `connectMeta` again after changing your Facebook password. To move the main account to another Page, send `connectMeta` with `"match"` set to that Page (see "Can it post to more than one Instagram account or Facebook Page?"); without it the script keeps the Page it has.

### How do I read followers, likes and views?
`{"action":"stats","platform":"instagram"}` (or `facebook`) with any token, optional `limit` (newest posts, default 25, up to 100). It returns `followers` and `posts`, each with `url`, `title`, `at`, `likes`, `comments`, `views` and `reach`. Views and reach need the `instagram_manage_insights` and `read_insights` permissions; an account connected before they were added gets `null` there until `connectMeta` is run again. `youtube` works too, with any `account`: `followers` is subscribers, `channelViews` is the channel's lifetime views, and each post has views, likes and comments (no reach, and at most the 50 newest uploads). Each YouTube post also has `engagedViews`: the views where someone stayed instead of swiping away, which are the only Shorts views the Partner Programme counts. It comes from the YouTube Analytics API (enable "YouTube Analytics API" in the Cloud project), is a day or two behind, and is `null` for a channel connected before November 2026 until `connectYouTube` is run again for it, because it needs one more read-only permission. Watch time isn't included; Shorts views don't count toward watch hours anyway. Instagram posts also carry how each Reel was watched, as Instagram reports it: `skipRate` (the share of first views that left in the first 3 seconds), `avgWatchTime`, `shares` and `saves`. Instagram still marks the skip rate as in development, so any of these can be `null`. LinkedIn has no stats yet.

### How do I read and reply to comments?
`{"action":"comments","platform":"youtube"}` (or `instagram`, `facebook`) with any token, optional `limit` (newest comments, default 20, up to 100). It returns `comments`, each with `id`, `author`, `text`, `at`, `videoId`, `videoTitle`, `url`, `replies` and `replied` (true once the account has answered it). The account's own comments are left out. Instagram and Facebook look at the comments on the 25 newest Reels.

To answer one, POST `{"action":"reply","platform":"youtube","commentId":"<id>","text":"..."}` (any of the three platforms). Sending the same text to the same comment again returns the first reply (`"existing": true`) instead of posting twice, so a retry is safe.

YouTube uses the `youtube.force-ssl` permission the channel already granted. Instagram needs `instagram_manage_comments`, and Facebook needs `pages_read_user_content` and `pages_manage_engagement`. Add them to the Meta app's Login for Business configuration, then run `connectMeta` again and accept. Until then these calls fail with a permissions error from Meta.

### Does the Meta app need App Review?
No, as long as it only posts to Pages and Instagram accounts of people who have a role on the app (you, as its admin). App Review is only needed to post for other people's accounts.

---

### Where are the text limits?

Each platform's limits are in its adapter (`limits` in `src/<platform>.js`), and `{"action":"platforms"}` returns them, so a pipeline that writes titles and captions can read them instead of keeping its own copy. A post over a limit is refused with a message that says which field and by how much; nothing is cut. Today: YouTube title 100 characters, description 5,000 UTF-8 bytes, tags 500 in total; Instagram caption 2,200 characters and 5 hashtags; Facebook title 100 and description 5,000 characters; LinkedIn text 3,000 and title 200 characters.

## Limits and setup

### How many videos can I post a day?
Instagram allows 50 API posts per account per day, and Facebook has no fixed daily cap for Page Reels. For YouTube:
YouTube gives each API project 10,000 quota units a day. An upload costs about 1,600, and a thumbnail, caption or playlist about 50 to 400 more, so plan on about 5 uploads a day. Editing existing videos is cheap. Quota resets at midnight Pacific time.

### Why did my upload stay private?
It shouldn't: an upload with `"privacy": "public"` goes out public. Leave `privacy` out and it defaults to private. Google confirmed in November 2026 that API uploads are not forced private, and a public test from this project's own Cloud project stayed public without an audit. If the result still shows a different privacy than you asked for, it comes with a warning: check the channel in YouTube Studio for a strike or a missing phone verification.

### Where is the architecture?
In [ARCHITECTURE.md](ARCHITECTURE.md): one diagram of the parts and one of the sign-in and upload flow.

### Do I need the YouTube audit?
Not for public uploads. Apply only if you need more than the daily quota. The steps:
1. In [console.cloud.google.com](https://console.cloud.google.com) create a project, enable the **YouTube Data API v3**, **Google Drive API** and **Apps Script API**, and set up the OAuth consent screen (home page, privacy policy, then publish).
2. In the Apps Script editor, Project Settings → Google Cloud Platform project → Change project, and enter the project number. Run `setup` again to authorize.
3. Fill in the [YouTube API Services audit form](https://support.google.com/youtube/contact/yt_api_form) for that project. It asks for screenshots of the privacy policy ([PRIVACY.md](../PRIVACY.md)), the terms ([TERMS.md](../TERMS.md)) and the sign-in screen, and a link to this repo as the working upload code. Approval can take a few weeks.

### It posts to the wrong channel. What do I do?
`channel` and `setup` show the channel. By default the script posts as its Google account's own channel. A brand channel (one listed separately under your account) needs its own sign-in:
1. In a Google Cloud project with the YouTube Data API on, create an OAuth client of type "Web application" with the redirect URI `https://script.google.com/macros/d/<script id>/usercallback`.
2. In the script's Project Settings → Script properties, add `YT_CLIENT_ID` and `YT_CLIENT_SECRET` from that client.
3. Run `connectYouTube` in the editor, open the link it logs, pick the brand channel and press Allow.
From then on every YouTube call uses that channel. Run `connectYouTube` again to switch channels.

### Can it post to more than one YouTube channel?
Yes. The first channel is the main one. Each extra channel is an "account" with a short name of your choice, like `second`.
1. POST `{"action":"connectYouTube","token":"<admin token>","account":"second"}`. It returns a `url`, valid for 10 minutes.
   Without an admin token: in the editor, add the Script Property `YT_CONNECT_ACCOUNT` with the name, run `connectYouTubeAccount` and take the link from the log.
2. Open the link in a browser signed in to the Google account that owns the script, pick that channel and press Allow.
3. Add `"account":"second"` to any YouTube call: `publish`, `channel`, `stats`, `comments`, `reply`.
Leave `account` out and the call uses the main channel, as before. A publish to an account that is not connected fails at once with `not_connected`. All accounts share the project's daily YouTube quota.

### Can it post to more than one Instagram account or Facebook Page?
Yes, the same way as YouTube. The first Page (with its Instagram account) is the main one; each extra Page is an "account" with a short name, like `second`. Each Instagram account must be professional and linked to its own Page.
1. POST `{"action":"connectMeta","token":"<admin token>","account":"second","match":"@second_insta"}`. It returns a `url`, valid for 10 minutes. `match` is the Page's name or id, or its Instagram @username; it picks the Page when the sign-in shares more than one, and an extra account never guesses without it.
2. Open the link signed in to Facebook as the app's admin. Tick every Page the script posts to, the main one too, so its access stays, and press Continue.
3. Add `"account":"second"` to any Instagram or Facebook call: `publish`, `channel`, `stats`, `comments`, `reply`.
Leave `account` out and the call uses the main Page, as before. A publish to an account that is not connected fails at once with `not_connected`. Each Instagram account has its own 50 posts a day.

### How do I set it up?
See the [README](../README.md#set-up-once).

### What is not in git, and what do I redo on a new Google account or machine?
The code, `dist/Code.js` and the two time triggers (`runQueue` every 5 minutes, `deployLatest` hourly, both made by `setup`) are in git. Not in git, so redo them by hand:
1. **Script Properties** (Project Settings in the editor), names only: `TOKENS` (client tokens), `SHEET_ID`, `SOURCE_REPO` and `SOURCE_BRANCH` (where `deployLatest` pulls code), `META_APP_ID`, `META_APP_SECRET`, `META_CONFIG_ID`, `META_PAGE_ID`, `META_PAGE_TOKEN`, `META_IG_ID` (and the same with `_<ACCOUNT>` for each extra Page), `YT_CLIENT_ID`, `YT_CLIENT_SECRET`, and the LinkedIn ones (`LI_*`, parked). The rest (`DEPLOYED_HASH`, `REF_DEPLOYED_AT`, `WORKER_UNTIL`, `LI_EXPIRES_AT`) the code writes itself. Never write values into the repo.
2. **The OAuth consents**, which only a person can click: the Meta app login (Instagram and the Page) and the YouTube channel connection. Run `connectYouTubeAccount` for each channel.
3. **Token expiry**: the Meta Page token lasts about 60 days and Google OAuth apps left in "Testing" mode lose their refresh token after 7 days. Move the Google app to production, and put a calendar reminder to reconnect Meta.
4. **A new `/exec` URL.** Update `SOCIAL_URL` in the studio repo's GitHub secrets (and `SOCIAL_TOKEN` if you made a new token).
5. **The Sheet** (post history) is state: copy it before you move.

### How do I get a token for a new app?
An admin calls `createToken` with a `name`. The token is shown once. In the editor, `createTokenForClaude` makes the token for Claude's jobs.
