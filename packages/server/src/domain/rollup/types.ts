// 彙總 domain 的型別。
//
// 命名對齊 spec 的實體與欄位名：IssueRelations、RelationTypeDefinitions、
// FieldDefs、IssueFieldValues、IssueFieldRecords。
// 本檔只宣告彙總計算真正讀到的欄位子集，不複製整份資料模型。
// 關聯兩個實體已由關聯完整性 domain 宣告，這裡取投影、不另立第二份定義；
// 日期原語與工作日曆走共用層，本檔不重宣告。

import type { IssueRelation, RelationTypeDefinition } from '../relation/types.js';
import type { IsoDate } from '../shared/index.js';
import { DomainError } from '../shared/index.js';

/** 可彙總欄位限四個，其餘欄位皆不彙總。 */
export type RollupableFieldName = 'StartTime' | 'EndTime' | 'StoryPoint' | 'WorkLog';

/**
 * 工時填報欄位名。
 *
 * 四個可彙總欄位裡唯一的多筆欄位，也是唯一恆為自動模式的欄位，
 * 三個行為都要單獨認它，欄位名因此收成常數。
 */
export const WORK_LOG_FIELD_NAME: RollupableFieldName = 'WorkLog';

/** `FieldDefs.rollupFn` 值域：最早、最晚、加總。 */
export type RollupFn = 'earliest' | 'latest' | 'sum';

/** `IssueFieldValues.rollupMode` 值域。 */
export type RollupMode = 'auto' | 'manual';

/** 彙總欄位的值：日期欄位為日期字串，點數與工時為數字。 */
export type RollupFieldValue = IsoDate | number;

/** 彙總結果；無可彙總下級或下級皆無值時為 null。 */
export type RollupValue = RollupFieldValue | null;

/** `RelationTypeDefinitions` 的彙總投影：只關心型別識別與彙總開關。 */
export type RollupRelationType = Pick<
  RelationTypeDefinition,
  'id' | 'companyId' | 'name' | 'rollup'
>;

/** `IssueRelations` 的彙總投影；關聯只存持有端一列，`fromIssueId` 為持有端。 */
export type RollupRelation = Pick<
  IssueRelation,
  'companyId' | 'fromIssueId' | 'toIssueId' | 'relationTypeId'
>;

/** `FieldDefs` 子集：彙總只關心可彙總旗標與算法。 */
export interface FieldDef {
  companyId: string;
  name: string;
  rollupable: boolean;
  rollupFn: RollupFn | null;
}

/** `IssueFieldValues` 子集；無值的欄位不存列。 */
export interface IssueFieldValue {
  companyId: string;
  issueId: string;
  fieldName: string;
  value: RollupFieldValue | null;
  rollupMode: RollupMode | null;
}

/** `IssueFieldRecords` 子集；承載 WorkLog 工時填報，一張工單多筆。 */
export interface IssueFieldRecord {
  id: string;
  companyId: string;
  issueId: string;
  fieldName: string;
  value: number;
}

/**
 * 彙總計算的資料快照。
 *
 * domain 為純函式、不做 IO，呼叫端一次帶入同一 Company 租戶內的資料；
 * 收集下級的範圍限本快照的 `companyId`，跨租戶的列一律忽略。
 */
export interface RollupSnapshot {
  companyId: string;
  relationTypes: RollupRelationType[];
  relations: RollupRelation[];
  fieldDefs: FieldDef[];
  fieldValues: IssueFieldValue[];
  fieldRecords: IssueFieldRecord[];
}

export type RollupErrorCode =
  /** 欄位在該 Company 的欄位定義不存在。 */
  | 'FIELD_NOT_DEFINED'
  /** 欄位的可彙總旗標為假，或未宣告彙總算法。 */
  | 'FIELD_NOT_ROLLUPABLE'
  /** 關聯成環，彙總無法收斂。 */
  | 'RELATION_CYCLE'
  /** 生效模式非 manual，偏離計算不適用。 */
  | 'NOT_MANUAL_MODE';

/** 彙總邏輯的錯誤，用於呼叫端違反前置條件的路徑。 */
export class RollupError extends DomainError<RollupErrorCode> {}
