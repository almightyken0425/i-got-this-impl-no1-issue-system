// Data display tokens · 資料展示元件參數（表格 / 看板 / 空狀態 / 過濾標示）
//
// 來源：design git 的 `10_foundations/component_tokens/no2_data_display_tokens.jsx`。
//
// 仲裁關係：design git 是視覺標準的唯一仲裁端，impl 逐名對齊、不自行設值。
// 幾何與色彩映射要變先在 design 定案，再回搬本檔。
//
// 消費端：DataTable、TableCell 系列、KanbanColumn、KanbanCard、EmptyState、FilterNotice，
// 服務 spec 的 ListScreen 工單表格與 KanbanScreen 看板欄。
//
// 兩段結構：
//   DATA_DISPLAY_TOKENS — 幾何與字體，全數引用 atomic 層階梯。
//   DATA_DISPLAY_COLORS — 色彩不存值、存「吃 theme 的哪個鍵」，每組是一個吃 theme
//                         的 resolver。同一份 token 在光暗兩主題都成立、元件不寫死主題。
//
// 禁止在本檔硬寫 hex 或 raw number；視覺校準例外一律標 `(literal: <原因>)`。

import type { Theme } from '../atomicTokens';
import type { Density } from '../layoutTokens';
import { BORDER_WIDTH, CONTROL_HEIGHT, ICON_SIZE, MOTION, RADIUS, ROW_HEIGHT, SHADOW, SPACING } from '../layoutTokens';
import { TYPE_STYLES, TYPOGRAPHY } from '../typography';

/** 抽成具名常數才吃得到 Density 全鍵檢查，漏一檔密度會在編譯期擋下。 */
const CELL_PADDING_X_BY_DENSITY: { readonly [K in Density]: number } = {
  compact: SPACING.sm,
  base: SPACING.md,
  relaxed: SPACING.md,
};

