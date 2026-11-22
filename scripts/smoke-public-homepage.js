#!/usr/bin/env node
'use strict';

// Isolated smoke test for public-homepage routing and ERP access boundaries.
// Uses a temporary DATA_DIR so no production or developer data is read or changed.
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');

async function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      server.close(err => err ? reject(err) : resolve(port));
    });
  });
}
async function waitFor(url, child) {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error('Server exited before becoming ready');
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch {}
    await new Promise(resolve => setTimeout(resolve, 200));
  }
  throw new Error('Server did not become ready within 15 seconds');
}

(async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hyoshin-home-smoke-'));
  const port = await freePort();
  const password = 'Smoke-Test-Only-Password-2026';
  const base = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, ['server.js'], {
    cwd: path.resolve(__dirname, '..'),
    env: { ...process.env, DATA_DIR: dataDir, PORT: String(port), HS_USER: 'smokeadmin', HS_PASS: password, NEWS_DISABLED: '1' },
    stdio: 'ignore'
  });

  try {
    await waitFor(base + '/api/health', child);

    const home = await fetch(base + '/', { redirect: 'manual' });
    assert.equal(home.status, 200, 'public root should return 200 without a session');
    const html = await home.text();
    assert.match(html, /주식회사 효신/);
    assert.match(html, /曉晨/);
    assert.match(html, /효신통합관리/);
    assert.match(html, /회사 소개서/);
    assert.match(html, /회사 연혁/);
    assert.match(html, /지명원/);

    const news = await fetch(base + '/api/public/news');
    assert.equal(news.status, 200, 'public news endpoint should be readable without login');
    const newsBody = await news.json();
    assert.equal(newsBody.ok, true);
    assert.ok(Array.isArray(newsBody.items));

    const protectedDb = await fetch(base + '/api/db');
    assert.equal(protectedDb.status, 401, 'ERP database API must remain protected');

    const erpWithoutSession = await fetch(base + '/erp', { redirect: 'manual' });
    assert.equal(erpWithoutSession.status, 302, 'ERP screen should redirect unauthenticated visitors');
    assert.equal(erpWithoutSession.headers.get('location'), '/login.html');

    const login = await fetch(base + '/api/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Origin': base },
      body: JSON.stringify({ username: 'smokeadmin', password })
    });
    assert.equal(login.status, 200, 'isolated admin login should succeed');
    const cookie = (login.headers.get('set-cookie') || '').split(';')[0];
    assert.match(cookie, /^hs_session=/);

    const erp = await fetch(base + '/erp', { headers: { Cookie: cookie } });
    assert.equal(erp.status, 200, 'authenticated user should reach ERP');
    assert.match(await erp.text(), /효신통합관리/);

    const admin = await fetch(base + '/admin.html', { headers: { Cookie: cookie } });
    assert.equal(admin.status, 200, 'admin page should remain reachable for admin');

    const signup = await fetch(base + '/signup.html');
    assert.equal(signup.status, 200, 'staff signup page should remain public');

    console.log('PASS: public homepage, public news, protected ERP API, login redirect, authenticated ERP, admin, signup');
  } finally {
    child.kill('SIGTERM');
    await new Promise(resolve => {
      if (child.exitCode !== null) return resolve();
      const timer = setTimeout(resolve, 2000);
      child.once('exit', () => { clearTimeout(timer); resolve(); });
    });
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
})().catch(err => {
  console.error(err);
  process.exitCode = 1;
});
