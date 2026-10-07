// 欄位 repository：欄位組定義、欄位定義、工單欄位多筆記錄的讀寫，及變更歷史寫入。
//
// 角色：domain 純函式與 PostgreSQL 之間的橋。
// - row（snake_case）轉 domain 型別（camelCase）由本檔的 mapper 承擔
// - 實體型別引用本層 types（FieldSetDef、FieldDef、IssueFieldRecord）與 domain 值域（RollupFn、RollupMode）
// - jsonb 欄位寫入前 JSON.stringify（與 schema 既有寫法一致），讀出時 driver 已還原為 JS 值
// - 全查詢帶 company_id 租戶鍵過濾，跨租戶資料互不可見
//
// 範圍分工：工單欄位「單值」IssueFieldValues 的讀寫由 issueRepo 承載
// （getFieldValue / setFieldValue / listFieldValues / deleteFieldValue），
// 避免同一表兩條寫入路徑。本檔專責欄位定義類、「多筆」記錄與變更歷史。

import type { Executor } from './executor.js';
import { getPool } from '../pool.js';
import { run, runOne } from './executor.js';
import type { FieldDef, FieldSetDef, IssueFieldRecord } from './types.js';
import type { ChangeLogEntry } from '../../domain/index.js';

// ============================================================
// row 型別與 mapper
// ============================================================

interface FieldSetRow {
  company_id: string;
  name: string;
  system: boolean;
}

interface FieldDefRow {
  company_id: string;
  name: string;
  field_set_name: string;
  kind: string;
  value_type: string;
  system: boolean;
  readonly: boolean;
  rollupable: boolean;
  rollup_fn: string | null;
  tracked: boolean;
  label: string;
}

interface IssueFieldRecordRow {
  id: string;
  company_id: string;
  issue_id: string;
  field_name: string;
  value: unknown; // jsonb，driver 已還原為 JS 值
  author_id: string;
  created_on: string; // bigint 由 driver 回傳為字串
}

function toFieldSetDef(row: FieldSetRow): FieldSetDef {
  return { companyId: row.company_id, name: row.name, system: row.system };
}

function toFieldDef(row: FieldDefRow): FieldDef {
  return {
    companyId: row.company_id,
    name: row.name,
    fieldSetName: row.field_set_name,
    kind: row.kind as FieldDef['kind'],
    valueType: row.value_type,
    system: row.system,
    readonly: row.readonly,
    rollupable: row.rollupable,
    rollupFn: row.rollup_fn as FieldDef['rollupFn'],
    tracked: row.tracked,
    label: row.label,
  };
}

function toIssueFieldRecord(row: IssueFieldRecordRow): IssueFieldRecord {
  return {
    id: row.id,
    companyId: row.company_id,
    issueId: row.issue_id,
    fieldName: row.field_name,
    value: row.value,
    authorId: row.author_id,
    createdOn: Number(row.created_on),
  };
}

// ============================================================
// 欄位組定義：讀寫
// ============================================================

/** 寫入一筆欄位組定義。複合主鍵為（companyId, name）。 */
export async function insertFieldSet(
  def: FieldSetDef,
  exec: Executor = getPool(),
): Promise<FieldSetDef> {
  const rows = await run<FieldSetRow>(
    exec,
    'INSERT INTO field_set_defs (company_id, name, system) VALUES ($1, $2, $3) RETURNING *',
    [def.companyId, def.name, def.system],
  );
  return toFieldSetDef(rows[0]!);
}

/** 依名稱查欄位組定義，限同 Company。 */
export async function findFieldSet(
  companyId: string,
  name: string,
  exec: Executor = getPool(),
): Promise<FieldSetDef | undefined> {
  const row = await runOne<FieldSetRow>(
    exec,
    'SELECT * FROM field_set_defs WHERE company_id = $1 AND name = $2',
    [companyId, name],
  );
  return row ? toFieldSetDef(row) : undefined;
}

/** 列出某 Company 的所有欄位組定義，依名稱排序。 */
export async function listFieldSets(
  companyId: string,
  exec: Executor = getPool(),
): Promise<FieldSetDef[]> {
  const rows = await run<FieldSetRow>(
    exec,
    'SELECT * FROM field_set_defs WHERE company_id = $1 ORDER BY name',
    [companyId],
  );
  return rows.map(toFieldSetDef);
}

