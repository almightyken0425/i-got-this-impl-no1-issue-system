import { randomUUID } from 'node:crypto';

import type { FastifyInstance, FastifyPluginAsync, preHandlerHookHandler } from 'fastify';
import type { Pool } from 'pg';

import { currentIdentity } from '../../auth/middleware.js';
import { withTransaction } from '../../db/client.js';
import { containerRepo, issueRepo, relationRepo, RelationRepoError } from '../../db/repositories/index.js';
import { refreshRollups } from '../../db/repositories/rollupRepo.js';
import { validateRelationTypeDefinition } from '../../domain/index.js';
import type { RelationTypeDefinition } from '../../domain/index.js';
import { sendError, sendValidationFailure } from '../errors.js';
import { canRemoveRelation, issueCapabilities, makeDefinitionAccessGuard, requireIssueAccess } from '../issueAccess.js';

// 關聯路由：/api/relations 之下的關聯型別定義讀寫、工單關聯建立與正反查。
//
// 本層只做協定轉換：schema 驗輸入、帶租戶鍵呼叫 repository、把結果碼轉 HTTP。
// 完整性判定全在 domain 與 repository：
// - 關聯型別開關組合檢查用 domain 的 validateRelationTypeDefinition，非法回 422
// - 工單關聯建立由 repository 的 createRelation 內跑 domain 的 validateRelationCreation，
//   失敗回 422；引用不存在的關聯型別由 repository 擲 RelationRepoError，同樣轉 422
// - 建立走 withTransaction 讓讀後寫原子完成，獨佔索引為併發下的硬底線

export interface RelationRoutesOptions {
  readonly pool: Pool;
  readonly requireAuth: preHandlerHookHandler;
}

// ---- 輸入 schema ----

const relationTypeBodySchema = {
  type: 'object',
  required: ['name'],
  additionalProperties: false,
  properties: {
    name: { type: 'string', minLength: 1, maxLength: 100 },
    exclusive: { type: 'boolean', default: false },
    acyclic: { type: 'boolean', default: false },
    ordered: { type: 'boolean', default: false },
    symmetric: { type: 'boolean', default: false },
    rollup: { type: 'boolean', default: false },
  },
} as const;

const createRelationBodySchema = {
  type: 'object',
  required: ['fromIssueId', 'toIssueId', 'relationTypeId'],
  additionalProperties: false,
  properties: {
    // Fastify 內建 ajv 無 format 外掛，識別碼以非空字串驗；不存在的 id 由查詢自然落空。
    fromIssueId: { type: 'string', minLength: 1 },
    toIssueId: { type: 'string', minLength: 1 },
    relationTypeId: { type: 'string', minLength: 1 },
    ordinal: { type: 'integer', minimum: 0 },
  },
} as const;

const idParamsSchema = {
  type: 'object',
  required: ['id'],
  properties: { id: { type: 'string', minLength: 1 } },
} as const;

const issueIdParamsSchema = {
  type: 'object',
  required: ['issueId'],
  properties: { issueId: { type: 'string', minLength: 1 } },
} as const;

const relationTypeQuerySchema = {
  type: 'object',
  additionalProperties: false,
  properties: { relationTypeId: { type: 'string', minLength: 1 } },
} as const;

interface RelationTypeBody {
  readonly name: string;
  readonly exclusive?: boolean;
  readonly acyclic?: boolean;
  readonly ordered?: boolean;
  readonly symmetric?: boolean;
  readonly rollup?: boolean;
}

interface CreateRelationBody {
  readonly fromIssueId: string;
  readonly toIssueId: string;
  readonly relationTypeId: string;
  readonly ordinal?: number;
}