export const DATA_DISPLAY_TOKENS = {
  // 本組 glyph 走 16 格線稿（控件組走 24 格），同一視覺粗細換算過來比控件組細一階。
  GLYPH_STROKE: 1.5, // (literal: 16 格線稿的筆畫粗細，視覺校準)

  // ─── 工單表格 ───────────────────────────────────────────────
  TABLE: {
    // row 高度三檔直接吃 ROW_HEIGHT；density prop 用同一組鍵名。
    ROW_HEIGHT_BY_DENSITY: ROW_HEIGHT,
    HEADER_HEIGHT: CONTROL_HEIGHT.lg, // 32，與 toolbar 控件同高
    GROUP_ROW_HEIGHT: CONTROL_HEIGHT.md, // 28，分組標題列比工單列矮一階

    // 欄距：compact 收到 sm 換掃描密度，base 與 relaxed 用 md。
    CELL_PADDING_X_BY_DENSITY,
    CELL_INNER_GAP: SPACING.sm, // 格內 avatar / icon 與文字的距離
    COLUMN_MIN_WIDTH: SPACING['3xl'] * 3, // 120，未指定欄寬時保留標籤可讀寬度
    GROUP_INDENT: SPACING.md, // 分組啟用時工單列的縮排

    // 字體：標題列走 label、儲存格走 tableCell、編號走 mono code、分組標題走 overline。
    HEADER_TYPE: TYPE_STYLES.label,
    CELL_TYPE: TYPE_STYLES.tableCell,
    KEY_TYPE: TYPE_STYLES.code, // 搭配 FONT_FAMILY.mono
    GROUP_TYPE: TYPE_STYLES.overline,
    META_TYPE: TYPE_STYLES.caption,
    KEY_WEIGHT: TYPOGRAPHY.weight.medium,
    GROUP_COUNT_WEIGHT: TYPOGRAPHY.weight.regular,

    // 線與框
    RADIUS: RADIUS.lg, // 表格外框
    ROW_DIVIDER_WIDTH: BORDER_WIDTH.hairline,
    HEADER_DIVIDER_WIDTH: BORDER_WIDTH.hairline,
    OUTER_BORDER_WIDTH: BORDER_WIDTH.hairline,
    SELECTED_ACCENT_WIDTH: BORDER_WIDTH.focus, // 選取列左側指示條
    FOCUS_RING_WIDTH: BORDER_WIDTH.focus,
    FOCUS_RING_OFFSET: -BORDER_WIDTH.focus, // 內縮，focus 不撐開列高

    // 格內元件。badge 與 avatar 交給基礎元件組渲染，這裡只留「用哪一檔」與 fallback
    // 幾何；數值鏡射 BADGE_TOKENS 與 AVATAR_TOKENS，兩者未載入時視覺仍一致。
    SORT_ICON_SIZE: ICON_SIZE.xs,
    STATUS_ICON_SIZE: ICON_SIZE.sm,
    BADGE_DOT: true, // 表格密度高，留圓點作色彩身份
    BADGE_HEIGHT: TYPE_STYLES.label.lineHeight + SPACING.xs, // 20，鏡射 BADGE_TOKENS.HEIGHT
    BADGE_RADIUS: RADIUS.full,
    BADGE_PADDING_X: SPACING.sm,
    BADGE_TYPE: TYPE_STYLES.label,
    AVATAR_SIZE_KEY: 'sm', // Avatar 的尺寸鍵
    AVATAR_SIZE: CONTROL_HEIGHT.sm, // 24，鏡射 AVATAR_TOKENS.SIZE.sm
    AVATAR_TYPE: TYPE_STYLES.caption,

    // 互動
    TRANSITION_MS: MOTION.duration.instant, // hover 反饋走 instant
    TRANSITION_EASING: MOTION.easing.standard,
  },

  // ─── 看板 ───────────────────────────────────────────────────
  KANBAN: {
    COLUMN_WIDTH: SPACING.xl * 12, // 288，容得下 mono 編號加兩行標題
    COLUMN_MIN_WIDTH: SPACING.xl * 10, // 240
    COLUMN_GAP: SPACING.md,
    COLUMN_RADIUS: RADIUS.lg,
    COLUMN_PADDING: SPACING.sm,
    COLUMN_BORDER_WIDTH: BORDER_WIDTH.hairline,
    COLUMN_HEADER_HEIGHT: CONTROL_HEIGHT.lg, // 32
    COLUMN_HEADER_PADDING_X: SPACING.sm,
    COLUMN_HEADER_GAP: SPACING.sm,
    COLUMN_HEADER_TYPE: TYPE_STYLES.label,
    COLUMN_COUNT_TYPE: TYPE_STYLES.caption,
    COLUMN_COUNT_PADDING_X: SPACING.xs,
    COLUMN_COUNT_MIN_WIDTH: SPACING.lg, // 16，個位數計數不塌成細條
    COLUMN_COUNT_RADIUS: RADIUS.full,
    COLUMN_BODY_GAP: SPACING.sm, // 卡片間距
    COLUMN_BODY_MIN_HEIGHT: SPACING['4xl'] * 2, // 96，空欄仍是可辨識的落點
    DROP_TARGET_BORDER_WIDTH: BORDER_WIDTH.focus,

    CARD_RADIUS: RADIUS.md,
    CARD_PADDING_X: SPACING.md,
    CARD_PADDING_Y: SPACING.sm,
    CARD_ROW_GAP: SPACING.xs, // 卡片內三段行距
    CARD_BORDER_WIDTH: BORDER_WIDTH.hairline,
    CARD_TITLE_TYPE: TYPE_STYLES.cardTitle,
    CARD_TITLE_MAX_LINES: 2,
    CARD_KEY_TYPE: TYPE_STYLES.code,
    CARD_META_TYPE: TYPE_STYLES.caption,
    CARD_META_ICON_SIZE: ICON_SIZE.sm, // 14，到期時鐘
    CARD_AVATAR_SIZE_KEY: 'sm',
    CARD_AVATAR_SIZE: CONTROL_HEIGHT.sm, // 24，鏡射 AVATAR_TOKENS.SIZE.sm
    CARD_BADGE_DOT: false, // 卡片橫向窄，狀態不再放圓點
    CARD_BADGE_HEIGHT: TYPE_STYLES.label.lineHeight + SPACING.xs, // 20
    CARD_BADGE_RADIUS: RADIUS.full,
    CARD_BADGE_PADDING_X: SPACING.sm,
    CARD_BADGE_TYPE: TYPE_STYLES.label,
    CARD_ELEVATION: SHADOW.level1,
    CARD_DRAG_ELEVATION: SHADOW.level3,
    CARD_DRAG_SCALE: 1.02, // (literal: 拖起放大幅度，非長度階梯)
    CARD_DRAG_TILT: '1.5deg', // (literal: 拖起傾角，非長度階梯)
    CARD_GHOST_OPACITY: 0.4, // (literal: 原位殘影透明度)
    CARD_LOADING_OPACITY: 0.6, // (literal: 狀態更新中的壓暗程度)
    CARD_SPINNER_SIZE: ICON_SIZE.sm,
    CARD_SPINNER_DURATION_MS: MOTION.duration.slow * 2, // 640
    CARD_SPINNER_TRACK_WIDTH: BORDER_WIDTH.hairline,

    // 卡片自己的 focus 幾何，與 TABLE、EMPTY_STATE 的同名鍵各自可調、不連坐。
    CARD_FOCUS_RING_WIDTH: BORDER_WIDTH.focus,
    CARD_FOCUS_RING_OFFSET: BORDER_WIDTH.hairline,

    TRANSITION_MS: MOTION.duration.fast,
    TRANSITION_EASING: MOTION.easing.standard,
  },

  // ─── 空狀態 ─────────────────────────────────────────────────
  EMPTY_STATE: {
    PADDING_Y: SPACING['3xl'], // 40
    PADDING_Y_COMPACT: SPACING.xl, // 24，看板欄內用
    PADDING_X: SPACING.xl,
    GAP: SPACING.sm,
    MAX_WIDTH: SPACING['2xl'] * 10, // 320，說明文字不拉成長條
    ICON_BOX: SPACING['4xl'], // 48
    ICON_BOX_COMPACT: SPACING['2xl'], // 32
    ICON_GLYPH_SIZE: ICON_SIZE.xl, // 24
    ICON_GLYPH_SIZE_COMPACT: ICON_SIZE.md, // 16
    ICON_RADIUS: RADIUS.full,
    TITLE_TYPE: TYPE_STYLES.bodyMedium,
    TITLE_TYPE_COMPACT: TYPE_STYLES.bodySm,
    DESC_TYPE: TYPE_STYLES.bodySm,
    ACTION_MARGIN_TOP: SPACING.md,
    ACTION_HEIGHT: CONTROL_HEIGHT.md, // 28
    ACTION_PADDING_X: SPACING.md,
    ACTION_RADIUS: RADIUS.sm,
    ACTION_TYPE: TYPE_STYLES.label,
    ACTION_BORDER_WIDTH: BORDER_WIDTH.hairline,
    FOCUS_RING_WIDTH: BORDER_WIDTH.focus,
    FOCUS_RING_OFFSET: BORDER_WIDTH.hairline,
  },

  // ─── 權限過濾標示 ───────────────────────────────────────────
  FILTER_NOTICE: {
    MIN_HEIGHT: CONTROL_HEIGHT.lg, // 32
    PADDING_X: SPACING.md,
    PADDING_Y: SPACING.xs,
    GAP: SPACING.sm,
    RADIUS: RADIUS.sm,
    BORDER_WIDTH: BORDER_WIDTH.hairline,
    ACCENT_WIDTH: BORDER_WIDTH.focus, // 左側色條
    ICON_SIZE: ICON_SIZE.sm, // 14
    TEXT_TYPE: TYPE_STYLES.bodySm,
    COUNT_WEIGHT: TYPOGRAPHY.weight.semibold,
    REASON_TYPE: TYPE_STYLES.caption,
  },
} as const;

