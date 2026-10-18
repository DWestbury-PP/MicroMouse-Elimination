#!/usr/bin/env node
// Publish the static site to here.now from a clean, pushed `main`.
//
//   node scripts/deploy.js            # normal release
//   node scripts/deploy.js --allow-dirty   # preview a local tree (skips git checks)
//
// Reads HERENOW_API_KEY (and optional HERENOW_SLUG) from the environment or .env.
'use strict';
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

process.chdir(path.resolve(__dirname, '..'));
const FILES = {
  'index.html': 'text/html; charset=utf-8',
  'css/style.css': 'text/css; charset=utf-8',
  'js/sim.js': 'text/javascript; charset=utf-8',
  'js/app.js': 'text/javascript; charset=utf-8',
};
const die = (msg) => { console.error('deploy: ' + msg); process.exit(1); };
const sh = (cmd) => execSync(cmd, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

function loadEnv() {
  if (!fs.existsSync('.env')) return;
  for (const line of fs.readFileSync('.env', 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^['"]|['"]$/g, '');
  }
}

function preflight(allowDirty) {
  if (!allowDirty) {
    if (sh('git rev-parse --abbrev-ref HEAD') !== 'main') die('releases ship from main (use --allow-dirty to preview)');
    if (sh('git status --porcelain')) die('working tree is not clean');
    sh('git fetch -q origin main');
    if (sh('git rev-parse HEAD') !== sh('git rev-parse origin/main')) die('local main is not in sync with origin/main');
  }
  try { sh('node --test tests/*.test.js'); } catch (e) { die('tests failed:\n' + (e.stdout || '') + (e.stderr || '')); }
  for (const f of Object.keys(FILES)) if (!fs.existsSync(f)) die('missing ' + f);
}

async function main() {
  const allowDirty = process.argv.includes('--allow-dirty');
  loadEnv();
  const key = process.env.HERENOW_API_KEY;
  const slug = process.env.HERENOW_SLUG || 'mellow-spirit-x2jq';
  if (!key) die('HERENOW_API_KEY is not set');
  preflight(allowDirty);

  const headers = { 'X-HereNow-Client': 'claude-code/deploy-js', Authorization: 'Bearer ' + key, 'content-type': 'application/json' };
  const api = async (method, url, body) => {
    const r = await fetch('https://here.now' + url, { method, headers, body: JSON.stringify(body) });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) die(`${method} ${url} -> HTTP ${r.status} ${JSON.stringify(j)}`);
    return j;
  };

  const files = Object.entries(FILES).map(([p, contentType]) => ({ path: p, size: fs.statSync(p).size, contentType }));
  const { upload } = await api('PUT', '/api/v1/publish/' + slug, { files });
  for (const u of upload.uploads) {
    const r = await fetch(u.url, { method: u.method || 'PUT', headers: u.headers, body: fs.readFileSync(u.path) });
    if (!r.ok) die(`upload ${u.path} -> HTTP ${r.status}`);
    console.log('  uploaded ' + u.path);
  }
  for (const s of upload.skipped || []) console.log('  unchanged ' + (s.path || s));
  const fin = await api('POST', `/api/v1/publish/${slug}/finalize`, { versionId: upload.versionId });

  // Verify what is actually served. here.now injects social meta tags into HTML,
  // so compare scripts byte-for-byte and the page by content marker.
  const base = fin.siteUrl;
  const bust = '?v=' + upload.versionId;
  for (const p of ['js/sim.js', 'js/app.js', 'css/style.css']) {
    const live = await (await fetch(base + p + bust)).text();
    if (live !== fs.readFileSync(p, 'utf8')) die(`live ${p} does not match local`);
  }
  const page = await (await fetch(base + bust)).text();
  if (!page.includes('<title>MicroMouse Grand Prix</title>')) die('live index.html looks wrong');

  const sha = allowDirty ? 'working tree' : sh('git rev-parse --short HEAD');
  console.log(`deployed ${sha} -> ${base} (version ${fin.currentVersionId}, previous ${fin.previousVersionId})`);
}

main().catch((e) => die(e.stack || String(e)));
