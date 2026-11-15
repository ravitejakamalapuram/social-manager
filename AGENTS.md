# Notes for AI agents

- Start with [docs/FAQ.md](docs/FAQ.md). It explains the product and the whole API.
- Social Manager is a standalone posting service. Keep anything specific to one client app (its channel names, series, prompts) out of this repo.
- Each platform is one adapter file in `src/` registered in `platforms_()` in `src/core.js`. A new platform must not change how the others work.
- With every change to the API, a platform or setup, update the matching FAQ answer in the same pull request. Add a new question when you add a feature. Keep answers short and plain.
- Run `npm run bundle && npm run check && npm test` before pushing. Pushing to `main` deploys to the live app.
- Never commit tokens, the `/exec` URL, the script id or Drive file ids.
- Never post anything publicly in a test. Test uploads use `"privacy": "private"`.