// ─── 色彩 resolver ───────────────────────────────────────────
// 每個 key 吃 theme 物件、回傳該元件用得到的色彩集合。
// 一律讀 theme 的語意鍵，不讀 PALETTE 原料、不寫 hex。
//
// 對比守則（依 atomic 層已驗證的配對）：
//   - 一切文字走 text.primary / secondary / tertiary，三階在雙主題都過 4.5:1
//   - badge 文字只吃 status.<name>_fg 疊 status.<name>_bg，四色都過 4.5:1
//   - 必要邊界（可聚焦元件的外框）吃 border.input，兩主題都過 3:1
//   - border.base / strong 只承裝飾性分隔，不當可聚焦元件的唯一邊界
//   - 逾期等紅字吃 status.error_fg 而非 status.error，後者只保 3:1 給圖示與圓點

export interface TableColors {
  readonly surface: string;
  readonly outerBorder: string;
  readonly headerBg: string;
  readonly headerFg: string;
  readonly headerActiveFg: string;
  readonly headerDivider: string;
  readonly headerHoverBg: string;
  readonly rowFg: string;
  readonly rowMutedFg: string;
  readonly rowDivider: string;
  readonly zebraBg: string;
  readonly hoverBg: string;
  readonly selectedBg: string;
  readonly selectedFg: string;
  readonly selectedAccent: string;
  readonly groupBg: string;
  readonly groupFg: string;
  readonly keyFg: string;
  readonly neutralBadgeBg: string;
  readonly neutralBadgeFg: string;
  readonly avatarBg: string;
  readonly avatarFg: string;
  readonly overdueFg: string;
  readonly dueSoonFg: string;
  readonly disabledFg: string;
  readonly disabledOpacity: number;
  readonly focusRing: string;
  readonly focusBorder: string;
}

