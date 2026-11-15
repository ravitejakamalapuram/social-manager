# publisher

Post videos to social platforms from one API call, with no browser. Put the video in Google Drive, send the title, description, tags, thumbnail, captions, playlist and publish time, and Publisher does the rest. It runs free on your Google account, with nothing to host. YouTube works today; Instagram and Facebook come next.

```
 Claude tasks / scripts / curl
              │  HTTPS + token
              ▼
   Apps Script web app (this repo) ──► "Publisher" Sheet: one row per job
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

1. Create a new project at [script.google.com](https://script.google.com) named **Publisher**, signed in to the Google account that owns the YouTube channel. Copy its Script ID (Project Settings).
2. In this repo's GitHub settings, add the secret `CLASPRC_JSON` (the contents of `~/.clasprc.json` after `npx @google/clasp@3.4.1 login`) and the variable `SCRIPT_ID`. Then run the **deploy** workflow. It pushes the code and creates the web app.
3. In the editor, Deploy → Manage deployments → edit the deployment → set **Who has access** to **Anyone**.
4. Pick **setup** and press **Run**. Allow the permissions (YouTube, Drive read-only, Sheets, external requests, triggers). The log shows the jobs sheet, the YouTube channel and the admin token (shown once).
5. Run **createTokenForClaude** for the token Claude's jobs use.
6. Check it: `PUBLISHER_URL=... PUBLISHER_TOKEN=... npm run smoke`.

Without GitHub: paste `dist/Code.js` into the editor (it is all of `src/` in one file), set the manifest from `src/appsscript.json`, and deploy as a web app.

## Develop

```bash
npm test          # runs the API end to end against fake Drive and YouTube
npm run bundle    # rebuilds dist/Code.js
npm run check
```
