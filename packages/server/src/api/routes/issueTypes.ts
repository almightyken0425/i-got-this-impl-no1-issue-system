import { randomUUID } from 'node:crypto';

import type { FastifyInstance, FastifyPluginAsync, preHandlerHookHandler } from 'fastify';
import type { Pool } from 'pg';

import { currentIdentity } from '../../auth/middleware.js';
import { makeDefinitionAccessGuard } from '../issueAccess.js';
import { withTransaction } from '../../db/client.js';
import { containerRepo, fieldRepo, issueRepo } from '../../db/repositories/index.js';
import { refreshRollups } from '../../db/repositories/rollupRepo.js';
import type { IssueTypeDefinition, WorkflowTransitionInput } from '../../db/repositories/index.js';
import type { ResolutionOptionValue, WorkflowStateEdit } from '../../domain/index.js';
import { validateWorkflowDefinitionEdit } from '../../domain/index.js';
import { sendError, sendValidationFailure } from '../errors.js';

// 工單型別路由：/api/issue-types 之下的工單型別讀寫。
//
// 本層只做協定轉換：schema 驗輸入、帶租戶鍵呼叫 repository、把結果碼轉 HTTP。
// 邊界：
// - 識別名稱在 Company 內唯一，重複先查再回 409
// - fieldSets 逐一核對欄位組定義存在，不存在回 422
// - 建立型別時一併呼叫 issueRepo.initializeTypeWorkflow 帶入預設流程，
//   兩步同交易，避免留下沒有流程定義的半成品型別
// - 不開 DELETE：畫面互動清單沒有刪除工單型別這個操作

export interface IssueTypeRoutesOptions {
  readonly pool: Pool;
  readonly requireAuth: preHandlerHookHandler;
}

// ---- 輸入 schema ----

const issueTypeBodySchema = {
  type: 'object',
  required: ['name', 'label', 'fieldSets'],
  additionalProperties: false,
  properties: {
    name: { type: 'string', minLength: 1, maxLength: 100 },
    label: { type: 'string', minLength: 1, maxLength: 200 },
    fieldSets: { type: 'array', items: { type: 'string', minLength: 1 } },
  },
} as const;

const issueTypePatchBodySchema = {
  type: 'object',
  required: ['label', 'fieldSets'],
  additionalProperties: false,
  properties: {
    label: { type: 'string', minLength: 1, maxLength: 200 },
    fieldSets: { type: 'array', items: { type: 'string', minLength: 1 } },
  },
} as const;

const idParamsSchema = {
  type: 'object',
  required: ['id'],
  properties: { id: { type: 'string', minLength: 1 } },
} as const;

const workflowStateSchema = {
  type: 'object',
  required: ['name', 'isInitial', 'isTerminal'],
  additionalProperties: false,
  properties: {
    name: { type: 'string', minLength: 1, maxLength: 100 },
    isInitial: { type: 'boolean' },
    isTerminal: { type: 'boolean' },
  },
} as const;

const workflowTransitionSchema = {
  type: 'object',
  required: ['fromState', 'toState', 'requiredRole', 'requiredFields'],
  additionalProperties: false,
  properties: {
    fromState: { type: 'string', minLength: 1, maxLength: 100 },
    toState: { type: 'string', minLength: 1, maxLength: 100 },
    requiredRole: { type: ['string', 'null'] },
    requiredFields: { type: 'array', items: { type: 'string', minLength: 1 } },
  },
} as const;

const resolutionOptionSchema = {
  type: 'object',
  required: ['value'],
  additionalProperties: false,
  properties: { value: { type: 'string', minLength: 1, maxLength: 100 } },
} as const;

const workflowPutBodySchema = {
  type: 'object',
  required: ['states', 'transitions', 'resolutionOptions'],
  additionalProperties: false,
  properties: {
    states: { type: 'array', items: workflowStateSchema },
    transitions: { type: 'array', items: workflowTransitionSchema },
    resolutionOptions: { type: 'array', items: resolutionOptionSchema },
  },
} as const;

