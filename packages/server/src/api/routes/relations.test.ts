import { randomUUID } from 'node:crypto';

import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { authed, bootstrap, registerSession, testUrl, type Session } from './testHarness.js';

// 關聯路由整合測試：以 Fastify inject 打真路由連 igotthis_test。
// 涵蓋關聯型別 CRUD、開關組合檢查、工單關聯建立與正反查、獨佔與型別缺失的錯誤碼、刪除。
//
// 容器骨架與工單無對應的建立需求，測試以 SQL 直插同租戶 fixture（環狀 FK 靠交易內 DEFERRABLE 閉環）。

const suite = testUrl ? describe : describe.skip;

interface Containers {
  readonly issueSetId: string;
  readonly issueTypeId: string;
}

/** 在指定 Company 下種 team>product>mgmt>issueSet 與一個工單型別。 */
async function seedContainers(pool: Pool, companyId: string): Promise<Containers> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const teamId = randomUUID();
    const productId = randomUUID();
    const mgmtId = randomUUID();
    const issueSetId = randomUUID();
    const issueTypeId = randomUUID();
    await client.query('INSERT INTO teams (id, company_id, name) VALUES ($1,$2,$3)', [
      teamId,
      companyId,
      'T',
    ]);
    await client.query(
      'INSERT INTO products (id, company_id, team_id, name) VALUES ($1,$2,$3,$4)',
      [productId, companyId, teamId, 'P'],
    );
    await client.query(
      'INSERT INTO mgmts (id, company_id, product_id, name, container_issue_set_id) VALUES ($1,$2,$3,$4,$5)',
      [mgmtId, companyId, productId, 'M', issueSetId],
    );
    await client.query(
      'INSERT INTO issue_sets (id, company_id, mgmt_id, name, key) VALUES ($1,$2,$3,$4,$5)',
      [issueSetId, companyId, mgmtId, 'Backlog', 'PROJ'],
    );
    await client.query(
      'INSERT INTO issue_type_definitions (id, company_id, name, label, field_sets, system) VALUES ($1,$2,$3,$4,$5,$6)',
      [issueTypeId, companyId, 'task', 'Task', JSON.stringify([]), false],
    );
    await client.query('COMMIT');
    return { issueSetId, issueTypeId };
  } catch (error: unknown) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

/** 直插一張工單，回其 id。 */
async function seedIssue(pool: Pool, companyId: string, c: Containers): Promise<string> {
  const id = randomUUID();
  await pool.query(
    'INSERT INTO issues (id, company_id, issue_set_id, issue_type_id, issue_key) VALUES ($1,$2,$3,$4,$5)',
    [id, companyId, c.issueSetId, c.issueTypeId, `PROJ-${id.slice(0, 8)}`],
  );
  return id;
}

