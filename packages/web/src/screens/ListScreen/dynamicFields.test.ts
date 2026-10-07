import { describe, expect, it } from 'vitest';
import type { FieldDef } from '../../api';
import { buildFieldColumns, fieldCells, sortFieldRows } from './dynamicFields';
import { parseColumnConfig } from './columnConfig';

const field = (name: string, valueType: string, kind: FieldDef['kind'] = 'single'): FieldDef => ({
  companyId: 'c', name, fieldSetName: '自訂', kind, valueType, label: `${name}標籤`,
  readonly: false, system: false, rollupable: false, rollupFn: null, tracked: false,
});
const defs = [field('budget', 'number'), field('ready', 'boolean'), field('date', 'date'), field('notes', 'text', 'multi')];

describe('自訂欄位清單', () => {
  it('相容舊版數字與布林字串，排序與分組仍依定義原語', () => {
    const rows = [
      { id: 'ten', cells: fieldCells({ budget: '10', ready: 'true' }, defs) },
      { id: 'two', cells: fieldCells({ budget: '2', ready: 'false' }, defs) },
      { id: 'three', cells: fieldCells({ budget: 3, ready: true }, defs) },
    ];
    expect(sortFieldRows(rows, { key: 'budget', direction: 'asc' }).map(row => row.id)).toEqual(['two', 'three', 'ten']);
    expect(rows[0]!.cells['ready']).toMatchObject({ label: '是', sortKey: 1 });
    expect(rows[1]!.cells['ready']).toMatchObject({ label: '否', sortKey: 0 });
  });
  it('單值欄位使用定義標籤，保留欄序與寬度並略過已刪欄位', () => {
    const columns = buildFieldColumns(defs);
    expect(columns.map(column => column.key)).toEqual(expect.arrayContaining(['key', 'title', 'budget', 'ready', 'date']));
    expect(columns.some(column => column.key === 'notes')).toBe(false);
    expect(columns.find(column => column.key === 'budget')?.label).toBe('budget標籤');
    expect(parseColumnConfig({ columns: [{ key: 'budget', width: 160 }, { key: 'deleted' }, { key: 'title' }] }, columns))
      .toEqual([{ key: 'budget', width: 160 }, { key: 'title' }]);
  });
  it('數字依數值排序，混合型別未填值在升降序都置後', () => {
    const rows = [
      { id: 'ten', cells: fieldCells({ budget: 10 }, defs) },
      { id: 'empty', cells: fieldCells({}, defs) },
      { id: 'two', cells: fieldCells({ budget: 2 }, defs) },
    ];
    expect(sortFieldRows(rows, { key: 'budget', direction: 'asc' }).map(row => row.id)).toEqual(['two', 'ten', 'empty']);
    expect(sortFieldRows(rows, { key: 'budget', direction: 'desc' }).map(row => row.id)).toEqual(['ten', 'two', 'empty']);
  });
  it('布林提供可讀分組標籤與否到是排序，日期按年月日排序', () => {
    const rows = [
      { id: 'yes', cells: fieldCells({ ready: true, date: '2026-11-01' }, defs) },
      { id: 'no', cells: fieldCells({ ready: false, date: '2026-02-01' }, defs) },
    ];
    expect(rows[0]!.cells['ready']).toMatchObject({ label: '是', sortKey: 1 });
    expect(rows[1]!.cells['ready']).toMatchObject({ label: '否', sortKey: 0 });
    expect(sortFieldRows(rows, { key: 'ready', direction: 'asc' }).map(row => row.id)).toEqual(['no', 'yes']);
    expect(sortFieldRows(rows, { key: 'date', direction: 'asc' }).map(row => row.id)).toEqual(['no', 'yes']);
  });
});
