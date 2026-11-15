/**
 * One-time setup, run from the Apps Script editor (select setup, press Run). Safe to run again:
 * it reuses the spreadsheet, trigger and tokens that already exist.
 */

function setup() {
  const p = props_();
  let ss = null;
  const id = p.getProperty('SHEET_ID');
  if (id) {
    try { ss = SpreadsheetApp.openById(id); } catch (err) { ss = null; }
  }
  if (!ss) {
    ss = SpreadsheetApp.create('Publisher');
    p.setProperty('SHEET_ID', ss.getId());
  }
  let sh = ss.getSheetByName('Jobs');
  if (!sh) {
    sh = ss.getSheets()[0];
    sh.setName('Jobs');
  }
  sh.getRange(1, 1, 1, JOB_COLS.length).setValues([JOB_COLS]).setFontWeight('bold');
  sh.setFrozenRows(1);

  if (!ScriptApp.getProjectTriggers().some((t) => t.getHandlerFunction() === 'runQueue')) {
    ScriptApp.newTrigger('runQueue').timeBased().everyMinutes(5).create();
  }

  const lines = [`Jobs sheet: ${ss.getUrl()}`];
  try {
    const c = YouTube.whoami();
    lines.push(`YouTube channel: ${c.title} (${c.url}). If this is not the channel you want, see the FAQ.`);
  } catch (err) {
    lines.push(`YouTube check failed: ${err.message}`);
  }
  if (!Object.values(tokens_()).some((t) => t.admin)) {
    lines.push(`Admin token (shown once, keep it in a password manager): ${issueToken_('admin', true)}`);
  } else {
    lines.push('Admin token already exists; run resetAdminToken() if you lost it.');
  }
  console.log(lines.join('\n'));
}

/** Replaces the admin token, e.g. if it leaked. Other tokens keep working. */
function resetAdminToken() {
  replaceToken_('admin', true);
}

/** Issues (or replaces) the token Claude's scheduled jobs use. */
function createTokenForClaude() {
  replaceToken_('claude', false);
}

function replaceToken_(name, admin) {
  const all = tokens_();
  Object.keys(all).forEach((h) => { if (all[h].name === name) delete all[h]; });
  props_().setProperty('TOKENS', JSON.stringify(all));
  console.log(`Token for "${name}" (shown once): ${issueToken_(name, admin)}`);
}
