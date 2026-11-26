/**
 * Pull deploy: keeps this script on the latest code from GitHub, with no credentials stored anywhere.
 * An hourly trigger (or the admin `deploy` action) fetches dist/Code.js and the manifest from the source
 * branch; if they changed, it replaces the project's code, makes a new version and points the web app at it.
 * The web app URL never changes. GitHub Actions calls `deploy` with the merged commit's SHA after every push
 * to main (.github/workflows/deploy.yml); the hourly run is the fallback if that call fails.
 */

function deployLatest() {
  console.log(JSON.stringify(deployLatest_(false)));
}

function deployLatest_(force, ref) {
  const p = props_();
  // A commit SHA pins the exact merged code; raw.githubusercontent.com can serve a branch a few minutes stale.
  if (ref && !/^[0-9a-f]{40}$/.test(String(ref))) throw new ApiError('invalid', 'ref must be a full 40-character commit SHA');
  // The repo was called social-manager before November 2026; the old name is tried if the new one is not found.
  const repos = p.getProperty('SOURCE_REPO') ? [p.getProperty('SOURCE_REPO')]
    : ['ravitejakamalapuram/social-media-publisher', 'ravitejakamalapuram/social-manager'];
  const branch = p.getProperty('SOURCE_BRANCH') || 'main';
  const at = ref || branch;
  const label = ref ? ref.slice(0, 7) : branch;
  const raw = (path) => {
    let code = 0;
    for (const repo of repos) {
      const r = UrlFetchApp.fetch(`https://raw.githubusercontent.com/${repo}/${at}/${path}`, { muteHttpExceptions: true });
      code = r.getResponseCode();
      if (code === 200) return r.getContentText();
      if (code !== 404) break;
    }
    throw new ApiError('upstream', `GitHub answered ${code} for ${path}`);
  };
  const code = raw('dist/Code.js');
  const manifest = raw('src/appsscript.json');
  const hash = sha256Hex_(code + manifest);
  // Right after a commit deploy, the branch URL may still serve the previous code; don't roll back to it.
  // Checked after the fetches (not before), so a commit deploy that finished while they ran is seen.
  // No script lock: the job queue uses it, and a deploy holding it would make publish calls busy.
  if (!ref && !force && Date.now() - Number(p.getProperty('REF_DEPLOYED_AT') || 0) < 15 * 60 * 1000) {
    return { deployed: false, reason: 'a commit was deployed in the last 15 minutes' };
  }
  if (!force && hash === p.getProperty('DEPLOYED_HASH')) {
    if (ref) p.setProperty('REF_DEPLOYED_AT', String(Date.now()));
    return { deployed: false, reason: 'already on the latest code' };
  }

  const api = `https://script.googleapis.com/v1/projects/${ScriptApp.getScriptId()}`;
  googleJson_('put', `${api}/content`, {
    json: { files: [{ name: 'Code', type: 'SERVER_JS', source: code }, { name: 'appsscript', type: 'JSON', source: manifest }] },
  });
  const version = googleJson_('post', `${api}/versions`, { json: { description: `${label} ${hash.slice(0, 7)}` } });
  const config = { scriptId: ScriptApp.getScriptId(), versionNumber: version.versionNumber, manifestFileName: 'appsscript', description: `${label} ${hash.slice(0, 7)}` };
  const web = (googleJson_('get', `${api}/deployments`).deployments || [])
    .find((d) => d.deploymentConfig && d.deploymentConfig.versionNumber && (d.entryPoints || []).some((e) => e.entryPointType === 'WEB_APP'));
  const dep = web
    ? googleJson_('put', `${api}/deployments/${web.deploymentId}`, { json: { deploymentConfig: config } })
    : googleJson_('post', `${api}/deployments`, { json: config });
  p.setProperty('DEPLOYED_HASH', hash);
  if (ref) p.setProperty('REF_DEPLOYED_AT', String(Date.now()));
  const entry = (dep.entryPoints || []).find((e) => e.entryPointType === 'WEB_APP');
  return { deployed: true, version: version.versionNumber, url: entry && entry.webApp ? entry.webApp.url : null };
}
