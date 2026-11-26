/**
 * Pull deploy: keeps this script on the latest code from GitHub, with no credentials stored anywhere.
 * An hourly trigger (or the admin `deploy` action) fetches dist/Code.js and the manifest from the source
 * branch; if they changed, it replaces the project's code, makes a new version and points the web app at it.
 * The web app URL never changes.
 */

function deployLatest() {
  console.log(JSON.stringify(deployLatest_(false)));
}

function deployLatest_(force) {
  const p = props_();
  const repo = p.getProperty('SOURCE_REPO') || 'ravitejakamalapuram/social-media-publisher';
  const branch = p.getProperty('SOURCE_BRANCH') || 'main';
  const raw = (path) => {
    const r = UrlFetchApp.fetch(`https://raw.githubusercontent.com/${repo}/${branch}/${path}`, { muteHttpExceptions: true });
    if (r.getResponseCode() !== 200) throw new ApiError('upstream', `GitHub answered ${r.getResponseCode()} for ${path}`);
    return r.getContentText();
  };
  const code = raw('dist/Code.js');
  const manifest = raw('src/appsscript.json');
  const hash = sha256Hex_(code + manifest);
  if (!force && hash === p.getProperty('DEPLOYED_HASH')) return { deployed: false, reason: 'already on the latest code' };

  const api = `https://script.googleapis.com/v1/projects/${ScriptApp.getScriptId()}`;
  googleJson_('put', `${api}/content`, {
    json: { files: [{ name: 'Code', type: 'SERVER_JS', source: code }, { name: 'appsscript', type: 'JSON', source: manifest }] },
  });
  const version = googleJson_('post', `${api}/versions`, { json: { description: `${branch} ${hash.slice(0, 7)}` } });
  const config = { scriptId: ScriptApp.getScriptId(), versionNumber: version.versionNumber, manifestFileName: 'appsscript', description: `${branch} ${hash.slice(0, 7)}` };
  const web = (googleJson_('get', `${api}/deployments`).deployments || [])
    .find((d) => d.deploymentConfig && d.deploymentConfig.versionNumber && (d.entryPoints || []).some((e) => e.entryPointType === 'WEB_APP'));
  const dep = web
    ? googleJson_('put', `${api}/deployments/${web.deploymentId}`, { json: { deploymentConfig: config } })
    : googleJson_('post', `${api}/deployments`, { json: config });
  p.setProperty('DEPLOYED_HASH', hash);
  const entry = (dep.entryPoints || []).find((e) => e.entryPointType === 'WEB_APP');
  return { deployed: true, version: version.versionNumber, url: entry && entry.webApp ? entry.webApp.url : null };
}
