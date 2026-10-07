import { randomUUID } from 'node:crypto';

import type { FastifyInstance, FastifyPluginAsync, preHandlerHookHandler } from 'fastify';
import type { Pool } from 'pg';

import { currentIdentity } from '../../auth/middleware.js';
import { withTransaction } from '../../db/client.js';
import {
  calendarRepo,
  containerRepo,
  fieldRepo,
  issueRepo,
  permissionRepo,
  relationRepo,
  viewRepo,
} from '../../db/repositories/index.js';
import type { RolePermissionBundle, View } from '../../db/repositories/index.js';
import {
  admitNewContainerIssue,
  applyViewFilter,
  assignSortPosition,
  buildKanbanColumns,
  computeIssueDuration,
  computeIssueLevel,
  computeRollupValue,
  expandDataSource,
  RelationError,
  resolveViewCalendar,
  RollupError,
  SortPositionError,
} from '../../domain/index.js';
import type {
  FilterConfig,
  Issue,
  IssueDuration,
  IssueFilterCandidate,
  IssueTypeWorkflow,
  IsoDate,
  RelationCandidate,
} from '../../domain/index.js';
import { buildGanttTimeline, toGanttBarSpan } from '../devOrderGantt.js';
import type { GanttBarSpan } from '../devOrderGantt.js';
import { sendError } from '../errors.js';
import { buildContainerIndex, filterMgmtsByPermission } from '../../permission/index.js';
import { requireIssueAccess } from '../issueAccess.js';
import { readSnapshot } from '../../db/repositories/rollupRepo.js';
import { createIssueReadProjection, type IssueReadProjection } from '../issueReadProjection.js';
import type { ContainerIndex } from '../../permission/index.js';
import { foldWorkspaceIssueFields } from '../workspaceIssueRow.js';
import type { WorkspaceIssueRow } from '../workspaceIssueRow.js';

// 檢視路由：/api/views 之下的檢視 CRUD、看板欄序、彙總值計算、檢視內容組裝。
//
// 本層只做協定轉換：schema 驗輸入、帶租戶鍵呼叫 repository、把 domain 純函式的結果轉 HTTP。
// domain 用法：
// - 看板欄序用 buildKanbanColumns，輸入由本 Company 的工單型別與流程狀態組成
// - 彙總值用 computeRollupValue，快照自目標工單沿關聯下探的子樹組成（只用既有 repository 查詢）
//   RollupError（欄位未定義 / 不可彙總 / 關聯成環）一律轉 422
// - 檢視內容（/:id/issues、/:id/workspace-issues）先用 filterMgmtsByPermission（permission
//   層，見 loadOperatorPermissionContext）把 sourceMgmtIds 分成可讀／不可讀，只有可讀集合
//   進 applyViewFilter → admitNewContainerIssue → resolveViewCalendar → computeIssueDuration
//   這條既有管線；不可讀集合只計筆數（permissionExcludedCount），不查欄位值、不進回應內容，
//   對應 spec PermissionLogic 的 filterViewByPermission。/:id/issues 額外把三個顯示層級
//   （主題/需求/工項）一次算好回傳，用 computeIssueLevel 對候選集合分組（不透過
//   switchDisplayLevel 的單層 filter，候選集合只查一次、不必為了三層重複查關聯資料），
//   甘特圖時間軸與座標換算見 devOrderGantt.ts。computeIssueLevel 成環（RelationError
//   RELATION_CYCLE）一律轉 422，比照 RollupError

export interface ViewRoutesOptions {
  readonly pool: Pool;
  readonly requireAuth: preHandlerHookHandler;
}

// ---- 輸入 schema ----

// 資料來源二擇一：直接給展開好的 sourceMgmtIds，或給組織範圍（scopeType + scopeId）
// 讓伺服器端展開。兩者皆非必填，由 handler 判斷至少擇一，否則 400。
const createViewBodySchema = {
  type: 'object',
  required: ['name', 'viewType', 'displayLevel'],
  additionalProperties: false,
  properties: {
    name: { type: 'string', minLength: 1, maxLength: 200 },
    viewType: { type: 'string', minLength: 1, maxLength: 50 },
    sourceMgmtIds: { type: 'array', items: { type: 'string', minLength: 1 } },
    scopeType: { type: 'string', enum: ['team', 'product', 'mgmt'] },
    scopeId: { type: 'string', minLength: 1 },
    displayLevel: { type: 'integer', minimum: 1 },
    filterConfig: {},
    columnConfig: {},
    calendarName: { type: 'string', nullable: true },
  },
} as const;

const updateViewBodySchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    columnConfig: {},
    filterConfig: {},
    calendarName: { type: 'string', nullable: true },
    displayLevel: { type: 'integer', minimum: 1 },
  },
} as const;

const listViewQuerySchema = {
  type: 'object',
  additionalProperties: false,
  properties: { scope: { type: 'string', enum: ['mine', 'company'] } },
} as const;

const rollupQuerySchema = {
  type: 'object',
  required: ['issueId', 'fieldName'],
  additionalProperties: false,
  properties: {
    issueId: { type: 'string', minLength: 1 },
    fieldName: { type: 'string', minLength: 1 },
  },
} as const;

const idParamsSchema = {
  type: 'object',
  required: ['id'],
  properties: { id: { type: 'string', minLength: 1 } },
} as const;

const sortParamsSchema = {
  type: 'object',
  required: ['id', 'issueId'],
  properties: {
    id: { type: 'string', minLength: 1 },
    issueId: { type: 'string', minLength: 1 },
  },
} as const;

const sortBodySchema = {
  type: 'object',
  required: ['targetIndex'],
  additionalProperties: false,
  properties: { targetIndex: { type: 'integer', minimum: 0 } },
} as const;

interface CreateViewBody {
  readonly name: string;
  readonly viewType: string;
  readonly sourceMgmtIds?: readonly string[];
  readonly scopeType?: 'team' | 'product' | 'mgmt';
  readonly scopeId?: string;
  readonly displayLevel: number;
  readonly filterConfig?: unknown;
  readonly columnConfig?: unknown;
  readonly calendarName?: string | null;
}

/**
 * 依組織範圍種類，走訪容器樹收集候選 Mgmt id（去重前的原始清單）。
 * Team 範圍需對每個 Product 各查一次 Mgmt，逐一 await（比照本檔其餘接力查詢的既有風格）。
 * 範圍節點查無或跨租戶時回 undefined——containerRepo 的查詢一律帶 companyId，
 * 跨租戶天然查無，呼叫端把 undefined 轉 422，不會誤把它處理成「範圍為空」。
 */
async function collectScopeMgmtIds(
  pool: Pool,
  companyId: string,
  scopeType: 'team' | 'product' | 'mgmt',
  scopeId: string,
): Promise<readonly string[] | undefined> {
  if (scopeType === 'mgmt') {
    const mgmt = await containerRepo.getMgmt(companyId, scopeId, pool);
    return mgmt === undefined ? undefined : [mgmt.id];
  }
  if (scopeType === 'product') {
    const product = await containerRepo.getProduct(companyId, scopeId, pool);
    if (product === undefined) return undefined;
    const mgmts = await containerRepo.listMgmtsByProduct(companyId, product.id, pool);
    return mgmts.map((m) => m.id);
  }
  const team = await containerRepo.getTeam(companyId, scopeId, pool);
  if (team === undefined) return undefined;
  const products = await containerRepo.listProductsByTeam(companyId, team.id, pool);
  const mgmtIds: string[] = [];
  for (const product of products) {
    const mgmts = await containerRepo.listMgmtsByProduct(companyId, product.id, pool);
    mgmtIds.push(...mgmts.map((m) => m.id));
  }
  return mgmtIds;
}

const SCOPE_NOT_FOUND_CODE = {
  team: 'TEAM_NOT_FOUND',
  product: 'PRODUCT_NOT_FOUND',
  mgmt: 'MGMT_NOT_FOUND',
} as const;

interface UpdateViewBody {
  readonly columnConfig?: unknown;
  readonly filterConfig?: unknown;
  readonly calendarName?: string | null;
  readonly displayLevel?: number;
}

/** 組本 Company 的工單型別與流程狀態清單，供 buildKanbanColumns。 */
async function loadIssueTypeWorkflows(pool: Pool, companyId: string): Promise<IssueTypeWorkflow[]> {
  const issueTypes = await issueRepo.listIssueTypes(companyId, pool);
  const workflows: IssueTypeWorkflow[] = [];
  for (const issueType of issueTypes) {
    const states = await issueRepo.listWorkflowStates(companyId, issueType.id, pool);
    workflows.push({
      issueTypeId: issueType.id,
      states: states.map((s) => ({ name: s.name, sortOrder: s.sortOrder })),
    });
  }
  return workflows;
}

// ---- 檢視內容組裝（/:id/issues） ----

/** 標題欄位名稱，對齊 workspace.ts 目前的種子欄位命名（小寫 title，非 spec 標準大寫名）。 */
const FIELD_TITLE = 'title';
/**
 * spec 標準欄位名稱，workspace.ts 的種子已種好這兩個欄位（帶 rollupable，
 * earliest／latest 彙總）。工單若未實際填值，computeIssueDuration 仍回
 * hasDuration: false，這是欄位空值的正常結果，不是限制。
 */
