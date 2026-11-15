// Read-only check of a live deployment: SOCIAL_URL=... SOCIAL_TOKEN=... npm run smoke
const url = process.env.SOCIAL_URL;
const token = process.env.SOCIAL_TOKEN;
if (!url || !token) { console.error('Set SOCIAL_URL and SOCIAL_TOKEN'); process.exit(1); }

const get = async (q) => (await fetch(`${url}?${new URLSearchParams(Object.assign({ token }, q))}`)).json();
let failed = 0;
const check = (name, ok, info) => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${ok ? '' : ` ${JSON.stringify(info)}`}`); if (!ok) failed++; };

const h = await get({ action: 'health' });
check('health', h.ok && h.platforms.includes('youtube'), h);
const c = await get({ action: 'channel' });
check(`channel${c.ok ? ` = ${c.title}` : ''}`, c.ok, c);
const l = await get({ action: 'list', limit: 5 });
check('list', l.ok && Array.isArray(l.jobs), l);
const bad = await get({ action: 'list', token: 'wrong' });
check('wrong token is refused', bad.error && bad.error.code === 'unauthorized', bad);
process.exit(failed ? 1 : 0);
