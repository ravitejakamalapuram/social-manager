# social-manager

Post videos to social platforms from one API call, with no browser. Put the video in Google Drive, send the title, description, tags, thumbnail, captions, playlist and publish time, and Social Manager does the rest. It runs free on your Google account, with nothing to host. It posts to YouTube, Instagram Reels and Facebook Page Reels.

```
 Claude tasks / scripts / curl
              │  HTTPS + token
              ▼
   Apps Script web app (this repo) ──► "Social Manager" Sheet: one row per job
              │  every 5 min: work the queue
              ▼
   Drive (read the files) ──► YouTube Data API (upload in parts, set details)
```

**New here, or an AI agent? Read [docs/FAQ.md](docs/FAQ.md) first.**

## How it is built

- `src/api.js`: the web app and its actions.
- `src/worker.js`: runs queued jobs step by step and saves progress after each one.
- `src/youtube.js`: the YouTube adapter. A new platform is a new file like it, added to `platforms_()` in `src/core.js`.
- `src/google.js`: Drive and Google API helpers. `src/store.js`: the jobs sheet.

## Set up (once)

1. Create a new project at [script.google.com](https://script.google.com) named **Social Manager**, signed in to the Google account that owns the YouTube channel. Make sure the Apps Script API is on at [script.google.com/home/usersettings](https://script.google.com/home/usersettings).
2. Paste `dist/Code.js` over `Code.gs`. In Project Settings, tick "Show appsscript.json", and paste `src/appsscript.json` over it.
3. Pick **setup** and press **Run**. Allow the permissions. The log shows the jobs sheet, the YouTube channel and the admin token (shown once).
4. Pick **deployLatest** and press **Run**. It creates the web app and logs its URL. From then on the script updates itself from `main` every hour.
5. Run **createTokenForClaude** for the token Claude's jobs use.
6. Check it: `SOCIAL_URL=... SOCIAL_TOKEN=... npm run smoke`.

## Develop

```bash
npm test          # runs the API end to end against fake Drive and YouTube
npm run bundle    # rebuilds dist/Code.js
npm run check
```
