import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { loadEnv } from './env.js';
import { applyMigrations } from './migrate.js';
import { withRollback } from './testDb.js';

// DB 基礎層整合測試：連 igotthis_test。
// 每個 case 靠交易 rollback 隔離，測試間不互相汙染。
// 無 TEST_DATABASE_URL（例如無 DB 的 CI）時整組略過，不讓純邏輯測試被拖垮。

loadEnv();
const testUrl = process.env['TEST_DATABASE_URL'];

/** spec no1_data_models 七個建表 model 的實體，對映為 snake_case 表名。deployment 不建表。 */
const EXPECTED_TABLES = [
  // container
  'companies',
  'teams',
  'products',
  'mgmts',
  'issue_sets',
  // permission
  'accounts',
  'account_roles',
  'roles',
  'role_scopes',
  'level_definitions',
  'tag_groups',
  'tag_values',
  'rate_histories',
  'view_shares',
  // calendar
  'calendar_definitions',
  'calendar_exceptions',
  // field
  'field_set_defs',
  'field_defs',
  'issue_field_values',
  'issue_field_records',
  // issue
  'issues',
  'issue_type_definitions',
  'workflow_states',
  'workflow_transitions',
  'resolution_options',
  // relation
  'relation_type_definitions',
  'issue_relations',
  // view
  'views',
  'view_sort_entries',
] as const;

/**
 * spec 實體以外、由 impl 層技術需求建立的基礎設施表。
 * sessions 為自帶帳密認證的伺服器端 session 儲存，非 Model 層資料實體。
 */
const INFRA_TABLES = ['sessions', 'rollup_access_sources'] as const;

const suite = testUrl ? describe : describe.skip;

