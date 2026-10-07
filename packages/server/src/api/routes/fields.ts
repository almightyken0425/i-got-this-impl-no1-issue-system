import type { FastifyInstance, FastifyPluginAsync, preHandlerHookHandler } from 'fastify';
import type { Pool } from 'pg';

import { currentIdentity } from '../../auth/middleware.js';
import { fieldRepo } from '../../db/repositories/index.js';
import type { FieldDef, FieldKind, FieldSetDef } from '../../db/repositories/index.js';
import type { RollupFn } from '../../domain/index.js';
import { isForeignKeyViolation, sendError } from '../errors.js';
import { makeDefinitionAccessGuard } from '../issueAccess.js';

// 欄位路由：/api/fields 之下的欄位組定義與欄位定義的讀寫。
//
// 本層只做協定轉換：schema 驗輸入、帶租戶鍵呼叫 repository、把結果碼轉 HTTP。
// 邊界：
// - 欄位組與欄位定義的複合主鍵為（companyId, name），重複名稱先查再回 409
// - 欄位定義所屬欄位組須先存在（外鍵），不存在回 422
// - 工單欄位單值（IssueFieldValues）的讀寫掛在工單路由 /api/issues 之下，不在本檔；
//   本檔專責定義類實體，避免同一張表兩條寫入路徑

export interface FieldRoutesOptions {
  readonly pool: Pool;
  readonly requireAuth: preHandlerHookHandler;
}

const FIELD_KINDS: readonly FieldKind[] = ['single', 'multi', 'relation'];
const ROLLUP_FNS: readonly RollupFn[] = ['earliest', 'latest', 'sum'];

// ---- 輸入 schema ----

const fieldSetBodySchema = {
  type: 'object',
  required: ['name'],
  additionalProperties: false,
  properties: { name: { type: 'string', minLength: 1, maxLength: 100 } },
} as const;

const fieldDefBodySchema = {
  type: 'object',
  required: ['name', 'fieldSetName', 'kind', 'valueType', 'label'],
  additionalProperties: false,
  properties: {
    name: { type: 'string', minLength: 1, maxLength: 100 },
    fieldSetName: { type: 'string', minLength: 1, maxLength: 100 },
    kind: { type: 'string', enum: [...FIELD_KINDS] },
    valueType: { type: 'string', minLength: 1, maxLength: 100 },
    label: { type: 'string', minLength: 1, maxLength: 200 },
    readonly: { type: 'boolean', default: false },
    rollupable: { type: 'boolean', default: false },
    rollupFn: { type: 'string', enum: [...ROLLUP_FNS, null], nullable: true },
    tracked: { type: 'boolean', default: false },
  },
} as const;

const nameParamsSchema = {
  type: 'object',
  required: ['name'],
  properties: { name: { type: 'string', minLength: 1 } },
} as const;

const fieldDefQuerySchema = {
  type: 'object',
  additionalProperties: false,
  properties: { fieldSetName: { type: 'string', minLength: 1 } },
} as const;

const fieldLabelBodySchema = {
  type: 'object',
  required: ['label'],
  additionalProperties: false,
  properties: { label: { type: 'string', minLength: 1, maxLength: 200 } },
} as const;

interface FieldSetBody {
  readonly name: string;
}

interface FieldLabelBody {
  readonly label: string;
}

interface FieldDefBody {
  readonly name: string;
  readonly fieldSetName: string;
  readonly kind: FieldKind;
  readonly valueType: string;
  readonly label: string;
  readonly readonly?: boolean;
  readonly rollupable?: boolean;
  readonly rollupFn?: RollupFn | null;
  readonly tracked?: boolean;
}

