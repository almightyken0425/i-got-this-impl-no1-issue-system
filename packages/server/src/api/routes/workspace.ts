import { randomUUID } from 'node:crypto';

import type { FastifyInstance, FastifyPluginAsync, preHandlerHookHandler } from 'fastify';
import type { Pool } from 'pg';

import { currentIdentity } from '../../auth/middleware.js';
import { writeField } from '../../db/repositories/rollupRepo.js';
import { createIssueReadProjection, type IssueReadProjection } from '../issueReadProjection.js';
import { withTransaction } from '../../db/client.js';
import { containerRepo, fieldRepo, issueRepo, permissionRepo, viewRepo } from '../../db/repositories/index.js';
import type {
  Company,
  FieldDef,
  IssueSet,
  IssueTypeDefinition,
  LevelDefinition,
  Role,
} from '../../db/repositories/index.js';
import type { Executor } from '../../db/repositories/index.js';
import { buildContainerIndex, computeEffectivePermission } from '../../permission/index.js';
import { makeIssueAccessGuard, permissionAtIssueSet } from '../issueAccess.js';
import { changeIssueStatus, formatIssueKey, invalid, recordFieldChange } from '../../domain/index.js';
import type {
  FieldChangeInput,
  StatusTransitionFailureCode,
  ValidationFailure,
} from '../../domain/index.js';
import { isUniqueViolation, sendError, sendValidationFailure } from '../errors.js';
import {
  asString,
  foldWorkspaceIssueFields,
  WORKSPACE_FIELD_ASSIGNEE as FIELD_ASSIGNEE,
  WORKSPACE_FIELD_DUE as FIELD_DUE,
  WORKSPACE_FIELD_POINT as FIELD_POINT,
  WORKSPACE_FIELD_RESOLUTION as FIELD_RESOLUTION,
  WORKSPACE_FIELD_STATUS as FIELD_STATUS,
  WORKSPACE_FIELD_TITLE as FIELD_TITLE,
} from '../workspaceIssueRow.js';
import type { WorkspaceIssueRow } from '../workspaceIssueRow.js';

// 前端工作區路由：/api/workspace 之下的預設工作區啟動與加值工單列表。
//
// 存在理由：泛用 REST 路由（containers / issues / fields）把工單型別、欄位定義、
// 流程狀態當作各自獨立資源，前端要開一張可用的工單得先串起七八個建立呼叫。
// 本路由把「單一 Company 模式下的預設工作區」收斂成一個冪等啟動點：
//   - 種一個內建工單型別 task 與其流程狀態
//   - 種內建欄位組「基本」與 title / status / assignee / point / due 欄位定義，
//     另種 spec 標準欄位 StartTime / EndTime（大寫名，供甘特圖與 rollup 讀取）
//   - 種一組預設 Team > Product > Mgmt + 初始工單集（KEY = IGT）
// 並提供以「工單 + 欄位單值」摺疊而成的加值列，讓三個畫面直接消費。
//
// 邊界：本層只做協定轉換與啟動編排，落庫仍走既有 repository；泛用路由與其測試不動。
// 租戶範圍：全路由掛 requireAuth，讀寫一律帶 identity.companyId。

export interface WorkspaceRoutesOptions {
  readonly pool: Pool;
  readonly requireAuth: preHandlerHookHandler;
}

// ---- 預設工作區的固定命名 ----

/**
 * spec 標準大寫欄位名，對齊 views.ts 的同名常數（甘特圖讀值路徑直查
 * issue_field_records，不經本檔的加值列摺疊，兩處各自持有字面字串，
 * 不共用 import——比照本檔其餘欄位常數與 views.ts FIELD_TITLE 的既有模式）。
 */
const FIELD_START_TIME = 'StartTime';
const FIELD_END_TIME = 'EndTime';

const DEFAULT_ISSUE_TYPE_NAME = 'task';
const DEFAULT_ISSUE_TYPE_LABEL = '工單';
const DEFAULT_FIELD_SET = '基本';
const DEFAULT_ISSUE_SET_KEY = 'IGT';

const DEFAULT_TEAM_NAME = '預設團隊';
const DEFAULT_PRODUCT_NAME = '預設產品';
const DEFAULT_MGMT_NAME = '預設管理域';
const DEFAULT_ISSUE_SET_NAME = '預設工單集';

