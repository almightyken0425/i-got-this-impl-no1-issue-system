// KanbanColumn · 看板欄
//
// 來源：design git 的 `20_components/no2_data_display.jsx`（KanbanColumn 段）。
//
// 消費畫面：KanbanScreen（spec `no2_screens/no2_kanban_screen.md`）。
// 一欄對應一個流程狀態；欄數由 Status 決定，結案原因不開欄。

import { Children } from 'react';
import type { DragEvent, ReactNode } from 'react';

import { DATA_DISPLAY_COLORS, DATA_DISPLAY_TOKENS, FONT_FAMILY, NUMERIC_FONT_VARIANT, useTheme } from '../../theme';
import { Truncate, typeStyleCss } from './internal';

const K = DATA_DISPLAY_TOKENS.KANBAN;

export interface KanbanColumnProps {
  readonly title: string;
  /** 省略時取 children 數量；伺服器端已知總數時傳進來覆寫。 */
  readonly count?: number | undefined;
  /** 拖曳懸停中，欄底與外框轉成落點提示。 */
  readonly isDropTarget?: boolean | undefined;
  /** 指定後卡片區捲動，欄標題留在原位。 */
  readonly maxHeight?: number | string | undefined;
  readonly footer?: ReactNode;
  readonly children?: ReactNode;
  readonly onDragOver?: ((event: DragEvent<HTMLElement>) => void) | undefined;
  readonly onDrop?: ((event: DragEvent<HTMLElement>) => void) | undefined;
}

export function KanbanColumn({
  title,
  count,
  isDropTarget = false,
  maxHeight,
  footer,
  children,
  onDragOver,
  onDrop,
}: KanbanColumnProps) {
  const { theme } = useTheme();
  const c = DATA_DISPLAY_COLORS.KANBAN(theme);
  const shown = count ?? Children.count(children);

  const borderWidth = isDropTarget ? K.DROP_TARGET_BORDER_WIDTH : K.COLUMN_BORDER_WIDTH;
  const borderStyle = isDropTarget ? 'dashed' : 'solid';
  const borderColor = isDropTarget ? c.dropTargetBorder : c.columnBorder;

  return (
    <section
      onDragOver={onDragOver}
      onDrop={onDrop}
      style={{
        width: '100%',
        boxSizing: 'border-box',
        minWidth: 0,
        flexShrink: 0,
        display: 'flex',
        flexDirection: 'column',
        background: isDropTarget ? c.dropTargetBg : c.columnBg,
        border: `${borderWidth}px ${borderStyle} ${borderColor}`,
        borderRadius: K.COLUMN_RADIUS,
        padding: K.COLUMN_PADDING,
        fontFamily: FONT_FAMILY.base,
        transition: `background ${K.TRANSITION_MS}ms ${K.TRANSITION_EASING}, border-color ${K.TRANSITION_MS}ms ${K.TRANSITION_EASING}`,
      }}
    >
      <header
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: K.COLUMN_HEADER_GAP,
          height: K.COLUMN_HEADER_HEIGHT,
          padding: `0 ${K.COLUMN_HEADER_PADDING_X}px`,
          color: c.columnHeaderFg,
          ...typeStyleCss(K.COLUMN_HEADER_TYPE),
        }}
      >
        <Truncate title={title}>{title}</Truncate>
        <span
          style={{
            marginLeft: 'auto',
            flexShrink: 0,
            minWidth: K.COLUMN_COUNT_MIN_WIDTH,
            padding: `0 ${K.COLUMN_COUNT_PADDING_X}px`,
            borderRadius: K.COLUMN_COUNT_RADIUS,
            background: c.countBg,
            color: c.countFg,
            textAlign: 'center',
            fontVariantNumeric: NUMERIC_FONT_VARIANT,
            ...typeStyleCss(K.COLUMN_COUNT_TYPE, { letterSpacing: 0 }),
          }}
        >
          {shown}
        </span>
      </header>

      <div
        style={{
          display: 'flex',
          flexDirection: 'column',
          gap: K.COLUMN_BODY_GAP,
          minHeight: K.COLUMN_BODY_MIN_HEIGHT,
          maxHeight,
          overflowY: maxHeight === undefined ? 'visible' : 'auto',
          padding: `${K.COLUMN_PADDING}px 0 0`,
        }}
      >
        {children}
      </div>

      {footer}
    </section>
  );
}
