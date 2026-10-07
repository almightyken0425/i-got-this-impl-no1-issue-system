import type { DayUnit, WorkCalendar } from '../shared/index.js';
import { differenceInCalendarDays, differenceInWorkingDays } from '../shared/index.js';
import { computeRollupValue } from './computeRollupValue.js';
import { resolveEffectiveMode } from './resolveEffectiveMode.js';
import { findFieldValueRow, requireRollupFn } from './snapshot.js';
import type { RollupFieldValue, RollupSnapshot } from './types.js';
import { RollupError } from './types.js';

/** 差距值的單位；日期欄位沿用共用層的天數單位，估點另計為點數。 */
export type DeviationUnit = DayUnit | 'point';

export interface NoDeviation {
  deviated: false;
}

export interface Deviated {
  deviated: true;
  /** 欄位當下的手動主值。 */
  mainValue: RollupFieldValue;
  /** 背景算出的彙總值，不作為主值。 */
  rollupValue: RollupFieldValue;
  /** 彙總值減主值；正值代表下級超出持有端的宣告。 */
  delta: number;
  unit: DeviationUnit;
  /** 所用日曆名稱；日曆天單位時為空。 */
  calendarName: string | null;
}

export type Deviation = NoDeviation | Deviated;

/**
 * 計算偏離標示：手動模式欄位在背景計算彙總值，標示與主值的偏離。
 *
 * 背景計算，彙總值不作為主值。不設差距門檻，任何差距皆標示——
 * 差距多大算嚴重因團隊而異，給數字比替團隊訂線準確。
 * 採用日曆由呼叫端帶入；未設定日曆時天數退回日曆天。
 */
export function evaluateDeviation(
  snapshot: RollupSnapshot,
  issueId: string,
  fieldName: string,
  calendar: WorkCalendar | null,
): Deviation {
  requireRollupFn(snapshot, fieldName);

  if (resolveEffectiveMode(snapshot, issueId, fieldName) !== 'manual') {
    throw new RollupError(
      'NOT_MANUAL_MODE',
      `工單 ${issueId} 的欄位 ${fieldName} 生效模式非 manual，偏離計算不適用`,
    );
  }

  const rollupValue = computeRollupValue(snapshot, issueId, fieldName);
  const mainValue = findFieldValueRow(snapshot, issueId, fieldName)?.value;

  // 任一側缺值就沒有兩個數可比，不標示。
  if (rollupValue === null || mainValue == null || rollupValue === mainValue) {
    return { deviated: false };
  }

  if (typeof rollupValue === 'number' && typeof mainValue === 'number') {
    return {
      deviated: true,
      mainValue,
      rollupValue,
      delta: rollupValue - mainValue,
      unit: 'point',
      calendarName: null,
    };
  }

  const from = String(mainValue);
  const to = String(rollupValue);

  if (calendar === null) {
    return {
      deviated: true,
      mainValue,
      rollupValue,
      delta: differenceInCalendarDays(from, to),
      unit: 'calendarDay',
      calendarName: null,
    };
  }

  return {
    deviated: true,
    mainValue,
    rollupValue,
    delta: differenceInWorkingDays(calendar, from, to),
    unit: 'workingDay',
    calendarName: calendar.name,
  };
}
