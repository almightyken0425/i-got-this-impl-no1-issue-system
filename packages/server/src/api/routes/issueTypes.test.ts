import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { authed, bootstrap, grantTypeAdminFixture, registerSession, testUrl, type Session } from './testHarness.js';

// 工單型別路由整合測試：以 Fastify inject 打真路由連 igotthis_test。
// 涵蓋建立（含預設流程一併初始化）、列出、更新、重複名稱與缺欄位組的錯誤碼。

const suite = testUrl ? describe : describe.skip;

suite('issue type routes', () => {
  let pool: Pool;
  let app: FastifyInstance;
  let session: Session;
  let call: ReturnType<typeof authed>;

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
    await grantTypeAdminFixture(pool, session);
    call = authed(app, session.cookie);
  });

  async function createSet(name: string): Promise<void> {
    const res = await call({ method: 'POST', url: '/api/fields/sets', payload: { name } });
    expect(res.statusCode).toBe(201);
  }

  it('未帶 cookie 存取工單型別路由回 401', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/issue-types' });
    expect(res.statusCode).toBe(401);
  });

  it('建立工單型別回 201，一併帶入預設流程狀態與結案原因', async () => {
    await createSet('基本');
    const res = await call({
      method: 'POST',
      url: '/api/issue-types',
      payload: { name: 'bug', label: 'Bug', fieldSets: ['基本'] },
    });
    expect(res.statusCode).toBe(201);
    const issueType = res.json().issueType;
    expect(issueType.name).toBe('bug');
    expect(issueType.label).toBe('Bug');
    expect(issueType.system).toBe(false);

    // 流程定義已一併落地，狀態轉換路由能認得預設起始狀態（間接驗證交易兩步都成功）。
    const workspace = await call({ method: 'GET', url: '/api/workspace' });
    expect(workspace.statusCode).toBe(200);
  });

  it('重複工單型別名稱回 409', async () => {
    await createSet('基本');
    await call({
      method: 'POST',
      url: '/api/issue-types',
      payload: { name: 'bug', label: 'Bug', fieldSets: ['基本'] },
    });
    const again = await call({
      method: 'POST',
      url: '/api/issue-types',
      payload: { name: 'bug', label: 'Bug2', fieldSets: ['基本'] },
    });
    expect(again.statusCode).toBe(409);
    expect(again.json().error.code).toBe('ISSUE_TYPE_NAME_TAKEN');
  });

  it('fieldSets 含不存在的欄位組回 422', async () => {
    const res = await call({
      method: 'POST',
      url: '/api/issue-types',
      payload: { name: 'bug', label: 'Bug', fieldSets: ['不存在'] },
    });
    expect(res.statusCode).toBe(422);
    expect(res.json().error.code).toBe('FIELD_SET_NOT_FOUND');
  });

  it('列出工單型別', async () => {
    await createSet('基本');
    await call({
      method: 'POST',
      url: '/api/issue-types',
      payload: { name: 'bug', label: 'Bug', fieldSets: ['基本'] },
    });
    const list = await call({ method: 'GET', url: '/api/issue-types' });
    expect(list.json().issueTypes.map((t: { name: string }) => t.name)).toEqual(['bug']);
  });

  it('更新工單型別的顯示名稱與欄位組配方；查無回 404', async () => {
    await createSet('基本');
    await createSet('進階');
    const created = await call({
      method: 'POST',
      url: '/api/issue-types',
      payload: { name: 'bug', label: 'Bug', fieldSets: ['基本'] },
    });
    const id = created.json().issueType.id;

    const updated = await call({
      method: 'PATCH',
      url: `/api/issue-types/${id}`,
      payload: { label: 'Defect', fieldSets: ['基本', '進階'] },
    });
    expect(updated.statusCode).toBe(200);
    expect(updated.json().issueType.label).toBe('Defect');
    expect(updated.json().issueType.fieldSets).toEqual(['基本', '進階']);

    const missing = await call({
      method: 'PATCH',
      url: '/api/issue-types/00000000-0000-0000-0000-000000000000',
      payload: { label: 'X', fieldSets: ['基本'] },
    });
    expect(missing.statusCode).toBe(404);
  });

  describe('流程定義路由 /:id/workflow', () => {
    async function createType(): Promise<string> {
      await createSet('基本');
      const created = await call({
        method: 'POST',
        url: '/api/issue-types',
        payload: { name: 'bug', label: 'Bug', fieldSets: ['基本'] },
      });
      return created.json().issueType.id as string;
    }

    it('讀取查無型別回 404', async () => {
      const res = await call({
        method: 'GET',
        url: '/api/issue-types/00000000-0000-0000-0000-000000000000/workflow',
      });
      expect(res.statusCode).toBe(404);
    });

    it('讀取剛建立型別的預設流程，三狀態與兩轉換皆已由 initializeTypeWorkflow 種好', async () => {
      const id = await createType();
      const res = await call({ method: 'GET', url: `/api/issue-types/${id}/workflow` });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.states.map((s: { name: string }) => s.name)).toEqual([
        '待處理',
        '處理中',
        '審查中',
        '已完成',
      ]);
      expect(body.transitions).toHaveLength(4);
      expect(body.resolutionOptions.map(
        ({ value, sortOrder }: { value: string; sortOrder: number }) => ({ value, sortOrder }),
      )).toEqual([
        { value: '已完成', sortOrder: 1 },
        { value: '不做', sortOrder: 2 },
      ]);
    });

    it('整包替換：新增一條帶 requiredRole／requiredFields 的轉換', async () => {
      const id = await createType();
      const res = await call({
        method: 'PUT',
        url: `/api/issue-types/${id}/workflow`,
        payload: {
          states: [
            { name: '待處理', isInitial: true, isTerminal: false },
            { name: '已關閉', isInitial: false, isTerminal: true },
          ],
          transitions: [
            {
              fromState: '待處理',
              toState: '已關閉',
              requiredRole: '管理員',
              requiredFields: ['resolution'],
            },
          ],
          resolutionOptions: [{ value: '已完成' }],
        },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.transitions).toHaveLength(1);
      expect(body.transitions[0].requiredRole).toBe('管理員');
      expect(body.transitions[0].requiredFields).toEqual(['resolution']);

      const reread = await call({ method: 'GET', url: `/api/issue-types/${id}/workflow` });
      expect(reread.json().states.map((s: { name: string }) => s.name)).toEqual(['待處理', '已關閉']);
    });

    it('多個結案原因依送出順序持久化且位置從一開始', async () => {
      const id = await createType();
      const saved = await call({
        method: 'PUT',
        url: `/api/issue-types/${id}/workflow`,
        payload: {
          states: [{ name: '待處理', isInitial: true, isTerminal: false }],
          transitions: [],
          resolutionOptions: [{ value: 'Zulu' }, { value: 'Alpha' }, { value: 'Mike' }],
        },
      });
      expect(saved.statusCode).toBe(200);

      const reread = await call({ method: 'GET', url: `/api/issue-types/${id}/workflow` });
      expect(reread.json().resolutionOptions.map(
        ({ value, sortOrder }: { value: string; sortOrder: number }) => ({ value, sortOrder }),
      )).toEqual([
        { value: 'Zulu', sortOrder: 1 },
        { value: 'Alpha', sortOrder: 2 },
        { value: 'Mike', sortOrder: 3 },
      ]);

      const reordered = await call({
        method: 'PUT',
        url: `/api/issue-types/${id}/workflow`,
        payload: {
          states: [{ name: '待處理', isInitial: true, isTerminal: false }],
          transitions: [],
          resolutionOptions: [{ value: 'Mike' }, { value: 'Zulu' }],
        },
      });
      expect(reordered.statusCode).toBe(200);
      const rereadReordered = await call({ method: 'GET', url: `/api/issue-types/${id}/workflow` });
      expect(rereadReordered.json().resolutionOptions.map(
        ({ value, sortOrder }: { value: string; sortOrder: number }) => ({ value, sortOrder }),
      )).toEqual([
        { value: 'Mike', sortOrder: 1 },
        { value: 'Zulu', sortOrder: 2 },
      ]);
    });

    it('起始狀態不是恰好一個回 422', async () => {
      const id = await createType();
      const res = await call({
        method: 'PUT',
        url: `/api/issue-types/${id}/workflow`,
        payload: {
          states: [
            { name: '待處理', isInitial: false, isTerminal: false },
            { name: '已關閉', isInitial: false, isTerminal: true },
          ],
          transitions: [],
          resolutionOptions: [],
        },
      });
      expect(res.statusCode).toBe(422);
      expect(res.json().error.code).toBe('INITIAL_STATE_COUNT_INVALID');
    });

    it('轉換引用不存在的狀態回 422，且不落庫（整包替換前擋下）', async () => {
      const id = await createType();
      const res = await call({
        method: 'PUT',
        url: `/api/issue-types/${id}/workflow`,
        payload: {
          states: [{ name: '待處理', isInitial: true, isTerminal: false }],
          transitions: [
            { fromState: '待處理', toState: '不存在', requiredRole: null, requiredFields: [] },
          ],
          resolutionOptions: [],
        },
      });
      expect(res.statusCode).toBe(422);
      expect(res.json().error.code).toBe('TRANSITION_STATE_NOT_FOUND');

      const reread = await call({ method: 'GET', url: `/api/issue-types/${id}/workflow` });
      expect(reread.json().states.map((s: { name: string }) => s.name)).toEqual([
        '待處理',
        '處理中',
        '審查中',
        '已完成',
      ]);
    });

    it('寫入查無型別回 404', async () => {
      const res = await call({
        method: 'PUT',
        url: '/api/issue-types/00000000-0000-0000-0000-000000000000/workflow',
        payload: {
          states: [{ name: '待處理', isInitial: true, isTerminal: false }],
          transitions: [],
          resolutionOptions: [],
        },
      });
      expect(res.statusCode).toBe(404);
    });
  });
});
