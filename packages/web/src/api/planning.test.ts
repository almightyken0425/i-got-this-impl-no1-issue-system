import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { authed, bootstrap, registerSession, testUrl } from '../../../server/src/api/routes/testHarness';
import * as issues from './issues';
import * as relations from './relations';
import * as calendars from './calendars';

const suite = testUrl ? describe : describe.skip;
suite('規劃操作的前後端接線', () => {
  let pool: Pool;
  let app: FastifyInstance;
  let call: ReturnType<typeof authed>;
  beforeAll(async () => { ({ pool, app } = await bootstrap()); });
  afterAll(async () => { await app.close(); await pool.end(); });
  afterEach(() => vi.unstubAllGlobals());
  beforeEach(async () => {
    await pool.query('TRUNCATE companies CASCADE');
    call = authed(app, (await registerSession(app)).cookie);
    await call({ method: 'GET', url: '/api/workspace' });
    vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
      const response = await call({ method: init?.method ?? 'GET', url,
        ...(typeof init?.body === 'string' ? { payload: JSON.parse(init.body) } : {}) });
      return new Response(response.statusCode === 204 ? null : response.body, { status: response.statusCode });
    });
  });
  it('依工單編號建立關聯、填報與修正工時、切换模式、維護日曆後可讀回', async () => {
    const create = async (title: string) => (await call({ method: 'POST', url: '/api/workspace/issues', payload: { title } })).json().issue;
    const parent = await create('主題');
    const child = await create('執行');
    expect((await issues.getIssueByKey(child.key)).id).toBe(child.id);
    const type = await relations.createRelationType({ name: 'Children', exclusive: true, acyclic: true, rollup: true });
    const relation = await relations.createRelation(parent.id, child.id, type.id);
    const record = await issues.writeWorkLog(child.id, 2);
    await issues.writeWorkLog(child.id, 3, record.id);
    expect((await issues.getIssueContext(parent.id)).rollups).toEqual(expect.arrayContaining([expect.objectContaining({ fieldName: 'WorkLog', value: 3 })]));
    await issues.updateFieldValue(child.id, 'point', 5);
    await issues.updateFieldValue(parent.id, 'point', 8, 'manual');
    expect((await issues.getIssueContext(parent.id)).rollups).toEqual(expect.arrayContaining([expect.objectContaining({ fieldName: 'point', mode: 'manual', deviation: expect.objectContaining({ delta: -3 }) })]));
    await issues.updateFieldValue(parent.id, 'point', null, 'auto');
    await calendars.createCalendar('工作週', ['SAT', 'SUN']);
    await calendars.setCalendarException('工作週', '2026-10-10', true);
    await calendars.updateWeeklyOff('工作週', ['SUN']);
    expect((await calendars.listCalendars())[0]).toMatchObject({ weeklyOff: ['SUN'], exceptions: [{ date: '2026-10-10', isWorking: true }] });
    await calendars.removeCalendarException('工作週', '2026-10-10');
    await issues.removeWorkLog(child.id, record.id);
    await relations.removeRelation(relation.id);
    expect((await issues.getIssueContext(parent.id)).rollups.every(row => !row.hasChildren)).toBe(true);
  });

  it('新日曆成功保存後，已開啟的選單可重新讀到它，離開或失敗時不通知', async () => {
    const refreshed: Array<Promise<readonly { name: string }[]>> = [];
    const removed = vi.fn();
    const stop = calendars.subscribeCalendarList(() => { refreshed.push(calendars.listCalendars()); });
    const stopRemoved = calendars.subscribeCalendarList(removed);
    stopRemoved();
    try {
      expect(await calendars.listCalendars()).toEqual([]);
      await calendars.createCalendar('新工作週', ['SAT', 'SUN']);
      expect(refreshed).toHaveLength(1);
      expect(await refreshed[0]).toEqual([expect.objectContaining({ name: '新工作週' })]);
      expect(removed).not.toHaveBeenCalled();
      await expect(calendars.createCalendar('新工作週', ['SUN'])).rejects.toThrow();
      expect(refreshed).toHaveLength(1);
      stop();
      await calendars.createCalendar('另一工作週', ['SUN']);
      expect(refreshed).toHaveLength(1);
    } finally { stop(); }
  });
});
