import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { authed, bootstrap, registerSession, testUrl } from '../../../server/src/api/routes/testHarness';
import * as issueTypesApi from './issueTypes';

const suite = testUrl ? describe : describe.skip;

suite('工單型別的畫面資料', () => {
  let pool: Pool;
  let app: FastifyInstance;
  let call: ReturnType<typeof authed>;

  beforeAll(async () => { ({ pool, app } = await bootstrap()); });
  afterAll(async () => { await app.close(); await pool.end(); });
  afterEach(() => vi.unstubAllGlobals());
  beforeEach(async () => {
    await pool.query('TRUNCATE companies CASCADE');
    const session = await registerSession(app);
    call = authed(app, session.cookie);
    await call({ method: 'GET', url: '/api/workspace' });
    // 只替換 HTTP 傳輸，前端 API、後端路由與資料庫皆走真實實作。
    vi.stubGlobal('fetch', async (input: string, init?: RequestInit) => {
      const result = await call({ method: init?.method ?? 'GET', url: input });
      return new Response(result.body, { status: result.statusCode });
    });
  });

  it('依指定型別提供單值欄位、狀態與結案原因', async () => {
    for (const name of ['需求', '缺陷']) {
      expect((await call({ method: 'POST', url: '/api/fields/sets', payload: { name } })).statusCode).toBe(201);
    }
    for (const [name, fieldSetName, kind] of [
      ['request_note', '需求', 'single'],
      ['request_comments', '需求', 'multi'],
      ['bug_severity', '缺陷', 'single'],
    ]) {
      expect((await call({ method: 'POST', url: '/api/fields/defs', payload: {
        name, fieldSetName, kind, valueType: 'text', label: name,
      } })).statusCode).toBe(201);
    }
    const created = await call({ method: 'POST', url: '/api/issue-types', payload: {
      name: 'request', label: '需求', fieldSets: ['基本', '需求'],
    } });
    expect(created.statusCode).toBe(201);
    const typeId = created.json().issueType.id as string;
    expect((await call({ method: 'PUT', url: `/api/issue-types/${typeId}/workflow`, payload: {
      states: [
        { name: '待釐清', isInitial: true, isTerminal: false },
        { name: '驗收完成', isInitial: false, isTerminal: true },
      ],
      transitions: [{ fromState: '待釐清', toState: '驗收完成', requiredRole: null, requiredFields: [] }],
      resolutionOptions: [{ value: '需求已交付' }, { value: '需求取消' }],
    } })).statusCode).toBe(200);

    const details = await issueTypesApi.getIssueTypeDetails(typeId);
    const names = details.singleFieldDefs.map((field) => field.name);
    expect(names).toEqual(expect.arrayContaining(['title', 'status', 'request_note']));
    expect(names).not.toContain('bug_severity');
    expect(names).not.toContain('request_comments');
    expect(details.workflow.states.map((state) => state.name)).toEqual(['待釐清', '驗收完成']);
    expect(details.workflow.resolutionOptions.map((option) => option.value)).toEqual(['需求已交付', '需求取消']);
  });
});
