// 快照查詢輔助。
//
// 彙總的六個行為都要沿關聯走圖、讀欄位值，查詢細節集中在此，
// 各行為檔只表達自己的規則。對外經 index.ts 匯出，供呼叫端組快照時共用同一組語意。

import type { IssueFieldValue, RollupFn, RollupSnapshot, RollupValue } from './types.js';
import { RollupError } from './types.js';

/**
 * 取欄位宣告的彙總算法。
 *
 * 可否彙總由欄位定義宣告，不由使用者逐張工單決定；不可彙總的欄位一律擲錯，
 * 讓呼叫端在開發期就撞牆，而不是拿到一個看似合理的空值。
 */
export function requireRollupFn(snapshot: RollupSnapshot, fieldName: string): RollupFn {
  const fieldDef = snapshot.fieldDefs.find(
    (def) => def.name === fieldName && def.companyId === snapshot.companyId,
  );

  if (fieldDef === undefined) {
    throw new RollupError(
      'FIELD_NOT_DEFINED',
      `欄位 ${fieldName} 不在 Company ${snapshot.companyId} 的欄位定義區`,
    );
  }

  if (!fieldDef.rollupable || fieldDef.rollupFn === null) {
    throw new RollupError('FIELD_NOT_ROLLUPABLE', `欄位 ${fieldName} 不可彙總`);
  }

  return fieldDef.rollupFn;
}

/** 該關聯型別的彙總開關是否為真；型別在定義區查不到時視為不彙總。 */
function isRollupRelation(snapshot: RollupSnapshot, relationTypeId: string): boolean {
  return (
    snapshot.relationTypes.find(
      (def) => def.id === relationTypeId && def.companyId === snapshot.companyId,
    )?.rollup === true
  );
}

/**
 * 目標工單持有的下級工單 id。
 *
 * 只沿彙總開關為真的關聯型別收集，收集範圍限本快照的 Company 租戶。
 */
export function findSubordinateIds(snapshot: RollupSnapshot, issueId: string): string[] {
  return [...new Set(snapshot.relations
    .filter(
      (rel) =>
        rel.fromIssueId === issueId &&
        rel.companyId === snapshot.companyId &&
        isRollupRelation(snapshot, rel.relationTypeId),
    )
    .map((rel) => rel.toIssueId))];
}

/**
 * 指向目標工單的持有端工單 id。
 *
 * 反查方向；同樣只沿彙總開關為真的關聯型別，範圍限本快照的 Company 租戶。
 */
export function findHolderIds(snapshot: RollupSnapshot, issueId: string): string[] {
  return snapshot.relations
    .filter(
      (rel) =>
        rel.toIssueId === issueId &&
        rel.companyId === snapshot.companyId &&
        isRollupRelation(snapshot, rel.relationTypeId),
    )
    .map((rel) => rel.fromIssueId);
}

/** 工單某欄位的單值列；無值的欄位不存列，回傳 undefined。 */
export function findFieldValueRow(
  snapshot: RollupSnapshot,
  issueId: string,
  fieldName: string,
): IssueFieldValue | undefined {
  return snapshot.fieldValues.find(
    (row) =>
      row.issueId === issueId &&
      row.fieldName === fieldName &&
      row.companyId === snapshot.companyId,
  );
}

/**
 * 帶著新主值的快照副本，原快照不動。
 *
 * 逐層往上重算時，上一層要看到下一層剛算完的值，才不會拿舊值再算一次。
 * 值為空代表該欄位無值——無值的欄位不存列，直接移除該列。
 */
export function withFieldValue(
  snapshot: RollupSnapshot,
  issueId: string,
  fieldName: string,
  value: RollupValue,
): RollupSnapshot {
  const existing = findFieldValueRow(snapshot, issueId, fieldName);
  const others = snapshot.fieldValues.filter((row) => row !== existing);

  if (value === null) {
    return { ...snapshot, fieldValues: others };
  }

  return {
    ...snapshot,
    fieldValues: [
      ...others,
      {
        companyId: snapshot.companyId,
        issueId,
        fieldName,
        value,
        // 自動模式寫入的值不得讓欄位在下次判定初值時被當成人填的值。
        rollupMode: existing?.rollupMode ?? 'auto',
      },
    ],
  };
}

/** 工單某多筆欄位的記錄值加總；無記錄時為 0。 */
export function sumFieldRecords(
  snapshot: RollupSnapshot,
  issueId: string,
  fieldName: string,
): number {
  return snapshot.fieldRecords
    .filter(
      (row) =>
        row.issueId === issueId &&
        row.fieldName === fieldName &&
        row.companyId === snapshot.companyId,
    )
    .reduce((total, row) => total + row.value, 0);
}
