import { findFieldValueRow, requireRollupFn } from './snapshot.js';
import type { RollupMode, RollupSnapshot } from './types.js';

/**
 * 決定模式初值：可彙總欄位尚無 `IssueFieldValues.rollupMode` 值時的初始模式。
 *
 * 有值代表人已經填過，續採信人填的；空的才交給彙總接手。
 */
export function initializeRollupMode(
  snapshot: RollupSnapshot,
  issueId: string,
  fieldName: string,
): RollupMode {
  requireRollupFn(snapshot, fieldName);

  return findFieldValueRow(snapshot, issueId, fieldName)?.value == null ? 'auto' : 'manual';
}
