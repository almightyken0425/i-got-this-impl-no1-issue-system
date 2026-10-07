import { describe, expect, it } from 'vitest';

import { computeRollupValue } from './computeRollupValue.js';
import {
  BEFORE_TYPE_ID,
  CHILDREN_TYPE_ID,
  CONTAINER_TYPE_ID,
  fieldValue,
  makeSnapshot,
  relation,
  workLog,
} from './fixtures.js';

describe('computeRollupValue 套用算法', () => {
  it('StartTime 取下級最早值', () => {
    const snap = makeSnapshot({
      relations: [relation('parent', 'child-a'), relation('parent', 'child-b')],
      fieldValues: [
        fieldValue('child-a', 'StartTime', '2026-03-18'),
        fieldValue('child-b', 'StartTime', '2026-02-02'),
      ],
    });

    expect(computeRollupValue(snap, 'parent', 'StartTime')).toBe('2026-02-02');
  });

  it('EndTime 取下級最晚值', () => {
    const snap = makeSnapshot({
      relations: [relation('parent', 'child-a'), relation('parent', 'child-b')],
      fieldValues: [
        fieldValue('child-a', 'EndTime', '2026-03-18'),
        fieldValue('child-b', 'EndTime', '2026-02-02'),
      ],
    });

    expect(computeRollupValue(snap, 'parent', 'EndTime')).toBe('2026-03-18');
  });

  it('StoryPoint 取下級值加總', () => {
    const snap = makeSnapshot({
      relations: [
        relation('parent', 'child-a'),
        relation('parent', 'child-b'),
        relation('parent', 'child-c'),
      ],
      fieldValues: [
        fieldValue('child-a', 'StoryPoint', 3),
        fieldValue('child-b', 'StoryPoint', 5),
        fieldValue('child-c', 'StoryPoint', 0.5),
      ],
    });

    expect(computeRollupValue(snap, 'parent', 'StoryPoint')).toBe(8.5);
  });

  it('WorkLog 取下級工時填報加總，同一張下級的多筆一併計入', () => {
    const snap = makeSnapshot({
      relations: [relation('parent', 'child-a'), relation('parent', 'child-b')],
      fieldRecords: [
        workLog('child-a', 2, 'wl-1'),
        workLog('child-a', 1.5, 'wl-2'),
        workLog('child-b', 4, 'wl-3'),
      ],
    });

    expect(computeRollupValue(snap, 'parent', 'WorkLog')).toBe(7.5);
  });

  it('WorkLog 累計整個下級子樹的填報，孫節點工時進得了祖父', () => {
    const snap = makeSnapshot({
      relations: [relation('grandparent', 'parent'), relation('parent', 'child')],
      fieldRecords: [workLog('parent', 3, 'wl-1'), workLog('child', 2, 'wl-2')],
    });

    expect(computeRollupValue(snap, 'grandparent', 'WorkLog')).toBe(5);
  });
});

describe('computeRollupValue 收集下級', () => {
  it('同一下級透過兩種關聯指入時只計一次', () => {
    const snap = makeSnapshot({
      relations: [relation('parent', 'child', CHILDREN_TYPE_ID), relation('parent', 'child', CONTAINER_TYPE_ID)],
      fieldValues: [fieldValue('child', 'StoryPoint', 3)],
      fieldRecords: [workLog('child', 2)],
    });
    expect(computeRollupValue(snap, 'parent', 'StoryPoint')).toBe(3);
    expect(computeRollupValue(snap, 'parent', 'WorkLog')).toBe(2);
  });

  it('工時經不同路徑抵達同一孫節點時只計一次', () => {
    const snap = makeSnapshot({
      relations: [relation('root', 'a'), relation('root', 'b'), relation('a', 'leaf', CHILDREN_TYPE_ID), relation('b', 'leaf', CONTAINER_TYPE_ID)],
      fieldRecords: [workLog('leaf', 2)],
    });
    expect(computeRollupValue(snap, 'root', 'WorkLog')).toBe(2);
  });

  it('彙總開關為假的關聯型別不收，Before 的被指端不入帳', () => {
    const snap = makeSnapshot({
      relations: [
        relation('parent', 'child', CHILDREN_TYPE_ID),
        relation('parent', 'successor', BEFORE_TYPE_ID),
      ],
      fieldValues: [
        fieldValue('child', 'StoryPoint', 3),
        fieldValue('successor', 'StoryPoint', 100),
      ],
    });

    expect(computeRollupValue(snap, 'parent', 'StoryPoint')).toBe(3);
  });

  it('彙總開關為真的多種關聯型別都收，Children 與 Container 併計', () => {
    const snap = makeSnapshot({
      relations: [
        relation('parent', 'child', CHILDREN_TYPE_ID),
        relation('parent', 'member', CONTAINER_TYPE_ID),
      ],
      fieldValues: [
        fieldValue('child', 'StoryPoint', 3),
        fieldValue('member', 'StoryPoint', 5),
      ],
    });

    expect(computeRollupValue(snap, 'parent', 'StoryPoint')).toBe(8);
  });

  it('跨 Company 租戶的關聯列不收', () => {
    const snap = makeSnapshot({
      relations: [
        relation('parent', 'child', CHILDREN_TYPE_ID),
        relation('parent', 'outsider', CHILDREN_TYPE_ID, 'company-2'),
      ],
      fieldValues: [
        fieldValue('child', 'StoryPoint', 3),
        fieldValue('outsider', 'StoryPoint', 100, null, 'company-2'),
      ],
    });

    expect(computeRollupValue(snap, 'parent', 'StoryPoint')).toBe(3);
  });

  it('關聯型別在定義區查不到時不收', () => {
    const snap = makeSnapshot({
      relations: [relation('parent', 'child', 'reltype-unknown')],
      fieldValues: [fieldValue('child', 'StoryPoint', 3)],
    });

    expect(computeRollupValue(snap, 'parent', 'StoryPoint')).toBeNull();
  });
});

