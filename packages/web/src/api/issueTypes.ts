// 工單型別 API · /api/issue-types 之下的工單型別讀寫
//
// 供 TypeDefinitionScreen 的「工單型別」分頁使用。

import { ApiError, apiFetch } from './client';
import { listFieldDefs } from './fields';
import type { FieldDef, IssueTypeDefinition, WorkflowDefinition } from './types';
import { getWorkflowDefinition } from './workflow';

export interface CreateIssueTypeInput {
  readonly name: string;
  readonly label: string;
  readonly fieldSets: readonly string[];
}

/** 建立工單型別；名稱在 Company 內唯一，後端一併帶入預設流程定義。 */
export async function createIssueType(input: CreateIssueTypeInput): Promise<IssueTypeDefinition> {
  const res = await apiFetch<{ issueType: IssueTypeDefinition }>('/api/issue-types', {
    method: 'POST',
    body: input,
  });
  return res.issueType;
}

/** 列出本 Company 的工單型別，依名稱排序。 */
export async function listIssueTypes(): Promise<readonly IssueTypeDefinition[]> {
  const res = await apiFetch<{ issueTypes: readonly IssueTypeDefinition[] }>('/api/issue-types');
  return res.issueTypes;
}

export interface IssueTypeDetails {
  readonly fieldDefs: readonly FieldDef[];
  readonly singleFieldDefs: readonly FieldDef[];
  readonly workflow: WorkflowDefinition;
}

/** 依工單所屬型別取得詳情欄位與流程，保留完整欄位名稱供歷史記錄顯示。 */
export async function getIssueTypeDetails(issueTypeId: string): Promise<IssueTypeDetails> {
  const [issueTypes, fieldDefs, workflow] = await Promise.all([
    listIssueTypes(),
    listFieldDefs(),
    getWorkflowDefinition(issueTypeId),
  ]);
  const issueType = issueTypes.find((type) => type.id === issueTypeId);
  if (issueType === undefined) {
    throw new ApiError(404, 'ISSUE_TYPE_NOT_FOUND', '找不到工單型別');
  }
  return {
    fieldDefs,
    singleFieldDefs: fieldDefs.filter(
      (field) => field.kind === 'single' && issueType.fieldSets.includes(field.fieldSetName),
    ),
    workflow,
  };
}

export interface UpdateIssueTypeInput {
  readonly label: string;
  readonly fieldSets: readonly string[];
}

/** 改工單型別的顯示名稱與欄位組配方；識別名稱與系統旗標不動。 */
export async function updateIssueType(
  id: string,
  input: UpdateIssueTypeInput,
): Promise<IssueTypeDefinition> {
  const res = await apiFetch<{ issueType: IssueTypeDefinition }>(
    `/api/issue-types/${encodeURIComponent(id)}`,
    { method: 'PATCH', body: input },
  );
  return res.issueType;
}
