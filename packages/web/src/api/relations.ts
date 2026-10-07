// 關聯 API：定義建立、工單關聯建立、移除與正反查。

import { apiFetch } from './client';
import type { IssueRelation, RelationTypeDefinition } from './types';

export async function createRelationType(input: { name: string; exclusive?: boolean; acyclic?: boolean; ordered?: boolean; symmetric?: boolean; rollup?: boolean }): Promise<RelationTypeDefinition> {
  return (await apiFetch<{ relationType: RelationTypeDefinition }>('/api/relations/types', { method: 'POST', body: input })).relationType;
}

export async function createRelation(fromIssueId: string, toIssueId: string, relationTypeId: string): Promise<IssueRelation> {
  return (await apiFetch<{ relation: IssueRelation }>('/api/relations/edges', { method: 'POST', body: { fromIssueId, toIssueId, relationTypeId } })).relation;
}

export function removeRelation(id: string): Promise<void> {
  return apiFetch(`/api/relations/edges/${id}`, { method: 'DELETE' });
}

/** 列出本 Company 的關聯型別定義，依名稱排序。 */
export async function listRelationTypes(): Promise<readonly RelationTypeDefinition[]> {
  const res = await apiFetch<{ relationTypes: readonly RelationTypeDefinition[] }>(
    '/api/relations/types',
  );
  return res.relationTypes;
}

/** 正查：以持有端取其持有的關聯。 */
export async function listRelationsFrom(issueId: string): Promise<readonly IssueRelation[]> {
  const res = await apiFetch<{ relations: readonly IssueRelation[] }>(
    `/api/relations/edges/from/${issueId}`,
  );
  return res.relations;
}

/** 反查：以被指端取指向它的關聯。 */
export async function listRelationsTo(issueId: string): Promise<readonly IssueRelation[]> {
  const res = await apiFetch<{ relations: readonly IssueRelation[] }>(
    `/api/relations/edges/to/${issueId}`,
  );
  return res.relations;
}