/**
 * 開機種子的初始狀態名稱；實際流程定義（含四狀態與退回路徑的完整理由）
 * 移到 issueRepo.initializeTypeWorkflow 的 DEFAULT_STATES/DEFAULT_TRANSITIONS，
 * 供本檔的開機種子與 issueTypes 路由的一般建立共用，不各寫一份。
 */
const DEFAULT_STATUS = '待處理';

/** 預設管理 Role 的標題；Roles 沒有 StandardRoles 這類 spec 資產，屬 impl 自訂命名，
 *  同時作為「本 Company 是否已啟動過權限種子」的判準（見 ensurePermissionBootstrap）。 */
const DEFAULT_ADMIN_ROLE_TITLE = '管理員';

interface LevelSeed {
  readonly name: string;
  readonly canRead: boolean;
  readonly canComment: boolean;
  readonly canCreate: boolean;
  readonly canEditOwn: boolean;
  readonly canEditAny: boolean;
  readonly canArchive: boolean;
  readonly canStructure: boolean;
  readonly canAssignRole: boolean;
}

/** 內建四等級，逐欄對齊 spec no1_data_models/no4_permission_model.md 的 StandardLevels 真值表。 */
const STANDARD_LEVEL_SEEDS: readonly LevelSeed[] = [
  { name: '觀看', canRead: true, canComment: false, canCreate: false, canEditOwn: false, canEditAny: false, canArchive: false, canStructure: false, canAssignRole: false },
  { name: '回報', canRead: true, canComment: true, canCreate: true, canEditOwn: true, canEditAny: false, canArchive: false, canStructure: false, canAssignRole: false },
  { name: '成員', canRead: true, canComment: true, canCreate: true, canEditOwn: true, canEditAny: true, canArchive: false, canStructure: false, canAssignRole: false },
  { name: '管理', canRead: true, canComment: true, canCreate: true, canEditOwn: true, canEditAny: true, canArchive: true, canStructure: true, canAssignRole: true },
];

/** 預設管理 Role 引用的等級名稱；必為 STANDARD_LEVEL_SEEDS 之一。 */
const BOOTSTRAP_LEVEL_NAME = '管理';

interface FieldSeed {
  readonly name: string;
  readonly label: string;
  readonly valueType: string;
  readonly tracked: boolean;
  readonly rollupable?: boolean;
  readonly rollupFn?: FieldDef['rollupFn'];
}

/**
 * 追蹤旗標依 spec no1_data_models/no3_field_model.md 的 StandardFieldCatalog：
 * Status／Assignee／StoryPoint／StartTime／EndTime 表列「開」，精確命中；
 * due 是 workspace MVP 自創的「到期日」欄位，不在 StandardFieldCatalog 表列，
 * 服務 ListScreen／KanbanScreen 既有的到期提醒視覺，與 StartTime／EndTime
 * 語意各自獨立、並存不互相取代；title／resolution 表列「-」，維持不追蹤。
 */
const FIELD_SEEDS: readonly FieldSeed[] = [
  { name: FIELD_TITLE, label: '標題', valueType: 'text', tracked: false },
  { name: FIELD_STATUS, label: '狀態', valueType: 'text', tracked: true },
  { name: FIELD_ASSIGNEE, label: '負責人', valueType: 'text', tracked: true },
  { name: FIELD_POINT, label: '點數', valueType: 'number', tracked: true, rollupable: true, rollupFn: 'sum' },
  { name: FIELD_DUE, label: '到期日', valueType: 'date', tracked: true },
  { name: FIELD_RESOLUTION, label: '結案原因', valueType: 'text', tracked: false },
  {
    name: FIELD_START_TIME,
    label: '開始日期',
    valueType: 'date',
    tracked: true,
    rollupable: true,
    rollupFn: 'earliest',
  },
  {
    name: FIELD_END_TIME,
    label: '結束日期',
    valueType: 'date',
    tracked: true,
    rollupable: true,
    rollupFn: 'latest',
  },
];

// ---- 對外形狀 ----

/** 前端啟動所需的工作區脈絡。 */
interface WorkspaceContext {
  readonly company: Company;
  readonly issueSet: Pick<IssueSet, 'id' | 'name' | 'key'>;
  readonly issueType: Pick<IssueTypeDefinition, 'id' | 'name' | 'label'>;
  readonly statuses: readonly { readonly name: string; readonly isTerminal: boolean }[];
  readonly resolutionOptions: readonly { readonly value: string }[];
}

