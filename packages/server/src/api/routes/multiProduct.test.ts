import { randomUUID } from 'node:crypto';

import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { authed, bootstrap, registerSession, testUrl } from './testHarness.js';

const suite = testUrl ? describe : describe.skip;

suite('多產品組織與建單', () => {
  let pool: Pool;
  let app: FastifyInstance;
  let call: ReturnType<typeof authed>;

  beforeAll(async () => { ({ pool, app } = await bootstrap()); });
  afterAll(async () => { await app.close(); await pool.end(); });
  beforeEach(async () => {
    await pool.query('TRUNCATE companies CASCADE');
    const session = await registerSession(app);
    call = authed(app, session.cookie);
    expect((await call({ method: 'GET', url: '/api/workspace' })).statusCode).toBe(200);
  });

  async function createProductTree() {
    const team = (await call({ method: 'POST', url: '/api/teams', payload: { name: '產品團隊' } })).json().team;
    const product = (await call({ method: 'POST', url: '/api/products', payload: { teamId: team.id, name: '第二產品' } })).json().product;
    const result = await call({ method: 'POST', url: `/api/products/${product.id}/mgmts`, payload: { name: '開發', issueSet: { name: '產品待辦', key: 'SECOND' } } });
    expect(result.statusCode).toBe(201);
    return { team, product, ...result.json() };
  }

  async function grant(accountId: string, levelName: string, scopeKind: string, scopeId: string, orgAdmin = false) {
    const levels = (await call({ method: 'GET', url: '/api/permissions/levels' })).json().levels;
    const level = levels.find((item: { name: string }) => item.name === levelName);
    const created = await call({ method: 'POST', url: '/api/permissions/roles', payload: {
      roleTitle: `${levelName}-${scopeId}`, levelId: level.id, orgAdmin,
      scopes: [{ scopeKind, scopeId }],
    } });
    expect(created.statusCode).toBe(201);
    const assigned = await call({ method: 'POST', url: `/api/permissions/accounts/${accountId}/roles`, payload: { roleId: created.json().role.id } });
    expect(assigned.statusCode).toBe(201);
  }

  it('指定第二產品與自訂型別建單後可從檢視讀回正確編號與起始狀態', async () => {
    const { mgmt, issueSet } = await createProductTree();
    const typeResponse = await call({ method: 'POST', url: '/api/issue-types', payload: { name: 'request', label: '需求', fieldSets: ['基本'] } });
    expect(typeResponse.statusCode).toBe(201);
    const issueTypeId = typeResponse.json().issueType.id;
    const workflow = await call({ method: 'PUT', url: `/api/issue-types/${issueTypeId}/workflow`, payload: {
      states: [{ name: '待釐清', isInitial: true, isTerminal: false }, { name: '結案', isInitial: false, isTerminal: true }],
      transitions: [{ fromState: '待釐清', toState: '結案', requiredRole: null, requiredFields: [] }],
      resolutionOptions: [{ value: '完成' }],
    } });
    expect(workflow.statusCode).toBe(200);
    const created = await call({ method: 'POST', url: '/api/workspace/issues', payload: { title: '第二產品需求', issueSetId: issueSet.id, issueTypeId } });
    expect(created.statusCode).toBe(201);
    expect(created.json().issue).toMatchObject({ key: 'SECOND-1', issueTypeId, title: '第二產品需求', status: '待釐清' });
    const stored = await call({ method: 'GET', url: `/api/issues/${created.json().issue.id}` });
    expect(stored.json().issue).toMatchObject({ issueSetId: issueSet.id, issueTypeId });
    const viewResult = await call({ method: 'POST', url: '/api/views', payload: { name: '第二產品', viewType: 'list', sourceMgmtIds: [mgmt.id], displayLevel: 1 } });
    expect(viewResult.statusCode).toBe(201);
    const view = viewResult.json().view;
    const rows = await call({ method: 'GET', url: `/api/views/${view.id}/workspace-issues` });
    expect(rows.statusCode).toBe(200);
    expect(rows.json().issues).toEqual(expect.arrayContaining([expect.objectContaining({ key: 'SECOND-1', issueTypeId, status: '待釐清' })]));
    const closed = await call({ method: 'PATCH', url: `/api/workspace/issues/${created.json().issue.id}`, payload: { status: '結案', resolution: '完成' } });
    expect(closed.statusCode).toBe(200);
    expect(closed.json().issue).toMatchObject({ issueTypeId, status: '結案', resolution: '完成' });
    const defaults = await call({ method: 'GET', url: '/api/workspace/issues' });
    expect(defaults.json().issues).toHaveLength(0);
  });

  it('未授權帳號不能對指定管理域建單', async () => {
    const { issueSet } = await createProductTree();
    const member = await registerSession(app, 'member@example.com');
    const denied = await authed(app, member.cookie)({ method: 'POST', url: '/api/workspace/issues', payload: { title: '不得建立', issueSetId: issueSet.id } });
    expect(denied.statusCode).toBe(403);
    expect(denied.json().error.code).toBe('FORBIDDEN');
    const rows = await call({ method: 'GET', url: `/api/issue-sets/${issueSet.id}/issues` });
    expect(rows.json().issues).toHaveLength(0);
  });

  it('未授權帳號不能建立或改名組織項目', async () => {
    const { team, product, mgmt, issueSet } = await createProductTree();
    const member = await registerSession(app, 'member@example.com');
    const memberCall = authed(app, member.cookie);
    const attempts = [
      { method: 'POST', url: '/api/teams', payload: { name: '不准新增' } },
      { method: 'PATCH', url: `/api/teams/${team.id}`, payload: { name: '不准改名' } },
      { method: 'POST', url: '/api/products', payload: { teamId: team.id, name: '不准新增' } },
      { method: 'PATCH', url: `/api/products/${product.id}`, payload: { name: '不准改名' } },
      { method: 'POST', url: `/api/products/${product.id}/mgmts`, payload: { name: '不准新增', issueSet: { name: '待辦', key: 'DENIED' } } },
      { method: 'PATCH', url: `/api/mgmts/${mgmt.id}`, payload: { name: '不准改名' } },
      { method: 'POST', url: `/api/mgmts/${mgmt.id}/issue-sets`, payload: { name: '不准新增', key: 'DENIED' } },
      { method: 'PATCH', url: `/api/issue-sets/${issueSet.id}`, payload: { name: '不准改名' } },
    ];
    for (const attempt of attempts) {
      const result = await memberCall(attempt);
      expect(result.statusCode, attempt.url).toBe(403);
    }
    expect((await call({ method: 'GET', url: `/api/products/${product.id}` })).json().product.name).toBe('第二產品');
  });

  it('新增工單集的工單也出現在清單與看板共用資料來源', async () => {
    const { mgmt } = await createProductTree();
    const issueSet = (await call({ method: 'POST', url: `/api/mgmts/${mgmt.id}/issue-sets`, payload: { name: '維護', key: 'MAINT' } })).json().issueSet;
    const created = await call({ method: 'POST', url: '/api/workspace/issues', payload: { title: '維護工作', issueSetId: issueSet.id } });
    expect(created.statusCode).toBe(201);
    const view = (await call({ method: 'POST', url: '/api/views', payload: { name: '產品全部', viewType: 'list', sourceMgmtIds: [mgmt.id], displayLevel: 1 } })).json().view;
    const rows = await call({ method: 'GET', url: `/api/views/${view.id}/workspace-issues` });
    expect(rows.json().issues).toEqual([expect.objectContaining({ key: 'MAINT-1', title: '維護工作' })]);
  });

  it('建單選項只提供當前檢視中具有讀取與建單權的工單集', async () => {
    const { mgmt, issueSet } = await createProductTree();
    const member = await registerSession(app, 'reporter@example.com');
    await grant(member.accountId, '回報', 'mgmt', mgmt.id);
    const memberCall = authed(app, member.cookie);
    const defaultContext = (await call({ method: 'GET', url: '/api/workspace' })).json();
    const defaultSet = (await call({ method: 'GET', url: `/api/issue-sets/${defaultContext.issueSet.id}` })).json().issueSet;
    const viewResult = await memberCall({ method: 'POST', url: '/api/views', payload: { name: '全部', viewType: 'list', sourceMgmtIds: [mgmt.id, defaultSet.mgmtId], displayLevel: 1 } });
    expect(viewResult.statusCode).toBe(201);
    const view = viewResult.json().view;
    const options = await memberCall({ method: 'GET', url: `/api/workspace/creation-options?viewId=${view.id}` });
    expect(options.statusCode).toBe(200);
    expect(options.json().issueSets).toEqual([expect.objectContaining({ id: issueSet.id, label: '產品團隊 / 第二產品 / 開發 / 產品待辦 · SECOND' })]);
    expect(options.json().issueTypes).toEqual(expect.arrayContaining([expect.objectContaining({ name: 'task' })]));
    const created = await memberCall({ method: 'POST', url: '/api/workspace/issues', payload: { title: '允許回報', issueSetId: issueSet.id } });
    expect(created.statusCode).toBe(201);
    const denied = await memberCall({ method: 'POST', url: '/api/workspace/issues', payload: { title: '範圍外', issueSetId: defaultContext.issueSet.id } });
    expect(denied.statusCode).toBe(403);
    const foreignView = await call({ method: 'GET', url: `/api/workspace/creation-options?viewId=${view.id}` });
    expect(foreignView.statusCode).toBe(404);
  });

  it('組織樹提供逐層管理能力並保留產品管理級的結構操作', async () => {
    const { team, product, mgmt } = await createProductTree();
    const member = await registerSession(app, 'manager@example.com');
    await grant(member.accountId, '管理', 'product', product.id);
    const memberCall = authed(app, member.cookie);
    const result = await memberCall({ method: 'GET', url: '/api/organization' });
    expect(result.statusCode).toBe(200);
    expect(result.json().orgAdmin).toBe(false);
    const treeProduct = result.json().teams.find((item: { id: string }) => item.id === team.id).products[0];
    expect(treeProduct).toMatchObject({ id: product.id, canStructure: true });
    expect(treeProduct.mgmts).toEqual([expect.objectContaining({ id: mgmt.id, canStructure: true })]);
    const created = await memberCall({ method: 'POST', url: `/api/products/${product.id}/mgmts`, payload: { name: '維護', issueSet: { name: '待辦', key: 'OPS' } } });
    expect(created.statusCode).toBe(201);
    const renamed = await memberCall({ method: 'PATCH', url: `/api/mgmts/${mgmt.id}`, payload: { name: '開發管理' } });
    expect(renamed.statusCode).toBe(200);
    const denied = await memberCall({ method: 'PATCH', url: `/api/products/${product.id}`, payload: { name: '越權' } });
    expect(denied.statusCode).toBe(403);
  });

  it('名稱去除首尾空白且拒絕空白名稱與重複 KEY 的半成品管理域', async () => {
    const { product, mgmt } = await createProductTree();
    const renamed = await call({ method: 'PATCH', url: `/api/products/${product.id}`, payload: { name: '  新產品名稱  ' } });
    expect(renamed.json().product.name).toBe('新產品名稱');
    const blank = await call({ method: 'POST', url: '/api/teams', payload: { name: '   ' } });
    expect(blank.statusCode).toBe(400);
    const duplicate = await call({ method: 'POST', url: `/api/products/${product.id}/mgmts`, payload: { name: '不能留下', issueSet: { name: '重複', key: 'SECOND' } } });
    expect(duplicate.statusCode).toBe(409);
    expect(duplicate.json().error.code).toBe('DUPLICATE_KEY');
    const current = await call({ method: 'GET', url: `/api/products/${product.id}/mgmts` });
    expect(current.json().mgmts).toEqual([expect.objectContaining({ id: mgmt.id, name: '開發' })]);
  });

  it('組織管理開關不能取代產品或管理域的結構授權', async () => {
    const { product, mgmt, issueSet } = await createProductTree();
    const member = await registerSession(app, 'org-manager@example.com');
    await grant(member.accountId, '觀看', 'product', product.id, true);
    const memberCall = authed(app, member.cookie);
    expect((await memberCall({ method: 'POST', url: '/api/teams', payload: { name: '允許團隊' } })).statusCode).toBe(201);
    expect((await memberCall({ method: 'POST', url: `/api/products/${product.id}/mgmts`, payload: { name: '不允許', issueSet: { name: '不允許', key: 'NO' } } })).statusCode).toBe(403);
    expect((await memberCall({ method: 'PATCH', url: `/api/mgmts/${mgmt.id}`, payload: { name: '不允許' } })).statusCode).toBe(403);
    expect((await memberCall({ method: 'PATCH', url: `/api/issue-sets/${issueSet.id}`, payload: { name: '不允許' } })).statusCode).toBe(403);
  });

  it('不存在與格式錯誤的建單選擇不回退至預設工單集', async () => {
    for (const choice of [{ issueSetId: randomUUID() }, { issueTypeId: randomUUID() }]) {
      const response = await call({ method: 'POST', url: '/api/workspace/issues', payload: { title: '無效選擇', ...choice } });
      expect(response.statusCode).toBe(422);
    }
    for (const choice of [{ issueSetId: 'invalid' }, { issueTypeId: '' }]) {
      expect((await call({ method: 'POST', url: '/api/workspace/issues', payload: { title: '格式錯誤', ...choice } })).statusCode).toBe(400);
    }
    const created = await call({ method: 'POST', url: '/api/workspace/issues', payload: { title: '仍由首號建立' } });
    expect(created.json().issue.key).toBe('IGT-1');
  });

  it('跨租戶工單集與型別不能用於建單或組織改名', async () => {
    const companyId = randomUUID();
    const accountId = randomUUID();
    const sessionId = randomUUID();
    const now = Date.now();
    await pool.query('INSERT INTO companies (id, name) VALUES ($1,$2)', [companyId, '隔離公司']);
    await pool.query('INSERT INTO accounts (id, company_id, name, email, password_hash, created_on, updated_on) VALUES ($1,$2,$3,$4,$5,$6,$6)', [accountId, companyId, '隔離帳號', 'isolated@example.com', 'fixture', now]);
    await pool.query('INSERT INTO sessions (id, company_id, account_id, created_on, expires_on) VALUES ($1,$2,$3,$4,$5)', [sessionId, companyId, accountId, now, now + 3600000]);
    const otherCall = authed(app, `igotthis_sid=${app.signCookie(sessionId)}`);
    const foreign = (await otherCall({ method: 'GET', url: '/api/workspace' })).json();
    for (const choice of [{ issueSetId: foreign.issueSet.id }, { issueTypeId: foreign.issueType.id }]) {
      expect((await call({ method: 'POST', url: '/api/workspace/issues', payload: { title: '不得跨租戶', ...choice } })).statusCode).toBe(422);
    }
    expect((await call({ method: 'PATCH', url: `/api/issue-sets/${foreign.issueSet.id}`, payload: { name: '不得跨租戶' } })).statusCode).toBe(404);
    expect((await otherCall({ method: 'GET', url: '/api/workspace/issues' })).json().issues).toHaveLength(0);
    expect((await call({ method: 'GET', url: '/api/workspace/issues' })).json().issues).toHaveLength(0);
  });
});
