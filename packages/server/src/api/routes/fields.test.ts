import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { authed, bootstrap, grantTypeAdminFixture, registerSession, testUrl, type Session } from './testHarness.js';

// 欄位路由整合測試：以 Fastify inject 打真路由連 igotthis_test。
// 涵蓋欄位組 CRUD、欄位定義 CRUD、重複名稱與缺欄位組的錯誤碼、可彙總欄位的 rollupFn 落地。

const suite = testUrl ? describe : describe.skip;

suite('field routes', () => {
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

  // ---- auth ----

  it('彙總定義必須帶相容算法與原語', async () => {
    await createSet('自訂');
    for (const value of [
      { valueType: 'number', rollupFn: null },
      { valueType: 'text', rollupFn: 'sum' },
      { valueType: 'date', rollupFn: 'sum' },
    ]) {
      const response = await call({ method: 'POST', url: '/api/fields/defs', payload: {
        name: 'invalid', label: '錯誤彙總', fieldSetName: '自訂', kind: 'single', rollupable: true, ...value,
      } });
      expect(response.statusCode).toBe(422);
    }
  });

  it('未帶 cookie 存取欄位路由回 401', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/fields/sets' });
    expect(res.statusCode).toBe(401);
  });

  // ---- 欄位組 ----

  it('建立欄位組回 201、可列出', async () => {
    const res = await call({ method: 'POST', url: '/api/fields/sets', payload: { name: '基本' } });
    expect(res.statusCode).toBe(201);
    expect(res.json().fieldSet.name).toBe('基本');
    expect(res.json().fieldSet.system).toBe(false);

    const list = await call({ method: 'GET', url: '/api/fields/sets' });
    expect(list.json().fieldSets).toHaveLength(1);
  });

  it('重複欄位組名稱回 409', async () => {
    await createSet('基本');
    const again = await call({ method: 'POST', url: '/api/fields/sets', payload: { name: '基本' } });
    expect(again.statusCode).toBe(409);
    expect(again.json().error.code).toBe('FIELD_SET_NAME_TAKEN');
  });

  it('刪除欄位組：查無回 404，成功回 204 且列表不再出現', async () => {
    const missing = await call({ method: 'DELETE', url: '/api/fields/sets/不存在' });
    expect(missing.statusCode).toBe(404);
    expect(missing.json().error.code).toBe('FIELD_SET_NOT_FOUND');

    await createSet('專案');
    const res = await call({ method: 'DELETE', url: '/api/fields/sets/專案' });
    expect(res.statusCode).toBe(204);
    const list = await call({ method: 'GET', url: '/api/fields/sets' });
    expect(list.json().fieldSets).toHaveLength(0);
  });

  it('刪除底下還有欄位的欄位組回 409', async () => {
    await createSet('基本');
    await call({
      method: 'POST',
      url: '/api/fields/defs',
      payload: { name: 'Title', fieldSetName: '基本', kind: 'single', valueType: 'text', label: '標題' },
    });
    const res = await call({ method: 'DELETE', url: '/api/fields/sets/基本' });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('FIELD_SET_NOT_EMPTY');
  });

  // ---- 欄位定義 ----

  it('建立欄位定義回 201', async () => {
    await createSet('基本');
    const res = await call({
      method: 'POST',
      url: '/api/fields/defs',
      payload: { name: 'Title', fieldSetName: '基本', kind: 'single', valueType: 'text', label: '標題' },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().fieldDef.name).toBe('Title');
    expect(res.json().fieldDef.rollupable).toBe(false);
    expect(res.json().fieldDef.rollupFn).toBeNull();
  });

  it('可彙總欄位落地 rollupFn', async () => {
    await createSet('基本');
    const res = await call({
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
    expect(res.statusCode).toBe(201);
    expect(res.json().fieldDef.rollupable).toBe(true);
    expect(res.json().fieldDef.rollupFn).toBe('sum');
  });

  it('不可彙總欄位即使帶 rollupFn 也落地為 null', async () => {
    await createSet('基本');
    const res = await call({
      method: 'POST',
      url: '/api/fields/defs',
      payload: {
        name: 'Note',
        fieldSetName: '基本',
        kind: 'single',
        valueType: 'text',
        label: '備註',
        rollupable: false,
        rollupFn: 'sum',
      },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().fieldDef.rollupFn).toBeNull();
  });

  it('所屬欄位組不存在回 422 FIELD_SET_NOT_FOUND', async () => {
    const res = await call({
      method: 'POST',
      url: '/api/fields/defs',
      payload: { name: 'X', fieldSetName: '不存在', kind: 'single', valueType: 'text', label: 'X' },
    });
    expect(res.statusCode).toBe(422);
    expect(res.json().error.code).toBe('FIELD_SET_NOT_FOUND');
  });

  it('重複欄位名稱回 409', async () => {
    await createSet('基本');
    const body = {
      name: 'Title',
      fieldSetName: '基本',
      kind: 'single',
      valueType: 'text',
      label: '標題',
    };
    await call({ method: 'POST', url: '/api/fields/defs', payload: body });
    const again = await call({ method: 'POST', url: '/api/fields/defs', payload: body });
    expect(again.statusCode).toBe(409);
    expect(again.json().error.code).toBe('FIELD_NAME_TAKEN');
  });

  it('列出欄位定義、可用 fieldSetName 過濾，取單一與 404', async () => {
    await createSet('基本');
    await createSet('進階');
    const mk = (name: string, set: string): Promise<unknown> =>
      call({
        method: 'POST',
        url: '/api/fields/defs',
        payload: { name, fieldSetName: set, kind: 'single', valueType: 'text', label: name },
      });
    await mk('Title', '基本');
    await mk('Extra', '進階');

    const all = await call({ method: 'GET', url: '/api/fields/defs' });
    expect(all.json().fieldDefs).toHaveLength(2);

    const bySet = await call({ method: 'GET', url: '/api/fields/defs?fieldSetName=進階' });
    expect(bySet.json().fieldDefs).toHaveLength(1);
    expect(bySet.json().fieldDefs[0].name).toBe('Extra');

    const one = await call({ method: 'GET', url: '/api/fields/defs/Title' });
    expect(one.statusCode).toBe(200);
    expect(one.json().fieldDef.name).toBe('Title');

    const gone = await call({ method: 'GET', url: '/api/fields/defs/Missing' });
    expect(gone.statusCode).toBe(404);
  });

  it('改欄位定義顯示名稱回 200；查無回 404', async () => {
    await createSet('基本');
    await call({
      method: 'POST',
      url: '/api/fields/defs',
      payload: { name: 'Title', fieldSetName: '基本', kind: 'single', valueType: 'text', label: '標題' },
    });
    const res = await call({
      method: 'PATCH',
      url: '/api/fields/defs/Title',
      payload: { label: '主旨' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().fieldDef.label).toBe('主旨');

    const missing = await call({
      method: 'PATCH',
      url: '/api/fields/defs/Missing',
      payload: { label: 'X' },
    });
    expect(missing.statusCode).toBe(404);
  });

  it('刪除欄位定義：查無回 404，成功回 204', async () => {
    await createSet('基本');
    await call({
      method: 'POST',
      url: '/api/fields/defs',
      payload: { name: 'Title', fieldSetName: '基本', kind: 'single', valueType: 'text', label: '標題' },
    });
    const res = await call({ method: 'DELETE', url: '/api/fields/defs/Title' });
    expect(res.statusCode).toBe(204);
    const gone = await call({ method: 'GET', url: '/api/fields/defs/Title' });
    expect(gone.statusCode).toBe(404);

    const missing = await call({ method: 'DELETE', url: '/api/fields/defs/Missing' });
    expect(missing.statusCode).toBe(404);
  });
});
