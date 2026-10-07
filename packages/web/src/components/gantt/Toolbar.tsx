// Toolbar · 畫面工具列容器
//
// 來源：design git 的 `20_components/no3_gantt_nav.jsx`。
//
// 仲裁關係：design git 是視覺標準的唯一仲裁端，impl 逐名對齊、不自行設值。
// 與 design 端的唯一差異：theme 不再逐層傳 prop，改由 useTheme() 取當下主題。
//
// 左中右三區：left 貼左、right 貼右、center 佔滿剩餘空間並置中。
// 三區都可為空；center 溢出時內縮，不擠壓左右兩區。

import type { CSSProperties, ReactNode } from 'react';

import { FONT_FAMILY, GANTT_TOKENS, resolveGanttColors, useTheme } from '../../theme';

export interface ToolbarProps {
  readonly left?: ReactNode;
  readonly center?: ReactNode;
  readonly right?: ReactNode;
  readonly style?: CSSProperties;
}

export function Toolbar({ left, center, right, style }: ToolbarProps) {
  const { theme } = useTheme();
  const colors = resolveGanttColors(theme);
  const slot = (extra: CSSProperties): CSSProperties => ({
    display: 'flex', flexWrap: 'wrap',
    alignItems: 'center',
    gap: GANTT_TOKENS.TOOLBAR_GAP,
    minWidth: 0,
    ...extra,
  });

  return (
    <div
      role="toolbar"
      style={{
        display: 'flex', flexWrap: 'wrap',
        alignItems: 'center',
        gap: GANTT_TOKENS.TOOLBAR_GAP,
        minHeight: GANTT_TOKENS.TOOLBAR_HEIGHT,
        boxSizing: 'border-box',
        padding: `${GANTT_TOKENS.TOOLBAR_PADDING_Y}px ${GANTT_TOKENS.TOOLBAR_PADDING_H}px`,
        background: colors.rowBg,
        borderBottom: `${GANTT_TOKENS.GRID_LINE_WIDTH}px solid ${colors.sectionLine}`,
        fontFamily: FONT_FAMILY.base,
        color: colors.textPrimary,
        ...style,
      }}
    >
      <div style={slot({ flex: '1 1 auto' })}>{left}</div>
      {center && <div style={slot({ flex: 1, justifyContent: 'center', overflow: 'hidden' })}>{center}</div>}
      {right && <div style={slot({ flex: '0 1 auto', justifyContent: 'flex-start' })}>{right}</div>}
    </div>
  );
}