export const relationRoutes: FastifyPluginAsync<RelationRoutesOptions> = async (
  app: FastifyInstance,
  opts,
) => {
  const { pool, requireAuth } = opts;

  // 全路由掛認證：無有效 session 一律 401。
  app.addHook('preHandler', requireAuth);
  app.addHook('preHandler', async (request, reply) => {
    const identity = currentIdentity(request);
    const params = request.params as { issueId?: string; id?: string };
    if (params.issueId !== undefined) {
      await requireIssueAccess(pool, identity, params.issueId, 'read', reply);
    } else if (request.routeOptions.url?.endsWith('/edges') && request.method === 'POST') {
      const body = request.body as CreateRelationBody;
      if (!(await requireIssueAccess(pool, identity, body.fromIssueId, 'edit', reply))) return;
      await requireIssueAccess(pool, identity, body.toIssueId, 'read', reply);
    } else if (request.routeOptions.url?.endsWith('/edges/:id') && request.method === 'DELETE') {
      const relation = await relationRepo.findRelationById(identity.companyId, params.id!, pool);
      if (relation !== undefined && !(await canRemoveRelation(pool, identity, relation))) {
        void sendError(reply, 403, 'FORBIDDEN', '沒有此關聯的移除權限');
      }
    }
  });

  // ---- 關聯型別定義 ----

  // 建立關聯型別；開關組合先過 domain 檢查，名稱在 Company 內唯一。
  app.post<{ Body: RelationTypeBody }>(
    '/types',
    { schema: { body: relationTypeBodySchema }, preHandler: makeDefinitionAccessGuard(pool) },
    async (request, reply) => {
      const { companyId } = currentIdentity(request);
      const switches = {
        exclusive: request.body.exclusive ?? false,
        acyclic: request.body.acyclic ?? false,
        ordered: request.body.ordered ?? false,
        symmetric: request.body.symmetric ?? false,
        rollup: request.body.rollup ?? false,
      };
      const check = validateRelationTypeDefinition(switches);
      if (!check.ok) {
        return sendValidationFailure(reply, check);
      }

      const existing = await relationRepo.findRelationTypeByName(companyId, request.body.name, pool);
      if (existing !== undefined) {
        return sendError(reply, 409, 'RELATION_TYPE_NAME_TAKEN', '關聯型別名稱已存在');
      }

      const now = Date.now();
      const def: RelationTypeDefinition = {
        id: randomUUID(),
        companyId,
        name: request.body.name,
        ...switches,
        system: false,
        createdOn: now,
        updatedOn: now,
      };
      const written = await relationRepo.insertRelationType(def, pool);
      return reply.status(201).send({ relationType: written });
    },
  );

  // 列出本 Company 的關聯型別，依名稱排序。
  app.get('/types', async (request, reply) => {
    const { companyId } = currentIdentity(request);
    const types = await relationRepo.listRelationTypes(companyId, pool);
    return reply.status(200).send({ relationTypes: types });
  });

  // 取單一關聯型別；查無回 404。
  app.get<{ Params: { id: string } }>(
    '/types/:id',
    { schema: { params: idParamsSchema } },
    async (request, reply) => {
      const { companyId } = currentIdentity(request);
      const type = await relationRepo.findRelationTypeById(companyId, request.params.id, pool);
      if (type === undefined) {
        return sendError(reply, 404, 'RELATION_TYPE_NOT_FOUND', '關聯型別不存在');
      }
      return reply.status(200).send({ relationType: type });
    },
  );

  // ---- 工單關聯 ----

  // 建立工單關聯；完整性檢查在 repository 的 createRelation 內完成，讀後寫走同一交易。
  app.post<{ Body: CreateRelationBody }>(
    '/edges',
    { schema: { body: createRelationBodySchema } },
    async (request, reply) => {
      const { companyId, accountId } = currentIdentity(request);
      const now = Date.now();
      try {
        const result = await withTransaction(
          async (tx) => {
            await containerRepo.lockCompanyForUpdate(companyId, tx);
            const result = await relationRepo.createRelation(
              {
                id: randomUUID(),
                companyId,
                fromIssueId: request.body.fromIssueId,
                toIssueId: request.body.toIssueId,
                relationTypeId: request.body.relationTypeId,
                ordinal: request.body.ordinal ?? 0,
                createdOn: now,
                updatedOn: now,
              },
              tx,
            );
            if (result.ok) await refreshRollups(tx, companyId, accountId);
            return result;
          },
          pool,
        );
        if (!result.ok) {
          return sendValidationFailure(reply, result);
        }
        return reply.status(201).send({ relation: result.relation });
      } catch (error: unknown) {
        if (error instanceof RelationRepoError) {
          return sendError(reply, 422, error.code, error.message);
        }
        throw error;
      }
    },
  );

  // 正查：以持有端取其持有的關聯；可選 relationTypeId 限型別。
  app.get<{ Params: { issueId: string }; Querystring: { relationTypeId?: string } }>(
    '/edges/from/:issueId',
    { schema: { params: issueIdParamsSchema, querystring: relationTypeQuerySchema } },
    async (request, reply) => {
      const { companyId } = currentIdentity(request);
      const relations = await relationRepo.findRelationsFromIssue(
        companyId,
        request.params.issueId,
        request.query.relationTypeId,
        pool,
      );
      const visible = await Promise.all(relations.map(async (relation) => ({
        ...relation,
        counterpartKey: (await issueRepo.getIssue(companyId, relation.toIssueId, pool))?.issueKey ?? relation.toIssueId,
        counterpartReadable: (await issueCapabilities(pool, currentIdentity(request), relation.toIssueId)).canRead,
        canRemove: await canRemoveRelation(pool, currentIdentity(request), relation),
      })));
      return reply.status(200).send({ relations: visible });
    },
  );

  // 反查：以被指端取指向它的關聯；可選 relationTypeId 限型別。
  app.get<{ Params: { issueId: string }; Querystring: { relationTypeId?: string } }>(
    '/edges/to/:issueId',
    { schema: { params: issueIdParamsSchema, querystring: relationTypeQuerySchema } },
    async (request, reply) => {
      const { companyId } = currentIdentity(request);
      const relations = await relationRepo.findRelationsToIssue(
        companyId,
        request.params.issueId,
        request.query.relationTypeId,
        pool,
      );
      const visible = await Promise.all(relations.map(async (relation) => ({
        ...relation,
        counterpartKey: (await issueRepo.getIssue(companyId, relation.fromIssueId, pool))?.issueKey ?? relation.fromIssueId,
        counterpartReadable: (await issueCapabilities(pool, currentIdentity(request), relation.fromIssueId)).canRead,
        canRemove: await canRemoveRelation(pool, currentIdentity(request), relation),
      })));
      return reply.status(200).send({ relations: visible });
    },
  );

  // 刪除工單關聯；命中回 204，查無回 404。
  app.delete<{ Params: { id: string } }>(
    '/edges/:id',
    { schema: { params: idParamsSchema } },
    async (request, reply) => {
      const { companyId, accountId } = currentIdentity(request);
      const deleted = await withTransaction(async (tx) => {
        await containerRepo.lockCompanyForUpdate(companyId, tx);
        const result = await relationRepo.deleteRelation(companyId, request.params.id, tx);
        if (result) await refreshRollups(tx, companyId, accountId);
        return result;
      }, pool);
      if (!deleted) {
        return sendError(reply, 404, 'RELATION_NOT_FOUND', '工單關聯不存在');
      }
      return reply.status(204).send();
    },
  );
};