// ---- 啟動編排 ----

/** 確保 task 工單型別、其欄位組與欄位定義、流程狀態皆存在，回傳型別。 */
async function ensureIssueType(
  tx: Executor,
  companyId: string,
): Promise<IssueTypeDefinition> {
  const existing = await issueRepo.getIssueTypeByName(companyId, DEFAULT_ISSUE_TYPE_NAME, tx);
  if (existing !== undefined) return existing;

  // 欄位組「基本」，工單型別的 fieldSets 配方指向它。
  const fieldSet = await fieldRepo.findFieldSet(companyId, DEFAULT_FIELD_SET, tx);
  if (fieldSet === undefined) {
    await fieldRepo.insertFieldSet({ companyId, name: DEFAULT_FIELD_SET, system: true }, tx);
  }
  for (const seed of FIELD_SEEDS) {
    const def = await fieldRepo.findFieldDef(companyId, seed.name, tx);
    if (def === undefined) {
      const fieldDef: FieldDef = {
        companyId,
        name: seed.name,
        fieldSetName: DEFAULT_FIELD_SET,
        kind: 'single',
        valueType: seed.valueType,
        system: true,
        readonly: false,
        rollupable: seed.rollupable ?? false,
        rollupFn: seed.rollupFn ?? null,
        tracked: seed.tracked,
        label: seed.label,
      };
      await fieldRepo.insertFieldDef(fieldDef, tx);
    }
  }

  await fieldRepo.insertFieldDef({ companyId, name: 'WorkLog', fieldSetName: DEFAULT_FIELD_SET,
    kind: 'multi', valueType: 'number', system: true, readonly: false, rollupable: true,
    rollupFn: 'sum', tracked: false, label: '工時' }, tx);

  // ChangeLog 為系統寫入的多筆欄位，供 recordFieldChange 追加記錄；
  // issue_field_records 對 (company_id, field_name) 有外鍵指向 field_defs，
  // 沒有這筆定義，appendChangeLog 會撞外鍵失敗。
  const changeLogDef = await fieldRepo.findFieldDef(companyId, fieldRepo.CHANGE_LOG_FIELD_NAME, tx);
  if (changeLogDef === undefined) {
    await fieldRepo.insertFieldDef(
      {
        companyId,
        name: fieldRepo.CHANGE_LOG_FIELD_NAME,
        fieldSetName: DEFAULT_FIELD_SET,
        kind: 'multi',
        valueType: 'text',
        system: true,
        readonly: true,
        rollupable: false,
        rollupFn: null,
        tracked: false,
        label: '變更歷史',
      },
      tx,
    );
  }

  const issueType = await issueRepo.createIssueType(
    {
      id: randomUUID(),
      companyId,
      name: DEFAULT_ISSUE_TYPE_NAME,
      label: DEFAULT_ISSUE_TYPE_LABEL,
      fieldSets: [DEFAULT_FIELD_SET],
      system: true,
    },
    tx,
  );

  // 預設流程（四狀態、退回路徑、結案原因）由 initializeTypeWorkflow 帶入，
  // 與 issueTypes 路由的一般建立共用同一份預設值，不各寫一份。
  await issueRepo.initializeTypeWorkflow(companyId, issueType.id, undefined, tx);

  return issueType;
}

/** 確保預設容器樹存在，回傳作為工作區的工單集（優先取 KEY = IGT）。 */
async function ensureIssueSet(tx: Executor, companyId: string): Promise<IssueSet> {
  const tree = await containerRepo.getContainerTree(companyId, tx);
  const existingSets = (tree?.teams ?? [])
    .flatMap((team) => team.products)
    .flatMap((product) => product.mgmts)
    .flatMap((mgmt) => mgmt.issueSets);
  const preferred =
    existingSets.find((set) => set.key === DEFAULT_ISSUE_SET_KEY) ?? existingSets[0];
  if (preferred !== undefined) return preferred;

  // 空 Company：種一組完整的預設容器樹。
  const team = await containerRepo.createTeam(
    { id: randomUUID(), companyId, name: DEFAULT_TEAM_NAME },
    tx,
  );
  const product = await containerRepo.createProduct(
    { id: randomUUID(), companyId, teamId: team.id, name: DEFAULT_PRODUCT_NAME },
    tx,
  );
  const created = await containerRepo.createMgmtWithInitialIssueSet(
    {
      mgmt: { id: randomUUID(), companyId, productId: product.id, name: DEFAULT_MGMT_NAME },
      issueSet: {
        id: randomUUID(),
        companyId,
        name: DEFAULT_ISSUE_SET_NAME,
        key: DEFAULT_ISSUE_SET_KEY,
      },
    },
    tx,
  );
  return created.issueSet;
}