export interface KanbanColors {
  readonly columnBg: string;
  readonly columnBorder: string;
  readonly columnHeaderFg: string;
  readonly countBg: string;
  readonly countFg: string;
  readonly dropTargetBg: string;
  readonly dropTargetBorder: string;
  readonly cardBg: string;
  readonly cardBorder: string;
  readonly cardHoverBorder: string;
  readonly cardSelectedBorder: string;
  readonly cardKeyFg: string;
  readonly cardTitleFg: string;
  readonly cardMetaFg: string;
  readonly avatarBg: string;
  readonly avatarFg: string;
  readonly overdueFg: string;
  readonly dueSoonFg: string;
  readonly neutralBadgeBg: string;
  readonly neutralBadgeFg: string;
  readonly spinnerTrack: string;
  readonly spinnerHead: string;
  readonly disabledFg: string;
  readonly disabledOpacity: number;
  readonly focusRing: string;
  readonly focusBorder: string;
  readonly shadowColor: string;
}

export interface EmptyStateColors {
  readonly iconBg: string;
  readonly iconFg: string;
  readonly titleFg: string;
  readonly descFg: string;
  readonly actionBg: string;
  readonly actionFg: string;
  readonly actionBorder: string;
  readonly actionHoverBg: string;
  readonly disabledFg: string;
  readonly disabledOpacity: number;
  readonly focusRing: string;
  readonly focusBorder: string;
}

export interface FilterNoticeToneColors {
  readonly bg: string;
  readonly fg: string;
  readonly accent: string;
}

export interface FilterNoticeColors {
  readonly info: FilterNoticeToneColors;
  readonly warning: FilterNoticeToneColors;
  readonly reasonFg: string;
  readonly border: string;
}

