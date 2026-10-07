import { randomUUID } from 'node:crypto';

import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import type { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { authed, bootstrap, registerSession, testUrl, type Session } from './testHarness.js';

// 檢視路由整合測試：以 Fastify inject 打真路由連 igotthis_test。
// 涵蓋檢視 CRUD、看板欄序（buildKanbanColumns）、彙總值（computeRollupValue）與彙總錯誤碼。
//
// 容器骨架、工單、流程狀態、欄位值以 SQL 直插同租戶；關聯與欄位定義走真路由建立。

const suite = testUrl ? describe : describe.skip;

interface Containers {
  readonly teamId: string;
  readonly productId: string;
  readonly mgmtId: string;
  readonly issueSetId: string;
  readonly issueTypeId: string;
}

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
    // 型別名不可用 'task'：ensureWorkspace 的 DEFAULT_ISSUE_TYPE_NAME 也是這個字面值，
    // beforeEach 先打過一次 GET /api/workspace 種好該筆，重名會撞
    // uq_issue_type_definitions_company_name。
    await client.query(
      'INSERT INTO issue_type_definitions (id, company_id, name, label, field_sets, system) VALUES ($1,$2,$3,$4,$5,$6)',
      [issueTypeId, companyId, 'view-fixture-task', 'Task', JSON.stringify(['基本']), false],
    );
    await client.query('COMMIT');
    return { teamId, productId, mgmtId, issueSetId, issueTypeId };
  } catch (error: unknown) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

async function seedIssue(pool: Pool, companyId: string, c: Containers): Promise<string> {
  const id = randomUUID();
  await pool.query(
    'INSERT INTO issues (id, company_id, issue_set_id, issue_type_id, issue_key) VALUES ($1,$2,$3,$4,$5)',
    [id, companyId, c.issueSetId, c.issueTypeId, `PROJ-${id.slice(0, 8)}`],
  );
  return id;
}

