// 工作區加值列的共用摺疊邏輯。
//
// workspace.ts（查工作區固定工單集）與 views.ts 的 /:id/workspace-issues
// （查檢視資料來源範圍）都需要把工單欄位單值摺成同一種加值列形狀，只是
// 輸入來源不同（前者現查欄位值、後者用 applyViewFilter 候選已查好的
// fields）。收在這裡讓兩處共用一份，不各寫一份會飄移的摺疊規則。
//
// 不放進 domain/：這不是 spec Logic 層函式，是 workspace MVP 的欄位命名
// 投影，domain 不該認得 status/assignee 這些字面欄位名。

export const WORKSPACE_FIELD_TITLE = 'title';
export const WORKSPACE_FIELD_STATUS = 'status';
export const WORKSPACE_FIELD_ASSIGNEE = 'assignee';
export const WORKSPACE_FIELD_POINT = 'point';
export const WORKSPACE_FIELD_DUE = 'due';
export const WORKSPACE_FIELD_RESOLUTION = 'resolution';

/** status 欄位缺值時的顯示回退值，對齊 workspace.ts 的種子流程狀態初始值。 */
export const WORKSPACE_STATUS_FALLBACK = '待處理';

export interface WorkspaceIssueRow {
  readonly restrictedFields?: readonly string[];
  readonly fields: Readonly<Record<string, unknown>>;
  readonly id: string;
  readonly issueTypeId: string;
  readonly key: string;
  readonly title: string;
  readonly status: string;
  readonly assignee: string;
  readonly point: number | null;
  readonly due: string | null;
  readonly resolution: string | null;
}

export function asString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

/** 把欄位單值 map 摺成加值列的欄位子集，識別欄位由呼叫端補上。 */
export function foldWorkspaceIssueFields(
  fields: Readonly<Record<string, unknown>>,
  restrictedFields: readonly string[] = [],
): Omit<WorkspaceIssueRow, 'id' | 'key' | 'issueTypeId'> {
  const pointRaw = fields[WORKSPACE_FIELD_POINT];
  const dueRaw = fields[WORKSPACE_FIELD_DUE];
  const resolutionRaw = fields[WORKSPACE_FIELD_RESOLUTION];
  return {
    ...(restrictedFields.length ? { restrictedFields } : {}),
    fields,
    title: asString(fields[WORKSPACE_FIELD_TITLE]),
    status: asString(fields[WORKSPACE_FIELD_STATUS]) || WORKSPACE_STATUS_FALLBACK,
    assignee: asString(fields[WORKSPACE_FIELD_ASSIGNEE]),
    point: typeof pointRaw === 'number' ? pointRaw : null,
    due: typeof dueRaw === 'string' && dueRaw !== '' ? dueRaw : null,
    resolution: typeof resolutionRaw === 'string' && resolutionRaw !== '' ? resolutionRaw : null,
  };
}