/**
 * 確保內建四等級與一個預設管理 Role 存在；本 Company 從未有人被授予任何 Role 時，
 * 把預設管理 Role 直接授予當前呼叫者（不經 checkRoleAssignment——那是給「已有
 * 權限者分派給別人」的正常流程，套用在此必然回拒絕，因為誰都零 Role）。
 *
 * 沒有這步，任何新帳號 computeEffectivePermission 恆回全否（含 canRead），
 * filterMgmtsByPermission 會把所有 Mgmt 判定無讀取權濾除；且無法後補——
 * POST /api/permissions/levels、/roles 都要求操作者持有 permAdmin，
 * 而 permAdmin 一樣來自 Role，形成沒有人能透過既有 API 解開的死結。
 *
 * 判準用「DEFAULT_ADMIN_ROLE_TITLE 的 Role 是否存在」，不是「AccountRoles
 * 是否為空」：DELETE /api/permissions/accounts/:id/roles/:assignmentId 是既有、
 * 可用的撤除端點，AccountRoles 可以被撤到零筆；若判準看那張表，管理員不慎撤光
 * 所有人的 Role 之後，下一個剛好呼叫本函式的任何人會被誤判成「還沒啟動過」而
 * 意外拿到管理權，是真實的權限提升風向。Role 目前沒有刪除端點，存在性單調不減，
 * 適合當一次性判準——撤權後的空狀態會維持空，需要人工介入救回，不會被靜默接管。
 *
 * level_definitions／roles 皆無天然唯一約束可讓並發首次請求靠撞鍵擋重複插入
 * （不像 ensureIssueType 倚賴 field_defs 的複合 PK），改用鎖 Company 列序列化。
 */
async function ensurePermissionBootstrap(
  tx: Executor,
  companyId: string,
  accountId: string,
): Promise<void> {
  await containerRepo.lockCompanyForUpdate(companyId, tx);

  const levels = await permissionRepo.listLevelDefinitions(tx, companyId);
  const levelByName = new Map(levels.map((l) => [l.name, l]));
  const now = Date.now();
  for (const seed of STANDARD_LEVEL_SEEDS) {
    if (levelByName.has(seed.name)) continue;
    const level: LevelDefinition = {
      id: randomUUID(),
      companyId,
      system: true,
      createdOn: now,
      updatedOn: now,
      ...seed,
    };
    await permissionRepo.insertLevelDefinition(tx, level);
    levelByName.set(level.name, level);
  }

  const roles = await permissionRepo.listRoles(tx, companyId);
  if (roles.some((r) => r.roleTitle === DEFAULT_ADMIN_ROLE_TITLE)) return;

  const managementLevel = levelByName.get(BOOTSTRAP_LEVEL_NAME);
  /* v8 ignore next 3 -- BOOTSTRAP_LEVEL_NAME 恆在 STANDARD_LEVEL_SEEDS 之列，上面迴圈保證存在 */
  if (managementLevel === undefined) {
    throw new Error(`內建等級 ${BOOTSTRAP_LEVEL_NAME} 未種成`);
  }

  const role: Role = {
    id: randomUUID(),
    companyId,
    roleTitle: DEFAULT_ADMIN_ROLE_TITLE,
    levelId: managementLevel.id,
    typeAdmin: true,
    orgAdmin: true,
    permAdmin: true,
    tags: null,
    createdOn: now,
    updatedOn: now,
  };
  await permissionRepo.insertRole(tx, role);
  await permissionRepo.insertRoleScope(tx, {
    id: randomUUID(),
    companyId,
    roleId: role.id,
    scopeKind: 'company',
    scopeId: companyId,
    createdOn: now,
    updatedOn: now,
  });
  await permissionRepo.insertAccountRole(tx, {
    id: randomUUID(),
    companyId,
    accountId,
    roleId: role.id,
    createdOn: now,
    updatedOn: now,
  });
}

