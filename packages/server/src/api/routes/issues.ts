import { randomUUID } from 'node:crypto';

import type { FastifyInstance, FastifyPluginAsync, preHandlerHookHandler } from 'fastify';
import type { Pool } from 'pg';

import { currentIdentity } from '../../auth/middleware.js';
import { withTransaction } from '../../db/client.js';
import { containerRepo, fieldRepo, issueRepo } from '../../db/repositories/index.js';
import { formatIssueKey } from '../../domain/index.js';
import type { RollupMode } from '../../domain/index.js';
import { refreshRollups, writeField } from '../../db/repositories/rollupRepo.js';
import { isForeignKeyViolation, sendError } from '../errors.js';
import { makeIssueAccessGuard, requireIssueAccess } from '../issueAccess.js';
import { installIssueContextRoutes } from './issueContext.js';
import { createIssueReadProjection } from '../issueReadProjection.js';
import {
  WORKSPACE_FIELD_RESOLUTION as FIELD_RESOLUTION,
  WORKSPACE_FIELD_STATUS as FIELD_STATUS,
} from '../workspaceIssueRow.js';

// 工單路由：工單的 CRUD、移動、依工單集列出，與工單欄位單值的讀寫。
//
// 本層只做協定轉換：schema 驗輸入、從 session 取租戶鍵、呼叫 repository、對應錯誤碼。
// 租戶範圍：全路由掛 requireAuth，讀寫一律帶 identity.companyId。
// 跨租戶引用把關：issues 的 issue_set_id / issue_type_id、issue_field_values 的 issue_id
//                 外鍵皆非複合租戶鍵，故 body 帶入的外來 id 先以租戶讀取確認歸屬。
// 取號：建立工單於單一交易內原子遞增工單集流水號（containerRepo.takeNextSeq），
//       再以 domain 的 formatIssueKey 組出永久編號；工單移動保留原號。

export interface IssueRoutesOptions {
  readonly pool: Pool;
  readonly requireAuth: preHandlerHookHandler;
}

const UUID_PATTERN =
  '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$';

function idParams(key: string) {
  return {
    type: 'object',
    required: [key],
    additionalProperties: false,
    properties: { [key]: { type: 'string', pattern: UUID_PATTERN } },
  } as const;
}

const fieldValueParams = {
  type: 'object',
  required: ['issueId', 'fieldName'],
  additionalProperties: false,
  properties: {
    issueId: { type: 'string', pattern: UUID_PATTERN },
    fieldName: { type: 'string', minLength: 1, maxLength: 200 },
  },
} as const;