suite('DB 基礎層 / 整合', () => {
  let pool: Pool;

  beforeAll(async () => {
    pool = new Pool({ connectionString: testUrl });
    // 全清後重跑 migration，取得乾淨且可重現的 schema。
    await pool.query('DROP SCHEMA public CASCADE');
    await pool.query('CREATE SCHEMA public');
    await applyMigrations(pool);
  });

  afterAll(async () => {
    await pool.end();
  });

  it('migration 建起 spec 所有實體對應的表', async () => {
    const result = await pool.query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables
       WHERE table_schema = 'public' AND table_type = 'BASE TABLE'`,
    );
    const actual = new Set(result.rows.map((row) => row.table_name));

    for (const table of EXPECTED_TABLES) {
      expect(actual.has(table), `缺少表 ${table}`).toBe(true);
    }
  });

  it('建表數等於 spec 實體數加基礎設施表加 schema_migrations，無多餘表', async () => {
    const result = await pool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM information_schema.tables
       WHERE table_schema = 'public' AND table_type = 'BASE TABLE'`,
    );
    // spec 實體表 + impl 基礎設施表（sessions）+ runner 自己的 schema_migrations。
    expect(Number(result.rows[0]?.count)).toBe(
      EXPECTED_TABLES.length + INFRA_TABLES.length + 1,
    );
  });

  it('全表帶非空 company_id 租戶鍵（companies 以自身 id 承載租戶鍵；deployment 不建表）', async () => {
    const result = await pool.query<{ table_name: string }>(
      `SELECT t.table_name
       FROM information_schema.tables t
       WHERE t.table_schema = 'public'
         AND t.table_type = 'BASE TABLE'
         AND t.table_name NOT IN ('schema_migrations', 'companies')
         AND NOT EXISTS (
           SELECT 1 FROM information_schema.columns c
           WHERE c.table_schema = 'public'
             AND c.table_name = t.table_name
             AND c.column_name = 'company_id'
             AND c.is_nullable = 'NO'
         )`,
    );
    expect(result.rows.map((row) => row.table_name)).toEqual([]);
  });

  it('company_id 皆建索引', async () => {
    // 每個帶 company_id 的表，至少有一個以 company_id 為首欄的索引。
    const result = await pool.query<{ table_name: string }>(
      `SELECT t.table_name
       FROM information_schema.tables t
       WHERE t.table_schema = 'public'
         AND t.table_type = 'BASE TABLE'
         AND t.table_name NOT IN ('schema_migrations', 'companies')
         AND NOT EXISTS (
           SELECT 1
           FROM pg_index i
           JOIN pg_class ci ON ci.oid = i.indexrelid
           JOIN pg_class ct ON ct.oid = i.indrelid
           JOIN pg_attribute a ON a.attrelid = ct.oid AND a.attnum = i.indkey[0]
           WHERE ct.relname = t.table_name
             AND a.attname = 'company_id'
         )`,
    );
    expect(result.rows.map((row) => row.table_name)).toEqual([]);
  });

  it('交易 rollback 隔離：寫入不落地', async () => {
    const id = '00000000-0000-0000-0000-000000000001';
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('INSERT INTO companies (id, name) VALUES ($1, $2)', [id, 'RollbackCo']);
      const inside = await client.query('SELECT name FROM companies WHERE id = $1', [id]);
      expect(inside.rows).toHaveLength(1);
      await client.query('ROLLBACK');
    } finally {
      client.release();
    }
    const after = await pool.query('SELECT name FROM companies WHERE id = $1', [id]);
    expect(after.rows).toHaveLength(0);
  });

  it('獨佔關聯的部分唯一索引擋掉同被指端第二列', async () => {
    await withRollback(pool, async (client) => {
      const company = '11111111-1111-1111-1111-111111111111';
      const teamId = '22222222-2222-2222-2222-222222222222';
      const prodId = '33333333-3333-3333-3333-333333333333';
      const mgmtId = '44444444-4444-4444-4444-444444444444';
      const setId = '55555555-5555-5555-5555-555555555555';
      const typeId = '66666666-6666-6666-6666-666666666666';
      const relType = '77777777-7777-7777-7777-777777777777';
      const holder = '88888888-8888-8888-8888-888888888888';
      const target = '99999999-9999-9999-9999-999999999999';
      const other = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';

      await client.query('INSERT INTO companies (id, name) VALUES ($1, $2)', [company, 'ExCo']);
      await client.query('INSERT INTO teams (id, company_id, name) VALUES ($1, $2, $3)', [
        teamId,
        company,
        'T',
      ]);
      await client.query(
        'INSERT INTO products (id, company_id, team_id, name) VALUES ($1, $2, $3, $4)',
        [prodId, company, teamId, 'P'],
      );
      // 環狀 FK 為 deferrable，同交易內先插 mgmt 再插 issue_set。
      await client.query(
        'INSERT INTO mgmts (id, company_id, product_id, name, container_issue_set_id) VALUES ($1, $2, $3, $4, $5)',
        [mgmtId, company, prodId, 'M', setId],
      );
      await client.query(
        'INSERT INTO issue_sets (id, company_id, mgmt_id, name, key) VALUES ($1, $2, $3, $4, $5)',
        [setId, company, mgmtId, 'S', 'KEY'],
      );
      await client.query(
        'INSERT INTO issue_type_definitions (id, company_id, name, label, field_sets, system) VALUES ($1, $2, $3, $4, $5, $6)',
        [typeId, company, 'task', 'Task', JSON.stringify(['基本']), false],
      );
      await client.query(
        'INSERT INTO relation_type_definitions (id, company_id, name, exclusive, acyclic, ordered, "symmetric", rollup, system, created_on, updated_on) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)',
        [relType, company, 'Container', true, true, false, false, true, true, 0, 0],
      );
      for (const issueId of [holder, target, other]) {
        await client.query(
          'INSERT INTO issues (id, company_id, issue_set_id, issue_type_id, issue_key) VALUES ($1,$2,$3,$4,$5)',
          [issueId, company, setId, typeId, `KEY-${issueId.slice(-1)}`],
        );
      }

      const insertRelation = (id: string, from: string, to: string): Promise<unknown> =>
        client.query(
          'INSERT INTO issue_relations (id, company_id, from_issue_id, to_issue_id, relation_type_id, exclusive, created_on, updated_on) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)',
          [id, company, from, to, relType, true, 0, 0],
        );

      // target 首次被指入：通過。
      await insertRelation('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', holder, target);
      // 同一 target、同型別被第二個持有端指入：獨佔部分唯一索引擋下。
      await expect(
        insertRelation('cccccccc-cccc-cccc-cccc-cccccccccccc', other, target),
      ).rejects.toThrow();
    });
  });
});
