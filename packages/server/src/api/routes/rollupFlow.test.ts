import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { authed, bootstrap, registerSession, testUrl } from './testHarness.js';

const suite = testUrl ? describe : describe.skip;
suite('工單異動與自動彙總', () => {
  let app: FastifyInstance;
  let pool: Pool;
  let call: ReturnType<typeof authed>;
  let relationTypeId: string;
  beforeAll(async () => { ({ app, pool } = await bootstrap()); });
  afterAll(async () => { await app.close(); await pool.end(); });
  beforeEach(async () => {
    await pool.query('TRUNCATE companies CASCADE');
    call = authed(app, (await registerSession(app)).cookie);
    await call({ method: 'GET', url: '/api/workspace' });
    const type = await call({ method: 'POST', url: '/api/relations/types', payload: {
      name: 'Children', exclusive: true, acyclic: true, rollup: true,
    } });
    expect(type.statusCode).toBe(201);
    relationTypeId = type.json().relationType.id;
  });
  async function issue(title: string) {
    const res = await call({ method: 'POST', url: '/api/workspace/issues', payload: { title } });
    expect(res.statusCode).toBe(201);
    return res.json().issue.id as string;
  }
  async function link(fromIssueId: string, toIssueId: string) {
    const res = await call({ method: 'POST', url: '/api/relations/edges', payload: { fromIssueId, toIssueId, relationTypeId } });
    expect(res.statusCode).toBe(201);
    return res.json().relation.id as string;
  }
  async function setDate(id: string, value: string, rollupMode?: 'auto' | 'manual') {
    return call({ method: 'PUT', url: `/api/issues/${id}/fields/EndTime`, payload: { value, ...(rollupMode === undefined ? {} : { rollupMode }) } });
  }
  async function value(id: string) {
    const res = await call({ method: 'GET', url: `/api/issues/${id}/fields/EndTime` });
    expect(res.statusCode).toBe(200);
    return res.json().fieldValue;
  }

  it('舊版缺算法定義不讓詳情整頁失效', async () => {
    const id = await issue('舊資料');
    await pool.query("UPDATE field_defs SET rollup_fn = NULL WHERE name = 'point'");
    const response = await call({ method: 'GET', url: `/api/issues/${id}/context` });
    expect(response.statusCode).toBe(200);
    expect(response.json().rollups.some((field: { fieldName: string }) => field.fieldName === 'point')).toBe(false);
  });

  it('下級日期向上逐層重算，自動主值不可直接覆蓋，手動主值不被下級改動蓋掉', async () => {
    const root = await issue('祖先');
    const parent = await issue('持有端');
    const child = await issue('執行單');
    await link(root, parent);
    await link(parent, child);
    expect((await setDate(child, '2026-10-08')).statusCode).toBe(200);
    expect(await value(parent)).toMatchObject({ value: '2026-10-08', rollupMode: 'auto' });
    expect(await value(root)).toMatchObject({ value: '2026-10-08', rollupMode: 'auto' });
    expect((await setDate(parent, '2026-10-01')).statusCode).toBe(422);
    expect((await setDate(parent, '2026-10-01', 'manual')).statusCode).toBe(200);
    expect((await setDate(child, '2026-10-12')).statusCode).toBe(200);
    expect(await value(parent)).toMatchObject({ value: '2026-10-01', rollupMode: 'manual' });
    expect(await value(root)).toMatchObject({ value: '2026-10-01', rollupMode: 'auto' });
    expect((await setDate(parent, 'ignored', 'auto')).statusCode).toBe(200);
    expect(await value(parent)).toMatchObject({ value: '2026-10-12', rollupMode: 'auto' });
    expect(await value(root)).toMatchObject({ value: '2026-10-12', rollupMode: 'auto' });
  });

  it('移除及封存來源會重算，最後一個下級消失後保留主值並轉手動', async () => {
    const parent = await issue('持有端');
    const a = await issue('甲');
    const b = await issue('乙');
    const edge = await link(parent, a);
    await link(parent, b);
    await setDate(a, '2026-10-20');
    await setDate(b, '2026-10-10');
    expect((await call({ method: 'DELETE', url: `/api/relations/edges/${edge}` })).statusCode).toBe(204);
    expect(await value(parent)).toMatchObject({ value: '2026-10-10', rollupMode: 'auto' });
    expect((await call({ method: 'DELETE', url: `/api/issues/${b}` })).statusCode).toBe(204);
    expect(await value(parent)).toMatchObject({ value: '2026-10-10', rollupMode: 'manual' });
  });

  it('工作區估點寫入與泛用寫入共用彙總及唯讀規則', async () => {
    const parent = await issue('持有端');
    const child = await issue('执行單');
    await link(parent, child);
    expect((await call({ method: 'PATCH', url: `/api/workspace/issues/${child}`, payload: { point: 5 } })).statusCode).toBe(200);
    const read = await call({ method: 'GET', url: `/api/issues/${parent}/fields/point` });
    expect(read.statusCode).toBe(200);
    expect(read.json().fieldValue).toMatchObject({ value: 5, rollupMode: 'auto' });
    expect((await call({ method: 'PATCH', url: `/api/workspace/issues/${parent}`, payload: { point: 8 } })).statusCode).toBe(422);
    expect((await call({ method: 'DELETE', url: `/api/issues/${parent}/fields/point` })).statusCode).toBe(422);
  });

  it('工時只在葉節點填報，新增、修正、移除立即改變祖先總計，記錄不可跨單操作', async () => {
    const parent = await issue('持有端');
    const child = await issue('執行單');
    await link(parent, child);
    const created = await call({ method: 'POST', url: `/api/issues/${child}/worklogs`, payload: { hours: 2.5 } });
    expect(created.statusCode).toBe(201);
    const record = created.json().record;
    const context = () => call({ method: 'GET', url: `/api/issues/${parent}/context` });
    expect((await context()).json().rollups).toEqual(expect.arrayContaining([expect.objectContaining({ fieldName: 'WorkLog', value: 2.5, mode: 'auto' })]));
    expect((await call({ method: 'POST', url: `/api/issues/${parent}/worklogs`, payload: { hours: 1 } })).statusCode).toBe(422);
    expect((await call({ method: 'POST', url: `/api/issues/${child}/worklogs`, payload: { hours: -1 } })).statusCode).toBe(400);
    const updated = await call({ method: 'PUT', url: `/api/issues/${child}/worklogs/${record.id}`, payload: { hours: 4 } });
    expect(updated.statusCode).toBe(200);
    expect(updated.json().record).toMatchObject({ value: 4, authorId: record.authorId, createdOn: record.createdOn });
    expect((await call({ method: 'DELETE', url: `/api/issues/${parent}/worklogs/${record.id}` })).statusCode).toBe(404);
    expect((await context()).json().rollups).toEqual(expect.arrayContaining([expect.objectContaining({ fieldName: 'WorkLog', value: 4 })]));
    expect((await call({ method: 'DELETE', url: `/api/issues/${child}/worklogs/${record.id}` })).statusCode).toBe(204);
    expect((await context()).json().rollups).toEqual(expect.arrayContaining([expect.objectContaining({ fieldName: 'WorkLog', value: 0 })]));
  });

  it('偏離採工作日曆，空手動主值保留模式，空下級不參與日期比較', async () => {
    const parent = await issue('持有端');
    const child = await issue('執行單');
    await link(parent, child);
    await setDate(child, '2026-10-12');
    await setDate(parent, '2026-10-09', 'manual');
    const calendar = await call({ method: 'POST', url: '/api/calendars', payload: { name: '工作週', weeklyOff: ['SAT', 'SUN'] } });
    expect(calendar.statusCode).toBe(201);
    const ctx = await call({ method: 'GET', url: `/api/issues/${parent}/context?calendarName=${encodeURIComponent('工作週')}` });
    expect(ctx.statusCode).toBe(200);
    expect(ctx.json().rollups).toEqual(expect.arrayContaining([expect.objectContaining({ fieldName: 'EndTime', deviation: expect.objectContaining({ delta: 1, unit: 'workingDay' }) })]));
    expect((await call({ method: 'PUT', url: `/api/issues/${parent}/fields/EndTime`, payload: { value: null, rollupMode: 'manual' } })).statusCode).toBe(200);
    await setDate(child, '2026-10-14');
    expect(await value(parent)).toMatchObject({ value: null, rollupMode: 'manual' });
  });

  it('移出配方停止自動改寫且拒絕隱藏欄位寫入，重新加入後重算', async () => {
    const type = (await call({ method: 'POST', url: '/api/issue-types', payload: { name: 'topic', label: '主題', fieldSets: ['基本'] } })).json().issueType;
    const parent = (await call({ method: 'POST', url: '/api/workspace/issues', payload: { title: '主題', issueTypeId: type.id } })).json().issue.id;
    const child = await issue('執行單');
    await link(parent, child);
    await setDate(child, '2026-10-08');
    expect((await call({ method: 'PATCH', url: `/api/issue-types/${type.id}`, payload: { label: '主題', fieldSets: [] } })).statusCode).toBe(200);
    await setDate(child, '2026-10-10');
    expect((await setDate(parent, '2026-10-20', 'manual')).statusCode).toBe(422);
    const stored = await pool.query("SELECT value FROM issue_field_values WHERE issue_id = $1 AND field_name = 'EndTime'", [parent]);
    expect(stored.rows[0].value).toBe('2026-10-08');
    expect((await call({ method: 'PATCH', url: `/api/issue-types/${type.id}`, payload: { label: '主題', fieldSets: ['基本'] } })).statusCode).toBe(200);
    expect(await value(parent)).toMatchObject({ value: '2026-10-10', rollupMode: 'auto' });
  });
});