describe('computeRollupValue 邊界', () => {
  it('葉節點無可彙總下級，四個欄位皆回傳空值', () => {
    const snap = makeSnapshot({
      fieldValues: [fieldValue('leaf', 'StartTime', '2026-01-01')],
      fieldRecords: [workLog('leaf', 8)],
    });

    expect(computeRollupValue(snap, 'leaf', 'StartTime')).toBeNull();
    expect(computeRollupValue(snap, 'leaf', 'EndTime')).toBeNull();
    expect(computeRollupValue(snap, 'leaf', 'StoryPoint')).toBeNull();
    expect(computeRollupValue(snap, 'leaf', 'WorkLog')).toBeNull();
  });

  it('空快照的任何工單皆回傳空值', () => {
    expect(computeRollupValue(makeSnapshot(), 'ghost', 'StoryPoint')).toBeNull();
  });

  it('單一下級時彙總值等於該下級的值', () => {
    const snap = makeSnapshot({
      relations: [relation('parent', 'only-child')],
      fieldValues: [fieldValue('only-child', 'EndTime', '2026-06-30')],
    });

    expect(computeRollupValue(snap, 'parent', 'EndTime')).toBe('2026-06-30');
  });

  it('下級存在但該欄位皆無值時回傳空值', () => {
    const snap = makeSnapshot({
      relations: [relation('parent', 'child-a'), relation('parent', 'child-b')],
      fieldValues: [fieldValue('child-a', 'StartTime', '2026-01-01')],
    });

    expect(computeRollupValue(snap, 'parent', 'StoryPoint')).toBeNull();
  });

  it('部分下級無值時只加總有值的下級', () => {
    const snap = makeSnapshot({
      relations: [relation('parent', 'child-a'), relation('parent', 'child-b')],
      fieldValues: [fieldValue('child-a', 'StoryPoint', 3)],
    });

    expect(computeRollupValue(snap, 'parent', 'StoryPoint')).toBe(3);
  });

  it('下級的工時填報全為零時回傳零，與無下級的空值分得開', () => {
    const snap = makeSnapshot({
      relations: [relation('parent', 'child')],
      fieldRecords: [workLog('child', 0)],
    });

    expect(computeRollupValue(snap, 'parent', 'WorkLog')).toBe(0);
  });

  it('下級有關聯但無任何工時填報時回傳零', () => {
    const snap = makeSnapshot({ relations: [relation('parent', 'child')] });

    expect(computeRollupValue(snap, 'parent', 'WorkLog')).toBe(0);
  });

  it('下級數量極多時仍逐筆加總', () => {
    const childIds = Array.from({ length: 500 }, (_, index) => `child-${String(index)}`);
    const snap = makeSnapshot({
      relations: childIds.map((childId) => relation('parent', childId)),
      fieldValues: childIds.map((childId) => fieldValue(childId, 'StoryPoint', 2)),
    });

    expect(computeRollupValue(snap, 'parent', 'StoryPoint')).toBe(1000);
  });
});

describe('computeRollupValue 錯誤路徑', () => {
  it('不可彙總的欄位擲出 FIELD_NOT_ROLLUPABLE', () => {
    const snap = makeSnapshot({
      relations: [relation('parent', 'child')],
      fieldValues: [fieldValue('child', 'Title', '子工單標題')],
    });

    expect(() => computeRollupValue(snap, 'parent', 'Title')).toThrowError(
      expect.objectContaining({ code: 'FIELD_NOT_ROLLUPABLE' }),
    );
  });

  it('欄位定義區查不到的欄位擲出 FIELD_NOT_DEFINED', () => {
    const snap = makeSnapshot({ relations: [relation('parent', 'child')] });

    expect(() => computeRollupValue(snap, 'parent', 'NoSuchField')).toThrowError(
      expect.objectContaining({ code: 'FIELD_NOT_DEFINED' }),
    );
  });

  it('關聯成環時擲出 RELATION_CYCLE，不無限遞迴', () => {
    const snap = makeSnapshot({
      relations: [relation('a', 'b'), relation('b', 'a')],
      fieldRecords: [workLog('a', 1), workLog('b', 2)],
    });

    expect(() => computeRollupValue(snap, 'a', 'WorkLog')).toThrowError(
      expect.objectContaining({ code: 'RELATION_CYCLE' }),
    );
  });
});
