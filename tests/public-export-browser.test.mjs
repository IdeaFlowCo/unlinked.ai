import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';

// Opt-in product check against a running Next.js app and an existing AXI browser.
// Run with PUBLIC_EXPORT_TEST_URL. Capture visual evidence separately: an AXI
// bridge can restrict screenshot paths to roots other than the evidence folder.
const base = process.env.PUBLIC_EXPORT_TEST_URL;
const axi = (...args) => execFileSync('chrome-devtools-axi', args, { encoding: 'utf8', timeout: 60000 });
const tabIds = () => [...axi('pages').matchAll(/^\s+(\d+),/gm)].map(m => Number(m[1]));
async function eventually(read, accept) {
  for (let i = 0; i < 20; i++) {
    const value = read();
    if (accept(value)) return value;
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  assert.fail('Browser did not reach expected state');
}
function evaluate(expression) {
  const output = axi('eval', expression);
  const encoded = output.match(/^result: (.+)$/m)?.[1];
  assert.ok(encoded, output);
  return JSON.parse(JSON.parse(encoded));
}
function clickLink(name) {
  const snapshot = axi('snapshot');
  const row = snapshot.split('\n').find(line => line.includes(`link "${name}"`));
  assert.ok(row, `Missing rendered link: ${name}`);
  axi('click', `@${row.match(/uid=(\S+)/)[1]}`);
}
const surface = () => evaluate(`({url:location.href,text:document.querySelector('main').innerText,
  files:document.querySelectorAll('main input[type=file]').length,
  primary:[...document.querySelectorAll('main a.public-button-primary')].map(a=>({text:a.innerText,href:a.href,target:a.target})),
  overflow:document.documentElement.scrollWidth>innerWidth})`);

test('public export journey is honest, navigable and responsive', { skip: !base }, async () => {
  axi('newpage', base);
  const originalTab = Math.max(...tabIds());
  axi('resize', '1440', '1000');
  let page = surface();
  assert.equal(page.files, 0);
  assert.equal(page.primary.length, 1);
  assert.match(page.primary[0].text, /^Start my LinkedIn export/);
  assert.equal(page.primary[0].href, 'https://www.linkedin.com/mypreferences/d/download-my-data');
  assert.equal(page.primary[0].target, '_blank');
  assert.match(page.text, /EXAMPLE · FICTIONAL PEOPLE/);
  assert.match(page.text, /Director of Partnerships\s+Northwind Solar/);
  assert.match(page.text, /Uploads and sign-in are not active yet/);
  assert.doesNotMatch(page.text, /provider/);
  assert.equal(page.overflow, false);
  const previousTabs = tabIds();
  clickLink('Start my LinkedIn export ↗');
  const popup = await eventually(() => tabIds().find(id => !previousTabs.includes(id)), Boolean);
  axi('selectpage', String(popup));
  await eventually(() => evaluate('location.href'), url => new URL(url).hostname.endsWith('linkedin.com'));
  axi('closepage', String(popup));
  axi('selectpage', String(originalTab));
  page = await eventually(surface, p => new URL(p.url).pathname === '/import-linkedin');
  assert.equal(new URL(page.url).pathname, '/import-linkedin');
  assert.match(page.text, /select Connections only/);
  assert.match(page.text, /within 48 hours/);
  assert.match(page.text, /not available on mobile/);
  assert.match(page.text, /within 72 hours/);
  assert.match(page.text, /invited Ideaflow ID account is required before upload/);
  assert.match(page.text, /browser file-picker journey still needs verification/);
  assert.equal(page.files, 0);
  // Exercise the alternate path for people who already downloaded their file.
  axi('open', base);
  clickLink('Already have your file? See the next step →');
  page = await eventually(surface, p => new URL(p.url).hash === '#next');
  assert.equal(new URL(page.url).hash, '#next');
  assert.match(page.text, /Sign-in and uploads are not active yet/);
  assert.equal(evaluate(`(()=>{const r=document.querySelector('#next').getBoundingClientRect();return r.top<innerHeight&&r.bottom>0})()`), true);
  axi('resize', '390', '844');
  axi('open', base);
  assert.equal(surface().overflow, false);
  clickLink('Already have your file? See the next step →');
  await eventually(surface, p => new URL(p.url).hash === '#next');
  assert.equal(surface().overflow, false);
  axi('closepage', String(originalTab));
});
