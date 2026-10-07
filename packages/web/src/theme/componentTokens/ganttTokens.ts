// Gantt tokens · 甘特圖與導航組專屬元件參數
//
// 來源：design git 的 `10_foundations/component_tokens/no3_gantt_tokens.jsx`。
//
// 仲裁關係：design git 是視覺標準的唯一仲裁端，impl 逐名對齊、不自行設值。
// 密度、長條幾何、假日底色要變先在 design 定案，再回搬本檔。
//
// 消費端：GanttHeader / GanttTimeline / GanttBar / SortableRow / SectionDivider /
// LevelSwitcher / Toolbar，最終服務 DevOrderScreen（開發順序表）。
//
// 兩類值分開放：
//   1. 尺寸 / 節奏 / 透明度 → GANTT_TOKENS，全數引用 atomic 階梯，
//      離開階梯的視覺校準值標 `(literal: <原因>)`。
//   2. 色彩 → resolveGanttColors(theme)，由 theme 物件即時解析。
//      元件不自行讀 THEME_LIGHT / THEME_DARK，光暗雙主題共用同一組鍵。
//
// 唯一例外是假日格底色：它是同色疊透明度的合成值，光暗兩組各自定案，
// 疊底來源仍取 PALETTE，只有 alpha 是校準值。見 GANTT_HOLIDAY_TINT_ALPHA。

import type { ElevationLevel, Theme, ThemeId } from '../atomicTokens';
import { PALETTE } from '../atomicTokens';
import type { Density } from '../layoutTokens';
import { BORDER_WIDTH, CONTROL_HEIGHT, ICON_SIZE, MOTION, RADIUS, ROW_HEIGHT, SPACING } from '../layoutTokens';

