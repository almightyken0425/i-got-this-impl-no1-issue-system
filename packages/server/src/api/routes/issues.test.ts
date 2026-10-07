import { randomUUID } from 'node:crypto';

import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { fieldRepo } from '../../db/repositories/index.js';
import { authed, bootstrap, registerSession, testUrl, type Session } from './testHarness.js';

// 工單路由整合測試：以 Fastify inject 打真路由連 igotthis_test。
// 涵蓋工單 CRUD、取號遞增、移動保留原號、依工單集列出，與工單欄位單值讀寫。
//
// 工單型別與欄位定義無對應的 CRUD 路由，測試以 SQL 直插同租戶的 fixture。

const suite = testUrl ? describe : describe.skip;

const FIELD_NAME = 'Title';

suite('issue routes', () => {
  let pool: Pool;
  let app: FastifyInstance;
  let session: Session;
  let call: ReturnType<typeof authed>;
  let issueSetId: string;
  let secondIssueSetId: string;
  let issueTypeId: string;

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
    await call({ method: 'GET', url: '/api/workspace' });

    // 容器骨架走真路由：team > product > mgmt + 初始工單集。
    const team = await call({ method: 'POST', url: '/api/teams', payload: { name: 'T' } });
    const teamId = team.json().team.id;
    const product = await call({
      method: 'POST',
      url: '/api/products',
      payload: { teamId, name: 'P' },
    });
    const productId = product.json().product.id;
    const mgmt = await call({
      method: 'POST',
      url: `/api/products/${productId}/mgmts`,
      payload: { name: 'M', issueSet: { name: 'Backlog', key: 'PROJ' } },
    });
    issueSetId = mgmt.json().issueSet.id;
    const mgmtId = mgmt.json().mgmt.id;

    const second = await call({
      method: 'POST',
      url: `/api/mgmts/${mgmtId}/issue-sets`,
      payload: { name: 'Sprint', key: 'SPR' },
    });
    secondIssueSetId = second.json().issueSet.id;

    // 工單型別與欄位定義直插同租戶（無對應 CRUD 路由）。
    issueTypeId = randomUUID();
    const { companyId } = session;
    await pool.query(
      'INSERT INTO issue_type_definitions (id, company_id, name, label, field_sets, system) VALUES ($1,$2,$3,$4,$5,$6)',
      [issueTypeId, companyId, 'test-task', 'Task', JSON.stringify(['基本']), false],
    );
    await pool.query('INSERT INTO field_set_defs (company_id, name, system) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING', [
      companyId,
      '基本',
      true,
    ]);
    await pool.query(
      `INSERT INTO field_defs
         (company_id, name, field_set_name, kind, value_type, system, readonly, rollupable, rollup_fn, tracked, label)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) ON CONFLICT DO NOTHING`,
      [companyId, FIELD_NAME, '基本', 'single', 'text', false, false, false, null, false, '標題'],
    );
    // ChangeLog 系統欄位定義：appendChangeLog 寫入時 field_name 固定用這個常數，
    // 沒有這筆 field_defs 會撞 fk_issue_field_records_field 外鍵（見 workspace.ts
    // ensureIssueType 同樣的補注）。
    await pool.query(
      `INSERT INTO field_defs
         (company_id, name, field_set_name, kind, value_type, system, readonly, rollupable, rollup_fn, tracked, label)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) ON CONFLICT DO NOTHING`,
      [companyId, fieldRepo.CHANGE_LOG_FIELD_NAME, '基本', 'multi', 'text', true, true, false, null, false, '變更歷史'],
    );
  });

  // ---- helpers ----

  async function createIssue(setId = issueSetId): Promise<{ id: string; issueKey: string }> {
    const res = await call({
      method: 'POST',
      url: `/api/issue-sets/${setId}/issues`,
      payload: { issueTypeId },
    });
    return res.json().issue;
  }

  // ---- auth ----

  it('未帶 cookie 存取工單路由回 401', async () => {
    const res = await app.inject({ method: 'GET', url: `/api/issues/${randomUUID()}` });
    expect(res.statusCode).toBe(401);
  });

  // ---- 建立與取號 ----

  it('建立工單回 201，編號為 KEY-流水號且逐次遞增', async () => {
    const first = await call({
      method: 'POST',
      url: `/api/issue-sets/${issueSetId}/issues`,
      payload: { issueTypeId },
    });
    expect(first.statusCode).toBe(201);
    expect(first.json().issue.issueKey).toBe('PROJ-1');

    const second = await createIssue();
    expect(second.issueKey).toBe('PROJ-2');
  });

  it('引用不存在的工單型別回 422 ISSUE_TYPE_NOT_FOUND', async () => {
    const res = await call({
      method: 'POST',
      url: `/api/issue-sets/${issueSetId}/issues`,
      payload: { issueTypeId: randomUUID() },
    });
    expect(res.statusCode).toBe(422);
    expect(res.json().error.code).toBe('ISSUE_TYPE_NOT_FOUND');
  });

  it('於不存在的工單集建工單回 404', async () => {
    const res = await call({
      method: 'POST',
      url: `/api/issue-sets/${randomUUID()}/issues`,
      payload: { issueTypeId },
    });
    expect(res.statusCode).toBe(404);
  });

  // ---- 讀取與列出 ----

  it('依工單集列出工單', async () => {
    await createIssue();
    await createIssue();
    const res = await call({ method: 'GET', url: `/api/issue-sets/${issueSetId}/issues` });
    expect(res.statusCode).toBe(200);
    expect(res.json().issues).toHaveLength(2);
  });

  it('取得工單；不存在回 404', async () => {
    const issue = await createIssue();
    const got = await call({ method: 'GET', url: `/api/issues/${issue.id}` });
    expect(got.statusCode).toBe(200);
    expect(got.json().issue.issueKey).toBe('PROJ-1');

    const gone = await call({ method: 'GET', url: `/api/issues/${randomUUID()}` });
    expect(gone.statusCode).toBe(404);
  });

  // ---- 移動 ----

  it('移動工單至其他工單集，編號保留原號', async () => {
    const issue = await createIssue();
    const moved = await call({
      method: 'POST',
      url: `/api/issues/${issue.id}/move`,
      payload: { issueSetId: secondIssueSetId },
    });
    expect(moved.statusCode).toBe(200);
    expect(moved.json().issue.issueSetId).toBe(secondIssueSetId);
    expect(moved.json().issue.issueKey).toBe('PROJ-1');
  });

  it('移動至不存在的工單集回 422 ISSUE_SET_NOT_FOUND', async () => {
    const issue = await createIssue();
    const res = await call({
      method: 'POST',
      url: `/api/issues/${issue.id}/move`,
      payload: { issueSetId: randomUUID() },
    });
    expect(res.statusCode).toBe(422);
    expect(res.json().error.code).toBe('ISSUE_SET_NOT_FOUND');
  });

  // ---- 刪除 ----

  it('刪除工單回 204，之後取得回 404', async () => {
    const issue = await createIssue();
    const removed = await call({ method: 'DELETE', url: `/api/issues/${issue.id}` });
    expect(removed.statusCode).toBe(204);
    const gone = await call({ method: 'GET', url: `/api/issues/${issue.id}` });
    expect(gone.statusCode).toBe(404);
  });

  // ---- 欄位值讀寫 ----

  it('寫入 / 取得 / 列出 / 刪除工單欄位值', async () => {
    const issue = await createIssue();

    const put = await call({
      method: 'PUT',
      url: `/api/issues/${issue.id}/fields/${FIELD_NAME}`,
      payload: { value: '修復登入頁' },
    });
    expect(put.statusCode).toBe(200);
    expect(put.json().fieldValue.value).toBe('修復登入頁');

    const got = await call({ method: 'GET', url: `/api/issues/${issue.id}/fields/${FIELD_NAME}` });
    expect(got.statusCode).toBe(200);
    expect(got.json().fieldValue.value).toBe('修復登入頁');

    const listed = await call({ method: 'GET', url: `/api/issues/${issue.id}/fields` });
    expect(listed.json().fieldValues).toEqual(expect.arrayContaining([
      expect.objectContaining({ fieldName: FIELD_NAME, value: '修復登入頁' }),
      expect.objectContaining({ fieldName: 'CreateBy', value: session.accountId }),
    ]));

    const removed = await call({
      method: 'DELETE',
      url: `/api/issues/${issue.id}/fields/${FIELD_NAME}`,
    });
    expect(removed.statusCode).toBe(204);

    const gone = await call({ method: 'GET', url: `/api/issues/${issue.id}/fields/${FIELD_NAME}` });
    expect(gone.statusCode).toBe(404);
  });

  it('覆蓋既有欄位值', async () => {
    const issue = await createIssue();
    await call({
      method: 'PUT',
      url: `/api/issues/${issue.id}/fields/${FIELD_NAME}`,
      payload: { value: 'v1' },
    });
    const put2 = await call({
      method: 'PUT',
      url: `/api/issues/${issue.id}/fields/${FIELD_NAME}`,
      payload: { value: 'v2' },
    });
    expect(put2.json().fieldValue.value).toBe('v2');
  });

  it('寫入未定義欄位回 422 FIELD_NOT_DEFINED', async () => {
    const issue = await createIssue();
    const res = await call({
      method: 'PUT',
      url: `/api/issues/${issue.id}/fields/Undefined`,
      payload: { value: 'x' },
    });
    expect(res.statusCode).toBe(422);
    expect(res.json().error.code).toBe('FIELD_NOT_DEFINED');
  });

  it('泛用路徑寫 status／resolution 回 422，不繞過工單流程規則', async () => {
    const issue = await createIssue();

    const statusRes = await call({
      method: 'PUT',
      url: `/api/issues/${issue.id}/fields/status`,
      payload: { value: '已完成' },
    });
    expect(statusRes.statusCode).toBe(422);
    expect(statusRes.json().error.code).toBe('FIELD_REQUIRES_WORKFLOW_TRANSITION');

    const resolutionRes = await call({
      method: 'PUT',
      url: `/api/issues/${issue.id}/fields/resolution`,
      payload: { value: '已解決' },
    });
    expect(resolutionRes.statusCode).toBe(422);
    expect(resolutionRes.json().error.code).toBe('FIELD_REQUIRES_WORKFLOW_TRANSITION');

    // 兩次都被擋下，欄位值不應存在。
    const got = await call({ method: 'GET', url: `/api/issues/${issue.id}/fields/status` });
    expect(got.statusCode).toBe(404);
  });

  it('對不存在的工單寫欄位值回 404', async () => {
    const res = await call({
      method: 'PUT',
      url: `/api/issues/${randomUUID()}/fields/${FIELD_NAME}`,
      payload: { value: 'x' },
    });
    expect(res.statusCode).toBe(404);
  });

  it('寫入 tracked 欄位記錄變更歷史，oldValue 首筆為 null', async () => {
    const trackedField = 'TrackedNote';
    await pool.query(
      `INSERT INTO field_defs
         (company_id, name, field_set_name, kind, value_type, system, readonly, rollupable, rollup_fn, tracked, label)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
      [session.companyId, trackedField, '基本', 'single', 'text', false, false, false, null, true, '追蹤備註'],
    );
    const issue = await createIssue();

    await call({
      method: 'PUT',
      url: `/api/issues/${issue.id}/fields/${trackedField}`,
      payload: { value: 'v1' },
    });
    const afterFirst = await call({ method: 'GET', url: `/api/issues/${issue.id}/changelog` });
    const firstLog = afterFirst.json().changeLog as ReadonlyArray<{
      value: { fieldName: string; oldValue: unknown; newValue: unknown };
    }>;
    expect(firstLog).toHaveLength(1);
    expect(firstLog[0]!.value).toMatchObject({ fieldName: trackedField, oldValue: null, newValue: 'v1' });

    await call({
      method: 'PUT',
      url: `/api/issues/${issue.id}/fields/${trackedField}`,
      payload: { value: 'v2' },
    });
    const afterSecond = await call({ method: 'GET', url: `/api/issues/${issue.id}/changelog` });
    const secondLog = afterSecond.json().changeLog as ReadonlyArray<{
      value: { oldValue: unknown; newValue: unknown };
    }>;
    expect(secondLog).toHaveLength(2);
    // 新到舊：覆蓋寫入的這筆排最前，oldValue 帶上第一次寫入的值。
    expect(secondLog[0]!.value).toMatchObject({ oldValue: 'v1', newValue: 'v2' });
  });

  // ---- 異動歷史 ----

  it('列出工單異動歷史，依時間新到舊排序', async () => {
    const issue = await createIssue();

    // ChangeLog 的 field_defs 已在 beforeEach 種好，這裡不再重插一次
    // （曾各自插一次，兩處同名撞 pk_field_defs）。

    const earlier = Date.now() - 1000;
    const later = Date.now();
    const writeEntry = (time: number, oldValue: unknown, newValue: unknown) =>
      fieldRepo.appendChangeLog(
        {
          id: randomUUID(),
          companyId: session.companyId,
          issueId: issue.id,
          entry: { fieldName: 'status', oldValue, newValue, actor: session.accountId, time },
          authorId: session.accountId,
          createdOn: time,
        },
        pool,
      );
    await writeEntry(earlier, null, '待處理');
    await writeEntry(later, '待處理', '處理中');

    const res = await call({ method: 'GET', url: `/api/issues/${issue.id}/changelog` });
    expect(res.statusCode).toBe(200);
    const changeLog = res.json().changeLog as ReadonlyArray<{ value: { newValue: unknown } }>;
    expect(changeLog).toHaveLength(2);
    // 新到舊：後寫入的 (待處理→處理中) 排最前。
    expect(changeLog[0]!.value.newValue).toBe('處理中');
    expect(changeLog[1]!.value.newValue).toBe('待處理');
  });

  it('對不存在的工單取異動歷史回 404', async () => {
    const res = await call({ method: 'GET', url: `/api/issues/${randomUUID()}/changelog` });
    expect(res.statusCode).toBe(404);
  });
});
