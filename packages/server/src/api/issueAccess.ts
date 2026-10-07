import type { FastifyReply, preHandlerHookHandler } from 'fastify';
import type { Pool } from 'pg';
import { currentIdentity } from '../auth/middleware.js';
import type { ResolvedIdentity } from '../auth/service.js';
import { containerRepo, fieldRepo, issueRepo, permissionRepo, relationRepo } from '../db/repositories/index.js';
import type { Executor } from '../db/repositories/executor.js';
import { buildContainerIndex, computeEffectivePermission, hasCompanySwitch } from '../permission/index.js';
import { sendError } from './errors.js';

export function makeDefinitionAccessGuard(pool: Pool): preHandlerHookHandler {
  return async (request, reply) => {
    if (request.method === 'GET') return;
    const { companyId, accountId } = currentIdentity(request);
    const bundles = await permissionRepo.getEffectivePermissionInputs(pool, companyId, accountId);
    if (!hasCompanySwitch(bundles, 'typeAdmin')) {
      void sendError(reply, 403, 'FORBIDDEN', '需要型別維護權限');
    }
  };
}

export async function permissionAtIssueSet(exec: Executor, identity: ResolvedIdentity, issueSetId: string) {
  const issueSet = await containerRepo.getIssueSet(identity.companyId, issueSetId, exec);
  const bundles = await permissionRepo.getEffectivePermissionInputs(exec, identity.companyId, identity.accountId);
  const tree = await containerRepo.getContainerTree(identity.companyId, exec);
  return computeEffectivePermission(bundles, buildContainerIndex(tree ?? { id: identity.companyId, name: '', teams: [] }),
    issueSet === undefined ? undefined : { kind: 'mgmt', id: issueSet.mgmtId });
}

export async function issueCapabilities(exec: Executor, identity: ResolvedIdentity, issueId: string) {
  const issue = await issueRepo.getIssue(identity.companyId, issueId, exec);
  if (!issue) return { canRead: false, canEdit: false, canArchive: false };
  const permission = await permissionAtIssueSet(exec, identity, issue.issueSetId);
  const creator = await issueRepo.getFieldValue(identity.companyId, issueId, 'CreateBy', exec);
  return { canRead: permission.canRead,
    canEdit: permission.canRead && (permission.canEditAny || (permission.canEditOwn && creator?.value === identity.accountId)),
    canArchive: permission.canRead && permission.canArchive };
}

export async function canRemoveRelation(exec: Executor, identity: ResolvedIdentity,
  relation: { fromIssueId: string; toIssueId: string; relationTypeId: string }) {
  const source = await issueCapabilities(exec, identity, relation.fromIssueId);
  const type = await relationRepo.findRelationTypeById(identity.companyId, relation.relationTypeId, exec);
  if (!type?.symmetric) return source.canEdit;
  const target = await issueCapabilities(exec, identity, relation.toIssueId);
  return (source.canEdit && target.canRead) || (target.canEdit && source.canRead);
}

export async function requireIssueAccess(
  exec: Executor, identity: ResolvedIdentity, issueId: string,
  action: 'read' | 'edit' | 'archive', reply: FastifyReply,
): Promise<boolean> {
  const issue = await issueRepo.getIssue(identity.companyId, issueId, exec);
  if (issue === undefined) {
    void sendError(reply, 404, 'NOT_FOUND', '工單不存在');
    return false;
  }
  const permission = await permissionAtIssueSet(exec, identity, issue.issueSetId);
  const creator = action === 'edit'
    ? await issueRepo.getFieldValue(identity.companyId, issueId, 'CreateBy', exec) : undefined;
  const allowed = permission.canRead && (action === 'read' ||
    (action === 'archive' ? permission.canArchive : permission.canEditAny ||
      (permission.canEditOwn && creator?.value === identity.accountId)));
  if (!allowed) void sendError(reply, 403, 'FORBIDDEN', '沒有此工單的操作權限');
  return allowed;
}

/** 工單路由與工作區 PATCH 共用，授權先於任何欄位讀寫。 */
export function makeIssueAccessGuard(pool: Pool): preHandlerHookHandler {
  return async (request, reply) => {
    const identity = currentIdentity(request);
    const params = request.params as { issueId?: string; issueSetId?: string; fieldName?: string };
    if (params.issueSetId !== undefined) {
      const issueSet = await containerRepo.getIssueSet(identity.companyId, params.issueSetId, pool);
      if (issueSet === undefined) return;
      const permission = await permissionAtIssueSet(pool, identity, params.issueSetId);
      if (!permission.canRead || (request.method !== 'GET' && !permission.canCreate)) {
        void sendError(reply, 403, 'FORBIDDEN', '沒有此管理域的操作權限');
      }
      return;
    }
    if (params.issueId === undefined) return;
    const action = request.method === 'GET' ? 'read'
      : request.method === 'DELETE' && request.routeOptions.url?.endsWith('/issues/:issueId') ? 'archive' : 'edit';
    if (!(await requireIssueAccess(pool, identity, params.issueId, action, reply))) return;
    const body = request.body as { issueSetId?: string } | undefined;
    if (body?.issueSetId !== undefined) {
      if (await containerRepo.getIssueSet(identity.companyId, body.issueSetId, pool) === undefined) return;
      const permission = await permissionAtIssueSet(pool, identity, body.issueSetId);
      if (!permission.canRead || !permission.canCreate) {
        void sendError(reply, 403, 'FORBIDDEN', '沒有目標管理域的建單權限');
        return;
      }
    }
    if (params.fieldName !== undefined && request.method !== 'GET') {
      const field = await fieldRepo.findFieldDef(identity.companyId, params.fieldName, pool);
      if (['status', 'resolution'].includes(params.fieldName)) {
        void sendError(reply, 422, 'FIELD_REQUIRES_WORKFLOW_TRANSITION', '流程欄位只能透過狀態轉換修改');
      } else if (field?.readonly || params.fieldName === 'CreateBy') {
        void sendError(reply, 422, 'FIELD_READONLY', '此欄位由系統維護');
      }
    }
  };
}