interface IssueTypeBody {
  readonly name: string;
  readonly label: string;
  readonly fieldSets: readonly string[];
}

interface IssueTypePatchBody {
  readonly label: string;
  readonly fieldSets: readonly string[];
}

interface WorkflowPutBody {
  // 對齊 workflowStateSchema 的 wire 形狀：不含 sortOrder。順序即 sortOrder，
  // 由 handler 依陣列位置換算後才交給 repo 層的 WorkflowStateInput。
  readonly states: readonly WorkflowStateEdit[];
  readonly transitions: readonly WorkflowTransitionInput[];
  // 對齊 resolutionOptionSchema 的 wire 形狀：不含 system，一律視為使用者自訂。
  readonly resolutionOptions: readonly ResolutionOptionValue[];
}

/** 逐一核對 fieldSets 清單裡的欄位組都存在；回傳缺漏的名稱，全存在則回空陣列。 */
async function findMissingFieldSets(
  companyId: string,
  fieldSets: readonly string[],
  pool: Pool,
): Promise<string[]> {
  const checks = await Promise.all(
    fieldSets.map(async (name) => ({ name, exists: (await fieldRepo.findFieldSet(companyId, name, pool)) !== undefined })),
  );
  return checks.filter((c) => !c.exists).map((c) => c.name);
}