export const issueRoutes: FastifyPluginAsync<IssueRoutesOptions> = async (
  app: FastifyInstance,
  opts,
) => {
  const { pool, requireAuth } = opts;

  app.addHook('preHandler', requireAuth);
  app.addHook('preHandler', makeIssueAccessGuard(pool));
  installIssueContextRoutes(app, pool);

  app.get<{ Params: { issueKey: string } }>('/issues/by-key/:issueKey', async (request, reply) => {
    const identity = currentIdentity(request);
    const issue = await issueRepo.getIssueByKey(identity.companyId, request.params.issueKey, pool);
    if (!issue) return sendError(reply, 404, 'NOT_FOUND', '工單編號不存在');
    if (!(await requireIssueAccess(pool, identity, issue.id, 'read', reply))) return;
    return { issue };
  });

  // ==========================================================
  // Issues
  // ==========================================================

  // 建立工單：取號 + 落庫，於單一交易內原子完成。
  app.post<{ Params: { issueSetId: string }; Body: { issueTypeId: string } }>(
    '/issue-sets/:issueSetId/issues',
    {
      schema: {
        params: idParams('issueSetId'),
        body: {
          type: 'object',
          required: ['issueTypeId'],
          additionalProperties: false,
          properties: { issueTypeId: { type: 'string', pattern: UUID_PATTERN } },
        },
      },
    },
    async (request, reply) => {
      const { companyId, accountId } = currentIdentity(request);
      const { issueSetId } = request.params;
      const { issueTypeId } = request.body;

      const result = await withTransaction(async (tx) => {
        const issueSet = await containerRepo.getIssueSet(companyId, issueSetId, tx);
        if (issueSet === undefined) {
          return { kind: 'issue-set-missing' as const };
        }
        const issueType = await issueRepo.getIssueType(companyId, issueTypeId, tx);
        if (issueType === undefined) {
          return { kind: 'issue-type-missing' as const };
        }
        // 原子取號：同列 UPDATE 取列鎖、逐一序列化，併發不撞號、不留空號。
        const seq = await containerRepo.takeNextSeq(companyId, issueSetId, tx);
        // issueSet 已在同交易內確認存在，取號必得值。
        const issueKey = formatIssueKey(issueSet.key, seq!);
        const issue = await issueRepo.createIssue(
          { id: randomUUID(), companyId, issueSetId, issueTypeId, issueKey },
          tx,
        );
        await issueRepo.recordCreator(companyId, issue.id, accountId, tx);
        return { kind: 'ok' as const, issue };
      }, pool);

      if (result.kind === 'issue-set-missing') {
        return sendError(reply, 404, 'NOT_FOUND', 'IssueSet 不存在');
      }
      if (result.kind === 'issue-type-missing') {
        return sendError(reply, 422, 'ISSUE_TYPE_NOT_FOUND', '指定的工單型別不存在');
      }
      return reply.status(201).send({ issue: result.issue });
    },
  );

  // 依工單集列出工單。
  app.get<{ Params: { issueSetId: string } }>(
    '/issue-sets/:issueSetId/issues',
    { schema: { params: idParams('issueSetId') } },
    async (request, reply) => {
      const { companyId } = currentIdentity(request);
      const issueSet = await containerRepo.getIssueSet(companyId, request.params.issueSetId, pool);
      if (issueSet === undefined) {
        return sendError(reply, 404, 'NOT_FOUND', 'IssueSet 不存在');
      }
      const issues = await issueRepo.listIssuesByIssueSet(
        companyId,
        request.params.issueSetId,
        pool,
      );
      return reply.status(200).send({ issues });
    },
  );

  app.get<{ Params: { issueId: string } }>(
    '/issues/:issueId',
    { schema: { params: idParams('issueId') } },
    async (request, reply) => {
      const { companyId } = currentIdentity(request);
      const issue = await issueRepo.getIssue(companyId, request.params.issueId, pool);
      if (issue === undefined) {
        return sendError(reply, 404, 'NOT_FOUND', '工單不存在');
      }
      return reply.status(200).send({ issue });
    },
  );

  // 移動工單至其他工單集；編號保留原號不變。
  app.post<{ Params: { issueId: string }; Body: { issueSetId: string } }>(
    '/issues/:issueId/move',
    {
      schema: {
        params: idParams('issueId'),
        body: {
          type: 'object',
          required: ['issueSetId'],
          additionalProperties: false,
          properties: { issueSetId: { type: 'string', pattern: UUID_PATTERN } },
        },
      },
    },
    async (request, reply) => {
      const { companyId } = currentIdentity(request);
      // 目標工單集須在租戶內；issues.issue_set_id 外鍵非複合，故在此把關。
      const target = await containerRepo.getIssueSet(companyId, request.body.issueSetId, pool);
      if (target === undefined) {
        return sendError(reply, 422, 'ISSUE_SET_NOT_FOUND', '目標工單集不存在');
      }
      const issue = await issueRepo.moveIssue(
        companyId,
        request.params.issueId,
        request.body.issueSetId,
        pool,
      );
      if (issue === undefined) {
        return sendError(reply, 404, 'NOT_FOUND', '工單不存在');
      }
      return reply.status(200).send({ issue });
    },
  );

  app.delete<{ Params: { issueId: string } }>(
    '/issues/:issueId',
    { schema: { params: idParams('issueId') } },
    async (request, reply) => {
      const { companyId, accountId } = currentIdentity(request);
      const removed = await withTransaction(async (tx) => {
        await containerRepo.lockCompanyForUpdate(companyId, tx);
        const result = await issueRepo.deleteIssue(companyId, request.params.issueId, tx);
        if (result) await refreshRollups(tx, companyId, accountId);
        return result;
      }, pool);
      if (!removed) {
        return sendError(reply, 404, 'NOT_FOUND', '工單不存在');
      }
      return reply.status(204).send();
    },
  );

  // ==========================================================
  // 工單欄位單值
  //
  // 每個欄位操作先以 getIssue 確認工單歸屬租戶，再讀寫欄位值；
  // 寫入未定義欄位（field_defs 外鍵不成立）收斂為 422。
  // ==========================================================

  app.get<{ Params: { issueId: string } }>(
    '/issues/:issueId/fields',
    { schema: { params: idParams('issueId') } },
    async (request, reply) => {
      const { companyId } = currentIdentity(request);
      const issue = await issueRepo.getIssue(companyId, request.params.issueId, pool);
      if (issue === undefined) {
        return sendError(reply, 404, 'NOT_FOUND', '工單不存在');
      }
      const fieldValues = await issueRepo.listFieldValues(companyId, request.params.issueId, pool);
      const projection = await createIssueReadProjection(pool, currentIdentity(request));
      const visible = fieldValues.filter((row) => projection.inRecipe(row.issueId, row.fieldName)).map((row) =>
        projection.restrictedField(row.issueId, row.fieldName) ? { ...row, value: null, restricted: true } : row);
      return reply.status(200).send({ fieldValues: visible });
    },
  );

  app.get<{ Params: { issueId: string; fieldName: string } }>(
    '/issues/:issueId/fields/:fieldName',
    { schema: { params: fieldValueParams } },
    async (request, reply) => {
      const { companyId } = currentIdentity(request);
      const issue = await issueRepo.getIssue(companyId, request.params.issueId, pool);
      if (issue === undefined) {
        return sendError(reply, 404, 'NOT_FOUND', '工單不存在');
      }
      const fieldValue = await issueRepo.getFieldValue(
        companyId,
        request.params.issueId,
        request.params.fieldName,
        pool,
      );
      const projection = await createIssueReadProjection(pool, currentIdentity(request));
      if (projection.restrictedField(request.params.issueId, request.params.fieldName)) {
        return sendError(reply, 403, 'ROLLUP_SOURCE_FORBIDDEN', '彙總來源權限不足');
      }
      if (!projection.inRecipe(request.params.issueId, request.params.fieldName)) {
        return sendError(reply, 404, 'NOT_FOUND', '欄位不在此型別配方內');
      }
      if (fieldValue === undefined) {
        return sendError(reply, 404, 'NOT_FOUND', '欄位值不存在');
      }
      return reply.status(200).send({ fieldValue });
    },
  );

  // 寫入或覆蓋工單的單一欄位值。
  app.put<{
    Params: { issueId: string; fieldName: string };
    Body: { value: unknown; rollupMode?: RollupMode | null };
  }>(
    '/issues/:issueId/fields/:fieldName',
    {
      schema: {
        params: fieldValueParams,
        body: {
          type: 'object',
          required: ['value'],
          additionalProperties: false,
          properties: {
            // value 為任意 JSON，以 jsonb 儲存，不加型別限制。
            value: {},
            rollupMode: { type: ['string', 'null'], enum: ['auto', 'manual', null] },
          },
        },
      },
    },
    async (request, reply) => {
      const { accountId, companyId } = currentIdentity(request);
      const issue = await issueRepo.getIssue(companyId, request.params.issueId, pool);
      if (issue === undefined) {
        return sendError(reply, 404, 'NOT_FOUND', '工單不存在');
      }
      const { issueId, fieldName } = request.params;
      if (fieldName === FIELD_STATUS || fieldName === FIELD_RESOLUTION) {
        return sendError(
          reply,
          422,
          'FIELD_REQUIRES_WORKFLOW_TRANSITION',
          `${fieldName} 受工單流程規則管制，請走 PATCH /api/workspace/issues/:issueId`,
        );
      }
      try {
        const fieldValue = await withTransaction((tx) => writeField(tx, companyId, issueId, fieldName,
          request.body.value, accountId, request.body.rollupMode), pool);
        const projection = await createIssueReadProjection(pool, currentIdentity(request));
        return reply.status(200).send({ fieldValue: projection.restrictedField(issueId, fieldName)
          ? { ...fieldValue, value: null, restricted: true } : fieldValue });
      } catch (error: unknown) {
        if (isForeignKeyViolation(error)) {
          return sendError(reply, 422, 'FIELD_NOT_DEFINED', '該欄位未在此 Company 定義');
        }
        throw error;
      }
    },
  );

  app.delete<{ Params: { issueId: string; fieldName: string } }>(
    '/issues/:issueId/fields/:fieldName',
    { schema: { params: fieldValueParams } },
    async (request, reply) => {
      const { companyId, accountId } = currentIdentity(request);
      const issue = await issueRepo.getIssue(companyId, request.params.issueId, pool);
      if (issue === undefined) {
        return sendError(reply, 404, 'NOT_FOUND', '工單不存在');
      }
      const removed = await withTransaction(async (tx) => {
        const { issueId, fieldName } = request.params;
        await containerRepo.lockCompanyForUpdate(companyId, tx);
        if (await issueRepo.getFieldValue(companyId, issueId, fieldName, tx) === undefined) return false;
        await writeField(tx, companyId, issueId, fieldName, null, accountId);
        const def = await fieldRepo.findFieldDef(companyId, fieldName, tx);
        if (!def?.rollupable) await issueRepo.deleteFieldValue(companyId, issueId, fieldName, tx);
        return true;
      }, pool);
      if (!removed) {
        return sendError(reply, 404, 'NOT_FOUND', '欄位值不存在');
      }
      return reply.status(204).send();
    },
  );

  // ==========================================================
  // 工單異動歷史（ChangeLog）
  //
  // 唯讀列出，供工單詳情頁的異動歷史區使用。對齊 Spec
  // no3_logics/no6_changelog_logic.md 的 listIssueChangelog：純讀取、
  // 依時間新到舊排序。fieldRepo.listChangeLog 回傳的是寫入（追加）順序，
  // 即由舊到新，本路由反轉後送出以滿足該讀取契約；記錄本身的寫入（含
  // 追蹤範圍判斷）仍只由 recordFieldChange 經既有欄位寫入路徑產生，本路由
  // 不寫入任何資料。
  // ==========================================================

  app.get<{ Params: { issueId: string } }>(
    '/issues/:issueId/changelog',
    { schema: { params: idParams('issueId') } },
    async (request, reply) => {
      const { companyId } = currentIdentity(request);
      const issue = await issueRepo.getIssue(companyId, request.params.issueId, pool);
      if (issue === undefined) {
        return sendError(reply, 404, 'NOT_FOUND', '工單不存在');
      }
      const records = await fieldRepo.listChangeLog(companyId, request.params.issueId, pool);
      const projection = await createIssueReadProjection(pool, currentIdentity(request));
      const changeLog = [...records].reverse().map((record) => {
        const entry = record.value as { fieldName: string; oldValue: unknown; newValue: unknown };
        return projection.restrictedField(request.params.issueId, entry.fieldName)
          ? { ...record, value: { ...entry, oldValue: null, newValue: null, restricted: true } } : record;
      });
      return reply.status(200).send({ changeLog });
    },
  );
};