/** hex → rgba 合成小工具。只給本檔的假日格底色用，不對外 export。 */
function ganttTint(hex: string, alpha: number): string {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${alpha})`;
}

// 假日格疊色透明度。兩主題不同值，理由是 AA 下限而非手感：
// light 疊暖墨 sand[900]，把紙面 sand[0] 壓成 #ECEAE5，對紙面亮度比 1.14；
// dark 疊暖白 sand[0]，把 surface sand[900] 抬成 #312D24，對 surface 亮度比 1.17。
// alpha 卡在 0.055 是因為再抬就吃掉整片 timeline 的前景預算。
//
// 假日格上的文字只出現在 header 的日號一處，那裡的底是「header dim + 假日 tint」雙層。
// 量雙層後 text.tertiary 只剩 4.10–4.54 落在 AA 之下，故日號改吃 text.secondary。
const GANTT_HOLIDAY_TINT_ALPHA: { readonly [K in ThemeId]: number } = {
  light: 0.07, // (literal: 對比預算校準，見上方註解)
  dark: 0.055, // (literal: 對比預算校準，見上方註解)
};

export interface GanttDensityStep {
  readonly rowHeight: number;
  readonly dayWidth: number;
  readonly barHeight: number;
}

// 三檔密度。row 高度沿用 ROW_HEIGHT 三檔，日格寬與長條高度隨之配對，
// 讓左側主題單列與右側甘特列逐列對齊——兩欄共用同一個 density 值。
const GANTT_DENSITY: { readonly [K in Density]: GanttDensityStep } = {
  compact: {
    rowHeight: ROW_HEIGHT.compact, // 32
    dayWidth: SPACING.xl - SPACING.xs, // 20
    barHeight: SPACING.md, // 12
  },
  base: {
    rowHeight: ROW_HEIGHT.base, // 36
    dayWidth: CONTROL_HEIGHT.md, // 28
    barHeight: SPACING.lg, // 16
  },
  relaxed: {
    rowHeight: ROW_HEIGHT.relaxed, // 44
    dayWidth: SPACING['3xl'], // 40
    barHeight: SPACING.lg + SPACING.xs, // 20
  },
};

/** 抽成具名常數才吃得到階名檢查，寫錯 elevation 階會在編譯期擋下。 */
const BAR_HOVER_ELEVATION: ElevationLevel ='level1';
const DRAG_ROW_ELEVATION: ElevationLevel ='level2';

const DEFAULT_GANTT_DENSITY: Density = 'base';

export const GANTT_TOKENS = {
  // ─── 密度與欄寬 ───
  DENSITY: GANTT_DENSITY,
  DEFAULT_DENSITY: DEFAULT_GANTT_DENSITY,
  LIST_COLUMN_WIDTH: SPACING['3xl'] * 6, // 240，主題單清單首欄預設寬
  LIST_COLUMN_MIN_WIDTH: SPACING['4xl'] * 3, // 144，縮到此寬仍容得下標題與拖曳把手

  // ─── 標頭 ───
  HEADER_MONTH_BAND_HEIGHT: CONTROL_HEIGHT.sm, // 24，月份帶
  HEADER_DAY_BAND_HEIGHT: CONTROL_HEIGHT.md, // 28，日期刻度帶
  HEADER_MONTH_LABEL_PADDING_H: SPACING.sm,
  HEADER_LEADING_PADDING_H: SPACING.sm,
  HEADER_LEADING_PADDING_BOTTOM: SPACING.xs, // 左 gutter 文字貼齊日期帶底線
  DAY_LABEL_MIN_CELL_WIDTH: SPACING.xl, // 24，日格窄於此就只留星期字母
  WEEKDAY_LABEL_MIN_CELL_WIDTH: SPACING['2xl'], // 32，日格窄於此就不並排星期字母

  // ─── 時間軸格線 ───
  GRID_LINE_WIDTH: BORDER_WIDTH.hairline,
  MONTH_SEPARATOR_WIDTH: BORDER_WIDTH.hairline,
  WEEK_SEPARATOR_EVERY: 7, // (literal: 一週七天，非視覺值)
  ROW_LINE_WIDTH: BORDER_WIDTH.hairline,

  // ─── 工單長條 ───
  BAR_RADIUS: RADIUS.sm,
  BAR_MIN_WIDTH: SPACING.sm, // 8，單日長條在 compact 下的下限
  BAR_INSET_H: SPACING['2xs'], // 2，左右各縮，相鄰長條不黏死
  BAR_LABEL_PADDING_H: SPACING.xs,
  BAR_LABEL_INSIDE_MIN_WIDTH: SPACING['4xl'] * 2, // 96，窄於此工期數字改掛長條尾端外側
  BAR_LEVEL_INDENT: SPACING.md, // 12，層級縮排（作用在標籤，不動起訖）
  BAR_LEVEL_HEIGHT_STEP: SPACING['2xs'], // 2，每深一層長條薄一階
  BAR_HEIGHT_MIN: SPACING.sm, // 8，薄到此為止
  BAR_HOVER_ELEVATION,
  BAR_SELECTED_BORDER_WIDTH: BORDER_WIDTH.hairline,

  // ─── 超期偏離 ───
  OVERRUN_MIN_WIDTH: SPACING.sm, // 8，偏離段窄於此仍畫得出斜紋
  OVERRUN_STRIPE_WIDTH: SPACING.xs, // 4，斜紋單位寬
  OVERRUN_STRIPE_ANGLE: '45deg', // (literal: CSS gradient 角度)
  OVERRUN_LABEL_GAP: SPACING.xs,

  // ─── 空列（尚未拆到該層深度）───
  EMPTY_ROW_RULE_WIDTH: BORDER_WIDTH.hairline,
  EMPTY_ROW_DASH: `${SPACING.xs}px ${SPACING.xs}px`, // 4 4 虛線節奏
  EMPTY_ROW_PADDING_H: SPACING.sm,

  // ─── 拖曳（SortableRow）───
  DRAG_HANDLE_WIDTH: CONTROL_HEIGHT.sm, // 24
  DRAG_HANDLE_ICON_SIZE: ICON_SIZE.md, // 16
  DRAG_HANDLE_RADIUS: RADIUS.sm, // 4，與控件組同一階
  DRAG_ROW_ELEVATION,
  DRAG_ROW_RADIUS: RADIUS.md,
  DRAG_ROW_SCALE: 1.01, // (literal: 拖起微放大，比 1.02 收斂、不撞相鄰列)
  DRAG_GHOST_OPACITY: 0.5, // (literal: 原位殘影；比 disabled 0.45 亮一點，仍讀得到標題)
  DROP_INDICATOR_WIDTH: BORDER_WIDTH.focus, // 2
  DROP_INDICATOR_CAP_SIZE: SPACING.sm, // 8，線首圓頭直徑
  DROP_INDICATOR_INSET: SPACING.xs,
  DROP_INDICATOR_RADIUS: RADIUS.full, // 線身與圓頭都走 pill

  // ─── 列與區塊 ───
  ROW_PADDING_H: SPACING.sm,
  ROW_GAP: SPACING.sm,
  SECTION_DIVIDER_HEIGHT: CONTROL_HEIGHT.lg, // 32
  SECTION_DIVIDER_PADDING_H: SPACING.sm,
  SECTION_COUNT_HEIGHT: SPACING.lg, // 16
  SECTION_COUNT_PADDING_H: SPACING.xs + SPACING['2xs'], // 6
  SECTION_COUNT_RADIUS: RADIUS.full,

  // ─── 顯示層級切換器 ───
  LEVEL_SWITCHER_HEIGHT: CONTROL_HEIGHT.md, // 28
  LEVEL_SWITCHER_RADIUS: RADIUS.md,
  LEVEL_SWITCHER_PADDING: SPACING['2xs'], // 2，外框內縮，滑塊不貼邊
  LEVEL_SWITCHER_ITEM_RADIUS: RADIUS.sm,
  LEVEL_SWITCHER_ITEM_PADDING_H: SPACING.md,
  LEVEL_SWITCHER_ITEM_MIN_WIDTH: SPACING['4xl'], // 48，字數不同的層級名不跳寬

  // ─── 工具列 ───
  TOOLBAR_HEIGHT: SPACING['4xl'] + SPACING.lg,
  TOOLBAR_PADDING_H: SPACING.xl,
  TOOLBAR_PADDING_Y: SPACING.md,
  TOOLBAR_GAP: SPACING.sm,

  // ─── focus 與動態 ───
  FOCUS_RING_WIDTH: BORDER_WIDTH.focus,
  FOCUS_RING_OFFSET: SPACING['2xs'],
  ROW_TRANSITION_MS: MOTION.duration.fast, // 150
  BAR_TRANSITION_MS: MOTION.duration.base, // 220
  DROP_INDICATOR_TRANSITION_MS: MOTION.duration.instant, // 80
  SWITCHER_TRANSITION_MS: MOTION.duration.fast, // 150
  EASING: MOTION.easing.standard,

  // ─── 假日格底色（光暗各一組，元件透過 resolveGanttColors 取用）───
  HOLIDAY_TINT_ALPHA: GANTT_HOLIDAY_TINT_ALPHA,
  HOLIDAY_CELL_BG: {
    light: ganttTint(PALETTE.sand[900], GANTT_HOLIDAY_TINT_ALPHA.light), // 暖墨壓紙面
    dark: ganttTint(PALETTE.sand[0], GANTT_HOLIDAY_TINT_ALPHA.dark), // 暖白抬暗面
  } as { readonly [K in ThemeId]: string },
} as const;

// ─── 色彩 resolver ───────────────────────────────────────────

export interface GanttColors {
  // 面
  readonly timelineBg: string;
  readonly headerBg: string;
  readonly rowBg: string;
  readonly rowBgHover: string;
  readonly rowBgSelected: string;
  readonly sectionBg: string;
  readonly holidayCell: string;

  // 線
  readonly dayLine: string;
  readonly weekLine: string;
  readonly monthLine: string;
  readonly rowLine: string;
  readonly sectionLine: string;
  readonly emptyRowRule: string;

  // 字
  readonly textPrimary: string;
  readonly textSecondary: string;
  readonly textTertiary: string;
  readonly textSelected: string;
  readonly textDisabled: string;

  // 長條
  readonly barFill: string;
  readonly barFillHover: string;
  readonly barLabelOn: string;
  readonly barLabelOutside: string;
  readonly barBorder: string;

  // 超期偏離
  readonly overrun: string;
  readonly overrunTrack: string;
  readonly overrunLabel: string;

  // 拖曳
  readonly dropIndicator: string;
  readonly handle: string;
  readonly handleActive: string;

  // 邊界與 focus
  readonly focusRing: string;
  readonly controlBorder: string;
  readonly shadowColor: string;
  readonly disabledOpacity: number;
}

/**
 * theme → 甘特組語意色。元件只讀本函式的回傳鍵，不碰 theme 內部路徑，
 * 也不做 theme.id 分支——分支只發生在這裡。
 */
export function resolveGanttColors(theme: Theme): GanttColors {
  const isDark = theme.id === 'dark';
  return {
    timelineBg: theme.bg.surface,
    headerBg: theme.bg.surface_dim,
    rowBg: theme.bg.surface,
    rowBgHover: theme.state.hover.bg,
    rowBgSelected: theme.state.selected.bg,
    sectionBg: theme.bg.surface_dim,
    holidayCell: GANTT_TOKENS.HOLIDAY_CELL_BG[theme.id],

    dayLine: theme.divider.hairline, // 日格線，最細一階
    weekLine: theme.divider.base, // 每七日一條，比日格線重
    monthLine: theme.border.strong, // 月份分隔，最重
    rowLine: theme.divider.hairline,
    sectionLine: theme.divider.base,
    emptyRowRule: theme.border.base,

    textPrimary: theme.text.primary,
    textSecondary: theme.text.secondary,
    textTertiary: theme.text.tertiary,
    textSelected: theme.state.selected.fg,
    textDisabled: theme.state.disabled.fg,

    barFill: theme.primary.main,
    barFillHover: isDark ? theme.primary[300] : theme.primary[700],
    barLabelOn: theme.primary.on_main, // 疊在長條上的工期字
    barLabelOutside: theme.text.secondary, // 掛在長條外側的工期字
    barBorder: theme.state.selected.border,

    overrun: theme.status.error,
    overrunTrack: theme.status.error_bg,
    overrunLabel: theme.status.error_fg,

    dropIndicator: theme.primary.main,
    handle: theme.text.tertiary,
    handleActive: theme.text.primary,

    focusRing: theme.border.input, // 必要邊界，兩主題都保 3:1
    controlBorder: theme.border.base,
    shadowColor: theme.shadow.color,
    disabledOpacity: theme.state.disabled.opacity,
  };
}