/** 刪除一筆欄位組定義，限同 Company；回傳是否真的刪到一列。 */
export async function deleteFieldSet(
  companyId: string,
  name: string,
  exec: Executor = getPool(),
): Promise<boolean> {
  const rows = await run<{ name: string }>(
    exec,
    'DELETE FROM field_set_defs WHERE company_id = $1 AND name = $2 RETURNING name',
    [companyId, name],
  );
  return rows.length > 0;
}

// ============================================================
// 欄位定義：讀寫
// ============================================================

/**
 * 寫入一筆欄位定義。複合主鍵為（companyId, name）；
 * 所屬欄位組須先存在（外鍵 (companyId, fieldSetName) → field_set_defs）。
 */
export async function insertFieldDef(
  def: FieldDef,
  exec: Executor = getPool(),
): Promise<FieldDef> {
  const rows = await run<FieldDefRow>(
    exec,
    `INSERT INTO field_defs
       (company_id, name, field_set_name, kind, value_type, system, readonly, rollupable, rollup_fn, tracked, label)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
     RETURNING *`,
    [
      def.companyId,
      def.name,
      def.fieldSetName,
      def.kind,
      def.valueType,
      def.system,
      def.readonly,
      def.rollupable,
      def.rollupFn,
      def.tracked,
      def.label,
    ],
  );
  return toFieldDef(rows[0]!);
}

/** 依名稱查欄位定義，限同 Company。 */
export async function findFieldDef(
  companyId: string,
  name: string,
  exec: Executor = getPool(),
): Promise<FieldDef | undefined> {
  const row = await runOne<FieldDefRow>(
    exec,
    'SELECT * FROM field_defs WHERE company_id = $1 AND name = $2',
    [companyId, name],
  );
  return row ? toFieldDef(row) : undefined;
}

/** 列出某 Company 的所有欄位定義，依名稱排序。 */
export async function listFieldDefs(
  companyId: string,
  exec: Executor = getPool(),
): Promise<FieldDef[]> {
  const rows = await run<FieldDefRow>(
    exec,
    'SELECT * FROM field_defs WHERE company_id = $1 ORDER BY name',
    [companyId],
  );
  return rows.map(toFieldDef);
}

/** 列出某欄位組下的欄位定義，限同 Company，依名稱排序。 */
export async function listFieldDefsBySet(
  companyId: string,
  fieldSetName: string,
  exec: Executor = getPool(),
): Promise<FieldDef[]> {
  const rows = await run<FieldDefRow>(
    exec,
    'SELECT * FROM field_defs WHERE company_id = $1 AND field_set_name = $2 ORDER BY name',
    [companyId, fieldSetName],
  );
  return rows.map(toFieldDef);
}

/** 改欄位定義的顯示名稱，限同 Company；其餘欄位不動。查無回 undefined。 */
export async function updateFieldLabel(
  companyId: string,
  name: string,
  label: string,
  exec: Executor = getPool(),
): Promise<FieldDef | undefined> {
  const row = await runOne<FieldDefRow>(
    exec,
    'UPDATE field_defs SET label = $3 WHERE company_id = $1 AND name = $2 RETURNING *',
    [companyId, name, label],
  );
  return row ? toFieldDef(row) : undefined;
}

/** 刪除一筆欄位定義，限同 Company；回傳是否真的刪到一列。 */
export async function deleteFieldDef(
  companyId: string,
  name: string,
  exec: Executor = getPool(),
): Promise<boolean> {
  const rows = await run<{ name: string }>(
    exec,
    'DELETE FROM field_defs WHERE company_id = $1 AND name = $2 RETURNING name',
    [companyId, name],
  );
  return rows.length > 0;
}

// ============================================================
// 工單欄位多筆記錄：讀寫
// ============================================================

/** 追加一筆多筆記錄的輸入。 */
export interface AppendFieldRecordInput {
  readonly id: string;
  readonly companyId: string;
  readonly issueId: string;
  readonly fieldName: string;
  readonly value: unknown;
  readonly authorId: string;
  readonly createdOn: number;
}

/**
 * 追加一筆多筆記錄（留言、附件、工時、變更歷史等）。
 * 單筆帶自身 id 可獨立定位、引用、刪除。value 走 jsonb，寫入前 JSON.stringify。
 */
