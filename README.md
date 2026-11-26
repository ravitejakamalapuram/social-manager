# social-media-publisher

Post videos to social platforms from one API call, with no browser. Put the video in Google Drive, send the title, description, tags, thumbnail, captions, playlist and publish time, and Social Media Publisher does the rest. It runs free on your Google account, with nothing to host. It posts to YouTube, Instagram Reels, Facebook Page Reels and LinkedIn.

```
 Claude tasks / scripts / curl
              │  HTTPS + token
              ▼
   Apps Script web app (this repo) ──► "Social Media Publisher" Sheet: one row per job
              │  every 5 min: work the queue
              ▼
   Drive (read the files) ──► one adapter per platform: YouTube, Instagram, Facebook, LinkedIn
```

**New here, or an AI agent? Read [docs/FAQ.md](docs/FAQ.md) first.** It has every action, field and error.

## What it does

- **Posts** a video from Drive to YouTube (title, description, tags, thumbnail, captions, playlist, scheduled publish), Instagram Reels, Facebook Page Reels and LinkedIn (personal profile). Each post is a queued job that resumes from the failed step on `retry`.
- **Reads numbers**: `stats` returns followers and the newest posts' views, likes and comments for YouTube, Instagram and Facebook.
- **Handles comments**: `comments` lists the newest comments, `reply` answers one (a repeated reply is not posted twice).
- **Several YouTube channels**: connect extra channels as named accounts and add `"account": "<name>"` to any YouTube call.

## Where it fits

Social Media Publisher is a standalone service. It knows nothing about the apps that call it: no channel names, schedules or approval rules live here. A client (a publisher script, a scheduled job, `curl`) decides what to post and when, calls this API with its token, and reads the job back for the post links. Client-specific settings belong in the client.

```bash
curl -sL "$SOCIAL_URL" -d '{"action":"publish","token":"'"$T"'","platform":"youtube","video":{"driveFileId":"..."},"title":"...","privacy":"private"}'
curl -sL "$SOCIAL_URL?action=stats&platform=instagram&token=$T"
```

## How it is built

- `src/api.js`: the web app and its actions.
- `src/worker.js`: runs queued jobs step by step and saves progress after each one.
- `src/youtube.js`, `src/instagram.js`, `src/facebook.js`, `src/linkedin.js`: one adapter per platform (`src/meta.js` and `src/youtube-auth.js` hold their sign-in helpers). A new platform is a new file like them, added to `platforms_()` in `src/core.js`.
- `src/deploy.js`: the self-update. GitHub Actions triggers it on every merge to `main` (`.github/workflows/deploy.yml`), and an hourly trigger is the fallback.
- `src/google.js`: Drive and Google API helpers. `src/store.js`: the jobs sheet. `src/setup.js`: the one-time setup and tokens.
- `dist/Code.js`: the bundle the live script runs. Rebuild and commit it with every change.

## Set up (once)

1. Create a new project at [script.google.com](https://script.google.com) named **Social Media Publisher**, signed in to the Google account that owns the YouTube channel. Make sure the Apps Script API is on at [script.google.com/home/usersettings](https://script.google.com/home/usersettings).
2. Paste `dist/Code.js` over `Code.gs`. In Project Settings, tick "Show appsscript.json", and paste `src/appsscript.json` over it.
3. Pick **setup** and press **Run**. Allow the permissions. The log shows the jobs sheet, the YouTube channel and the admin token (shown once).
4. Pick **deployLatest** and press **Run**. It creates the web app and logs its URL. From then on the script updates itself from `main` every hour.
5. Run **createTokenForClaude** for the token Claude's jobs use.
6. Connect the platforms you use (each is a one-time sign-in in a browser): YouTube brand or extra channels with `connectYouTube` / `connectYouTubeAccount`, Instagram and Facebook with `connectMeta` after adding the Meta app's Script Properties. The FAQ has the steps for each.
7. Check it: `SOCIAL_URL=... SOCIAL_TOKEN=... npm run smoke`.
8. For deploy on merge, add the repository secrets `PUBLISHER_URL` (the `/exec` URL) and `PUBLISHER_ADMIN_TOKEN` (the admin token from step 3) in GitHub under Settings > Secrets and variables > Actions.

Script Properties, OAuth consents, the Sheet and the `/exec` URL are not in git; the FAQ answer "What is not in git" lists what to redo on a new account.

## Develop

```bash
npm test          # runs the API end to end against fake Drive and YouTube
npm run bundle    # rebuilds dist/Code.js
npm run check     # syntax-checks src/ and dist/Code.js
```

Run all three before pushing, and commit the rebuilt `dist/Code.js`: the live script pulls `main` within an hour. Tests never post publicly.
