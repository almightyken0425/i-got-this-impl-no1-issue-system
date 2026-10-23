// Layout tokens · 間距 / 圓角 / 陰影 alias / 邊框 / 動畫 / icon 尺寸 / 控件與 row 高度
//
// 來源：design git 的 `10_foundations/no3_layout_tokens.jsx`。
//
// 仲裁關係：design git 是視覺標準的唯一仲裁端，impl 逐名對齊、不自行設值。
// 階梯要加階或改值先在 design 定案，再回搬本檔。
//
// 跨元件共用的版面原語階梯。component token 一律引用此檔，不各自 hardcode。
// SHADOW 為 SHADOW_ELEVATION 的 alias；主來源在 atomicTokens.ts。

import { SHADOW_ELEVATION } from './atomicTokens';

// ─── SPACING ─────────────────────────────────────────────────
// 4px 網格。語意命名階梯，桌面高密度介面預設用 sm / md 級距。
// 最小階 2xs=2 專供行內微調（badge 內距、icon 與文字的貼齊補位），不視為元件間留白。

export const SPACING = {
  '2xs': 2,
  xs: 4,
  sm: 8,
  md: 12,
  lg: 16,
  xl: 24,
  '2xl': 32,
  '3xl': 40,
  '4xl': 48,
} as const;

export type SpacingKey = keyof typeof SPACING;

// ─── RADIUS ──────────────────────────────────────────────────
// F4：控件 10、卡片 11、模組 18。
// full 只給 pill 形 badge 與 avatar。

export const RADIUS = {
  none: 0,
  sm: 10,
  md: 11,
  lg: 18,
  full: 9999,
} as const;

export type RadiusKey = keyof typeof RADIUS;

// ─── SHADOW ──────────────────────────────────────────────────
// SHADOW 為 SHADOW_ELEVATION 的向後相容 alias，對齊 design 的同名 export。

export const SHADOW = SHADOW_ELEVATION;

// ─── BORDER_WIDTH ────────────────────────────────────────────
// hairline 為一切分隔與外框的預設；focus 只給 focus ring。

export const BORDER_WIDTH = {
  hairline: 1,
  focus: 2,
} as const;

export type BorderWidthKey = keyof typeof BORDER_WIDTH;

// ─── MOTION ──────────────────────────────────────────────────
// duration 與 easing。桌面工具動畫節制、偏快，hover 反饋走 instant。

export const MOTION = {
  duration: {
    instant: 80,
    fast: 150,
    base: 220,
    slow: 320,
  },
  easing: {
    standard: 'cubic-bezier(0.4, 0, 0.2, 1)',
    decelerate: 'cubic-bezier(0, 0, 0.2, 1)',
    accelerate: 'cubic-bezier(0.4, 0, 1, 1)',
  },
} as const;

export type MotionDurationKey = keyof typeof MOTION.duration;
export type MotionEasingKey = keyof typeof MOTION.easing;

// ─── ICON_SIZE ───────────────────────────────────────────────
// 桌面密度比行動端小一號：列表與按鈕內 icon 預設 md 16。

export const ICON_SIZE = {
  /** 行內 chevron / 排序箭頭 */
  xs: 12,
  /** 表格 row 內 status icon */
  sm: 14,
  /** 按鈕 / 列表標準 icon */
  md: 16,
  /** toolbar / nav icon */
  lg: 20,
  /** 空狀態與強調區 icon */
  xl: 24,
} as const;

export type IconSizeKey = keyof typeof ICON_SIZE;

// ─── CONTROL_HEIGHT ──────────────────────────────────────────
// 控件高度三階。滑鼠精度高於觸控，桌面控件不受 44pt 下界拘束。

export const CONTROL_HEIGHT = {
  /** 行內 filter chip、表格內小按鈕 */
  sm: 24,
  /** 預設按鈕 / input / select */
  md: 28,
  /** 頁面主要動作按鈕、搜尋框 */
  lg: 32,
} as const;

export type ControlHeightKey = keyof typeof CONTROL_HEIGHT;

// ─── ROW_HEIGHT ──────────────────────────────────────────────
// 工單表格 row 高度三檔。compact 為高密度掃描模式，base 為預設。

export const ROW_HEIGHT = {
  compact: 32,
  base: 36,
  relaxed: 44,
} as const;

/** 表格與甘特共用的密度鍵，兩處吃同一個值才逐列對齊。 */
export type Density = keyof typeof ROW_HEIGHT;

// F4 角色尺寸，Design 仲裁，Impl 逐名引用。
export const F4_LAYOUT = {
  rail: 56, railGap: 22, boardGap: 17, moduleRadius: 18, cardRadius: 11,
  controlRadius: 10, thumbnailRadius: 8, thumbnailWidth: 89, thumbnailHeight: 64,
  cardMinHeight: 82, mobileBreakpoint: 800, singleColumnBreakpoint: 540,
  pagePadding: 32, touchTarget: 44,
} as const;