suite('relation routes', () => {
  let pool: Pool;
  let app: FastifyInstance;
  let session: Session;
  let call: ReturnType<typeof authed>;
  let containers: Containers;

  beforeAll(async () => {
    ({ pool, app } = await bootstrap());
  });

  afterAll(async () => {
    await app.close();
    await pool.end();
  });

  beforeEach(async () => {
    await pool.query('TRUNCATE companies CASCADE');
    session = await registerSession(app);
    call = authed(app, session.cookie);
    containers = await seedContainers(pool, session.companyId);
    await call({ method: 'GET', url: '/api/workspace' });
  });

  // ---- helpers ----

  async function createRelationType(
    body: Record<string, unknown>,
  ): Promise<{ id: string; name: string }> {
    const res = await call({ method: 'POST', url: '/api/relations/types', payload: body });
    return res.json().relationType;
  }

  // ---- auth ----

  it('未帶 cookie 存取關聯路由回 401', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/relations/types' });
    expect(res.statusCode).toBe(401);
  });

  // ---- 關聯型別 CRUD ----

  it('建立關聯型別回 201、帶開關值', async () => {
    const res = await call({
      method: 'POST',
      url: '/api/relations/types',
      payload: { name: 'RelatedTo', symmetric: true },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().relationType.name).toBe('RelatedTo');
    expect(res.json().relationType.symmetric).toBe(true);
    expect(res.json().relationType.system).toBe(false);
  });

  it('非法開關組合回 422', async () => {
    // 對稱與獨佔並存為非法組合。
    const res = await call({
      method: 'POST',
      url: '/api/relations/types',
      payload: { name: 'Bad', symmetric: true, exclusive: true },
    });
    expect(res.statusCode).toBe(422);
    expect(res.json().error.code).toBe('symmetric_forbids_exclusive_and_ordered');
  });

  it('重複名稱回 409', async () => {
    await createRelationType({ name: 'Dup' });
    const again = await call({
      method: 'POST',
      url: '/api/relations/types',
      payload: { name: 'Dup' },
    });
    expect(again.statusCode).toBe(409);
    expect(again.json().error.code).toBe('RELATION_TYPE_NAME_TAKEN');
  });

  it('列出關聯型別依名稱排序', async () => {
    await createRelationType({ name: 'Before', acyclic: true });
    await createRelationType({ name: 'After', acyclic: true });
    const res = await call({ method: 'GET', url: '/api/relations/types' });
    expect(res.statusCode).toBe(200);
    expect(res.json().relationTypes.map((t: { name: string }) => t.name)).toEqual([
      'After',
      'Before',
    ]);
  });

  it('取單一關聯型別；不存在回 404', async () => {
    const created = await createRelationType({ name: 'Ref' });
    const got = await call({ method: 'GET', url: `/api/relations/types/${created.id}` });
    expect(got.statusCode).toBe(200);
    expect(got.json().relationType.id).toBe(created.id);

    const gone = await call({ method: 'GET', url: `/api/relations/types/${randomUUID()}` });
    expect(gone.statusCode).toBe(404);
  });

  // ---- 工單關聯建立 ----

  it('建立工單關聯回 201，exclusive 由型別複製', async () => {
    const relType = await createRelationType({ name: 'Container', exclusive: true, acyclic: true });
    const from = await seedIssue(pool, session.companyId, containers);
    const to = await seedIssue(pool, session.companyId, containers);
    const res = await call({
      method: 'POST',
      url: '/api/relations/edges',
      payload: { fromIssueId: from, toIssueId: to, relationTypeId: relType.id },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().relation.exclusive).toBe(true);
    expect(res.json().relation.toIssueId).toBe(to);
  });

  it('引用不存在的關聯型別回 422', async () => {
    const from = await seedIssue(pool, session.companyId, containers);
    const to = await seedIssue(pool, session.companyId, containers);
    const res = await call({
      method: 'POST',
      url: '/api/relations/edges',
      payload: { fromIssueId: from, toIssueId: to, relationTypeId: randomUUID() },
    });
    expect(res.statusCode).toBe(422);
    expect(res.json().error.code).toBe('relation_type_not_found');
  });

  it('獨佔被指端已被指入時第二次建立回 422 exclusive_target_already_held', async () => {
    const relType = await createRelationType({ name: 'Excl', exclusive: true });
    const target = await seedIssue(pool, session.companyId, containers);
    const h1 = await seedIssue(pool, session.companyId, containers);
    const h2 = await seedIssue(pool, session.companyId, containers);

    const first = await call({
      method: 'POST',
      url: '/api/relations/edges',
      payload: { fromIssueId: h1, toIssueId: target, relationTypeId: relType.id },
    });
    expect(first.statusCode).toBe(201);

    const second = await call({
      method: 'POST',
      url: '/api/relations/edges',
      payload: { fromIssueId: h2, toIssueId: target, relationTypeId: relType.id },
    });
    expect(second.statusCode).toBe(422);
    expect(second.json().error.code).toBe('exclusive_target_already_held');
  });

  // ---- 正查與反查 ----

  it('正查取持有端關聯、反查取被指端關聯', async () => {
    const relType = await createRelationType({ name: 'Ref' });
    const target = await seedIssue(pool, session.companyId, containers);
    const h1 = await seedIssue(pool, session.companyId, containers);
    const h2 = await seedIssue(pool, session.companyId, containers);
    for (const holder of [h1, h2]) {
      const res = await call({
        method: 'POST',
        url: '/api/relations/edges',
        payload: { fromIssueId: holder, toIssueId: target, relationTypeId: relType.id },
      });
      expect(res.statusCode).toBe(201);
    }

    const reverse = await call({ method: 'GET', url: `/api/relations/edges/to/${target}` });
    expect(reverse.statusCode).toBe(200);
    expect(reverse.json().relations).toHaveLength(2);

    const forward = await call({ method: 'GET', url: `/api/relations/edges/from/${h1}` });
    expect(forward.json().relations).toHaveLength(1);
    expect(forward.json().relations[0].toIssueId).toBe(target);
  });

  it('正查可用 relationTypeId 過濾', async () => {
    const a = await createRelationType({ name: 'A' });
    const b = await createRelationType({ name: 'B' });
    const from = await seedIssue(pool, session.companyId, containers);
    const t1 = await seedIssue(pool, session.companyId, containers);
    const t2 = await seedIssue(pool, session.companyId, containers);
    await call({
      method: 'POST',
      url: '/api/relations/edges',
      payload: { fromIssueId: from, toIssueId: t1, relationTypeId: a.id },
    });
    await call({
      method: 'POST',
      url: '/api/relations/edges',
      payload: { fromIssueId: from, toIssueId: t2, relationTypeId: b.id },
    });
    const filtered = await call({
      method: 'GET',
      url: `/api/relations/edges/from/${from}?relationTypeId=${a.id}`,
    });
    expect(filtered.json().relations).toHaveLength(1);
    expect(filtered.json().relations[0].toIssueId).toBe(t1);
  });

  // ---- 刪除 ----

  it('刪除工單關聯回 204，再刪回 404', async () => {
    const relType = await createRelationType({ name: 'Del' });
    const from = await seedIssue(pool, session.companyId, containers);
    const to = await seedIssue(pool, session.companyId, containers);
    const created = await call({
      method: 'POST',
      url: '/api/relations/edges',
      payload: { fromIssueId: from, toIssueId: to, relationTypeId: relType.id },
    });
    const relationId = created.json().relation.id;

    const removed = await call({ method: 'DELETE', url: `/api/relations/edges/${relationId}` });
    expect(removed.statusCode).toBe(204);

    const again = await call({ method: 'DELETE', url: `/api/relations/edges/${relationId}` });
    expect(again.statusCode).toBe(404);
  });
});