export const DATA_DISPLAY_COLORS = {
  TABLE: (theme: Theme): TableColors => ({
    surface: theme.bg.surface,
    outerBorder: theme.border.base,
    headerBg: theme.bg.surface_dim,
    headerFg: theme.text.secondary,
    headerActiveFg: theme.text.primary,
    headerDivider: theme.border.base,
    headerHoverBg: theme.state.hover.bg,
    rowFg: theme.text.primary,
    rowMutedFg: theme.text.tertiary,
    rowDivider: theme.divider.hairline,
    zebraBg: theme.bg.surface_dim, // 4% 疊層，疊在 surface 上不改色相
    hoverBg: theme.state.hover.bg,
    selectedBg: theme.state.selected.bg,
    selectedFg: theme.state.selected.fg,
    selectedAccent: theme.state.selected.border,
    groupBg: theme.bg.surface_dim,
    groupFg: theme.text.secondary,
    keyFg: theme.primary.main, // light pine800 / dark pine400，兩邊都過 AA
    neutralBadgeBg: theme.bg.surface_dim,
    neutralBadgeFg: theme.text.secondary,
    avatarBg: theme.primary.main,
    avatarFg: theme.primary.on_main,
    overdueFg: theme.status.error_fg,
    dueSoonFg: theme.status.warning_fg,
    disabledFg: theme.state.disabled.fg,
    disabledOpacity: theme.state.disabled.opacity,
    focusRing: theme.state.focus.ring,
    focusBorder: theme.border.input, // 焦點態的元件外框，3:1 必要邊界
  }),

  KANBAN: (theme: Theme): KanbanColors => ({
    columnBg: theme.bg.surface_dim, // 比卡片暗一階，卡片才浮得起來
    columnBorder: theme.border.base,
    columnHeaderFg: theme.text.secondary,
    countBg: theme.bg.surface,
    countFg: theme.text.tertiary,
    dropTargetBg: theme.state.selected.bg,
    dropTargetBorder: theme.state.selected.border,
    cardBg: theme.bg.surface,
    cardBorder: theme.border.base,
    cardHoverBorder: theme.border.strong,
    cardSelectedBorder: theme.state.selected.border,
    cardKeyFg: theme.primary.main,
    cardTitleFg: theme.text.primary,
    cardMetaFg: theme.text.tertiary,
    avatarBg: theme.primary.main,
    avatarFg: theme.primary.on_main,
    overdueFg: theme.status.error_fg,
    dueSoonFg: theme.status.warning_fg,
    neutralBadgeBg: theme.bg.surface_dim,
    neutralBadgeFg: theme.text.secondary,
    spinnerTrack: theme.border.base,
    spinnerHead: theme.primary.main,
    disabledFg: theme.state.disabled.fg,
    disabledOpacity: theme.state.disabled.opacity,
    focusRing: theme.state.focus.ring,
    focusBorder: theme.border.input,
    shadowColor: theme.shadow.color,
  }),

  EMPTY_STATE: (theme: Theme): EmptyStateColors => ({
    iconBg: theme.bg.surface_dim,
    iconFg: theme.text.tertiary,
    titleFg: theme.text.primary,
    descFg: theme.text.secondary,
    actionBg: theme.primary.main,
    actionFg: theme.primary.on_main,
    actionBorder: theme.border.input,
    // hover 走「同色系推一階」，方向依主題相反——與 BUTTON_TOKENS 的 primary 同一條規則。
    // 兩主題都推 700 會讓 dark 的深墨字壓在深底上、對比塌到 2:1 以下。
    actionHoverBg: theme.id === 'dark' ? theme.primary[300] : theme.primary[900],
    disabledFg: theme.state.disabled.fg,
    disabledOpacity: theme.state.disabled.opacity,
    focusRing: theme.state.focus.ring,
    focusBorder: theme.border.input,
  }),

  FILTER_NOTICE: (theme: Theme): FilterNoticeColors => ({
    info: { bg: theme.status.info_bg, fg: theme.status.info_fg, accent: theme.status.info },
    warning: { bg: theme.status.warning_bg, fg: theme.status.warning_fg, accent: theme.status.warning },
    reasonFg: theme.text.secondary,
    border: theme.border.base,
  }),
} as const;
