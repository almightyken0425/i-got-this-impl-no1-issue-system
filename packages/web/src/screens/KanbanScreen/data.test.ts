import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { authed, bootstrap, registerSession, testUrl } from '../../../../server/src/api/routes/testHarness';
import * as kanban from './data';

const suite = testUrl ? describe : describe.skip;

suite('看板的多型別資料', () => {
  let pool: Pool;
  let app: FastifyInstance;
  let call: ReturnType<typeof authed>;
  let viewId: string;

  beforeAll(async () => { ({ pool, app } = await bootstrap()); });
  afterAll(async () => { await app.close(); await pool.end(); });
  afterEach(() => vi.unstubAllGlobals());
  beforeEach(async () => {
    await pool.query('TRUNCATE companies CASCADE');
    call = authed(app, (await registerSession(app)).cookie);
    const context = (await call({ method: 'GET', url: '/api/workspace' })).json();
    const issueSet = (await call({ method: 'GET', url: `/api/issue-sets/${context.issueSet.id}` })).json().issueSet;
    const view = await call({ method: 'POST', url: '/api/views', payload: {
      name: '混合型別', viewType: 'kanban', sourceMgmtIds: [issueSet.mgmtId], displayLevel: 1,
    } });
    expect(view.statusCode).toBe(201);
    viewId = view.json().view.id as string;
    vi.stubGlobal('fetch', async (input: string, init?: RequestInit) => {
      const result = await call({ method: init?.method ?? 'GET', url: input });
      return new Response(result.body, { status: result.statusCode });
    });
  });

  async function createTypedIssue(name: string, reviewIsTerminal: boolean, resolutions: string[]) {
    const typeResponse = await call({ method: 'POST', url: '/api/issue-types', payload: {
      name, label: name, fieldSets: ['基本'],
    } });
    expect(typeResponse.statusCode).toBe(201);
    const issueTypeId = typeResponse.json().issueType.id as string;
    expect((await call({ method: 'PUT', url: `/api/issue-types/${issueTypeId}/workflow`, payload: {
      states: [
        { name: '待處理', isInitial: true, isTerminal: false },
        { name: '待驗收', isInitial: false, isTerminal: reviewIsTerminal },
        { name: '結束', isInitial: false, isTerminal: true },
      ],
      transitions: [
        { fromState: '待處理', toState: '待驗收', requiredRole: null, requiredFields: [] },
        { fromState: '待驗收', toState: '結束', requiredRole: null, requiredFields: [] },
      ],
      resolutionOptions: resolutions.map((value) => ({ value })),
    } })).statusCode).toBe(200);
    const issueResponse = await call({ method: 'POST', url: '/api/workspace/issues', payload: {
      title: name, issueTypeId, due: '2026-10-10',
    } });
    expect(issueResponse.statusCode).toBe(201);
    return { issueTypeId, issueId: issueResponse.json().issue.id as string };
  }

  it('同名狀態依卡片型別判斷終止，結案原因各自保留順序', async () => {
    const request = await createTypedIssue('request', true, ['需求交付', '需求取消']);
    const bug = await createTypedIssue('bug', false, ['無法重現', '已修正']);

    const data = await kanban.loadKanbanData(viewId);
    expect(data.issues).toHaveLength(2);
    const requestCard = data.issues.find((issue) => issue.id === request.issueId)!;
    const bugCard = data.issues.find((issue) => issue.id === bug.issueId)!;
    expect(requestCard.issueTypeId).toBe(request.issueTypeId);
    expect(bugCard.issueTypeId).toBe(bug.issueTypeId);
    expect(kanban.isTerminalStatus(requestCard, '待驗收')).toBe(true);
    expect(kanban.isTerminalStatus(bugCard, '待驗收')).toBe(false);
    expect(requestCard.workflow.resolutionOptions.map((option) => option.value)).toEqual(['需求交付', '需求取消']);
    expect(bugCard.workflow.resolutionOptions.map((option) => option.value)).toEqual(['無法重現', '已修正']);
    expect(data.columns).toEqual(expect.arrayContaining(['待處理', '待驗收', '結束']));

    const denied = await call({ method: 'PATCH', url: `/api/workspace/issues/${request.issueId}`, payload: {
      status: '待驗收', resolution: '已修正',
    } });
    expect(denied.statusCode).toBe(422);
    expect((await kanban.loadKanbanData(viewId)).issues.find((issue) => issue.id === request.issueId)?.status).toBe('待處理');

    expect((await call({ method: 'PATCH', url: `/api/workspace/issues/${request.issueId}`, payload: {
      status: '待驗收', resolution: '需求交付',
    } })).statusCode).toBe(200);
    expect((await call({ method: 'PATCH', url: `/api/workspace/issues/${bug.issueId}`, payload: {
      status: '待驗收',
    } })).statusCode).toBe(200);
    const refreshed = await kanban.loadKanbanData(viewId);
    expect(refreshed.issues.find((issue) => issue.id === request.issueId)).toMatchObject({ status: '待驗收', resolution: '需求交付' });
    expect(refreshed.issues.find((issue) => issue.id === bug.issueId)).toMatchObject({ status: '待驗收', resolution: null });
  });

  it('沒有工單的檢視仍保留流程欄位', async () => {
    const data = await kanban.loadKanbanData(viewId);
    expect(data.issues).toEqual([]);
    expect(data.columns.length).toBeGreaterThan(0);
    expect(data.permissionExcludedCount).toBe(0);
  });
});
