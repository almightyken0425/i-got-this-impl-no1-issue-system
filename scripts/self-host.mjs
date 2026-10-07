import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { cp, mkdir, open, readFile, readdir, realpath, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, URL } from 'node:url';
import process from 'node:process';
import console from 'node:console';
import { config } from 'dotenv';
import { Pool } from 'pg';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const migrationsDirectory = join(root, 'packages/server/dist/db/migrations');
const releasePath = join(root, 'packages/server/dist/release.json');
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { cwd: root, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, ...options });
  if (result.error || result.status !== 0) throw new Error(`${command} 失敗，請檢查工具版本、連線與檔案權限`);
  return result.stdout;
}

export async function build() {
  run('npm', ['run', 'build'], { stdio: 'inherit' });
  await mkdir(migrationsDirectory, { recursive: true });
  const names = (await readdir(join(root, 'packages/server/src/db/migrations'))).filter(name => name.endsWith('.sql')).sort();
  const migrations = [];
  for (const name of names) {
    await cp(join(root, 'packages/server/src/db/migrations', name), join(migrationsDirectory, name));
    migrations.push({ name, sha256: sha256(await readFile(join(migrationsDirectory, name))) });
  }
  // 版本包含未提交來源的雜湊，避免把工作區候選誤認為已發布的 commit。
  const commit = run('git', ['rev-parse', 'HEAD']).trim();
  const files = [...new Set(run('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard']).split('\0').filter(Boolean))].sort();
  const source = createHash('sha256');
  for (const name of files) {
    source.update(name).update('\0');
    try { source.update(await readFile(join(root, name))); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  const sourceHash = source.digest('hex');
  const release = { format: 1, version: process.env.RELEASE_VERSION ?? `candidate-${sourceHash.slice(0, 12)}`, commit, sourceHash, builtAt: new Date().toISOString(), migrations };
  await writeFile(releasePath, `${JSON.stringify(release, null, 2)}\n`);
  return release;
}

async function readRelease() {
  const release = JSON.parse(await readFile(releasePath, 'utf8'));
  const actual = (await readdir(migrationsDirectory)).filter(name => name.endsWith('.sql')).sort();
  if (JSON.stringify(actual) !== JSON.stringify(release.migrations.map(item => item.name))) throw new Error('migration 清單不符，請重新 build');
  for (const item of release.migrations) {
    if (sha256(await readFile(join(migrationsDirectory, item.name))) !== item.sha256) throw new Error('migration 校驗失敗，請重新 build');
  }
  return release;
}

async function withDatabase(url, action) {
  if (!url) throw new Error('DATABASE_URL 未設定');
  const pool = new Pool({ connectionString: url, max: 1 });
  try {
    const lock = await pool.query("SELECT pg_try_advisory_lock(hashtext('igotthis-maintenance')) AS acquired");
    if (!lock.rows[0].acquired) throw new Error('另一個維護作業正在執行');
    return await action(pool);
  } finally { await pool.end(); }
}

async function requireEmpty(pool) {
  const result = await pool.query(`SELECT count(*)::int AS count FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname NOT IN ('pg_catalog', 'information_schema') AND n.nspname NOT LIKE 'pg_toast%'
    AND c.relkind IN ('r', 'p', 'v', 'm', 'S', 'f')`);
  if (result.rows[0].count !== 0) throw new Error('必須使用空資料庫，不會覆蓋既有資料');
}

async function migrationNames(pool) {
  return (await pool.query('SELECT name FROM schema_migrations ORDER BY name')).rows.map(row => row.name);
}

async function migrate(pool) {
  const release = await readRelease();
  const exists = (await pool.query("SELECT to_regclass('public.schema_migrations') AS name")).rows[0].name;
  if (exists) {
    const current = await migrationNames(pool);
    const expected = release.migrations.map(item => item.name);
    if (current.some((name, index) => name !== expected[index])) throw new Error('資料庫版本與交付版本不相容，拒絕降版或缺號升級');
  }
  const { applyMigrations } = await import('../packages/server/dist/db/migrate.js');
  return applyMigrations(pool);
}

export async function install(url) {
  return withDatabase(url, async pool => { await requireEmpty(pool); return migrate(pool); });
}

function connection(url) {
  const parsed = new URL(url);
  const password = decodeURIComponent(parsed.password);
  parsed.password = '';
  return { url: parsed.href, env: { ...process.env, ...(password ? { PGPASSWORD: password } : {}) } };
}

async function createBackup(pool, url, path) {
  const release = await readRelease();
  const names = await migrationNames(pool);
  const target = resolve(path);
  const handle = await open(target, 'wx', 0o600);
  const pg = connection(url);
  try { run('pg_dump', ['--format=custom', '--no-owner', '--no-acl', '--dbname', pg.url], { env: pg.env, stdio: ['ignore', handle.fd, 'pipe'] }); }
  finally { await handle.close(); }
  run('pg_restore', ['--list', target]);
  const metadata = { format: 1, createdAt: new Date().toISOString(), sha256: sha256(await readFile(target)), migrations: names, toolRelease: release.version };
  await writeFile(`${target}.json`, `${JSON.stringify(metadata, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
  return metadata;
}

export async function backup(url, path) {
  return withDatabase(url, pool => createBackup(pool, url, path));
}

export async function upgrade(url, backupPath) {
  return withDatabase(url, async pool => {
    await createBackup(pool, url, backupPath);
    return migrate(pool);
  });
}

export async function restore(url, path) {
  const target = resolve(path);
  const metadata = JSON.parse(await readFile(`${target}.json`, 'utf8'));
  if (metadata.format !== 1 || metadata.sha256 !== sha256(await readFile(target))) throw new Error('備份校驗失敗，未寫入資料库');
  run('pg_restore', ['--list', target]);
  return withDatabase(url, async pool => {
    await requireEmpty(pool);
    const pg = connection(url);
    run('pg_restore', ['--exit-on-error', '--single-transaction', '--no-owner', '--no-acl', '--dbname', pg.url, target], { env: pg.env });
    const names = await migrationNames(pool);
    if (JSON.stringify(names) !== JSON.stringify(metadata.migrations)) throw new Error('還原後 migration 清單不符');
    return { restored: true, migrations: names };
  });
}

export async function verify(url) {
  const release = await readRelease();
  return withDatabase(url, async pool => {
    const names = await migrationNames(pool);
    if (JSON.stringify(names) !== JSON.stringify(release.migrations.map(item => item.name))) throw new Error('資料庫版本與交付版本不符');
    const result = await pool.query('SELECT count(*)::int AS issues FROM issues');
    return { version: release.version, migrations: names.length, issues: result.rows[0].issues };
  });
}

if (process.argv[1] && await realpath(process.argv[1]) === fileURLToPath(import.meta.url)) {
  config({ path: join(root, '.env') });
  const [command, path] = process.argv.slice(2);
  try {
    if (command === 'build') console.log(JSON.stringify(await build(), null, 2));
    else if (command === 'install') console.log(await install(process.env.DATABASE_URL));
    else if (command === 'verify') console.log(await verify(process.env.DATABASE_URL));
    else if (['backup', 'restore', 'upgrade'].includes(command) && path) console.log(await ({ backup, restore, upgrade })[command](process.env.DATABASE_URL, path));
    else throw new Error('用法：node scripts/self-host.mjs build|install|verify|backup <檔案>|restore <檔案>|upgrade <升級前備份檔案>');
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
