// 工單 API · /api/issues 之下的單張工單讀取與泛用欄位寫入、異動歷史
//
// 供工單詳情頁使用。欄位單值的一般寫入（PUT /issues/:issueId/fields/:fieldName）
// 已會記變更歷史，非白名單欄位（title/status/resolution/assignee/point/due
// 以外）的編輯走這條；白名單欄位仍走 workspace.ts 既有的 PATCH。

import { apiFetch } from './client';
import type { ChangeLogEntry, IssueContext, IssueFieldValue, IssueSummary, WorkLogRecord } from './types';

/** 取單張工單的基本識別（不含欄位值）；查無時 apiFetch 對 404 拋 ApiError。 */
export async function getIssue(issueId: string): Promise<IssueSummary> {
  const res = await apiFetch<{ issue: IssueSummary }>(`/api/issues/${issueId}`);
  return res.issue;
}

export async function getIssueByKey(key: string): Promise<IssueSummary> {
  return (await apiFetch<{ issue: IssueSummary }>(`/api/issues/by-key/${encodeURIComponent(key)}`)).issue;
}

export function getIssueContext(issueId: string, calendarName?: string | null): Promise<IssueContext> {
  return apiFetch(`/api/issues/${issueId}/context${calendarName ? `?calendarName=${encodeURIComponent(calendarName)}` : ''}`);
}

export async function writeWorkLog(issueId: string, hours: number, recordId?: string): Promise<WorkLogRecord> {
  return (await apiFetch<{ record: WorkLogRecord }>(`/api/issues/${issueId}/worklogs${recordId ? `/${recordId}` : ''}`,
    { method: recordId ? 'PUT' : 'POST', body: { hours } })).record;
}

export function removeWorkLog(issueId: string, recordId: string): Promise<void> {
  return apiFetch(`/api/issues/${issueId}/worklogs/${recordId}`, { method: 'DELETE' });
}

/** 列出一張工單的全部單值欄位。 */
export async function listFieldValues(issueId: string): Promise<readonly IssueFieldValue[]> {
  const res = await apiFetch<{ fieldValues: readonly IssueFieldValue[] }>(
    `/api/issues/${issueId}/fields`,
  );
  return res.fieldValues;
}

/** 寫入一張工單的單一泛用欄位值；status／resolution 受工單流程規則管制，走此路徑會被後端擋下。 */
export async function updateFieldValue(
  issueId: string,
  fieldName: string,
  value: unknown,
  rollupMode?: 'auto' | 'manual',
): Promise<IssueFieldValue> {
  const res = await apiFetch<{ fieldValue: IssueFieldValue }>(
    `/api/issues/${issueId}/fields/${encodeURIComponent(fieldName)}`,
    { method: 'PUT', body: { value, ...(rollupMode ? { rollupMode } : {}) } },
  );
  return res.fieldValue;
}

/**
 * 後端 GET /issues/:issueId/changelog 的原始 wire 形狀：ChangeLog 是系統多筆
 * 欄位，單筆記錄的異動內容本體落在 value（對齊 domain 的 ChangeLogEntry）。
 * 本檔把它攤平成好用的 ChangeLogEntry（帶 id），畫面層不必穿透這層包裝。
 */
interface ChangeLogRecordWire {
  readonly id: string;
  readonly value: {
    readonly fieldName: string;
    readonly oldValue: unknown;
    readonly newValue: unknown;
    readonly actor: string;
    readonly time: number;
  };
}

/** 列出一張工單的異動歷史；伺服器端已依時間新到舊排序。 */
export async function listChangelog(issueId: string): Promise<readonly ChangeLogEntry[]> {
  const res = await apiFetch<{ changeLog: readonly ChangeLogRecordWire[] }>(
    `/api/issues/${issueId}/changelog`,
  );
  return res.changeLog.map((record) => ({ id: record.id, ...record.value }));
}