const FIELD_START_TIME = 'StartTime';
const FIELD_END_TIME = 'EndTime';

/** 甘特圖時間軸長度：8 週（design 定案的視覺長度），從今天起算。 */
const DEV_ORDER_TIMELINE_DAY_COUNT = 56;

/** 顯示層級數字：epic↔1, story↔2, task↔3，對應 computeIssueLevel「根為第一層」。 */
const DEV_ORDER_LEVEL_NUMBERS = [1, 2, 3] as const;

function asString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function asIsoDateOrNull(value: unknown): IsoDate | null {
  return typeof value === 'string' ? value : null;
}

/**
 * 展開檢視的 sourceMgmtIds 成主題單全集：逐一取該 Mgmt 的主題單位置工單集
 * （`Mgmts.containerIssueSetId`），收集其下工單。查無的 Mgmt id 略過不擲錯——
 * 資料來源設定當下有效、事後 Mgmt 被刪不影響既有檢視繼續運作。
 */
async function collectContainerIssues(
  pool: Pool,
  companyId: string,
  mgmtIds: readonly string[],
): Promise<Issue[]> {
  const issues: Issue[] = [];
  for (const mgmtId of mgmtIds) {
    const mgmt = await containerRepo.getMgmt(companyId, mgmtId, pool);
    if (mgmt === undefined) continue;
    const found = await issueRepo.listIssuesByIssueSet(companyId, mgmt.containerIssueSetId, pool);
    issues.push(...found);
  }
  return issues;
}

async function collectMgmtIssues(pool: Pool, companyId: string, mgmtIds: readonly string[]): Promise<Issue[]> {
  const issues: Issue[] = [];
  for (const mgmtId of new Set(mgmtIds)) {
    const issueSets = await containerRepo.listIssueSetsByMgmt(companyId, mgmtId, pool);
    for (const issueSet of issueSets) {
      issues.push(...await issueRepo.listIssuesByIssueSet(companyId, issueSet.id, pool));
    }
  }
  return issues;
}

/**
 * 查一帳號的權限判定素材：全部 Role bundle ＋ 容器歸屬索引，供 filterMgmtsByPermission
 * 判定讀取權。比照 permissions.ts 的 operatorBundles／loadContainerIndex，但那兩個是該檔
 * 未匯出的區域函式，跨檔案不能直接重用；這裡複製同一套邏輯——量體小（兩三行 repo 呼叫
 * 組裝），不為此開共用模組，等出現第三個呼叫端才是抽共用的時機。
 */
async function loadOperatorPermissionContext(
  pool: Pool,
  companyId: string,
  accountId: string,
): Promise<{ bundles: RolePermissionBundle[]; index: ContainerIndex }> {
  const bundles = await permissionRepo.getEffectivePermissionInputs(pool, companyId, accountId);
  const tree = await containerRepo.getContainerTree(companyId, pool);
  const index = buildContainerIndex(tree ?? { id: companyId, name: '', teams: [] });
  return { bundles, index };
}

/** 逐張工單查欄位單值，組成 applyViewFilter 的候選投影。 */
async function buildFilterCandidates(
  pool: Pool,
  companyId: string,
  issues: readonly Issue[],
  projection: IssueReadProjection,
): Promise<IssueFilterCandidate[]> {
  const candidates: IssueFilterCandidate[] = [];
  for (const issue of issues) {
    const values = await issueRepo.listFieldValues(companyId, issue.id, pool);
    const fields: Record<string, unknown> = {};
    for (const value of values) {
      fields[value.fieldName] = value.value;
    }
    candidates.push({ issueId: issue.id, fields: projection.fields(issue.id, fields) });
  }
  return candidates;
}

/**
 * 收集 switchDisplayLevel 的候選集：先取目標主題單沿 Container 關聯查得的工單
 * （起點），再沿 Children 關聯 BFS 收集這些起點各自可達的全部子孫。
 * relations 含 Container 起點邊與全部 Children 邊，直接餵給 switchDisplayLevel——
 * computeIssueLevel 內部只認 childrenRelationTypeId 的邊，Container 邊不影響層級計算。
 */
