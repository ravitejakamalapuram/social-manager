# Social Manager FAQ

Short answers about what Social Manager is and how to use it. If you are an AI agent starting work with Social Manager, read this page first. It has everything you need to call the API.

---

## The basics

### What is Social Manager?
Social Manager posts your videos to social platforms for you, with no browser. You put the video in Google Drive and send one API call with the title, description, tags, thumbnail, captions, playlist and publish time. Social Manager uploads it and sets everything up.

### Which platforms does it support?
YouTube today. Instagram and Facebook are planned. Each platform is one adapter file, so adding one doesn't change the others.

### What is it built on?
Free Google services, so there is nothing to host:

- A **Google Apps Script web app** is the API. It is one URL.
- A **Google Sheet** named "Social Manager" keeps one row per job, so you can see what happened.
- A **time trigger** runs the queue every 5 minutes.

### Where is the code?
In this repo. `src/` is the app, `test/` holds the tests, and `docs/` holds this FAQ.

### How does new code go live?
The script deploys itself. Every hour it fetches `dist/Code.js` and the manifest from `main` on GitHub. If they changed, it updates its own code, makes a new version and points the web app at it. The URL never changes, and no credentials are stored in GitHub. To deploy right away, an admin calls `deploy`, or runs `deployLatest` in the editor. If new code adds a permission, open the editor and run `setup` once to allow it.

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
| `platforms` | Lists the platforms. |
| `channel` | Shows which YouTube channel it posts to. |
| `publish` | Queues a post. Returns a job. |
| `get` | One job, by `id` or by your `key`. |
| `list` | Recent jobs, newest first. Filters: `status`, `platform`, `limit` (max 200). |
| `retry` | Puts a failed job back in the queue. It carries on from the step that failed. |
| `cancel` | Cancels a job that hasn't uploaded its video yet. |
| `run` | Works the queue now instead of waiting for the trigger (admin). |
| `deploy` | Pulls the latest code from GitHub `main` now (admin). Send `"force": true` to redeploy unchanged code. |
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
- `playlists`: playlist ids, or exact playlist titles on the channel.

Limits: title 100 characters, description 5,000, tags 500 in total. Titles and descriptions can't contain `<` or `>`.

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
Network hiccups are retried by themselves, up to 3 tries, 5 minutes apart. If YouTube's daily quota is used up, the job waits and tries again every hour. Anything else marks the job `failed` with the reason in `error`. Fix the cause and call `retry`: it continues from the failed step, so a finished upload is never repeated.

---

## Limits and setup

### How many videos can I post a day?
YouTube gives each API project 10,000 quota units a day. An upload costs about 1,600, and a thumbnail, caption or playlist about 50 to 400 more, so plan on about 5 uploads a day. Editing existing videos is cheap. Quota resets at midnight Pacific time.

### Why did my upload stay private?
YouTube locks every video uploaded through an API project that hasn't passed its free compliance audit to private, and those videos can't be made public later, only uploaded again. The result shows a warning when this happens. The fix: move the script to your own Google Cloud project and apply for the audit (see the next question). Until it passes, upload from the YouTube app and use `videoId` to set everything else.

### How do I apply for the YouTube audit?
1. In [console.cloud.google.com](https://console.cloud.google.com) create a project, enable the **YouTube Data API v3** and **Google Drive API**, and set up the OAuth consent screen.
2. In the Apps Script editor, Project Settings → Google Cloud Platform project → Change project, and enter the project number. Run `setup` again to authorize.
3. Fill in the [YouTube API Services audit form](https://support.google.com/youtube/contact/yt_api_form) for that project. Approval can take a few weeks.

### It posts to the wrong channel. What do I do?
`channel` and `setup` show the channel. Social Manager posts to the default channel of the Google account that owns the script. If your channel is a brand account, make it the default channel for that account at youtube.com/account, then run `setup` again.

### How do I set it up?
See the [README](../README.md#set-up-once).

### How do I get a token for a new app?
An admin calls `createToken` with a `name`. The token is shown once. In the editor, `createTokenForClaude` makes the token for Claude's jobs.