export const fieldRoutes: FastifyPluginAsync<FieldRoutesOptions> = async (
  app: FastifyInstance,
  opts,
) => {
  const { pool, requireAuth } = opts;

  app.addHook('preHandler', requireAuth);
  app.addHook('preHandler', makeDefinitionAccessGuard(pool));

  // ---- 欄位組定義 ----

  // 建立欄位組；名稱在 Company 內唯一。
  app.post<{ Body: FieldSetBody }>(
    '/sets',
    { schema: { body: fieldSetBodySchema } },
    async (request, reply) => {
      const { companyId } = currentIdentity(request);
      const existing = await fieldRepo.findFieldSet(companyId, request.body.name, pool);
      if (existing !== undefined) {
        return sendError(reply, 409, 'FIELD_SET_NAME_TAKEN', '欄位組名稱已存在');
      }
      const def: FieldSetDef = { companyId, name: request.body.name, system: false };
      const written = await fieldRepo.insertFieldSet(def, pool);
      return reply.status(201).send({ fieldSet: written });
    },
  );

  // 列出本 Company 的欄位組，依名稱排序。
  app.get('/sets', async (request, reply) => {
    const { companyId } = currentIdentity(request);
    const fieldSets = await fieldRepo.listFieldSets(companyId, pool);
    return reply.status(200).send({ fieldSets });
  });

  // 刪除欄位組；系統內建不可刪，還有欄位掛在底下也不可刪。
  app.delete<{ Params: { name: string } }>(
    '/sets/:name',
    { schema: { params: nameParamsSchema } },
    async (request, reply) => {
      const { companyId } = currentIdentity(request);
      const existing = await fieldRepo.findFieldSet(companyId, request.params.name, pool);
      if (existing === undefined) {
        return sendError(reply, 404, 'FIELD_SET_NOT_FOUND', '欄位組不存在');
      }
      if (existing.system) {
        return sendError(reply, 403, 'FIELD_SET_IS_SYSTEM', '系統內建欄位組不可刪除');
      }
      const fields = await fieldRepo.listFieldDefsBySet(companyId, request.params.name, pool);
      if (fields.length > 0) {
        return sendError(reply, 409, 'FIELD_SET_NOT_EMPTY', '欄位組底下還有欄位，須先刪除或搬移');
      }
      await fieldRepo.deleteFieldSet(companyId, request.params.name, pool);
      return reply.status(204).send();
    },
  );

  // ---- 欄位定義 ----

  // 建立欄位定義；所屬欄位組須先存在，名稱在 Company 內唯一。
  app.post<{ Body: FieldDefBody }>(
    '/defs',
    { schema: { body: fieldDefBodySchema } },
    async (request, reply) => {
      const { companyId } = currentIdentity(request);
      const body = request.body;

      const existing = await fieldRepo.findFieldDef(companyId, body.name, pool);
      if (existing !== undefined) {
        return sendError(reply, 409, 'FIELD_NAME_TAKEN', '欄位名稱已存在');
      }
      const parentSet = await fieldRepo.findFieldSet(companyId, body.fieldSetName, pool);
      if (parentSet === undefined) {
        return sendError(reply, 422, 'FIELD_SET_NOT_FOUND', '所屬欄位組不存在');
      }

      const rollupable = body.rollupable ?? false;
      if (rollupable && (body.kind !== 'single' || !body.rollupFn ||
        (body.rollupFn === 'sum' ? body.valueType !== 'number' : body.valueType !== 'date'))) {
        return sendError(reply, 422, 'INVALID_ROLLUP_DEFINITION', '單值數字需選加總，單值日期需選最早或最晚');
      }
      const def: FieldDef = {
        companyId,
        name: body.name,
        fieldSetName: body.fieldSetName,
        kind: body.kind,
        valueType: body.valueType,
        system: false,
        readonly: body.readonly ?? false,
        rollupable,
        // 不可彙總的欄位算法恆為 null，避免落地矛盾狀態。
        rollupFn: rollupable ? (body.rollupFn ?? null) : null,
        tracked: body.tracked ?? false,
        label: body.label,
      };
      const written = await fieldRepo.insertFieldDef(def, pool);
      return reply.status(201).send({ fieldDef: written });
    },
  );

  // 列出欄位定義；可選 fieldSetName 限某欄位組，皆依名稱排序。
  app.get<{ Querystring: { fieldSetName?: string } }>(
    '/defs',
    { schema: { querystring: fieldDefQuerySchema } },
    async (request, reply) => {
      const { companyId } = currentIdentity(request);
      const fieldDefs =
        request.query.fieldSetName === undefined
          ? await fieldRepo.listFieldDefs(companyId, pool)
          : await fieldRepo.listFieldDefsBySet(companyId, request.query.fieldSetName, pool);
      return reply.status(200).send({ fieldDefs });
    },
  );

  // 取單一欄位定義；查無回 404。
  app.get<{ Params: { name: string } }>(
    '/defs/:name',
    { schema: { params: nameParamsSchema } },
    async (request, reply) => {
      const { companyId } = currentIdentity(request);
      const def = await fieldRepo.findFieldDef(companyId, request.params.name, pool);
      if (def === undefined) {
        return sendError(reply, 404, 'FIELD_NOT_FOUND', '欄位定義不存在');
      }
      return reply.status(200).send({ fieldDef: def });
    },
  );

  // 改欄位定義的顯示名稱；系統內建不可改。
  app.patch<{ Params: { name: string }; Body: FieldLabelBody }>(
    '/defs/:name',
    { schema: { params: nameParamsSchema, body: fieldLabelBodySchema } },
    async (request, reply) => {
      const { companyId } = currentIdentity(request);
      const existing = await fieldRepo.findFieldDef(companyId, request.params.name, pool);
      if (existing === undefined) {
        return sendError(reply, 404, 'FIELD_NOT_FOUND', '欄位定義不存在');
      }
      if (existing.system) {
        return sendError(reply, 403, 'FIELD_IS_SYSTEM', '系統內建欄位不可編輯');
      }
      const updated = await fieldRepo.updateFieldLabel(companyId, request.params.name, request.body.label, pool);
      return reply.status(200).send({ fieldDef: updated });
    },
  );

  // 刪除欄位定義；系統內建不可刪；已有欄位值時外鍵會擋，轉乾淨的 409。
  app.delete<{ Params: { name: string } }>(
    '/defs/:name',
    { schema: { params: nameParamsSchema } },
    async (request, reply) => {
      const { companyId } = currentIdentity(request);
      const existing = await fieldRepo.findFieldDef(companyId, request.params.name, pool);
      if (existing === undefined) {
        return sendError(reply, 404, 'FIELD_NOT_FOUND', '欄位定義不存在');
      }
      if (existing.system) {
        return sendError(reply, 403, 'FIELD_IS_SYSTEM', '系統內建欄位不可刪除');
      }
      try {
        await fieldRepo.deleteFieldDef(companyId, request.params.name, pool);
      } catch (error: unknown) {
        if (isForeignKeyViolation(error)) {
          return sendError(reply, 409, 'FIELD_IN_USE', '欄位已有工單資料，不可刪除');
        }
        throw error;
      }
      return reply.status(204).send();
    },
  );
};
