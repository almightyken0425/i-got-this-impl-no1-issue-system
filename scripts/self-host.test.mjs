import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, appendFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';
import { fileURLToPath, URL } from 'node:url';
import { test } from 'node:test';
import { Pool } from 'pg';
import { config } from 'dotenv';
import { backup, install, restore, upgrade, verify } from './self-host.mjs';

config({ path: fileURLToPath(new URL('../.env', import.meta.url)) });

test('全新安裝、舊版升級、獨立還原及失敗保護', async () => {
  assert.ok(process.env.TEST_DATABASE_URL, 'TEST_DATABASE_URL 未設定，維護演練未執行');
  const admin = new Pool({ connectionString: process.env.TEST_DATABASE_URL });
  const suffix = randomUUID().replaceAll('-', '');
  const names = [`igt_install_${suffix}`, `igt_restore_${suffix}`];
  const urls = names.map(name => { const url = new URL(process.env.TEST_DATABASE_URL); url.pathname = `/${name}`; return url.href; });
  const directory = await mkdtemp(join(tmpdir(), 'igotthis-maintenance-'));
  const pool = new Pool({ connectionString: urls[0] });
  let restored;
  let app;
  try {
    for (const name of names) await admin.query(`CREATE DATABASE "${name}"`);
    await install(urls[0]);
    await verify(urls[0]);
    await assert.rejects(install(urls[0]), /空資料庫/);
    const { createServer } = await import('../packages/server/dist/api/index.js');
    app = createServer({ pool, authConfig: { sessionSecret: 'test-only-secret', cookieName: 'sid', ttlSeconds: 3600, cookieSecure: false } });
    const registration = await app.inject({ method: 'POST', url: '/api/auth/register', payload: { name: '維護者', email: 'maintenance@example.test', password: 'test-password-123' } });
    assert.equal(registration.statusCode, 201, registration.body);
    const cookie = registration.cookies.map(value => `${value.name}=${value.value}`).join('; ');
    const call = options => app.inject({ ...options, headers: { cookie } });
    assert.equal((await call({ method: 'GET', url: '/api/workspace' })).statusCode, 200);
    const issueResponse = await call({ method: 'POST', url: '/api/workspace/issues', payload: { title: '升級必須保留的工單', point: 5 } });
    assert.equal(issueResponse.statusCode, 201, issueResponse.body);
    const issue = issueResponse.json().issue;
    assert.equal((await call({ method: 'PATCH', url: `/api/workspace/issues/${issue.id}`, payload: { title: '保留工單與異動歷史' } })).statusCode, 200);
    await app.close(); app = undefined;
    // 還原 005 的既有資料形態，再由公開升級入口套用 006。
    await pool.query("DELETE FROM field_defs WHERE name = 'WorkLog'");
    await pool.query("UPDATE field_defs SET rollupable = false, rollup_fn = NULL WHERE name = 'point'");
    await pool.query('DROP TABLE rollup_access_sources');
    await pool.query("DELETE FROM schema_migrations WHERE name >= '006_rollup_fields.sql'");
    const before = (await pool.query('SELECT * FROM issue_field_records ORDER BY id')).rows;
    const workflow = (await pool.query('SELECT * FROM workflow_states ORDER BY name')).rows;
    const preUpgrade = join(directory, 'before-upgrade.dump');
    await upgrade(urls[0], preUpgrade);
    assert.equal((await pool.query("SELECT rollupable FROM field_defs WHERE name = 'point'")).rows[0].rollupable, true);
    assert.equal((await pool.query("SELECT count(*)::int AS count FROM field_defs WHERE name = 'WorkLog'")).rows[0].count, 1);
    assert.deepEqual((await pool.query('SELECT * FROM issue_field_records ORDER BY id')).rows, before);
    assert.deepEqual((await pool.query('SELECT * FROM workflow_states ORDER BY name')).rows, workflow);
    await verify(urls[0]);
    const dump = join(directory, 'current.dump');
    await backup(urls[0], dump);
    await assert.rejects(backup(urls[0], dump), /exist|EEXIST/);
    await assert.rejects(restore(urls[0], dump), /空資料庫/);
    await restore(urls[1], dump);
    restored = new Pool({ connectionString: urls[1] });
    assert.equal((await restored.query('SELECT issue_key FROM issues WHERE id = $1', [issue.id])).rows[0].issue_key, issue.key);
    assert.deepEqual((await restored.query('SELECT * FROM issue_field_records ORDER BY id')).rows, before);
    assert.deepEqual((await restored.query('SELECT * FROM workflow_states ORDER BY name')).rows, workflow);
    await verify(urls[1]);
    const metadata = JSON.parse(await readFile(`${dump}.json`, 'utf8'));
    assert.equal(metadata.migrations.at(-1), '007_rollup_access_sources.sql');
    await appendFile(dump, 'corrupted');
    await assert.rejects(restore(urls[1], dump), /校驗/);
    await assert.rejects(upgrade(urls[0], dump), /exist|EEXIST/);
  } finally {
    await app?.close();
    await pool.end(); await restored?.end();
    for (const name of names) await admin.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
    await admin.end();
    await rm(directory, { recursive: true, force: true });
  }
});
