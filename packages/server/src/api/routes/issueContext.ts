import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { currentIdentity } from '../../auth/middleware.js';
import { withTransaction } from '../../db/client.js';
import { calendarRepo, containerRepo, fieldRepo, issueRepo, permissionRepo } from '../../db/repositories/index.js';
import { assertWorkLogWritable, readRollupStatus } from '../../db/repositories/rollupRepo.js';
import { permissionAtIssueSet } from '../issueAccess.js';
import { sendError } from '../errors.js';
import { createIssueReadProjection } from '../issueReadProjection.js';

const uuid = { type: 'string', pattern: '^[0-9a-fA-F-]{36}$' } as const;
const params = { type: 'object', required: ['issueId'], properties: { issueId: uuid } } as const;
const recordParams = { type: 'object', required: ['issueId', 'recordId'], properties: { issueId: uuid, recordId: uuid } } as const;
const body = { type: 'object', additionalProperties: false, required: ['hours'], properties: { hours: { type: 'number', exclusiveMinimum: 0 } } } as const;

/** 由 issues 路由安裝，共用工單讀寫權限 guard。 */
export function installIssueContextRoutes(app: FastifyInstance, pool: Pool) {
  app.get<{ Params: { issueId: string }; Querystring: { calendarName?: string } }>('/issues/:issueId/context',
    { schema: { params, querystring: { type: 'object', additionalProperties: false, properties: { calendarName: { type: 'string' } } } } },
    async (request) => {
      const identity = currentIdentity(request);
      const { companyId, accountId } = identity;
      const { issueId } = request.params;
      const issue = (await issueRepo.getIssue(companyId, issueId, pool))!;
      const permission = await permissionAtIssueSet(pool, identity, issue.issueSetId);
      const creator = await issueRepo.getFieldValue(companyId, issueId, 'CreateBy', pool);
      const account = await permissionRepo.getAccount(pool, companyId, accountId);
      const calendarName = request.query.calendarName || account?.defaultCalendarName || null;
      const calendar = calendarName ? await calendarRepo.getCalendar(pool, companyId, calendarName) ?? null : null;
      const projection = await createIssueReadProjection(pool, identity);
      const rollups = (await readRollupStatus(pool, companyId, issueId, calendar)).map((row) =>
        projection.restrictedField(issueId, row.fieldName) ? { ...row, value: null, deviation: { deviated: false }, restricted: true } : row);
      return {
        canEdit: permission.canEditAny || (permission.canEditOwn && creator?.value === accountId),
        canArchive: permission.canArchive,
        calendarName: calendar?.name ?? null,
        rollups,
        worklogs: await fieldRepo.listFieldRecords(companyId, issueId, 'WorkLog', pool),
      };
    });

  app.post<{ Params: { issueId: string }; Body: { hours: number } }>('/issues/:issueId/worklogs',
    { schema: { params, body } }, async (request, reply) => {
      const { companyId, accountId } = currentIdentity(request);
      const { issueId } = request.params;
      const record = await withTransaction(async (tx) => {
        await containerRepo.lockCompanyForUpdate(companyId, tx);
        await assertWorkLogWritable(tx, companyId, issueId);
        return fieldRepo.appendFieldRecord({ id: randomUUID(), companyId, issueId,
          fieldName: 'WorkLog', value: request.body.hours, authorId: accountId, createdOn: Date.now() }, tx);
      }, pool);
      return reply.status(201).send({ record });
    });

  app.put<{ Params: { issueId: string; recordId: string }; Body: { hours: number } }>('/issues/:issueId/worklogs/:recordId',
    { schema: { params: recordParams, body } }, async (request, reply) => {
      const { companyId } = currentIdentity(request);
      const { issueId, recordId } = request.params;
      const record = await withTransaction(async (tx) => {
        await containerRepo.lockCompanyForUpdate(companyId, tx);
        const old = await fieldRepo.findFieldRecordById(companyId, recordId, tx);
        if (!old || old.issueId !== issueId || old.fieldName !== 'WorkLog') return undefined;
        await assertWorkLogWritable(tx, companyId, issueId);
        return fieldRepo.updateFieldRecordValue(companyId, recordId, request.body.hours, tx);
      }, pool);
      if (!record) return sendError(reply, 404, 'NOT_FOUND', '工時記錄不存在');
      return { record };
    });

  app.delete<{ Params: { issueId: string; recordId: string } }>('/issues/:issueId/worklogs/:recordId',
    { schema: { params: recordParams } }, async (request, reply) => {
      const { companyId } = currentIdentity(request);
      const { issueId, recordId } = request.params;
      const removed = await withTransaction(async (tx) => {
        await containerRepo.lockCompanyForUpdate(companyId, tx);
        const old = await fieldRepo.findFieldRecordById(companyId, recordId, tx);
        if (!old || old.issueId !== issueId || old.fieldName !== 'WorkLog') return false;
        await assertWorkLogWritable(tx, companyId, issueId);
        return fieldRepo.deleteFieldRecord(companyId, recordId, tx);
      }, pool);
      if (!removed) return sendError(reply, 404, 'NOT_FOUND', '工時記錄不存在');
      return reply.status(204).send();
    });
}
