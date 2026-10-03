import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

const root = resolve(process.argv[2]);
const url = process.env.CI_TEST_DATABASE_URL;
if (!url || new URL(url).pathname !== '/automatic_ci') {
  throw new Error(
    'CI_TEST_DATABASE_URL must point to the isolated automatic_ci database. Never use production.',
  );
}
const metadata = JSON.parse(readFileSync(resolve(root, 'release.json'), 'utf8'));
const require = createRequire(resolve(root, 'apps/api/package.json'));
const pg = require('pg');
const bcrypt = require('bcryptjs');
const pool = new pg.Pool({ connectionString: url });
const child = spawn(process.execPath, ['dist/server.js'], {
  cwd: resolve(root, 'apps/api'),
  env: {
    ...process.env,
    NODE_ENV: 'production',
    HOST: '127.0.0.1',
    PORT: '3100',
    DATABASE_URL: url,
    CORS_ORIGINS: 'https://ci.example.test',
    DEV_ADMIN_ENABLED: 'false',
    JWT_ACCESS_SECRET: randomBytes(48).toString('hex'),
    JWT_ISSUER: 'automatic-api',
    JWT_AUDIENCE: 'automatic-web',
    RESEND_API_KEY: '',
    RESEND_FROM: '',
    AUTOMATIC_RELEASE: metadata.release,
    AUTOMATIC_COMMIT: metadata.commit,
  },
  stdio: 'inherit',
});
const base = 'http://127.0.0.1:3100';
const id = randomUUID();
const email = `ci-${id}@example.test`;
const password = randomBytes(18).toString('hex');
const request = (path, options = {}) =>
  fetch(base + path, { ...options, signal: AbortSignal.timeout(5000) });
try {
  let ready = false;
  for (let i = 0; i < 40; i++) {
    if (child.exitCode !== null) throw new Error('Packaged API exited during startup');
    try {
      const response = await request('/api/health');
      const body = await response.json();
      assert.equal(body.release, metadata.release);
      assert.equal(body.commit, metadata.commit);
      ready = response.ok;
      if (ready) break;
    } catch {
      await delay(250);
    }
  }
  assert.ok(ready, 'Packaged API did not become healthy');
  await pool.query('INSERT INTO users (id,email,password_hash,name) VALUES ($1,$2,$3,$4)', [
    id,
    email,
    await bcrypt.hash(password, 4),
    'CI smoke',
  ]);
  const headers = { 'content-type': 'application/json', origin: 'https://ci.example.test' };
  const login = await request('/api/auth/login', {
    method: 'POST',
    headers,
    body: JSON.stringify({ email, password }),
  });
  assert.equal(login.status, 200);
  const body = await login.json();
  const cookie = login.headers.get('set-cookie');
  assert.ok(cookie.includes('Secure') && cookie.includes('HttpOnly'));
  assert.equal(
    (await request('/api/auth/me', { headers: { authorization: `Bearer ${body.accessToken}` } }))
      .status,
    200,
  );
  const refresh = await request('/api/auth/refresh', {
    method: 'POST',
    headers: { ...headers, cookie: cookie.split(';')[0] },
  });
  assert.equal(refresh.status, 200);
  const rotated = refresh.headers.get('set-cookie').split(';')[0];
  assert.equal(
    (
      await request('/api/auth/logout', {
        method: 'POST',
        headers: { ...headers, cookie: rotated },
      })
    ).status,
    204,
  );
  console.log(
    'Packaged API passed PostgreSQL migrations, release identity, login, refresh and logout.',
  );
} finally {
  child.kill('SIGTERM');
  await new Promise((resolveExit) => {
    if (child.exitCode !== null) resolveExit();
    else child.once('exit', resolveExit);
  });
  await pool.query('DELETE FROM users WHERE id=$1', [id]).catch(() => {});
  await pool.end();
}
