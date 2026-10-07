// DataTable · 工單表格
//
// 來源：design git 的 `20_components/no2_data_display.jsx`（DataTable 段）。
//
// 消費畫面：ListScreen（spec `no2_screens/no1_list_screen.md`）。
//
// 受控範圍——搬進 impl 時明確定死的邊界：
//   - 排序：`sort` 與 `onSortChange` 成對，型別上綁死「要嘛都給、要嘛都不給」。
//     本元件只畫指示箭頭、只發出下一個狀態的提議，永遠不重排 `rows`；
//     實際比較邏輯與資料順序由畫面層決定，這樣才接得上伺服器端排序與分頁。
//   - 選取：`selectedIds` 是唯一真相，`onRowSelect` 只回報「哪一列被點了」，
//     不在元件內算新的選取集合；`onRowSelect` 也綁死必須與 `selectedIds` 同時出現。
//   - 元件內剩下的 state 只有 hover 與 focus 兩個游標視覺，離開畫面就沒有意義、
//     畫面層也不需要知道。
//
// 分組只是呈現層的聚集：依首次出現順序分堆，群內順序照 `rows` 原樣，不重排。

import { Fragment, useMemo, useState } from 'react';
import type { KeyboardEvent, MouseEvent, ReactNode } from 'react';

import { DATA_DISPLAY_COLORS, DATA_DISPLAY_TOKENS, FONT_FAMILY, NUMERIC_FONT_VARIANT, SPACING, useTheme } from '../../theme';
import type { Density, Theme } from '../../theme';
import { EmptyState } from './EmptyState';
import {
  TableDateCell,
  TableKeyCell,
  TableNumberCell,
  TableStatusCell,
  TableTextCell,
  TableUserCell,
} from './TableCell';
import { TableHeaderCell } from './TableHeaderCell';
import { Truncate, focusStyleCss, typeStyleCss } from './internal';
import { toPlainText, toTextCellValue } from './types';
import type { SortState, TableColumn, TableRow } from './types';

const T = DATA_DISPLAY_TOKENS.TABLE;

/** 分組欄位沒有值時的堆名。 */
const UNGROUPED_LABEL = '未填寫';

export type RowPointerHandler = (row: TableRow, event: MouseEvent<HTMLDivElement>) => void;

export type RowSelectHandler = (
  row: TableRow,
  event: MouseEvent<HTMLDivElement> | KeyboardEvent<HTMLDivElement>,
) => void;

export interface DataTableBaseProps {
  readonly columns: readonly TableColumn[];
  /** 已經是最終顯示順序；本元件不排序。 */
  readonly rows: readonly TableRow[];
  readonly density?: Density | undefined;
  readonly zebra?: boolean | undefined;
  /** 指定欄 key 後改分組呈現。 */
  readonly groupBy?: string | undefined;
  /** 列的第二動作，通常是開啟工單。 */
  readonly onRowActivate?: RowPointerHandler | undefined;
  /** 指定後標題列 sticky、內容區捲動。 */
  readonly maxHeight?: number | string | undefined;
  /** 無資料時的節點；省略走預設 EmptyState，給 null 則什麼都不畫。 */
  readonly emptyState?: ReactNode;
}

/** 排序成對受控：給了 `sort` 就必須給 `onSortChange`，不留「看得到卻改不動」的半套狀態。 */
export type DataTableSortProps =
  | {
      /** 目前排序狀態，null 代表未排序。 */
      readonly sort: SortState | null;
      readonly onSortChange: (next: SortState) => void;
    }
  | { readonly sort?: undefined; readonly onSortChange?: undefined };

/** 選取受控：`onRowSelect` 只在有 `selectedIds` 時才成立；純展示的選取態允許不給回呼。 */
export type DataTableSelectionProps =
  | {
      readonly selectedIds: readonly string[];
      readonly onRowSelect?: RowSelectHandler | undefined;
    }
  | { readonly selectedIds?: undefined; readonly onRowSelect?: undefined };

export type DataTableProps = DataTableBaseProps & DataTableSortProps & DataTableSelectionProps;

interface RowGroup {
  readonly label: string;
  readonly items: readonly TableRow[];
}