export async function appendFieldRecord(
  input: AppendFieldRecordInput,
  exec: Executor = getPool(),
): Promise<IssueFieldRecord> {
  const rows = await run<IssueFieldRecordRow>(
    exec,
    `INSERT INTO issue_field_records (id, company_id, issue_id, field_name, value, author_id, created_on)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     RETURNING *`,
    [
      input.id,
      input.companyId,
      input.issueId,
      input.fieldName,
      JSON.stringify(input.value),
      input.authorId,
      input.createdOn,
    ],
  );
  return toIssueFieldRecord(rows[0]!);
}

/** 列出一張工單某欄位的多筆記錄，限同 Company，依時間排序（追加順序）。 */
export async function listFieldRecords(
  companyId: string,
  issueId: string,
  fieldName: string,
  exec: Executor = getPool(),
): Promise<IssueFieldRecord[]> {
  const rows = await run<IssueFieldRecordRow>(
    exec,
    `SELECT * FROM issue_field_records
     WHERE company_id = $1 AND issue_id = $2 AND field_name = $3
     ORDER BY created_on, id`,
    [companyId, issueId, fieldName],
  );
  return rows.map(toIssueFieldRecord);
}

/** 依 id 查單筆記錄，限同 Company。 */
export async function findFieldRecordById(
  companyId: string,
  id: string,
  exec: Executor = getPool(),
): Promise<IssueFieldRecord | undefined> {
  const row = await runOne<IssueFieldRecordRow>(
    exec,
    'SELECT * FROM issue_field_records WHERE company_id = $1 AND id = $2',
    [companyId, id],
  );
  return row ? toIssueFieldRecord(row) : undefined;
}

/** 刪除一筆記錄，限同 Company；回傳是否真的刪到一列。 */
export async function deleteFieldRecord(
  companyId: string,
  id: string,
  exec: Executor = getPool(),
): Promise<boolean> {
  const rows = await run<{ id: string }>(
    exec,
    'DELETE FROM issue_field_records WHERE company_id = $1 AND id = $2 RETURNING id',
    [companyId, id],
  );
  return rows.length > 0;
}

/** 修正填報值，保留原作者與填報時間。 */
export async function updateFieldRecordValue(companyId: string, id: string, value: unknown, exec: Executor): Promise<IssueFieldRecord | undefined> {
  const row = await runOne<IssueFieldRecordRow>(exec,
    'UPDATE issue_field_records SET value = $3 WHERE company_id = $1 AND id = $2 RETURNING *',
    [companyId, id, JSON.stringify(value)]);
  return row ? toIssueFieldRecord(row) : undefined;
}

// ============================================================
// 變更歷史：寫入
// ============================================================

/** ChangeLog 欄位名；變更歷史以此欄位名的多筆記錄承載。 */
export const CHANGE_LOG_FIELD_NAME = 'ChangeLog';

/** 一筆變更歷史的內容；型別定義見 domain/changelog，本層不重造第二份。 */
export type { ChangeLogEntry } from '../../domain/index.js';

/** 追加一筆變更歷史的輸入。 */
export interface AppendChangeLogInput {
  readonly id: string;
  readonly companyId: string;
  readonly issueId: string;
  readonly entry: ChangeLogEntry;
  readonly authorId: string;
  readonly createdOn: number;
}

/**
 * 追加一筆變更歷史；本質是欄位名為 ChangeLog 的多筆記錄，value 存整個 entry。
 * 每次欄位異動由呼叫端建 entry 後追加，記錄只增不改。
 */
export async function appendChangeLog(
  input: AppendChangeLogInput,
  exec: Executor = getPool(),
): Promise<IssueFieldRecord> {
  return appendFieldRecord(
    {
      id: input.id,
      companyId: input.companyId,
      issueId: input.issueId,
      fieldName: CHANGE_LOG_FIELD_NAME,
      value: input.entry,
      authorId: input.authorId,
      createdOn: input.createdOn,
    },
    exec,
  );
}

/** 列出一張工單的變更歷史，限同 Company，依時間排序。 */
export async function listChangeLog(
  companyId: string,
  issueId: string,
  exec: Executor = getPool(),
): Promise<IssueFieldRecord[]> {
  return listFieldRecords(companyId, issueId, CHANGE_LOG_FIELD_NAME, exec);
}