/** 冪等啟動：種齊預設工作區並回傳脈絡。並發下撞唯一約束則重讀既有狀態。 */
async function ensureWorkspace(
  pool: Pool,
  companyId: string,
  accountId: string,
): Promise<WorkspaceContext> {
  const company = await containerRepo.getCompany(companyId, pool);
  if (company === undefined) {
    throw new Error('當前身分的 Company 不存在');
  }

  let issueType: IssueTypeDefinition;
  let issueSet: IssueSet;
  try {
    ({ issueType, issueSet } = await withTransaction(async (tx) => {
      const type = await ensureIssueType(tx, companyId);
      const set = await ensureIssueSet(tx, companyId);
      return { issueType: type, issueSet: set };
    }, pool));
  } catch (error: unknown) {
    // 並發啟動：另一請求已搶先種好，撞唯一約束後重讀既有狀態即可。
    if (!isUniqueViolation(error)) throw error;
    const type = await issueRepo.getIssueTypeByName(companyId, DEFAULT_ISSUE_TYPE_NAME, pool);
    const set = await ensureIssueSet(pool, companyId);
    if (type === undefined) throw error;
    issueType = type;
    issueSet = set;
  }

  // 獨立一個 transaction，不塞進上面那個：容器/工單型別種子跟權限種子失敗域無關，
  // 不該互相拖累對方 rollback，也不動上面既有的 unique-violation 復原邏輯。
  await withTransaction((tx) => ensurePermissionBootstrap(tx, companyId, accountId), pool);

  const states = await issueRepo.listWorkflowStates(companyId, issueType.id, pool);
  const resolutionOptions = await issueRepo.listResolutionOptions(companyId, issueType.id, pool);
  return {
    company,
    issueSet: { id: issueSet.id, name: issueSet.name, key: issueSet.key },
    issueType: { id: issueType.id, name: issueType.name, label: issueType.label },
    statuses: states.map((s) => ({ name: s.name, isTerminal: s.isTerminal })),
    resolutionOptions: resolutionOptions.map((r) => ({ value: r.value })),
  };
}

// ---- 加值列摺疊 ----

/** 欄位是否算「已有值」，供 requiredFields 檢查共用；跟摺列展示的欄位回退值是不同概念，不拉進共用模組。 */
function hasFieldValue(value: unknown): boolean {
  return value !== null && value !== undefined && value !== '';
}

/** 把單張工單與其欄位單值摺疊成加值列。 */
async function foldIssueRow(
  pool: Pool,
  companyId: string,
  issue: { id: string; issueKey: string; issueTypeId: string },
  projection: IssueReadProjection,
): Promise<WorkspaceIssueRow> {
  const values = await issueRepo.listFieldValues(companyId, issue.id, pool);
  const fields: Record<string, unknown> = {};
  for (const v of values) fields[v.fieldName] = v.value;
  return { id: issue.id, key: issue.issueKey, issueTypeId: issue.issueTypeId, ...foldWorkspaceIssueFields(projection.fields(issue.id, fields), projection.restrictedFields(issue.id)) };
}

// ---- 輸入 schema ----

const UUID_PATTERN =
  '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$';

const createIssueBodySchema = {
  type: 'object',
  required: ['title'],
  additionalProperties: false,
  properties: {
    title: { type: 'string', minLength: 1, maxLength: 500 },
    issueSetId: { type: 'string', pattern: UUID_PATTERN },
    issueTypeId: { type: 'string', pattern: UUID_PATTERN },
    status: { type: 'string', minLength: 1, maxLength: 100 },
    assignee: { type: 'string', maxLength: 100 },
    point: { type: 'number' },
    due: { type: 'string', maxLength: 40 },
  },
} as const;

const updateIssueBodySchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    title: { type: 'string', minLength: 1, maxLength: 500 },
    status: { type: 'string', minLength: 1, maxLength: 100 },
    resolution: { type: 'string', minLength: 1, maxLength: 200 },
    assignee: { type: 'string', maxLength: 100 },
    point: { type: ['number', 'null'] },
    due: { type: ['string', 'null'], maxLength: 40 },
  },
} as const;