suite('view routes', () => {
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
    // 打一次真路由觸發 ensureWorkspace：種好 field_defs（title／StartTime／
    // EndTime 等標準欄位）並讓本帳號拿到公司範圍的管理員權限，兩者是後續
    // setFieldValue 直插與 Mgmt 讀取權檢查的前提；容器骨架本身仍走 SQL 直插。
    await call({ method: 'GET', url: '/api/workspace' });
    containers = await seedContainers(pool, session.companyId);
  });

  async function createView(
    name = 'My View',
    overrides: Partial<{
      sourceMgmtIds: readonly string[];
      filterConfig: unknown;
      calendarName: string | null;
      displayLevel: number;
    }> = {},
  ): Promise<{ id: string; ownerId: string }> {
    const res = await call({
      method: 'POST',
      url: '/api/views',
      payload: { name, viewType: 'list', sourceMgmtIds: [], displayLevel: 1, ...overrides },
    });
    expect(res.statusCode).toBe(201);
    return res.json().view;
  }

  // ---- auth ----

  it('未帶 cookie 存取檢視路由回 401', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/views' });
    expect(res.statusCode).toBe(401);
  });

  // ---- 檢視 CRUD ----

  it('建立檢視回 201，擁有者為當前帳號', async () => {
    const view = await createView();
    expect(view.ownerId).toBe(session.accountId);
  });

  // ---- 資料來源展開（scopeType + scopeId，對應 spec ViewLogic / expandDataSource） ----

  /** 在既有 containers.productId 下再建一個 Mgmt（同 Product、不同 Mgmt）。 */
  async function seedSiblingMgmt(): Promise<string> {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const mgmtId = randomUUID();
      const issueSetId = randomUUID();
      await client.query(
        'INSERT INTO mgmts (id, company_id, product_id, name, container_issue_set_id) VALUES ($1,$2,$3,$4,$5)',
        [mgmtId, session.companyId, containers.productId, 'M-sibling', issueSetId],
      );
      await client.query(
        'INSERT INTO issue_sets (id, company_id, mgmt_id, name, key) VALUES ($1,$2,$3,$4,$5)',
        [issueSetId, session.companyId, mgmtId, 'Backlog-sibling', 'SIB'],
      );
      await client.query('COMMIT');
      return mgmtId;
    } catch (error: unknown) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  /** 在既有 containers.teamId 下再建一個 Product + Mgmt（同 Team、不同 Product）。 */
  async function seedSiblingProductWithMgmt(): Promise<{ productId: string; mgmtId: string }> {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const productId = randomUUID();
      const mgmtId = randomUUID();
      const issueSetId = randomUUID();
      await client.query(
        'INSERT INTO products (id, company_id, team_id, name) VALUES ($1,$2,$3,$4)',
        [productId, session.companyId, containers.teamId, 'P-sibling'],
      );
      await client.query(
        'INSERT INTO mgmts (id, company_id, product_id, name, container_issue_set_id) VALUES ($1,$2,$3,$4,$5)',
        [mgmtId, session.companyId, productId, 'M-sibling-team', issueSetId],
      );
      await client.query(
        'INSERT INTO issue_sets (id, company_id, mgmt_id, name, key) VALUES ($1,$2,$3,$4,$5)',
        [issueSetId, session.companyId, mgmtId, 'Backlog-sibling-team', 'SIBT'],
      );
      await client.query('COMMIT');
      return { productId, mgmtId };
    } catch (error: unknown) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  /** 建另一個 Company 底下的一個 Mgmt，供跨租戶測試。 */
  /**
   * container_issue_set_id 是 DEFERRABLE INITIALLY DEFERRED 外鍵，檢核時機是交易結束時；
   * 裸 pool.query() 每句各自 autocommit，插入 mgmt 那句本身結束時 issue_set 還不存在就
   * 會先丟外鍵違反，必須包在同一交易內（比照 seedSiblingMgmt 等既有 helper）。
   */
  async function seedForeignMgmt(): Promise<{ teamId: string; productId: string; mgmtId: string }> {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const companyId = randomUUID();
      const teamId = randomUUID();
      const productId = randomUUID();
      const mgmtId = randomUUID();
      const issueSetId = randomUUID();
      await client.query('INSERT INTO companies (id, name) VALUES ($1,$2)', [companyId, 'Foreign Co']);
      await client.query('INSERT INTO teams (id, company_id, name) VALUES ($1,$2,$3)', [
        teamId,
        companyId,
        'Foreign T',
      ]);
      await client.query(
        'INSERT INTO products (id, company_id, team_id, name) VALUES ($1,$2,$3,$4)',
        [productId, companyId, teamId, 'Foreign P'],
      );
      await client.query(
        'INSERT INTO mgmts (id, company_id, product_id, name, container_issue_set_id) VALUES ($1,$2,$3,$4,$5)',
        [mgmtId, companyId, productId, 'Foreign M', issueSetId],
      );
      await client.query(
        'INSERT INTO issue_sets (id, company_id, mgmt_id, name, key) VALUES ($1,$2,$3,$4,$5)',
        [issueSetId, companyId, mgmtId, 'Foreign Backlog', 'FGN'],
      );
      await client.query('COMMIT');
      return { teamId, productId, mgmtId };
    } catch (error: unknown) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async function createViewWithScope(
    scopeType: 'team' | 'product' | 'mgmt',
    scopeId: string,
  ): Promise<LightMyRequestResponse> {
    return call({
      method: 'POST',
      url: '/api/views',
      payload: { name: 'Scoped', viewType: 'list', displayLevel: 1, scopeType, scopeId },
    });
  }

  it('scopeType mgmt：sourceMgmtIds 恰為該筆', async () => {
    const res = await createViewWithScope('mgmt', containers.mgmtId);
    expect(res.statusCode).toBe(201);
    expect(res.json().view.sourceMgmtIds).toEqual([containers.mgmtId]);
  });

  it('scopeType product：sourceMgmtIds 為該 Product 下所有 Mgmt 的聯集', async () => {
    const sibling = await seedSiblingMgmt();
    const res = await createViewWithScope('product', containers.productId);
    expect(res.statusCode).toBe(201);
    expect(res.json().view.sourceMgmtIds.sort()).toEqual([containers.mgmtId, sibling].sort());
  });

  // 驗證接力查詢（Team → 各 Product → 各 Mgmt）本身有沒有漏查任何一個 Product；
  // 不是驗證去重——products/mgmts 皆為單一 FK 歸屬，這個資料模型下兩個不同
  // Product 結構上不可能指向同一個 Mgmt，本測試不會、也不需要走到去重分支。
  // 去重邏輯（含合成重複 id 的情境）鎖在 expandDataSource.test.ts。
  it('scopeType team：sourceMgmtIds 為該 Team 下所有 Product 的 Mgmt 聯集（接力查詢）', async () => {
    const { mgmtId: siblingMgmtId } = await seedSiblingProductWithMgmt();
    const res = await createViewWithScope('team', containers.teamId);
    expect(res.statusCode).toBe(201);
    expect(res.json().view.sourceMgmtIds.sort()).toEqual(
      [containers.mgmtId, siblingMgmtId].sort(),
    );
  });

  it('scopeType product：範圍下無任何 Mgmt 時，合法回空陣列', async () => {
    const bareProductId = randomUUID();
    await pool.query('INSERT INTO products (id, company_id, team_id, name) VALUES ($1,$2,$3,$4)', [
      bareProductId,
      session.companyId,
      containers.teamId,
      'P-bare',
    ]);
    const res = await createViewWithScope('product', bareProductId);
    expect(res.statusCode).toBe(201);
    expect(res.json().view.sourceMgmtIds).toEqual([]);
  });

  it('scopeType/scopeId 指向不存在的範圍：422 對應 NOT_FOUND code', async () => {
    const mgmtRes = await createViewWithScope('mgmt', randomUUID());
    expect(mgmtRes.statusCode).toBe(422);
    expect(mgmtRes.json().error.code).toBe('MGMT_NOT_FOUND');

    const productRes = await createViewWithScope('product', randomUUID());
    expect(productRes.statusCode).toBe(422);
    expect(productRes.json().error.code).toBe('PRODUCT_NOT_FOUND');

    const teamRes = await createViewWithScope('team', randomUUID());
    expect(teamRes.statusCode).toBe(422);
    expect(teamRes.json().error.code).toBe('TEAM_NOT_FOUND');
  });

  it('scopeId 指向另一 Company 的範圍：視同不存在，422', async () => {
    const foreign = await seedForeignMgmt();
    const res = await createViewWithScope('mgmt', foreign.mgmtId);
    expect(res.statusCode).toBe(422);
    expect(res.json().error.code).toBe('MGMT_NOT_FOUND');
  });

  it('不帶 sourceMgmtIds 也不帶 scopeType/scopeId：400', async () => {
    const res = await call({
      method: 'POST',
      url: '/api/views',
      payload: { name: 'NoSource', viewType: 'list', displayLevel: 1 },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('MISSING_DATA_SOURCE');
  });

  it('scope 只給 scopeType 不給 scopeId：400 INCOMPLETE_SCOPE', async () => {
    const res = await call({
      method: 'POST',
      url: '/api/views',
      payload: { name: 'HalfScope', viewType: 'list', displayLevel: 1, scopeType: 'mgmt' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('INCOMPLETE_SCOPE');
  });

  it('scope 只給 scopeId 不給 scopeType：400 INCOMPLETE_SCOPE', async () => {
    const res = await call({
      method: 'POST',
      url: '/api/views',
      payload: { name: 'HalfScope', viewType: 'list', displayLevel: 1, scopeId: containers.mgmtId },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('INCOMPLETE_SCOPE');
  });

  it('完整 scope 與 sourceMgmtIds 同時帶：400 AMBIGUOUS_DATA_SOURCE，不靜默擇一', async () => {
    const res = await call({
      method: 'POST',
      url: '/api/views',
      payload: {
        name: 'Ambiguous',
        viewType: 'list',
        displayLevel: 1,
        scopeType: 'mgmt',
        scopeId: containers.mgmtId,
        sourceMgmtIds: [containers.mgmtId],
      },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('AMBIGUOUS_DATA_SOURCE');
  });

  it('scopeId 空字串：schema 層擋下，400 INVALID_INPUT', async () => {
    const res = await call({
      method: 'POST',
      url: '/api/views',
      payload: { name: 'Bad', viewType: 'list', displayLevel: 1, scopeType: 'mgmt', scopeId: '' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('INVALID_INPUT');
  });

  it('scopeType 不在合法列舉值內：schema 層擋下，400 INVALID_INPUT', async () => {
    const res = await call({
      method: 'POST',
      url: '/api/views',
      payload: {
        name: 'Bad',
        viewType: 'list',
        displayLevel: 1,
        scopeType: 'company',
        scopeId: containers.mgmtId,
      },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('INVALID_INPUT');
  });

  it('列出自己擁有的檢視', async () => {
    await createView('A');
    await createView('B');
    const res = await call({ method: 'GET', url: '/api/views' });
    expect(res.statusCode).toBe(200);
    expect(res.json().views).toHaveLength(2);
  });

  it('取單一檢視；不存在回 404', async () => {
    const view = await createView();
    const got = await call({ method: 'GET', url: `/api/views/${view.id}` });
    expect(got.statusCode).toBe(200);
    expect(got.json().view.id).toBe(view.id);

    const gone = await call({ method: 'GET', url: `/api/views/${randomUUID()}` });
    expect(gone.statusCode).toBe(404);
  });

  it('更新檢視欄位顯示設定；不存在回 404', async () => {
    const view = await createView();
    const patched = await call({
      method: 'PATCH',
      url: `/api/views/${view.id}`,
      payload: { columnConfig: { columns: ['Title'] } },
    });
    expect(patched.statusCode).toBe(200);
    expect(patched.json().view.columnConfig).toEqual({ columns: ['Title'] });

    const gone = await call({
      method: 'PATCH',
      url: `/api/views/${randomUUID()}`,
      payload: { columnConfig: {} },
    });
    expect(gone.statusCode).toBe(404);
  });

  it('更新檢視顯示層級，對應 spec ViewLogic / switchDisplayLevel；不存在回 404', async () => {
    const view = await createView();
    const patched = await call({
      method: 'PATCH',
      url: `/api/views/${view.id}`,
      payload: { displayLevel: 2 },
    });
    expect(patched.statusCode).toBe(200);
    expect(patched.json().view.displayLevel).toBe(2);

    const gone = await call({
      method: 'PATCH',
      url: `/api/views/${randomUUID()}`,
      payload: { displayLevel: 1 },
    });
    expect(gone.statusCode).toBe(404);
  });

  it('刪除檢視回 204，再刪回 404', async () => {
    const view = await createView();
    const removed = await call({ method: 'DELETE', url: `/api/views/${view.id}` });
    expect(removed.statusCode).toBe(204);
    const again = await call({ method: 'DELETE', url: `/api/views/${view.id}` });
    expect(again.statusCode).toBe(404);
  });

  // ---- 手動排序 ----

  async function sortedIds(viewId: string): Promise<string[]> {
    const res = await call({ method: 'GET', url: `/api/views/${viewId}/sort` });
    expect(res.statusCode).toBe(200);
    return (res.json().entries as { issueId: string }[]).map((entry) => entry.issueId);
  }

  function place(viewId: string, issueId: string, targetIndex: number) {
    return call({
      method: 'PUT',
      url: `/api/views/${viewId}/sort/${issueId}`,
      payload: { targetIndex },
    });
  }

  it('新檢視的排序區為空', async () => {
    const view = await createView();
    expect(await sortedIds(view.id)).toEqual([]);
  });

  it('指派位置後工單進入已排序區', async () => {
    const view = await createView();
    const issue = await seedIssue(pool, session.companyId, containers);

    const res = await place(view.id, issue, 0);
    expect(res.statusCode).toBe(200);
    expect(await sortedIds(view.id)).toEqual([issue]);
  });

  it('依序插入三筆，順序與插入位置一致', async () => {
    const view = await createView();
    const [a, b, c] = await seedThree();

    await place(view.id, a, 0);
    await place(view.id, b, 1);
    await place(view.id, c, 1);

    expect(await sortedIds(view.id)).toEqual([a, c, b]);
  });

  it('重排既有項目：移到最前不重複佔位', async () => {
    const view = await createView();
    const [a, b, c] = await seedThree();
    await place(view.id, a, 0);
    await place(view.id, b, 1);
    await place(view.id, c, 2);

    await place(view.id, c, 0);

    expect(await sortedIds(view.id)).toEqual([c, a, b]);
  });

  it('重排回原位順序不變', async () => {
    const view = await createView();
    const [a, b] = await seedThree();
    await place(view.id, a, 0);
    await place(view.id, b, 1);

    expect((await place(view.id, b, 1)).statusCode).toBe(200);
    expect(await sortedIds(view.id)).toEqual([a, b]);
  });

  it('回應直接帶回更新後的排序清單', async () => {
    const view = await createView();
    const [a, b] = await seedThree();
    await place(view.id, a, 0);

    const res = await place(view.id, b, 0);
    expect((res.json().entries as { issueId: string }[]).map((e) => e.issueId)).toEqual([b, a]);
  });

  it('位置越界回 400 SORT_INDEX_OUT_OF_RANGE', async () => {
    const view = await createView();
    const issue = await seedIssue(pool, session.companyId, containers);

    const res = await place(view.id, issue, 3);
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('SORT_INDEX_OUT_OF_RANGE');
  });

  it('檢視不存在回 404', async () => {
    const issue = await seedIssue(pool, session.companyId, containers);
    const res = await place(randomUUID(), issue, 0);
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe('VIEW_NOT_FOUND');
  });

  it('工單不存在回 404', async () => {
    const view = await createView();
    const res = await place(view.id, randomUUID(), 0);
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe('ISSUE_NOT_FOUND');
  });

  it('租戶隔離：另一 Company 的檢視讀不到也排不動', async () => {
    const issue = await seedIssue(pool, session.companyId, containers);
    const foreignViewId = await seedForeignView();

    const read = await call({ method: 'GET', url: `/api/views/${foreignViewId}/sort` });
    expect(read.statusCode).toBe(404);

    const write = await place(foreignViewId, issue, 0);
    expect(write.statusCode).toBe(404);
  });

  it('刪除檢視連同排序項一併清除', async () => {
    const view = await createView();
    const issue = await seedIssue(pool, session.companyId, containers);
    await place(view.id, issue, 0);

    await call({ method: 'DELETE', url: `/api/views/${view.id}` });

    const rows = await pool.query('SELECT 1 FROM view_sort_entries WHERE view_id = $1', [view.id]);
    expect(rows.rowCount).toBe(0);
  });

  async function seedThree(): Promise<[string, string, string]> {
    return [
      await seedIssue(pool, session.companyId, containers),
      await seedIssue(pool, session.companyId, containers),
      await seedIssue(pool, session.companyId, containers),
    ];
  }

  /**
   * 造一張隸屬另一個 Company 的檢視。
   * 單一 Company 模式下再註冊一個帳號只會綁進同一租戶，拿不到第二個租戶，只能直插。
   */
  async function seedForeignView(): Promise<string> {
    const companyId = randomUUID();
    const accountId = randomUUID();
    const viewId = randomUUID();
    await pool.query('INSERT INTO companies (id, name) VALUES ($1,$2)', [companyId, 'Other Co']);
    await pool.query(
      'INSERT INTO accounts (id, company_id, name, created_on, updated_on) VALUES ($1,$2,$3,$4,$5)',
      [accountId, companyId, 'Other Owner', 0, 0],
    );
    await pool.query(
      `INSERT INTO views (id, company_id, name, owner_id, view_type, source_mgmt_ids, display_level)
       VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [viewId, companyId, 'Theirs', accountId, 'list', JSON.stringify([]), 0],
    );
    return viewId;
  }

  // ---- 檢視內容 ----

  async function setFieldValue(issueId: string, fieldName: string, value: unknown): Promise<void> {
    await pool.query(
      `INSERT INTO issue_field_values (company_id, issue_id, field_name, value, rollup_mode)
       VALUES ($1,$2,$3,$4,$5)`,
      [session.companyId, issueId, fieldName, JSON.stringify(value), null],
    );
  }

  async function seedCalendar(name: string, weeklyOff: readonly string[]): Promise<void> {
    await pool.query(
      'INSERT INTO calendar_definitions (company_id, name, weekly_off) VALUES ($1,$2,$3)',
      [session.companyId, name, JSON.stringify(weeklyOff)],
    );
  }

  /** 建第二個 Mgmt（各自獨立 Team/Product），在其主題單位置塞一個工單。 */
  async function seedSecondMgmtWithIssue(): Promise<{ mgmtId: string; issueId: string }> {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const teamId = randomUUID();
      const productId = randomUUID();
      const mgmtId = randomUUID();
      const issueSetId = randomUUID();
      const issueId = randomUUID();
      await client.query('INSERT INTO teams (id, company_id, name) VALUES ($1,$2,$3)', [
        teamId,
        session.companyId,
        'T2',
      ]);
      await client.query(
        'INSERT INTO products (id, company_id, team_id, name) VALUES ($1,$2,$3,$4)',
        [productId, session.companyId, teamId, 'P2'],
      );
      await client.query(
        'INSERT INTO mgmts (id, company_id, product_id, name, container_issue_set_id) VALUES ($1,$2,$3,$4,$5)',
        [mgmtId, session.companyId, productId, 'M2', issueSetId],
      );
      await client.query(
        'INSERT INTO issue_sets (id, company_id, mgmt_id, name, key) VALUES ($1,$2,$3,$4,$5)',
        [issueSetId, session.companyId, mgmtId, 'Backlog2', 'PROJ2'],
      );
      await client.query(
        'INSERT INTO issues (id, company_id, issue_set_id, issue_type_id, issue_key) VALUES ($1,$2,$3,$4,$5)',
        [issueId, session.companyId, issueSetId, containers.issueTypeId, `PROJ2-${issueId.slice(0, 8)}`],
      );
      await client.query('COMMIT');
      return { mgmtId, issueId };
    } catch (error: unknown) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  function issueIds(res: { sortedIssues: { id: string }[]; unsortedIssues: { id: string }[] }): string[] {
    return [...res.sortedIssues, ...res.unsortedIssues].map((row) => row.id);
  }

  it('檢視內容：檢視不存在回 404', async () => {
    const res = await call({ method: 'GET', url: `/api/views/${randomUUID()}/issues` });
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe('VIEW_NOT_FOUND');
  });

  it('資料來源為空：兩區皆空', async () => {
    const view = await createView('Empty', { sourceMgmtIds: [] });
    const res = await call({ method: 'GET', url: `/api/views/${view.id}/issues` });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ sortedIssues: [], unsortedIssues: [], excludedCount: 0 });
  });

  it('新建主題單未經排序：先進未排序區', async () => {
    const issue = await seedIssue(pool, session.companyId, containers);
    const view = await createView('V', { sourceMgmtIds: [containers.mgmtId] });

    const res = await call({ method: 'GET', url: `/api/views/${view.id}/issues` });
    const body = res.json();
    expect(body.sortedIssues).toEqual([]);
    expect(body.unsortedIssues.map((row: { id: string }) => row.id)).toEqual([issue]);
  });

  it('已排序項依 sortValue 升冪落 sortedIssues，其餘落未排序區', async () => {
    const [a, b, c] = await seedThree();
    const view = await createView('V', { sourceMgmtIds: [containers.mgmtId] });
    await place(view.id, a, 0);
    await place(view.id, b, 1);

    const res = await call({ method: 'GET', url: `/api/views/${view.id}/issues` });
    const body = res.json();
    expect(body.sortedIssues.map((row: { id: string }) => row.id)).toEqual([a, b]);
    expect(body.unsortedIssues.map((row: { id: string }) => row.id)).toEqual([c]);
  });

  it('sourceMgmtIds 含多個 Mgmt：各自主題單皆收進資料來源', async () => {
    const first = await seedIssue(pool, session.companyId, containers);
    const { mgmtId: mgmtId2, issueId: second } = await seedSecondMgmtWithIssue();
    const view = await createView('V', { sourceMgmtIds: [containers.mgmtId, mgmtId2] });

    const res = await call({ method: 'GET', url: `/api/views/${view.id}/issues` });
    expect(issueIds(res.json()).sort()).toEqual([first, second].sort());
  });

  it('Mgmt 底下的一般工單集不計入，只收 containerIssueSetId 那份主題單位置', async () => {
    const otherIssueSetId = randomUUID();
    await pool.query(
      'INSERT INTO issue_sets (id, company_id, mgmt_id, name, key) VALUES ($1,$2,$3,$4,$5)',
      [otherIssueSetId, session.companyId, containers.mgmtId, 'Other', 'OTH'],
    );
    await pool.query(
      'INSERT INTO issues (id, company_id, issue_set_id, issue_type_id, issue_key) VALUES ($1,$2,$3,$4,$5)',
      [randomUUID(), session.companyId, otherIssueSetId, containers.issueTypeId, 'OTH-1'],
    );
    const containerIssue = await seedIssue(pool, session.companyId, containers);
    const view = await createView('V', { sourceMgmtIds: [containers.mgmtId] });

    const res = await call({ method: 'GET', url: `/api/views/${view.id}/issues` });
    expect(issueIds(res.json())).toEqual([containerIssue]);
  });

  it('filterConfig 排除不符合條件的工單，excludedCount 反映排除數', async () => {
    const keep = await seedIssue(pool, session.companyId, containers);
    await setFieldValue(keep, 'title', 'keep-me');
    const drop = await seedIssue(pool, session.companyId, containers);
    await setFieldValue(drop, 'title', 'drop-me');

    const view = await createView('V', {
      sourceMgmtIds: [containers.mgmtId],
      filterConfig: { conditions: [{ fieldName: 'title', operator: 'equals', value: 'keep-me' }] },
    });

    const res = await call({ method: 'GET', url: `/api/views/${view.id}/issues` });
    const body = res.json();
    expect(issueIds(body)).toEqual([keep]);
    expect(body.excludedCount).toBe(1);
  });

  it('filterConfig 格式不符：fail-open 視為不篩選', async () => {
    const issue = await seedIssue(pool, session.companyId, containers);
    const view = await createView('V', {
      sourceMgmtIds: [containers.mgmtId],
      filterConfig: 'not-an-object',
    });

    const res = await call({ method: 'GET', url: `/api/views/${view.id}/issues` });
    const body = res.json();
    expect(issueIds(body)).toEqual([issue]);
    expect(body.excludedCount).toBe(0);
  });

  it('檢視選用日曆時，回傳生效日曆名稱', async () => {
    await seedCalendar('台灣', ['SAT', 'SUN']);
    const view = await createView('V', {
      sourceMgmtIds: [containers.mgmtId],
      calendarName: '台灣',
    });

    const res = await call({ method: 'GET', url: `/api/views/${view.id}/issues` });
    expect(res.json().calendarName).toBe('台灣');
  });

  it('檢視未選用日曆、帳號亦無預設：calendarName 為 null', async () => {
    const view = await createView('V', { sourceMgmtIds: [containers.mgmtId] });

    const res = await call({ method: 'GET', url: `/api/views/${view.id}/issues` });
    expect(res.json().calendarName).toBeNull();
  });

  it('工單缺 StartTime／EndTime：工期回 hasDuration false', async () => {
    const issue = await seedIssue(pool, session.companyId, containers);
    const view = await createView('V', { sourceMgmtIds: [containers.mgmtId] });

    const res = await call({ method: 'GET', url: `/api/views/${view.id}/issues` });
    const row = res.json().unsortedIssues[0];
    expect(row.id).toBe(issue);
    expect(row.duration).toEqual({ hasDuration: false });
  });

  it('工單有 StartTime／EndTime 且有生效日曆：工期以工作天計，扣除週末', async () => {
    await seedCalendar('台灣', ['SAT', 'SUN']);
    const issue = await seedIssue(pool, session.companyId, containers);
    // 2026-01-05 為週一，2026-01-12 為週一，中間跨一個六日。
    await setFieldValue(issue, 'StartTime', '2026-01-05');
    await setFieldValue(issue, 'EndTime', '2026-01-12');
    const view = await createView('V', {
      sourceMgmtIds: [containers.mgmtId],
      calendarName: '台灣',
    });

    const res = await call({ method: 'GET', url: `/api/views/${view.id}/issues` });
    const row = res.json().unsortedIssues[0];
    expect(row.duration).toEqual({ hasDuration: true, days: 5, unit: 'workingDay' });
  });

  // ---- 顯示層級：三個層級一次算好的甘特座標（devOrderGantt.ts） ----

  /** 建一個關聯型別；預設獨佔、禁環，不有序（Children 呼叫端自行覆寫 ordered: true）。 */
  async function createRelationType(
    name: string,
    overrides: Partial<{ ordered: boolean }> = {},
  ): Promise<string> {
    const res = await call({
      method: 'POST',
      url: '/api/relations/types',
      payload: { name, exclusive: true, acyclic: true, ordered: false, rollup: false, ...overrides },
    });
    expect(res.statusCode).toBe(201);
    return res.json().relationType.id;
  }

  async function createEdge(fromIssueId: string, toIssueId: string, relationTypeId: string): Promise<void> {
    const res = await call({
      method: 'POST',
      url: '/api/relations/edges',
      payload: { fromIssueId, toIssueId, relationTypeId },
    });
    expect(res.statusCode).toBe(201);
  }

  /** 建一個一般工單集（不是任何 Mgmt 的主題單位置），供 Container/Children 測試工單使用。 */
  async function seedWorkIssueSet(): Promise<string> {
    const issueSetId = randomUUID();
    await pool.query(
      'INSERT INTO issue_sets (id, company_id, mgmt_id, name, key) VALUES ($1,$2,$3,$4,$5)',
      [issueSetId, session.companyId, containers.mgmtId, 'Work', `WORK${issueSetId.slice(0, 4)}`],
    );
    return issueSetId;
  }

  async function seedWorkIssue(issueSetId: string, key: string): Promise<string> {
    const id = randomUUID();
    await pool.query(
      'INSERT INTO issues (id, company_id, issue_set_id, issue_type_id, issue_key) VALUES ($1,$2,$3,$4,$5)',
      [id, session.companyId, issueSetId, containers.issueTypeId, key],
    );
    return id;
  }

  interface LevelGroupBody {
    readonly level: number;
    readonly bars: readonly { readonly start: number; readonly span: number }[] | null;
  }
  interface TopicRowBody {
    readonly id: string;
    readonly levels: readonly LevelGroupBody[];
  }

  function levelsOf(
    res: { sortedIssues: readonly TopicRowBody[]; unsortedIssues: readonly TopicRowBody[] },
    topicIssueId: string,
  ): readonly LevelGroupBody[] {
    const row = [...res.sortedIssues, ...res.unsortedIssues].find((r) => r.id === topicIssueId);
    return row?.levels ?? [];
  }

  function barsAtLevel(
    levels: readonly LevelGroupBody[],
    level: number,
  ): readonly { readonly start: number; readonly span: number }[] | null {
    return levels.find((g) => g.level === level)?.bars ?? null;
  }

  /** 今天的 IsoDate 字串；供測試斷言與被測程式碼（route 層現算）用同一種方式取得基準日。 */
  function todayIso(): string {
    return new Date().toISOString().slice(0, 10);
  }

  function isoDateOffset(baseIso: string, days: number): string {
    const d = new Date(`${baseIso}T00:00:00.000Z`);
    d.setUTCDate(d.getUTCDate() + days);
    return d.toISOString().slice(0, 10);
  }

  it('levels：Container 起點加兩層 Children，一次算好三層各自的甘特座標', async () => {
    const containerType = await createRelationType('Container');
    const childrenType = await createRelationType('Children', { ordered: true });
    const workSetId = await seedWorkIssueSet();
    const topic = await seedIssue(pool, session.companyId, containers);
    const root = await seedWorkIssue(workSetId, 'WORK-1');
    const mid = await seedWorkIssue(workSetId, 'WORK-2');
    const leaf = await seedWorkIssue(workSetId, 'WORK-3');
    await createEdge(topic, root, containerType);
    await createEdge(root, mid, childrenType);
    await createEdge(mid, leaf, childrenType);

    const today = todayIso();
    // 三層各設不同長度的起訖區間：bars 本身不帶身份，用 span 數值間接驗證分層正確。
    await setFieldValue(root, 'StartTime', today);
    await setFieldValue(root, 'EndTime', isoDateOffset(today, 9)); // span 10
    await setFieldValue(mid, 'StartTime', today);
    await setFieldValue(mid, 'EndTime', isoDateOffset(today, 4)); // span 5
    await setFieldValue(leaf, 'StartTime', today);
    await setFieldValue(leaf, 'EndTime', today); // span 1

    const view = await createView('V', { sourceMgmtIds: [containers.mgmtId] });

    const res = await call({ method: 'GET', url: `/api/views/${view.id}/issues` });
    const levels = levelsOf(res.json(), topic);
    expect(barsAtLevel(levels, 1)).toEqual([{ start: 0, span: 10 }]);
    expect(barsAtLevel(levels, 2)).toEqual([{ start: 0, span: 5 }]);
    expect(barsAtLevel(levels, 3)).toEqual([{ start: 0, span: 1 }]);
  });

  it('主題單無 Container 綁定：三層皆為 null', async () => {
    await createRelationType('Container');
    await createRelationType('Children', { ordered: true });
    const topic = await seedIssue(pool, session.companyId, containers);
    const view = await createView('V', { sourceMgmtIds: [containers.mgmtId] });

    const res = await call({ method: 'GET', url: `/api/views/${view.id}/issues` });
    const levels = levelsOf(res.json(), topic);
    expect(barsAtLevel(levels, 1)).toBeNull();
    expect(barsAtLevel(levels, 2)).toBeNull();
    expect(barsAtLevel(levels, 3)).toBeNull();
  });

  it('Container／Children 型別此 Company 尚未建立：整包仍 200，三層皆為 null', async () => {
    const topic = await seedIssue(pool, session.companyId, containers);
    const view = await createView('V', { sourceMgmtIds: [containers.mgmtId] });

    const res = await call({ method: 'GET', url: `/api/views/${view.id}/issues` });
    expect(res.statusCode).toBe(200);
    const levels = levelsOf(res.json(), topic);
    expect(barsAtLevel(levels, 1)).toBeNull();
    expect(barsAtLevel(levels, 2)).toBeNull();
    expect(barsAtLevel(levels, 3)).toBeNull();
  });

  it('層內有候選但缺 StartTime／EndTime：該層 bars 為空陣列，不是 null', async () => {
    const containerType = await createRelationType('Container');
    const topic = await seedIssue(pool, session.companyId, containers);
    const workSetId = await seedWorkIssueSet();
    const root = await seedWorkIssue(workSetId, 'WORK-1');
    await createEdge(topic, root, containerType);

    const view = await createView('V', { sourceMgmtIds: [containers.mgmtId] });
    const res = await call({ method: 'GET', url: `/api/views/${view.id}/issues` });
    expect(barsAtLevel(levelsOf(res.json(), topic), 1)).toEqual([]);
  });

  it('工單起訖日完全落在時間軸視窗外：該筆不出現在 bars 陣列中', async () => {
    const containerType = await createRelationType('Container');
    const topic = await seedIssue(pool, session.companyId, containers);
    const workSetId = await seedWorkIssueSet();
    const root = await seedWorkIssue(workSetId, 'WORK-1');
    await createEdge(topic, root, containerType);
    await setFieldValue(root, 'StartTime', '2000-01-01');
    await setFieldValue(root, 'EndTime', '2000-01-05');

    const view = await createView('V', { sourceMgmtIds: [containers.mgmtId] });
    const res = await call({ method: 'GET', url: `/api/views/${view.id}/issues` });
    expect(barsAtLevel(levelsOf(res.json(), topic), 1)).toEqual([]);
  });

  it('同一層有多筆候選工單，各自依日期獨立換算格子座標', async () => {
    const containerType = await createRelationType('Container');
    const childrenType = await createRelationType('Children', { ordered: true });
    const workSetId = await seedWorkIssueSet();
    const topic = await seedIssue(pool, session.companyId, containers);
    const root = await seedWorkIssue(workSetId, 'WORK-ROOT');
    const childA = await seedWorkIssue(workSetId, 'WORK-A');
    const childB = await seedWorkIssue(workSetId, 'WORK-B');
    await createEdge(topic, root, containerType);
    await createEdge(root, childA, childrenType);
    await createEdge(root, childB, childrenType);

    const today = todayIso();
    await setFieldValue(childA, 'StartTime', today);
    await setFieldValue(childA, 'EndTime', isoDateOffset(today, 1)); // start 0, span 2
    await setFieldValue(childB, 'StartTime', isoDateOffset(today, 3));
    await setFieldValue(childB, 'EndTime', isoDateOffset(today, 5)); // start 3, span 3

    const view = await createView('V', { sourceMgmtIds: [containers.mgmtId] });
    const res = await call({ method: 'GET', url: `/api/views/${view.id}/issues` });
    const bars = barsAtLevel(levelsOf(res.json(), topic), 2);
    expect(bars).toHaveLength(2);
    expect(bars).toEqual(
      expect.arrayContaining([
        { start: 0, span: 2 },
        { start: 3, span: 3 },
      ]),
    );
  });

  it('兩張主題單各自的層級內容互不污染', async () => {
    const containerType = await createRelationType('Container');
    const workSetId = await seedWorkIssueSet();
    const topicA = await seedIssue(pool, session.companyId, containers);
    const topicB = await seedIssue(pool, session.companyId, containers);
    const rootA = await seedWorkIssue(workSetId, 'WORK-A');
    const rootB = await seedWorkIssue(workSetId, 'WORK-B');
    await createEdge(topicA, rootA, containerType);
    await createEdge(topicB, rootB, containerType);

    const today = todayIso();
    await setFieldValue(rootA, 'StartTime', today);
    await setFieldValue(rootA, 'EndTime', isoDateOffset(today, 2)); // span 3
    await setFieldValue(rootB, 'StartTime', today);
    await setFieldValue(rootB, 'EndTime', isoDateOffset(today, 6)); // span 7

    const view = await createView('V', { sourceMgmtIds: [containers.mgmtId] });

    const res = await call({ method: 'GET', url: `/api/views/${view.id}/issues` });
    const body = res.json();
    expect(barsAtLevel(levelsOf(body, topicA), 1)).toEqual([{ start: 0, span: 3 }]);
    expect(barsAtLevel(levelsOf(body, topicB), 1)).toEqual([{ start: 0, span: 7 }]);
  });

  it('回應含 days 欄位：長度 56，第一天 isToday 為真、key 為今天', async () => {
    const view = await createView('V', { sourceMgmtIds: [containers.mgmtId] });
    const res = await call({ method: 'GET', url: `/api/views/${view.id}/issues` });
    const days: { key: string; isToday: boolean }[] = res.json().days;
    expect(days).toHaveLength(56);
    expect(days[0]?.isToday).toBe(true);
    expect(days[0]?.key).toBe(todayIso());
  });

  it('days 的 isHoliday 反映檢視生效日曆的 weeklyOff', async () => {
    await seedCalendar('台灣', ['SAT', 'SUN']);
    const view = await createView('V', {
      sourceMgmtIds: [containers.mgmtId],
      calendarName: '台灣',
    });
    const res = await call({ method: 'GET', url: `/api/views/${view.id}/issues` });
    const days: { key: string; isHoliday: boolean }[] = res.json().days;
    for (const day of days) {
      const weekday = new Date(`${day.key}T00:00:00.000Z`).getUTCDay();
      expect(day.isHoliday).toBe(weekday === 0 || weekday === 6);
    }
  });

  it('days 的 isHoliday 反映日曆例外（補班日／額外假日）', async () => {
    const today = todayIso();
    await seedCalendar('台灣', []);
    await pool.query(
      'INSERT INTO calendar_exceptions (company_id, calendar_name, date, is_working) VALUES ($1,$2,$3,$4)',
      [session.companyId, '台灣', today, false],
    );
    const view = await createView('V', {
      sourceMgmtIds: [containers.mgmtId],
      calendarName: '台灣',
    });
    const res = await call({ method: 'GET', url: `/api/views/${view.id}/issues` });
    const days: { isHoliday: boolean }[] = res.json().days;
    expect(days[0]?.isHoliday).toBe(true);
  });

  it('主題單清單恆定：PATCH displayLevel 前後 sortedIssues／unsortedIssues 的內容不變', async () => {
    const [a, b, c] = await seedThree();
    const view = await createView('V', { sourceMgmtIds: [containers.mgmtId] });
    await place(view.id, a, 0);

    const before = await call({ method: 'GET', url: `/api/views/${view.id}/issues` });
    const beforeBody = before.json();
    expect(beforeBody.sortedIssues.map((row: { id: string }) => row.id)).toEqual([a]);
    expect(beforeBody.unsortedIssues.map((row: { id: string }) => row.id).sort()).toEqual([b, c].sort());

    const patchRes = await call({
      method: 'PATCH',
      url: `/api/views/${view.id}`,
      payload: { displayLevel: 3 },
    });
    expect(patchRes.statusCode).toBe(200);
    const after = await call({ method: 'GET', url: `/api/views/${view.id}/issues` });

    expect(issueIds(after.json())).toEqual(issueIds(beforeBody));
  });

  it('母子鏈成環：GET /:id/issues 回 422 RELATION_CYCLE，不是 500', async () => {
    const containerType = await createRelationType('Container');
    const childrenType = await createRelationType('Children', { ordered: true });
    const workSetId = await seedWorkIssueSet();
    const topic = await seedIssue(pool, session.companyId, containers);
    const a = await seedWorkIssue(workSetId, 'WORK-A');
    const b = await seedWorkIssue(workSetId, 'WORK-B');
    await createEdge(topic, a, containerType);
    await createEdge(a, b, childrenType);
    // 反向邊直插資料庫：createRelation 端點本身的禁環檢查會擋下這筆，
    // 需繞過 API、直接寫壞資料才能重現「資料已壞」這個情境。
    await pool.query(
      `INSERT INTO issue_relations
         (id, company_id, from_issue_id, to_issue_id, relation_type_id, ordinal, exclusive, created_on, updated_on)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [randomUUID(), session.companyId, b, a, childrenType, 0, true, 0, 0],
    );

    const view = await createView('V', { sourceMgmtIds: [containers.mgmtId], displayLevel: 1 });
    const res = await call({ method: 'GET', url: `/api/views/${view.id}/issues` });
    expect(res.statusCode).toBe(422);
    expect(res.json().error.code).toBe('RELATION_CYCLE');
  });

  // ---- 檢視內容：完整欄位工單列（/:id/workspace-issues，供 ListScreen／KanbanScreen） ----

  it('workspace-issues：檢視不存在回 404', async () => {
    const res = await call({ method: 'GET', url: `/api/views/${randomUUID()}/workspace-issues` });
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe('VIEW_NOT_FOUND');
  });

  it('workspace-issues：資料來源為空，issues 為空陣列、excludedCount 為 0', async () => {
    const view = await createView('Empty', { sourceMgmtIds: [] });
    const res = await call({ method: 'GET', url: `/api/views/${view.id}/workspace-issues` });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ issues: [], excludedCount: 0 });
  });

  it('workspace-issues：摺出完整欄位（title/status/assignee/point/due/resolution）', async () => {
    const issue = await seedIssue(pool, session.companyId, containers);
    await setFieldValue(issue, 'title', '標題文字');
    await setFieldValue(issue, 'status', '處理中');
    await setFieldValue(issue, 'assignee', '成員甲');
    await setFieldValue(issue, 'point', 3);
    await setFieldValue(issue, 'due', '2026-09-01');
    await setFieldValue(issue, 'resolution', '已完成');

    const view = await createView('V', { sourceMgmtIds: [containers.mgmtId] });
    const res = await call({ method: 'GET', url: `/api/views/${view.id}/workspace-issues` });
    expect(res.statusCode).toBe(200);
    const row = res.json().issues.find((r: { id: string }) => r.id === issue);
    expect(row).toMatchObject({
      id: issue,
      title: '標題文字',
      status: '處理中',
      assignee: '成員甲',
      point: 3,
      due: '2026-09-01',
      resolution: '已完成',
    });
  });

  it('workspace-issues：欄位全缺時，status 回退「待處理」、其餘為空字串或 null', async () => {
    const issue = await seedIssue(pool, session.companyId, containers);
    const view = await createView('V', { sourceMgmtIds: [containers.mgmtId] });
    const res = await call({ method: 'GET', url: `/api/views/${view.id}/workspace-issues` });
    const row = res.json().issues.find((r: { id: string }) => r.id === issue);
    expect(row).toMatchObject({
      title: '',
      status: '待處理',
      assignee: '',
      point: null,
      due: null,
      resolution: null,
    });
  });

  it('workspace-issues：sourceMgmtIds 含多個 Mgmt，各自工單皆收進結果', async () => {
    const first = await seedIssue(pool, session.companyId, containers);
    const { mgmtId: mgmtId2, issueId: second } = await seedSecondMgmtWithIssue();
    const view = await createView('V', { sourceMgmtIds: [containers.mgmtId, mgmtId2] });
    const res = await call({ method: 'GET', url: `/api/views/${view.id}/workspace-issues` });
    const ids = res.json().issues.map((r: { id: string }) => r.id);
    expect(ids.sort()).toEqual([first, second].sort());
  });

  it('workspace-issues：filterConfig 排除不符合條件的工單，excludedCount 反映排除數', async () => {
    const keep = await seedIssue(pool, session.companyId, containers);
    const drop = await seedIssue(pool, session.companyId, containers);
    await setFieldValue(keep, 'status', '處理中');
    await setFieldValue(drop, 'status', '已完成');
    const view = await createView('V', {
      sourceMgmtIds: [containers.mgmtId],
      filterConfig: { conditions: [{ fieldName: 'status', operator: 'equals', value: '處理中' }] },
    });
    const res = await call({ method: 'GET', url: `/api/views/${view.id}/workspace-issues` });
    const ids = res.json().issues.map((r: { id: string }) => r.id);
    expect(ids).toEqual([keep]);
    expect(res.json().excludedCount).toBe(1);
  });

  // ---- 看板欄序 ----

  it('看板欄序由工單型別的流程狀態保序併入', async () => {
    const states: readonly [string, number][] = [
      ['Todo', 0],
      ['Doing', 1],
      ['Done', 2],
    ];
    for (const [name, order] of states) {
      await pool.query(
        `INSERT INTO workflow_states (company_id, issue_type_id, name, sort_order, is_initial, is_terminal)
         VALUES ($1,$2,$3,$4,$5,$6)`,
        [session.companyId, containers.issueTypeId, name, order, order === 0, order === 2],
      );
    }
    const res = await call({ method: 'GET', url: '/api/views/kanban-columns' });
    expect(res.statusCode).toBe(200);
    // beforeEach 的 GET /api/workspace 會種出另一個預設工單型別與其自身流程狀態，
    // 併入同一份欄序；本測試只斷言自己種的三欄相對順序，不假設公司內僅此一型別。
    const names = res.json().columns.map((c: { name: string }) => c.name);
    const ownNames = names.filter((name: string) => ['Todo', 'Doing', 'Done'].includes(name));
    expect(ownNames).toEqual(['Todo', 'Doing', 'Done']);
  });

  // ---- 彙總 ----

  async function setupRollupField(): Promise<void> {
    await call({ method: 'POST', url: '/api/fields/sets', payload: { name: '基本' } });
    await call({
      method: 'POST',
      url: '/api/fields/defs',
      payload: {
        name: 'StoryPoint',
        fieldSetName: '基本',
        kind: 'single',
        valueType: 'number',
        label: '點數',
        rollupable: true,
        rollupFn: 'sum',
      },
    });
  }

  async function setStoryPoint(issueId: string, value: number): Promise<void> {
    await pool.query(
      `INSERT INTO issue_field_values (company_id, issue_id, field_name, value, rollup_mode)
       VALUES ($1,$2,$3,$4,$5)`,
      [session.companyId, issueId, 'StoryPoint', JSON.stringify(value), null],
    );
  }

  it('彙總沿母子關聯加總下級點數', async () => {
    await setupRollupField();
    const children = await call({
      method: 'POST',
      url: '/api/relations/types',
      payload: { name: 'Children', exclusive: true, acyclic: true, ordered: true, rollup: true },
    });
    const relTypeId = children.json().relationType.id;

    const parent = await seedIssue(pool, session.companyId, containers);
    const c1 = await seedIssue(pool, session.companyId, containers);
    const c2 = await seedIssue(pool, session.companyId, containers);
    for (const child of [c1, c2]) {
      const res = await call({
        method: 'POST',
        url: '/api/relations/edges',
        payload: { fromIssueId: parent, toIssueId: child, relationTypeId: relTypeId },
      });
      expect(res.statusCode).toBe(201);
    }
    await setStoryPoint(c1, 3);
    await setStoryPoint(c2, 5);

    const res = await call({
      method: 'GET',
      url: `/api/views/rollup?issueId=${parent}&fieldName=StoryPoint`,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().value).toBe(8);
  });

  it('彙總不可彙總欄位回 422 FIELD_NOT_ROLLUPABLE', async () => {
    await call({ method: 'POST', url: '/api/fields/sets', payload: { name: '基本' } });
    await call({
      method: 'POST',
      url: '/api/fields/defs',
      payload: { name: 'Note', fieldSetName: '基本', kind: 'single', valueType: 'text', label: '備註' },
    });
    const issue = await seedIssue(pool, session.companyId, containers);
    const res = await call({
      method: 'GET',
      url: `/api/views/rollup?issueId=${issue}&fieldName=Note`,
    });
    expect(res.statusCode).toBe(422);
    expect(res.json().error.code).toBe('FIELD_NOT_ROLLUPABLE');
  });

  it('彙總未定義欄位回 422 FIELD_NOT_DEFINED', async () => {
    const issue = await seedIssue(pool, session.companyId, containers);
    const res = await call({
      method: 'GET',
      url: `/api/views/rollup?issueId=${issue}&fieldName=Ghost`,
    });
    expect(res.statusCode).toBe(422);
    expect(res.json().error.code).toBe('FIELD_NOT_DEFINED');
  });
});