async function collectDisplayLevelCandidates(
  pool: Pool,
  companyId: string,
  topicIssueId: string,
  containerTypeId: string,
  // undefined 代表此 Company 尚未建立 Children 型別：只收 Container 直接候選
  // （皆為第 1 層），不往下 BFS——沒有母子型別就沒有第 2、3 層可言。
  childrenTypeId: string | undefined,
): Promise<{ candidateIssueIds: string[]; relations: RelationCandidate[] }> {
  const relations: RelationCandidate[] = [];
  const candidateIds = new Set<string>();
  const enqueued = new Set<string>();
  const queue: string[] = [];

  const containerEdges = await relationRepo.findRelationsFromIssue(
    companyId,
    topicIssueId,
    containerTypeId,
    pool,
  );
  for (const edge of containerEdges) {
    relations.push({
      fromIssueId: edge.fromIssueId,
      toIssueId: edge.toIssueId,
      relationTypeId: edge.relationTypeId,
    });
    candidateIds.add(edge.toIssueId);
    if (!enqueued.has(edge.toIssueId)) {
      enqueued.add(edge.toIssueId);
      queue.push(edge.toIssueId);
    }
  }

  while (childrenTypeId !== undefined && queue.length > 0) {
    const current = queue.shift();
    if (current === undefined) break;
    const childEdges = await relationRepo.findRelationsFromIssue(companyId, current, childrenTypeId, pool);
    for (const edge of childEdges) {
      relations.push({
        fromIssueId: edge.fromIssueId,
        toIssueId: edge.toIssueId,
        relationTypeId: edge.relationTypeId,
      });
      candidateIds.add(edge.toIssueId);
      if (!enqueued.has(edge.toIssueId)) {
        enqueued.add(edge.toIssueId);
        queue.push(edge.toIssueId);
      }
    }
  }

  return { candidateIssueIds: [...candidateIds], relations };
}

/**
 * 把 Views.filterConfig（DB 存的未驗證 JSON）窄化成 FilterConfig。
 * fail-open：整體格式不符當無篩選條件；單一 condition 格式不符時跳過該條、
 * 其餘照常套用，不因一條寫壞就讓整張檢視的篩選失效。
 */
function parseFilterConfig(raw: unknown): FilterConfig | null {
  if (raw === null || typeof raw !== 'object') return null;
  const conditions = (raw as { conditions?: unknown }).conditions;
  if (!Array.isArray(conditions)) return null;

  const parsed = conditions.flatMap((item: unknown) => {
    if (
      typeof item === 'object' &&
      item !== null &&
      typeof (item as { fieldName?: unknown }).fieldName === 'string' &&
      (item as { operator?: unknown }).operator === 'equals' &&
      'value' in item
    ) {
      const condition = item as { fieldName: string; operator: 'equals'; value: unknown };
      return [{ fieldName: condition.fieldName, operator: 'equals' as const, value: condition.value }];
    }
    return [];
  });

  return { conditions: parsed };
}