const issueIdParams = {
  type: 'object',
  required: ['issueId'],
  additionalProperties: false,
  properties: { issueId: { type: 'string', pattern: UUID_PATTERN } },
} as const;

interface CreateIssueBody {
  readonly title: string;
  readonly issueSetId?: string;
  readonly issueTypeId?: string;
  readonly status?: string;
  readonly assignee?: string;
  readonly point?: number;
  readonly due?: string;
}

interface UpdateIssueBody {
  readonly title?: string;
  readonly status?: string;
  readonly resolution?: string;
  readonly assignee?: string;
  readonly point?: number | null;
  readonly due?: string | null;
}

// ---- 路由 ----

export const workspaceRoutes: FastifyPluginAsync<WorkspaceRoutesOptions> = async (
  app: FastifyInstance,
  opts,
) => {
  const { pool, requireAuth } = opts;

  app.addHook('preHandler', requireAuth);
  app.addHook('preHandler', makeIssueAccessGuard(pool));

  // 啟動工作區並回脈絡；冪等，前端登入後首呼即可拿到工單集與型別。
  app.get('/', async (request, reply) => {
    const { accountId, companyId } = currentIdentity(request);
    const context = await ensureWorkspace(pool, companyId, accountId);
    return reply.status(200).send(context);
  });

  app.get<{ Querystring: { viewId: string } }>('/creation-options', {
    schema: { querystring: {
      type: 'object', required: ['viewId'], additionalProperties: false,
      properties: { viewId: { type: 'string', pattern: UUID_PATTERN } },
    } },
  }, async (request, reply) => {
    const { companyId, accountId } = currentIdentity(request);
    const view = await viewRepo.getView(pool, companyId, request.query.viewId);
    if (view === undefined || view.ownerId !== accountId) {
      return sendError(reply, 404, 'VIEW_NOT_FOUND', '檢視不存在');
    }
    const tree = await containerRepo.getContainerTree(companyId, pool);
    const bundles = await permissionRepo.getEffectivePermissionInputs(pool, companyId, accountId);
    const index = buildContainerIndex(tree ?? { id: companyId, name: '', teams: [] });
    const sourceIds = new Set(view.sourceMgmtIds);
    const issueSets: Array<{ id: string; label: string; key: string }> = [];
    for (const team of tree?.teams ?? []) {
      for (const product of team.products) {
        for (const mgmt of product.mgmts) {
          const permission = computeEffectivePermission(bundles, index, { kind: 'mgmt', id: mgmt.id });
          if (!sourceIds.has(mgmt.id) || !permission.canCreate || !permission.canRead) continue;
          for (const issueSet of mgmt.issueSets) {
            issueSets.push({ id: issueSet.id, key: issueSet.key, label: `${team.name} / ${product.name} / ${mgmt.name} / ${issueSet.name} · ${issueSet.key}` });
          }
        }
      }
    }
    const issueTypes = await issueRepo.listIssueTypes(companyId, pool);
    return reply.send({ issueSets, issueTypes });
  });

  // 加值工單列：工作區工單集下的工單摺疊欄位單值。
  app.get('/issues', async (request, reply) => {
    const { accountId, companyId } = currentIdentity(request);
    const context = await ensureWorkspace(pool, companyId, accountId);
    const permission = await permissionAtIssueSet(pool, currentIdentity(request), context.issueSet.id);
    if (!permission.canRead) return sendError(reply, 403, 'FORBIDDEN', '沒有此管理域的讀取權限');
    const issues = await issueRepo.listIssuesByIssueSet(companyId, context.issueSet.id, pool);
    const rows: WorkspaceIssueRow[] = [];
    const projection = await createIssueReadProjection(pool, currentIdentity(request));
    for (const issue of issues) {
      rows.push(await foldIssueRow(pool, companyId, issue, projection));
    }
    return reply.status(200).send({ issues: rows });
  });

  // 建立工單：取號落庫 + 寫入 title / status / 其餘欄位，回傳加值列。
  app.post<{ Body: CreateIssueBody }>(
    '/issues',
    { schema: { body: createIssueBodySchema } },
    async (request, reply) => {
      const { accountId, companyId } = currentIdentity(request);
      const context = await ensureWorkspace(pool, companyId, accountId);
      const body = request.body;
      const issueSet = await containerRepo.getIssueSet(companyId, body.issueSetId ?? context.issueSet.id, pool);
      if (issueSet === undefined) {
        return sendError(reply, 422, 'ISSUE_SET_NOT_FOUND', '指定的工單集不存在');
      }
      const issueType = await issueRepo.getIssueType(companyId, body.issueTypeId ?? context.issueType.id, pool);
      if (issueType === undefined) {
        return sendError(reply, 422, 'ISSUE_TYPE_NOT_FOUND', '指定的工單型別不存在');
      }
      const bundles = await permissionRepo.getEffectivePermissionInputs(pool, companyId, accountId);
      const tree = await containerRepo.getContainerTree(companyId, pool);
      const permission = computeEffectivePermission(
        bundles, buildContainerIndex(tree ?? { id: companyId, name: '', teams: [] }),
        { kind: 'mgmt', id: issueSet.mgmtId },
      );
      if (!permission.canCreate) {
        return sendError(reply, 403, 'FORBIDDEN', '沒有此管理域的建單權限');
      }

      const issue = await withTransaction(async (tx) => {
        const now = Date.now();
        const seq = await containerRepo.takeNextSeq(companyId, issueSet.id, tx);
        const issueKey = formatIssueKey(issueSet.key, seq!);
        const created = await issueRepo.createIssue(
          {
            id: randomUUID(),
            companyId,
            issueSetId: issueSet.id,
            issueTypeId: issueType.id,
            issueKey,
          },
          tx,
        );
        // 新建工單所有欄位都是從無到有；oldValue 一律 null，與 PATCH 走同一套
        // recordFieldChange，不必為建立特判成另一個函式。
        const changes: FieldChangeInput[] = [];
        const setField = (name: string, value: unknown): Promise<unknown> => {
          changes.push({ fieldName: name, oldValue: null, newValue: value });
          return issueRepo.setFieldValue({ companyId, issueId: created.id, fieldName: name, value }, tx);
        };
        await setField(FIELD_TITLE, body.title);
        // 未帶 status 時落在該型別真正的起始狀態，不寫死中文字面值；
        // checkExactlyOneInitialState 保證每個型別恆有一個 isInitial，
        // DEFAULT_STATUS 只當資料異常時的防禦回退。
        const workflowStates = await issueRepo.listWorkflowStates(companyId, issueType.id, tx);
        const initialStatus = workflowStates.find((s) => s.isInitial)?.name ?? DEFAULT_STATUS;
        await setField(FIELD_STATUS, body.status ?? initialStatus);
        if (body.assignee !== undefined && body.assignee !== '') {
          await setField(FIELD_ASSIGNEE, body.assignee);
        }
        if (body.point !== undefined) await setField(FIELD_POINT, body.point);
        if (body.due !== undefined && body.due !== '') await setField(FIELD_DUE, body.due);

        const fieldDefs = await fieldRepo.listFieldDefs(companyId, tx);
        await issueRepo.recordCreator(companyId, created.id, accountId, tx);
        const entries = recordFieldChange({ changes, actor: accountId, now, fieldDefs });
        for (const entry of entries) {
          await fieldRepo.appendChangeLog(
            { id: randomUUID(), companyId, issueId: created.id, entry, authorId: accountId, createdOn: now },
            tx,
          );
        }
        return created;
      }, pool);

      const row = await foldIssueRow(pool, companyId, issue, await createIssueReadProjection(pool, currentIdentity(request)));
      return reply.status(201).send({ issue: row });
    },
  );

  // 更新工單欄位：帶到的欄位就寫、null 清除、未帶不動，回傳加值列。看板拖曳改狀態走此。
  //
  // status 有變動時走 changeIssueStatus 驗證：不合法轉換、角色不符、缺必填欄位、
  // 終止狀態缺結案原因、結案原因不合法皆回 422。resolution 只能隨一次真正的
  // status 轉換一併提供，單獨送視為請求不合法。狀態值與現況相同視為 no-op，
  // 不觸發驗證，讓整包送回的編輯流程不會平白被要求補結案原因。
  app.patch<{ Params: { issueId: string }; Body: UpdateIssueBody }>(
    '/issues/:issueId',
    { schema: { params: issueIdParams, body: updateIssueBodySchema } },
    async (request, reply) => {
      const { accountId, companyId } = currentIdentity(request);
      const { issueId } = request.params;
      const body = request.body;

      const issue = await issueRepo.getIssue(companyId, issueId, pool);
      if (issue === undefined) {
        return sendError(reply, 404, 'NOT_FOUND', '工單不存在');
      }

      type UpdateOutcome =
        | ValidationFailure<StatusTransitionFailureCode | 'RESOLUTION_REQUIRES_STATUS_CHANGE'>
        | { readonly ok: true };

      const outcome = await withTransaction<UpdateOutcome>(async (tx) => {
        await containerRepo.lockCompanyForUpdate(companyId, tx);
        const now = Date.now();
        const fieldValues = await issueRepo.listFieldValues(companyId, issueId, tx);
        const byName = new Map(fieldValues.map((v) => [v.fieldName, v.value]));

        const changes: FieldChangeInput[] = [];
        const write = (name: string, value: unknown): Promise<unknown> => {
          changes.push({ fieldName: name, oldValue: byName.get(name) ?? null, newValue: value });
          return issueRepo.setFieldValue({ companyId, issueId, fieldName: name, value }, tx);
        };
        const clear = (name: string): Promise<unknown> => {
          changes.push({ fieldName: name, oldValue: byName.get(name) ?? null, newValue: null });
          return issueRepo.deleteFieldValue(companyId, issueId, name, tx);
        };

        const currentStatus = asString(byName.get(FIELD_STATUS)) || DEFAULT_STATUS;
        const statusChanging = body.status !== undefined && body.status !== currentStatus;

        if (body.resolution !== undefined && !statusChanging) {
          return invalid(
            'RESOLUTION_REQUIRES_STATUS_CHANGE',
            'resolution 只能隨 status 轉換一併提供',
          );
        }

        if (statusChanging) {
          const targetStatus = body.status as string;
          const [states, transitions, resolutionOptions, roleBundles] = await Promise.all([
            issueRepo.listWorkflowStates(companyId, issue.issueTypeId, tx),
            issueRepo.listWorkflowTransitions(companyId, issue.issueTypeId, tx),
            issueRepo.listResolutionOptions(companyId, issue.issueTypeId, tx),
            permissionRepo.getEffectivePermissionInputs(tx, companyId, accountId),
          ]);
          const fieldsWithValue = [...byName.entries()]
            .filter(([, value]) => hasFieldValue(value))
            .map(([name]) => name);

          const result = changeIssueStatus({
            definition: {
              states: states.map((s) => ({ name: s.name, isTerminal: s.isTerminal })),
              transitions: transitions.map((t) => ({
                fromState: t.fromState,
                toState: t.toState,
                requiredRole: t.requiredRole,
                requiredFields: t.requiredFields,
              })),
              resolutionOptions: resolutionOptions.map((r) => ({ value: r.value })),
            },
            issue: { currentStatus, fieldsWithValue },
            targetStatus,
            actor: { roleNames: roleBundles.map((b) => b.role.roleTitle) },
            resolution: body.resolution ?? null,
          });
          if (!result.ok) {
            return result;
          }
          await write(FIELD_STATUS, result.status);
          if (result.resolution !== undefined) {
            await write(FIELD_RESOLUTION, result.resolution);
          }
        }

        if (body.title !== undefined) await write(FIELD_TITLE, body.title);
        if (body.assignee !== undefined) {
          await (body.assignee === '' ? clear(FIELD_ASSIGNEE) : write(FIELD_ASSIGNEE, body.assignee));
        }
        if (body.point !== undefined) {
          await writeField(tx, companyId, issueId, FIELD_POINT, body.point, accountId);
        }
        if (body.due !== undefined) {
          await (body.due === null || body.due === '' ? clear(FIELD_DUE) : write(FIELD_DUE, body.due));
        }

        const fieldDefs = await fieldRepo.listFieldDefs(companyId, tx);
        const entries = recordFieldChange({ changes, actor: accountId, now, fieldDefs });
        for (const entry of entries) {
          await fieldRepo.appendChangeLog(
            { id: randomUUID(), companyId, issueId, entry, authorId: accountId, createdOn: now },
            tx,
          );
        }
        return { ok: true };
      }, pool);

      if (!outcome.ok) {
        return sendValidationFailure(reply, outcome);
      }

      const row = await foldIssueRow(pool, companyId, issue, await createIssueReadProjection(pool, currentIdentity(request)));
      return reply.status(200).send({ issue: row });
    },
  );
};
