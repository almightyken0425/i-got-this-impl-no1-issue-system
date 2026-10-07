import type { FieldDef } from '../../api';
import type { SortState, TableCellValue, TableColumn, TableRow } from '../../components/data';
import { LIST_COLUMNS } from './fixtures';
import { LIST_SCREEN_TOKENS as T } from './tokens';

export function buildFieldColumns(defs: readonly FieldDef[]): readonly TableColumn[] {
  const known = new Set(LIST_COLUMNS.map(column => column.key));
  return [
    ...LIST_COLUMNS.map(column => ({ ...column, label: defs.find(field => field.name === column.key)?.label ?? column.label })),
    ...defs.filter(field => field.kind === 'single' && !known.has(field.name) && field.name !== 'Archived').map((field): TableColumn => ({
      key: field.name, label: field.label, sortable: true,
      type: field.valueType === 'number' ? 'number' : field.valueType === 'date' ? 'date' : 'text',
      width: field.valueType === 'number' ? T.COLUMN_WIDTH.point : field.valueType === 'date' ? T.COLUMN_WIDTH.due : T.COLUMN_WIDTH.assignee,
      ...(field.valueType === 'number' ? { align: 'right' as const } : {}),
    })),
  ];
}

export function fieldCells(fields: Readonly<Record<string, unknown>>, defs: readonly FieldDef[]): Record<string, TableCellValue> {
  return Object.fromEntries(defs.filter(field => field.kind === 'single').map(field => {
    let value = fields[field.name];
    if (field.valueType === 'number' && typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value))) value = Number(value);
    if (field.valueType === 'boolean' && (value === 'true' || value === 'false')) value = value === 'true';
    if (value === null || value === undefined || value === '') return [field.name, null];
    if (typeof value === 'boolean') return [field.name, { label: value ? '是' : '否', sortKey: value ? 1 : 0 }];
    return [field.name, typeof value === 'number' || typeof value === 'string' ? value : null];
  }));
}

function sortValue(raw: TableCellValue | undefined): number | string | null {
  if (raw === null || raw === undefined || raw === '') return null;
  if (typeof raw === 'number' || typeof raw === 'string') return raw;
  if (typeof raw !== 'object') return null;
  const sortable = raw as { sortKey?: unknown; label?: unknown };
  if (typeof sortable.sortKey === 'number' || typeof sortable.sortKey === 'string') return sortable.sortKey;
  return typeof sortable.label === 'string' ? sortable.label : null;
}

export function sortFieldRows(rows: readonly TableRow[], sort: SortState | null): readonly TableRow[] {
  if (sort === null) return rows;
  const direction = sort.direction === 'desc' ? -1 : 1;
  return rows.slice().sort((a, b) => {
    const av = sortValue(a.cells[sort.key]);
    const bv = sortValue(b.cells[sort.key]);
    if (av === null && bv === null) return 0;
    if (av === null) return 1;
    if (bv === null) return -1;
    return (typeof av === 'number' && typeof bv === 'number' ? av - bv : String(av).localeCompare(String(bv), 'zh-Hant')) * direction;
  });
}
