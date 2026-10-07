import {
  findFieldValueRow,
  findSubordinateIds,
  requireRollupFn,
  sumFieldRecords,
} from './snapshot.js';
import type { RollupFieldValue, RollupSnapshot, RollupValue } from './types.js';
import { RollupError, WORK_LOG_FIELD_NAME } from './types.js';

/**
 * 計算彙總值：依欄位宣告的算法，從下級工單算出彙總值。
 *
 * 純計算，不寫入欄位主值；無可彙總下級時回傳空值。
 * 下級的主值不分模式一律採信——手動模式的下級，其人工值就是持有端該看到的值。
 */
export function computeRollupValue(
  snapshot: RollupSnapshot,
  issueId: string,
  fieldName: string,
): RollupValue {
  const rollupFn = requireRollupFn(snapshot, fieldName);
  const subordinateIds = findSubordinateIds(snapshot, issueId);

  // 工時是四個可彙總欄位裡唯一的多筆欄位，值落在工時填報記錄、不在單值欄位。
  if (fieldName === WORK_LOG_FIELD_NAME) {
    return sumWorkLogSubtree(snapshot, subordinateIds, new Set([issueId]));
  }

  const values = subordinateIds
    .map((subordinateId) => findFieldValueRow(snapshot, subordinateId, fieldName)?.value)
    .filter((value): value is RollupFieldValue => value !== undefined && value !== null);

  if (values.length === 0) {
    return null;
  }

  switch (rollupFn) {
    case 'earliest':
      return values.reduce((earliest, value) => (value < earliest ? value : earliest));
    case 'latest':
      return values.reduce((latest, value) => (value > latest ? value : latest));
    case 'sum':
      return values.reduce<number>(
        (total, value) => total + (typeof value === 'number' ? value : 0),
        0,
      );
  }
}

/**
 * 工時累計整個下級子樹的填報。
 *
 * 與另外三個欄位不同：工時的值不在單值欄位、恆由執行者填在各層工單，
 * 持有端本身不填。逐層往下加總才能讓孫節點的工時進得了祖父。
 * 逐層下探是本模組唯一的遞迴路徑，環偵測也只在這裡。
 */
function sumWorkLogSubtree(
  snapshot: RollupSnapshot,
  subordinateIds: string[],
  visited: Set<string>,
  counted = new Set<string>(),
): number | null {
  if (subordinateIds.length === 0) {
    return null;
  }

  return subordinateIds.reduce((total, subordinateId) => {
    if (visited.has(subordinateId)) {
      throw new RollupError('RELATION_CYCLE', `工單 ${subordinateId} 的彙總關聯成環`);
    }
    if (counted.has(subordinateId)) return total;
    counted.add(subordinateId);

    const descendants = sumWorkLogSubtree(
      snapshot,
      findSubordinateIds(snapshot, subordinateId),
      new Set(visited).add(subordinateId),
      counted,
    );

    const reported = sumFieldRecords(snapshot, subordinateId, WORK_LOG_FIELD_NAME);

    return total + reported + (descendants ?? 0);
  }, 0);
}