export function DataTable(props: DataTableProps) {
  const {
    columns,
    rows,
    density = 'base',
    zebra = false,
    sort,
    onSortChange,
    groupBy,
    selectedIds,
    onRowSelect,
    onRowActivate,
    maxHeight,
    emptyState,
  } = props;

  const { theme } = useTheme();
  const c = DATA_DISPLAY_COLORS.TABLE(theme);
  const [hoveredId, setHoveredId] = useState<string | null>(null);
  const [focusedId, setFocusedId] = useState<string | null>(null);

  // 窄版保留已設定欄寬，由表格自身橫向捲動，不裁切右側欄位。
  const contentWidth = columns.reduce((sum, column) => sum + (typeof column.width === 'number' ? column.width : Number(column.width?.match(/(?:minmax\()?([0-9.]+)px/)?.[1] ?? T.COLUMN_MIN_WIDTH)), 0);
  const rowHeight = T.ROW_HEIGHT_BY_DENSITY[density];
  const template = columns
    .map((col) =>
      typeof col.width === 'number'
        ? `${col.width}px`
        : (col.width ?? `minmax(${T.COLUMN_MIN_WIDTH}px, 1fr)`),
    )
    .join(' ');

  const groupColumn = groupBy === undefined ? null : (columns.find((col) => col.key === groupBy) ?? null);

  const groups = useMemo<readonly RowGroup[] | null>(() => {
    if (groupBy === undefined) return null;
    const order: string[] = [];
    const bucket = new Map<string, TableRow[]>();
    for (const row of rows) {
      const text = toPlainText(row.cells[groupBy]);
      const label = text === '' ? UNGROUPED_LABEL : text;
      const existing = bucket.get(label);
      if (existing === undefined) {
        bucket.set(label, [row]);
        order.push(label);
      } else {
        existing.push(row);
      }
    }
    return order.map((label) => ({ label, items: bucket.get(label) ?? [] }));
  }, [rows, groupBy]);

  const selected = selectedIds ?? [];

  const renderRow = (row: TableRow, index: number, indented: boolean) => {
    const isSelected = selected.includes(row.id);
    const disabled = row.disabled === true;
    const hovered = hoveredId === row.id && !disabled;
    const focused = focusedId === row.id;
    const striped = zebra && index % 2 === 1;
    const bg = isSelected ? c.selectedBg : hovered ? c.hoverBg : striped ? c.zebraBg : 'transparent';

    return (
      <div
        key={row.id}
        role="row"
        aria-selected={isSelected}
        tabIndex={disabled ? -1 : 0}
        onMouseEnter={() => setHoveredId(row.id)}
        onMouseLeave={() => setHoveredId(null)}
        onFocus={() => setFocusedId(row.id)}
        onBlur={() => setFocusedId(null)}
        onClick={(event) => {
          if (!disabled) onRowSelect?.(row, event);
        }}
        onDoubleClick={(event) => {
          if (!disabled) onRowActivate?.(row, event);
        }}
        onKeyDown={(event) => {
          if (disabled) return;
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            onRowSelect?.(row, event);
          }
        }}
        style={{
          display: 'grid',
          gridTemplateColumns: template,
          alignItems: 'center',
          height: rowHeight,
          background: bg,
          color: disabled ? c.disabledFg : isSelected ? c.selectedFg : c.rowFg,
          opacity: disabled ? c.disabledOpacity : 1,
          // 四邊留同寬透明框給 focus 用色，只有上緣著色當分隔線，focus 時列高不會跳。
          border: `${T.OUTER_BORDER_WIDTH}px solid transparent`,
          borderTopWidth: T.ROW_DIVIDER_WIDTH,
          borderTopColor: c.rowDivider,
          boxShadow: isSelected ? `inset ${T.SELECTED_ACCENT_WIDTH}px 0 0 0 ${c.selectedAccent}` : 'none',
          paddingLeft: indented ? T.GROUP_INDENT : 0,
          cursor: disabled ? 'default' : onRowSelect !== undefined ? 'pointer' : 'default',
          transition: `background ${T.TRANSITION_MS}ms ${T.TRANSITION_EASING}`,
          ...(focused ? focusStyleCss(c, T.FOCUS_RING_WIDTH, T.FOCUS_RING_OFFSET) : null),
        }}
      >
        {columns.map((col) => (
          <Fragment key={col.key}>{renderCell(theme, col, row, density, disabled)}</Fragment>
        ))}
      </div>
    );
  };

  const renderGroupRow = (group: RowGroup) => (
    <div
      key={`group-${group.label}`}
      role="row"
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: SPACING.sm,
        height: T.GROUP_ROW_HEIGHT,
        padding: `0 ${T.CELL_PADDING_X_BY_DENSITY[density]}px`,
        background: c.groupBg,
        color: c.groupFg,
        borderTop: `${T.ROW_DIVIDER_WIDTH}px solid ${c.headerDivider}`,
        fontFamily: FONT_FAMILY.base,
        ...typeStyleCss(T.GROUP_TYPE),
      }}
    >
      <Truncate>{groupColumn === null ? group.label : `${groupColumn.label}: ${group.label}`}</Truncate>
      <span
        style={{
          color: c.rowMutedFg,
          fontVariantNumeric: NUMERIC_FONT_VARIANT,
          ...typeStyleCss(T.META_TYPE, { fontWeight: T.GROUP_COUNT_WEIGHT, letterSpacing: 0 }),
        }}
      >
        {group.items.length}
      </span>
    </div>
  );

  let body: ReactNode;
  if (rows.length === 0) {
    body =
      emptyState !== undefined ? (
        emptyState
      ) : (
        <EmptyState title="沒有符合條件的工單" description="調整篩選條件或改選其他檢視。" />
      );
  } else if (groups !== null) {
    body = groups.map((group) => (
      <Fragment key={group.label}>
        {renderGroupRow(group)}
        {group.items.map((row, i) => renderRow(row, i, true))}
      </Fragment>
    ));
  } else {
    body = rows.map((row, i) => renderRow(row, i, false));
  }

  return (
    <div
      role="table"
      style={{
        width: '100%',
        background: c.surface,
        border: `${T.OUTER_BORDER_WIDTH}px solid ${c.outerBorder}`,
        borderRadius: T.RADIUS,
        overflow: 'hidden',
        fontFamily: FONT_FAMILY.base,
        color: c.rowFg,
      }}
    >
      <div tabIndex={0} aria-label="可左右捲動的表格" style={{ maxHeight, overflow: 'auto' }}>
        <div style={{ minWidth: contentWidth }}>
        <div
          role="row"
          style={{
            display: 'grid',
            gridTemplateColumns: template,
            alignItems: 'center',
            height: T.HEADER_HEIGHT,
            background: c.headerBg,
            borderBottom: `${T.HEADER_DIVIDER_WIDTH}px solid ${c.headerDivider}`,
            position: maxHeight === undefined ? 'static' : 'sticky',
            top: 0,
            zIndex: 1,
          }}
        >
          {columns.map((col) => (
            <TableHeaderCell
              key={col.key}
              column={col}
              density={density}
              sort={sort ?? null}
              onSortChange={onSortChange}
            />
          ))}
        </div>
        {body}
        </div>
      </div>
    </div>
  );
}

/** `column.type` 到 TableCell 系列的預設對應；`column.render` 存在時優先。 */
function renderCell(
  theme: Theme,
  column: TableColumn,
  row: TableRow,
  density: Density,
  disabled: boolean,
): ReactNode {
  const value = row.cells[column.key];
  if (column.render !== undefined) return column.render(value, row, { theme, density });

  switch (column.type) {
    case 'key':
      return (
        <TableKeyCell
          density={density}
          align={column.align}
          disabled={disabled}
          value={toPlainText(value)}
          onClick={column.onClick}
        />
      );
    case 'status':
      return <TableStatusCell density={density} align={column.align} disabled={disabled} status={value} />;
    case 'user':
      return <TableUserCell density={density} align={column.align} disabled={disabled} user={value} />;
    case 'date':
      return <TableDateCell density={density} align={column.align} disabled={disabled} date={value} />;
    case 'number':
      return (
        <TableNumberCell
          density={density}
          align={column.align ?? 'right'}
          disabled={disabled}
          value={value}
        />
      );
    case 'text':
    case undefined:
      return (
        <TableTextCell
          density={density}
          align={column.align}
          muted={column.muted}
          disabled={disabled}
          value={toTextCellValue(value)}
        />
      );
  }
}