export const issueTypeRoutes: FastifyPluginAsync<IssueTypeRoutesOptions> = async (
  app: FastifyInstance,
  opts,
) => {
  const { pool, requireAuth } = opts;

  app.addHook('preHandler', requireAuth);
  app.addHook('preHandler', makeDefinitionAccessGuard(pool));

  // 建立工單型別；名稱在 Company 內唯一，fieldSets 逐一須存在。
  // 交易內建型別 + 帶入預設流程，兩步失敗則整批回滾。
  app.post<{ Body: IssueTypeBody }>(
    '/',
    { schema: { body: issueTypeBodySchema } },
    async (request, reply) => {
      const { companyId } = currentIdentity(request);
      const body = request.body;

      const existing = await issueRepo.getIssueTypeByName(companyId, body.name, pool);
      if (existing !== undefined) {
        return sendError(reply, 409, 'ISSUE_TYPE_NAME_TAKEN', '工單型別名稱已存在');
      }
      const missing = await findMissingFieldSets(companyId, body.fieldSets, pool);
      if (missing.length > 0) {
        return sendError(reply, 422, 'FIELD_SET_NOT_FOUND', `欄位組不存在：${missing.join('、')}`);
      }

      const issueType = await withTransaction<IssueTypeDefinition>(async (tx) => {
        const created = await issueRepo.createIssueType(
          {
            id: randomUUID(),
            companyId,
            name: body.name,
            label: body.label,
            fieldSets: body.fieldSets,
            system: false,
          },
          tx,
        );
        await issueRepo.initializeTypeWorkflow(companyId, created.id, undefined, tx);
        return created;
      }, pool);

      return reply.status(201).send({ issueType });
    },
  );

  // 列出本 Company 的工單型別，依名稱排序。
  app.get('/', async (request, reply) => {
    const { companyId } = currentIdentity(request);
    const issueTypes = await issueRepo.listIssueTypes(companyId, pool);
    return reply.status(200).send({ issueTypes });
  });

  // 改工單型別的顯示名稱與欄位組配方；識別名稱與系統旗標不動。
  app.patch<{ Params: { id: string }; Body: IssueTypePatchBody }>(
    '/:id',
    { schema: { params: idParamsSchema, body: issueTypePatchBodySchema } },
    async (request, reply) => {
      const { companyId } = currentIdentity(request);
      const missing = await findMissingFieldSets(companyId, request.body.fieldSets, pool);
      if (missing.length > 0) {
        return sendError(reply, 422, 'FIELD_SET_NOT_FOUND', `欄位組不存在：${missing.join('、')}`);
      }
      const updated = await withTransaction(async (tx) => {
        await containerRepo.lockCompanyForUpdate(companyId, tx);
        const result = await issueRepo.updateIssueType(companyId, request.params.id, request.body, tx);
        if (result) await refreshRollups(tx, companyId, currentIdentity(request).accountId);
        return result;
      }, pool);
      if (updated === undefined) {
        return sendError(reply, 404, 'ISSUE_TYPE_NOT_FOUND', '工單型別不存在');
      }
      return reply.status(200).send({ issueType: updated });
    },
  );

  // 讀該型別完整流程定義：狀態、轉換、結案原因三清單一次帶回，供管理畫面初始載入。
  app.get<{ Params: { id: string } }>(
    '/:id/workflow',
    { schema: { params: idParamsSchema } },
    async (request, reply) => {
      const { companyId } = currentIdentity(request);
      const issueType = await issueRepo.getIssueType(companyId, request.params.id, pool);
      if (issueType === undefined) {
        return sendError(reply, 404, 'ISSUE_TYPE_NOT_FOUND', '工單型別不存在');
      }
      const [states, transitions, resolutionOptions] = await Promise.all([
        issueRepo.listWorkflowStates(companyId, request.params.id, pool),
        issueRepo.listWorkflowTransitions(companyId, request.params.id, pool),
        issueRepo.listResolutionOptions(companyId, request.params.id, pool),
      ]);
      return reply.status(200).send({ states, transitions, resolutionOptions });
    },
  );

  // 改該型別完整流程定義：三清單整包替換，同交易內依序 states → transitions →
  // resolutionOptions（states 先落地，transitions 的外鍵才有依據；比照
  // issueRepo.initializeTypeWorkflow 同一套「三張表同交易內清空重建」）。
  // 對應 Spec updateWorkflowDefinition：狀態、轉換（含執行者角色與必填欄位）、
  // 起始／終止狀態、結案原因皆可加可改可刪，前端每次送當前完整三份。
  app.put<{ Params: { id: string }; Body: WorkflowPutBody }>(
    '/:id/workflow',
    { schema: { params: idParamsSchema, body: workflowPutBodySchema } },
    async (request, reply) => {
      const { companyId } = currentIdentity(request);
      const issueType = await issueRepo.getIssueType(companyId, request.params.id, pool);
      if (issueType === undefined) {
        return sendError(reply, 404, 'ISSUE_TYPE_NOT_FOUND', '工單型別不存在');
      }

      const validation = validateWorkflowDefinitionEdit(request.body.states, request.body.transitions);
      if (!validation.ok) {
        return sendValidationFailure(reply, validation);
      }

      // wire 上的 states 不含 sortOrder（順序即 sortOrder），送進 repo 層前
      // 依陣列位置換算；repo 的 WorkflowStateInput 要求這個欄位非 undefined。
      const statesWithSortOrder = request.body.states.map((s, index) => ({
        ...s,
        sortOrder: index,
      }));
      // wire 上的 resolutionOptions 不含 sortOrder／system：順序即 sortOrder，
      // 依陣列位置換算；整包替換一律視為使用者自訂，system 固定 false。
      const resolutionOptionsWithSystem = request.body.resolutionOptions.map((r, index) => ({
        ...r,
        sortOrder: index + 1,
        system: false,
      }));

      const result = await withTransaction(async (tx) => {
        const states = await issueRepo.replaceWorkflowStates(
          companyId,
          request.params.id,
          statesWithSortOrder,
          tx,
        );
        const transitions = await issueRepo.replaceWorkflowTransitions(
          companyId,
          request.params.id,
          request.body.transitions,
          tx,
        );
        const resolutionOptions = await issueRepo.replaceResolutionOptions(
          companyId,
          request.params.id,
          resolutionOptionsWithSystem,
          tx,
        );
        return { states, transitions, resolutionOptions };
      }, pool);

      return reply.status(200).send(result);
    },
  );
};
