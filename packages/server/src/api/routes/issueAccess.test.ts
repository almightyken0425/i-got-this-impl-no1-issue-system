import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { authed, bootstrap, registerSession, testUrl } from './testHarness.js';

const suite = testUrl ? describe : describe.skip;
suite('工單操作的管理域權限', () => {
  let app: FastifyInstance;
  let pool: Pool;
  let owner: ReturnType<typeof authed>;
  let member: ReturnType<typeof authed>;
  let memberId: string;
  let issueId: string;
  let issueSetId: string;
  let issueTypeId: string;
  let mgmtId: string;
  beforeAll(async () => { ({ app, pool } = await bootstrap()); });
  afterAll(async () => { await app.close(); await pool.end(); });
  beforeEach(async () => {
    await pool.query('TRUNCATE companies CASCADE');
    owner = authed(app, (await registerSession(app)).cookie);
    const context = (await owner({ method: 'GET', url: '/api/workspace' })).json();
    issueSetId = context.issueSet.id;
    issueTypeId = context.issueType.id;
    mgmtId = (await owner({ method: 'GET', url: `/api/issue-sets/${issueSetId}` })).json().issueSet.mgmtId;
    issueId = (await owner({ method: 'POST', url: '/api/workspace/issues', payload: { title: '受保護工單' } })).json().issue.id;
    const session = await registerSession(app, 'reporter@example.com');
    member = authed(app, session.cookie);
    memberId = session.accountId;
  });
  async function grant(levelName: string) {
    const levels = (await owner({ method: 'GET', url: '/api/permissions/levels' })).json().levels;
    const level = levels.find((item: { name: string }) => item.name === levelName);
    const role = await owner({ method: 'POST', url: '/api/permissions/roles', payload: {
      roleTitle: levelName, levelId: level.id, scopes: [{ scopeKind: 'mgmt', scopeId: mgmtId }],
    } });
    expect(role.statusCode).toBe(201);
    expect((await owner({ method: 'POST', url: `/api/permissions/accounts/${memberId}/roles`, payload: { roleId: role.json().role.id } })).statusCode).toBe(201);
  }

  it('無權限者無法透過詳情、欄位、歷史、工作區或彙總入口取得內容', async () => {
    for (const url of [
      `/api/issues/${issueId}`, `/api/issues/${issueId}/fields`,
      `/api/issues/${issueId}/fields/title`, `/api/issues/${issueId}/changelog`,
      `/api/issue-sets/${issueSetId}/issues`, '/api/workspace/issues',
      `/api/views/rollup?issueId=${issueId}&fieldName=StartTime`,
      `/api/relations/edges/from/${issueId}`, `/api/relations/edges/to/${issueId}`,
    ]) {
      expect((await member({ method: 'GET', url })).statusCode, url).toBe(403);
    }
  });

  it('觀看者不能經任何欄位寫入、刪除、移動或建單入口繞過權限', async () => {
    await grant('觀看');
    expect((await member({ method: 'GET', url: `/api/issues/${issueId}` })).statusCode).toBe(200);
    for (const request of [
      { method: 'PATCH', url: `/api/workspace/issues/${issueId}`, payload: { title: '竄改' } },
      { method: 'PUT', url: `/api/issues/${issueId}/fields/title`, payload: { value: '竄改' } },
      { method: 'DELETE', url: `/api/issues/${issueId}/fields/title` },
      { method: 'DELETE', url: `/api/issues/${issueId}` },
      { method: 'POST', url: `/api/issues/${issueId}/move`, payload: { issueSetId } },
      { method: 'POST', url: `/api/issue-sets/${issueSetId}/issues`, payload: { issueTypeId } },
    ]) expect((await member(request)).statusCode, request.url).toBe(403);
  });

  it('回報者可修改自己建立的工單，不能偽造建單者或刪掉流程欄位', async () => {
    await grant('回報');
    const created = await member({ method: 'POST', url: '/api/workspace/issues', payload: { title: '自己建立' } });
    expect(created.statusCode).toBe(201);
    const ownId = created.json().issue.id as string;
    expect((await member({ method: 'PATCH', url: `/api/workspace/issues/${ownId}`, payload: { title: '允許修改' } })).statusCode).toBe(200);
    expect((await member({ method: 'PATCH', url: `/api/workspace/issues/${issueId}`, payload: { title: '不得修改' } })).statusCode).toBe(403);
    expect((await owner({ method: 'PUT', url: `/api/issues/${issueId}/fields/CreateBy`, payload: { value: memberId } })).statusCode).toBe(422);
    expect((await owner({ method: 'DELETE', url: `/api/issues/${issueId}/fields/status` })).statusCode).toBe(422);
  });

  it('一般成員不能修改公司定義或任意建立關聯', async () => {
    await grant('觀看');
    for (const request of [
      { method: 'POST', url: '/api/fields/sets', payload: { name: '越權欄位組' } },
      { method: 'POST', url: '/api/issue-types', payload: { name: 'unauthorized', label: '越權', fieldSets: ['基本'] } },
      { method: 'POST', url: '/api/relations/types', payload: { name: '越權關聯' } },
      { method: 'POST', url: '/api/relations/edges', payload: { fromIssueId: issueId, toIssueId: issueId, relationTypeId: issueTypeId } },
    ]) expect((await member(request)).statusCode, request.url).toBe(403);
  });

  it('跨管理域彙總不能透過父單欄位、歷史、清單或甘特外露不可讀來源', async () => {
    await grant('管理');
    const team = (await owner({ method: 'POST', url: '/api/teams', payload: { name: '秘密團隊' } })).json().team;
    const product = (await owner({ method: 'POST', url: '/api/products', payload: { teamId: team.id, name: '秘密產品' } })).json().product;
    const hidden = (await owner({ method: 'POST', url: `/api/products/${product.id}/mgmts`, payload: { name: '秘密開發', issueSet: { name: '私有待辦', key: 'SECRET' } } })).json();
    const child = (await owner({ method: 'POST', url: '/api/workspace/issues', payload: { issueSetId: hidden.issueSet.id, title: '機密標題', point: 9876 } })).json().issue;
    const type = (await owner({ method: 'POST', url: '/api/relations/types', payload: { name: 'Container', exclusive: true, acyclic: true, rollup: true } })).json().relationType;
    expect((await owner({ method: 'POST', url: '/api/relations/edges', payload: { fromIssueId: issueId, toIssueId: child.id, relationTypeId: type.id } })).statusCode).toBe(201);
    const view = (await member({ method: 'POST', url: '/api/views', payload: { name: '可讀', viewType: 'list', sourceMgmtIds: [mgmtId], displayLevel: 1 } })).json().view;
    for (const url of [`/api/issues/${issueId}/fields`, `/api/issues/${issueId}/changelog`,
      `/api/issues/${issueId}/context`, '/api/workspace/issues', `/api/views/${view.id}/workspace-issues`, `/api/views/${view.id}/issues`]) {
      const result = await member({ method: 'GET', url });
      expect(result.statusCode, url).toBe(200);
      expect(result.body, url).not.toContain('9876');
      expect(result.body, url).not.toContain('機密標題');
    }
    expect((await member({ method: 'GET', url: `/api/views/rollup?issueId=${issueId}&fieldName=point` })).statusCode).toBe(403);
    const relation = await member({ method: 'GET', url: `/api/relations/edges/from/${issueId}` });
    expect(relation.json().relations[0].counterpartKey).toBe('SECRET-1');
    expect((await owner({ method: 'GET', url: `/api/issues/${issueId}/fields/point` })).json().fieldValue.value).toBe(9876);
    expect((await member({ method: 'DELETE', url: `/api/relations/edges/${relation.json().relations[0].id}` })).statusCode).toBe(204);
    for (const url of [`/api/issues/${issueId}/fields`, `/api/issues/${issueId}/changelog`, '/api/workspace/issues']) {
      expect((await member({ method: 'GET', url })).body).not.toContain('9876');
    }
    expect((await owner({ method: 'POST', url: '/api/relations/edges', payload: { fromIssueId: issueId, toIssueId: child.id, relationTypeId: type.id } })).statusCode).toBe(201);
    expect((await owner({ method: 'DELETE', url: `/api/issues/${child.id}` })).statusCode).toBe(204);
    expect((await member({ method: 'GET', url: `/api/issues/${issueId}/fields` })).body).not.toContain('9876');
  });

  it('對稱關聯可由任一可編輯端移除，有向關聯仍由持有端管理', async () => {
    await grant('回報');
    const own = (await member({ method: 'POST', url: '/api/workspace/issues', payload: { title: '自己工單' } })).json().issue;
    for (const symmetric of [true, false]) {
      const type = (await owner({ method: 'POST', url: '/api/relations/types', payload: { name: symmetric ? 'RelatedTo' : 'Blocks', symmetric } })).json().relationType;
      const edge = (await owner({ method: 'POST', url: '/api/relations/edges', payload: { fromIssueId: issueId, toIssueId: own.id, relationTypeId: type.id } })).json().relation;
      expect((await member({ method: 'DELETE', url: `/api/relations/edges/${edge.id}` })).statusCode).toBe(symmetric ? 204 : 403);
    }
  });
});