export const viewRoutes: FastifyPluginAsync<ViewRoutesOptions> = async (
  app: FastifyInstance,
  opts,
) => {
  const { pool, requireAuth } = opts;

  app.addHook('preHandler', requireAuth);

  // ---- 檢視 CRUD ----

  // 建立檢視；擁有者為當前帳號。
  // 資料來源二擇一、互斥：scopeType+scopeId 由伺服器端展開（expandDataSource）；
  // 或直接帶已展開好的 sourceMgmtIds。以下皆回 400，不靜默猜測呼叫端意圖：
  // - 都沒帶（MISSING_DATA_SOURCE）
  // - scopeType／scopeId 只給一個（INCOMPLETE_SCOPE）
  // - 完整 scope 與 sourceMgmtIds 同時帶（AMBIGUOUS_DATA_SOURCE）
  app.post<{ Body: CreateViewBody }>(
    '/',
    { schema: { body: createViewBodySchema } },
    async (request, reply) => {
      const { companyId, accountId } = currentIdentity(request);
      const body = request.body;

      let sourceMgmtIds: readonly string[];
      if ((body.scopeType === undefined) !== (body.scopeId === undefined)) {
        return sendError(
          reply,
          400,
          'INCOMPLETE_SCOPE',
          'scopeType 與 scopeId 須同時提供',
        );
      } else if (body.scopeType !== undefined && body.scopeId !== undefined) {
        if (body.sourceMgmtIds !== undefined) {
          return sendError(
            reply,
            400,
            'AMBIGUOUS_DATA_SOURCE',
            '資料來源請擇一：scopeType 與 scopeId，或 sourceMgmtIds，不可同時提供',
          );
        }
        const candidates = await collectScopeMgmtIds(pool, companyId, body.scopeType, body.scopeId);
        if (candidates === undefined) {
          return sendError(
            reply,
            422,
            SCOPE_NOT_FOUND_CODE[body.scopeType],
            '指定的組織範圍不存在',
          );
        }
        sourceMgmtIds = expandDataSource({ mgmtIds: candidates });
      } else if (body.sourceMgmtIds !== undefined) {
        sourceMgmtIds = expandDataSource({ mgmtIds: body.sourceMgmtIds });
      } else {
        return sendError(
          reply,
          400,
          'MISSING_DATA_SOURCE',
          '須帶 sourceMgmtIds 或 scopeType 與 scopeId 之一',
        );
      }

      const view: View = {
        id: randomUUID(),
        companyId,
        name: body.name,
        ownerId: accountId,
        viewType: body.viewType,
        sourceMgmtIds: [...sourceMgmtIds],
        filterConfig: body.filterConfig ?? null,
        displayLevel: body.displayLevel,
        columnConfig: body.columnConfig ?? null,
        calendarName: body.calendarName ?? null,
      };
      await viewRepo.insertView(pool, view);
      return reply.status(201).send({ view });
    },
  );

  // 列出檢視；scope=mine 取自己擁有的（預設），scope=company 取全 Company。
  app.get<{ Querystring: { scope?: 'mine' | 'company' } }>(
    '/',
    { schema: { querystring: listViewQuerySchema } },
    async (request, reply) => {
      const { companyId, accountId } = currentIdentity(request);
      const views =
        request.query.scope === 'company'
          ? await viewRepo.listViewsByCompany(pool, companyId)
          : await viewRepo.listViewsByOwner(pool, companyId, accountId);
      return reply.status(200).send({ views });
    },
  );

  // 取單一檢視；查無回 404。
  app.get<{ Params: { id: string } }>(
    '/:id',
    { schema: { params: idParamsSchema } },
    async (request, reply) => {
      const { companyId } = currentIdentity(request);
      const view = await viewRepo.getView(pool, companyId, request.params.id);
      if (view === undefined) {
        return sendError(reply, 404, 'VIEW_NOT_FOUND', '檢視不存在');
      }
      return reply.status(200).send({ view });
    },
  );

  // 更新檢視的欄位顯示設定與/或篩選條件；未帶的欄不動。查無回 404。
  app.patch<{ Params: { id: string }; Body: UpdateViewBody }>(
    '/:id',
    { schema: { params: idParamsSchema, body: updateViewBodySchema } },
    async (request, reply) => {
      const { companyId } = currentIdentity(request);
      const id = request.params.id;
      const existing = await viewRepo.getView(pool, companyId, id);
      if (existing === undefined) {
        return sendError(reply, 404, 'VIEW_NOT_FOUND', '檢視不存在');
      }
      if (request.body.columnConfig !== undefined) {
        await viewRepo.updateViewColumnConfig(pool, companyId, id, request.body.columnConfig);
      }
      if (request.body.filterConfig !== undefined) {
        await viewRepo.updateViewFilterConfig(pool, companyId, id, request.body.filterConfig);
      }
      if (request.body.calendarName !== undefined) {
        await viewRepo.updateViewCalendarName(pool, companyId, id, request.body.calendarName);
      }
      if (request.body.displayLevel !== undefined) {
        await viewRepo.updateViewDisplayLevel(pool, companyId, id, request.body.displayLevel);
      }
      const updated = await viewRepo.getView(pool, companyId, id);
      return reply.status(200).send({ view: updated });
    },
  );

  // 刪除檢視，連同其排序項；命中回 204，查無回 404。
  app.delete<{ Params: { id: string } }>(
    '/:id',
    { schema: { params: idParamsSchema } },
    async (request, reply) => {
      const { companyId } = currentIdentity(request);
      const deleted = await withTransaction(
        (tx) => viewRepo.deleteView(tx, companyId, request.params.id),
        pool,
      );
      if (!deleted) {
        return sendError(reply, 404, 'VIEW_NOT_FOUND', '檢視不存在');
      }
      return reply.status(204).send();
    },
  );

  // ---- 手動排序 ----

  // 一張檢視的已排序項，依排序值升冪；無列的工單屬該檢視的未排序區。查無檢視回 404。
  app.get<{ Params: { id: string } }>(
    '/:id/sort',
    { schema: { params: idParamsSchema } },
    async (request, reply) => {
      const { companyId } = currentIdentity(request);
      const view = await viewRepo.getView(pool, companyId, request.params.id);
      if (view === undefined) {
        return sendError(reply, 404, 'VIEW_NOT_FOUND', '檢視不存在');
      }
      const entries = await viewRepo.listSortEntries(pool, companyId, request.params.id);
      return reply.status(200).send({ entries });
    },
  );

  // 指派工單於檢視的排序位置，對應 spec ViewLogic / assignSortPosition。
  //
  // targetIndex 是「把目標自己移出後」的插入位置，移入未排序區與既有重排走同一條路徑。
  // 讀現有排序、算值、寫入同在一個交易內，避免兩人同時拖曳時互相覆蓋。
  // 回傳更新後的完整排序清單，前端不必再打一次 GET。
  app.put<{ Params: { id: string; issueId: string }; Body: { targetIndex: number } }>(
    '/:id/sort/:issueId',
    { schema: { params: sortParamsSchema, body: sortBodySchema } },
    async (request, reply) => {
      const { companyId } = currentIdentity(request);
      const { id, issueId } = request.params;

      const view = await viewRepo.getView(pool, companyId, id);
      if (view === undefined) {
        return sendError(reply, 404, 'VIEW_NOT_FOUND', '檢視不存在');
      }
      const issue = await issueRepo.getIssue(companyId, issueId, pool);
      if (issue === undefined) {
        return sendError(reply, 404, 'ISSUE_NOT_FOUND', '工單不存在');
      }

      try {
        const entries = await withTransaction(async (tx) => {
          const current = await viewRepo.listSortEntries(tx, companyId, id);
          const sortValue = assignSortPosition(current, issueId, request.body.targetIndex);
          await viewRepo.upsertSortEntry(tx, {
            id: randomUUID(),
            companyId,
            viewId: id,
            issueId,
            sortValue,
          });
          return viewRepo.listSortEntries(tx, companyId, id);
        }, pool);
        return reply.status(200).send({ entries });
      } catch (error: unknown) {
        if (error instanceof SortPositionError) {
          // 位置越界屬請求本身不合法；精度耗盡是該檢視的狀態需重鋪，非本次請求的錯。
          const status = error.code === 'SORT_INDEX_OUT_OF_RANGE' ? 400 : 409;
          return sendError(reply, status, error.code, error.message);
        }
        throw error;
      }
    },
  );

  // ---- 檢視內容 ----

  /** 檢視內容的一列：id 供互動、key／title／duration 供呈現。 */
  interface ViewIssueRow {
    readonly id: string;
    readonly key: string;
    readonly title: string;
    readonly duration: IssueDuration;
  }

  /** 單一顯示層級的甘特長條集合；bars 為 null 代表該主題單在此層級無內容。 */
  interface DevOrderLevelGroup {
    readonly level: number;
    readonly bars: readonly GanttBarSpan[] | null;
  }

  /** 主題單清單的一列，額外帶三個顯示層級（主題/需求/工項）一次算好的甘特座標。 */
  interface TopicIssueRow extends ViewIssueRow {
    readonly levels: readonly DevOrderLevelGroup[];
  }

  // 檢視資料來源展開、套用篩選、已排序/未排序分區、日曆與工期計算、顯示層級內容。查無檢視回 404。
  // 資料來源先依讀取者的 Mgmt 讀取權分流（filterMgmtsByPermission）：可讀集合才進欄位值
  // 查詢與後續管線，不可讀集合只計筆數（permissionExcludedCount）、不查欄位值、不進回應。
  // Container／Children 關聯型別若此 Company 尚未建立（無種子植入邏輯，需手動建立），
  // 一律視為無層級內容，不把 undefined 傳進關聯查詢——那樣語意會從「查特定型別」
  // 錯變成「查全部型別」，混入不相干工單。
  app.get<{ Params: { id: string } }>(
    '/:id/issues',
    { schema: { params: idParamsSchema } },
    async (request, reply) => {
      const { companyId, accountId } = currentIdentity(request);
      const view = await viewRepo.getView(pool, companyId, request.params.id);
      if (view === undefined) {
        return sendError(reply, 404, 'VIEW_NOT_FOUND', '檢視不存在');
      }

      const { bundles, index } = await loadOperatorPermissionContext(pool, companyId, accountId);
      const { readableMgmtIds, deniedMgmtIds } = filterMgmtsByPermission(
        view.sourceMgmtIds,
        bundles,
        index,
      );

      const containerIssues = await collectContainerIssues(pool, companyId, readableMgmtIds);
      const permissionExcludedCount = (
        await collectContainerIssues(pool, companyId, deniedMgmtIds)
      ).length;
      const projection = await createIssueReadProjection(pool, currentIdentity(request));
      const candidates = await buildFilterCandidates(pool, companyId, containerIssues, projection);
      const { included, excludedIds } = applyViewFilter(candidates, parseFilterConfig(view.filterConfig));

      const sortEntries = await viewRepo.listSortEntries(pool, companyId, view.id);
      const { sortedIds, unsortedIds } = admitNewContainerIssue(
        included.map((candidate) => candidate.issueId),
        sortEntries,
      );

      const account = await permissionRepo.getAccount(pool, companyId, accountId);
      const calendarName = resolveViewCalendar(view, {
        defaultCalendarName: account?.defaultCalendarName ?? null,
      });
      const calendar =
        calendarName === null
          ? null
          : ((await calendarRepo.getCalendar(pool, companyId, calendarName)) ?? null);

      // route 層算好「今天」再傳給純函式；domain／api 純函式不碰時鐘。
      const today: IsoDate = new Date().toISOString().slice(0, 10);
      const days = buildGanttTimeline(today, DEV_ORDER_TIMELINE_DAY_COUNT, calendar);

      const candidateById = new Map(included.map((candidate) => [candidate.issueId, candidate]));
      const issueById = new Map(containerIssues.map((issue) => [issue.id, issue]));

      const toRow = (issueId: string): ViewIssueRow => {
        const fields = candidateById.get(issueId)?.fields ?? {};
        return {
          id: issueId,
          key: issueById.get(issueId)?.issueKey ?? '',
          title: asString(fields[FIELD_TITLE]),
          duration: computeIssueDuration(
            asIsoDateOrNull(fields[FIELD_START_TIME]),
            asIsoDateOrNull(fields[FIELD_END_TIME]),
            calendar,
          ),
        };
      };

      const containerType = await relationRepo.findRelationTypeByName(companyId, 'Container', pool);
      const childrenType = await relationRepo.findRelationTypeByName(companyId, 'Children', pool);

      // 三層一次算好：候選集合只查一次，對每個候選呼叫 computeIssueLevel 取得層級數字
      // 直接分組，不透過 switchDisplayLevel 的單層 filter（那樣三層要重複查三次）。
      // 候選工單（沿 Container/Children 關聯查到的）不在 candidateById 範圍內
      // （它們屬於不同的工單集，不是主題單位置本身），需要各自查欄位值。
      //
      // 關聯下級仍依讀取者權限投影，未授權來源不產生長條。
      const levelBarsOf = async (topicIssueId: string): Promise<DevOrderLevelGroup[]> => {
        // Container 型別不存在時，連第 1 層的候選都無從查起，三層皆為 null。
        // Children 型別不存在但 Container 存在時，仍可查到第 1 層候選——只是沒有
        // 母子關聯往下展開，不因此連第 1 層一起交白卷。
        if (containerType === undefined) {
          return DEV_ORDER_LEVEL_NUMBERS.map((level) => ({ level, bars: null }));
        }
        const { candidateIssueIds, relations } = await collectDisplayLevelCandidates(
          pool,
          companyId,
          topicIssueId,
          containerType.id,
          childrenType?.id,
        );

        const issueIdsByLevel = new Map<number, string[]>();
        for (const issueId of candidateIssueIds) {
          // 沒有 Children 型別就沒有母子鏈，Container 直接候選必為第 1 層。
          const level =
            childrenType === undefined
              ? 1
              : computeIssueLevel({
                  issueId,
                  relations,
                  childrenRelationTypeId: childrenType.id,
                });
          const group = issueIdsByLevel.get(level);
          if (group === undefined) issueIdsByLevel.set(level, [issueId]);
          else group.push(issueId);
        }

        const groups: DevOrderLevelGroup[] = [];
        for (const level of DEV_ORDER_LEVEL_NUMBERS) {
          const issueIds = issueIdsByLevel.get(level);
          if (issueIds === undefined) {
            groups.push({ level, bars: null });
            continue;
          }
          const bars: GanttBarSpan[] = [];
          for (const issueId of issueIds) {
            if (!projection.canRead(issueId) || projection.restricted.has(issueId)) continue;
            const values = await issueRepo.listFieldValues(companyId, issueId, pool);
            const fields: Record<string, unknown> = {};
            for (const value of values) fields[value.fieldName] = value.value;
            const span = toGanttBarSpan(
              asIsoDateOrNull(fields[FIELD_START_TIME]),
              asIsoDateOrNull(fields[FIELD_END_TIME]),
              today,
              DEV_ORDER_TIMELINE_DAY_COUNT,
            );
            if (span !== null) bars.push(span);
          }
          groups.push({ level, bars });
        }
        return groups;
      };

      const toTopicRows = async (issueIds: readonly string[]): Promise<TopicIssueRow[]> => {
        const rows: TopicIssueRow[] = [];
        for (const issueId of issueIds) {
          rows.push({ ...toRow(issueId), levels: await levelBarsOf(issueId) });
        }
        return rows;
      };

      try {
        const sortedIssues = await toTopicRows(sortedIds);
        const unsortedIssues = await toTopicRows(unsortedIds);
        return reply.status(200).send({
          sortedIssues,
          unsortedIssues,
          calendarName,
          excludedCount: excludedIds.length,
          permissionExcludedCount,
          days,
        });
      } catch (error: unknown) {
        if (error instanceof RelationError) {
          return sendError(reply, 422, error.code, error.message);
        }
        throw error;
      }
    },
  );

  // 檢視資料來源範圍內的完整欄位工單列，供 ListScreen／KanbanScreen 消費。
  // 跟 /:id/issues（主題單視角，窄欄位、供 DevOrderScreen）是不同形狀，各自服務。
  // 資料來源展開、套用篩選同一條鏈路，只是摺列换成完整欄位（title/status/
  // assignee/point/due/resolution）。資料來源分流同 /:id/issues：先依讀取者的 Mgmt
  // 讀取權過濾，見 loadOperatorPermissionContext／filterMgmtsByPermission。
  app.get<{ Params: { id: string } }>(
    '/:id/workspace-issues',
    { schema: { params: idParamsSchema } },
    async (request, reply) => {
      const { companyId, accountId } = currentIdentity(request);
      const view = await viewRepo.getView(pool, companyId, request.params.id);
      if (view === undefined) {
        return sendError(reply, 404, 'VIEW_NOT_FOUND', '檢視不存在');
      }

      const { bundles, index } = await loadOperatorPermissionContext(pool, companyId, accountId);
      const { readableMgmtIds, deniedMgmtIds } = filterMgmtsByPermission(
        view.sourceMgmtIds,
        bundles,
        index,
      );

      const containerIssues = await collectMgmtIssues(pool, companyId, readableMgmtIds);
      const permissionExcludedCount = (
        await collectMgmtIssues(pool, companyId, deniedMgmtIds)
      ).length;
      const projection = await createIssueReadProjection(pool, currentIdentity(request));
      const candidates = await buildFilterCandidates(pool, companyId, containerIssues, projection);
      const { included, excludedIds } = applyViewFilter(candidates, parseFilterConfig(view.filterConfig));

      const issueById = new Map(containerIssues.map((issue) => [issue.id, issue]));
      const issues: WorkspaceIssueRow[] = included.map((candidate) => ({
        id: candidate.issueId,
        key: issueById.get(candidate.issueId)?.issueKey ?? '',
        issueTypeId: issueById.get(candidate.issueId)!.issueTypeId,
        ...foldWorkspaceIssueFields(candidate.fields, projection.restrictedFields(candidate.issueId)),
      }));

      return reply
        .status(200)
        .send({ issues, excludedCount: excludedIds.length, permissionExcludedCount });
    },
  );

  // ---- 看板欄序 ----

  // 本 Company 的看板欄集合與欄序，由各工單型別的流程狀態保序併入。
  app.get('/kanban-columns', async (request, reply) => {
    const { companyId } = currentIdentity(request);
    const workflows = await loadIssueTypeWorkflows(pool, companyId);
    const columns = buildKanbanColumns(workflows);
    return reply.status(200).send({ columns });
  });

  // ---- 彙總 ----

  // 計算某工單某欄位的彙總值；快照自該工單下探子樹組成。
  app.get<{ Querystring: { issueId: string; fieldName: string } }>(
    '/rollup',
    { schema: { querystring: rollupQuerySchema } },
    async (request, reply) => {
      const { companyId } = currentIdentity(request);
      const { issueId, fieldName } = request.query;
      if (!(await requireIssueAccess(pool, currentIdentity(request), issueId, 'read', reply))) return;
      const projection = await createIssueReadProjection(pool, currentIdentity(request));
      if (projection.restricted.has(issueId)) return sendError(reply, 403, 'ROLLUP_SOURCE_FORBIDDEN', '彙總來源權限不足');
      const def = await fieldRepo.findFieldDef(companyId, fieldName, pool);
      if (!def) return sendError(reply, 422, 'FIELD_NOT_DEFINED', '欄位未定義');
      if (!def.rollupable) return sendError(reply, 422, 'FIELD_NOT_ROLLUPABLE', '欄位不可彙總');
      if (!projection.inRecipe(issueId, fieldName)) return sendError(reply, 422, 'FIELD_NOT_IN_RECIPE', '欄位不在此型別配方內');
      const snapshot = await readSnapshot(pool, companyId);
      try {
        const value = computeRollupValue(snapshot, issueId, fieldName);
        return reply.status(200).send({ value });
      } catch (error: unknown) {
        if (error instanceof RollupError) {
          return sendError(reply, 422, error.code, error.message);
        }
        throw error;
      }
    },
  );
};
