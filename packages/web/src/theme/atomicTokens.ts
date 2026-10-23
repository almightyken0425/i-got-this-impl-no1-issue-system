// F4 灰藍主題。sand / PRIMARY_PINE 保留相容識別名，值由本次 Foundations 定案。
export type SandStep = 0 | 50 | 100 | 200 | 300 | 400 | 500 | 600 | 700 | 800 | 900 | 950 | 1000;
export type PineStep = 50 | 100 | 200 | 300 | 400 | 500 | 600 | 700 | 800 | 900;

export type SandScale = { readonly [K in SandStep]: string };
export type PineScale = { readonly [K in PineStep]: string };

export type SemanticName = 'success' | 'warning' | 'error' | 'info';
export type SemanticScale = { readonly [K in SemanticName]: string };

export type ThemeId = 'light' | 'dark';
export type ElevationLevel = 'level0' | 'level1' | 'level2' | 'level3';

export const PALETTE = {
  sand: {
    0: '#FFFFFF',
    50: '#F8F9FB',
    100: '#F0F2F6',
    200: '#E5E8ED',
    300: '#CDD3DD',
    400: '#A5AFBF',
    500: '#7F8999',
    600: '#677384',
    700: '#4D596C',
    800: '#384355',
    900: '#2C3441',
    950: '#171D29',
    1000: '#0E1320',
  },
  semantic: {
    success: '#16A34A',
    warning: '#D97706',
    error: '#DC2626',
    info: '#0284C7',
  },
} as const satisfies { readonly sand: SandScale; readonly semantic: SemanticScale };

export const PRIMARY_PINE = {
  50: '#EDF0FC',
  100: '#E1E7FB',
  200: '#CBD5F8',
  300: '#B5C3F7',
  400: '#A2B3FF',
  500: '#7A91EA',
  600: '#6680E0',
  700: '#526CCE',
  800: '#4663D2',
  900: '#354FAF',
} as const satisfies PineScale;

export interface ShadowElevationStep {
  readonly offsetY: number;
  readonly blur: number;
  readonly opacity: number;
}

export type ShadowElevation = { readonly [K in ElevationLevel]: ShadowElevationStep };

export const SHADOW_ELEVATION = {
  level0: { offsetY: 0, blur: 0, opacity: 0 },
  level1: { offsetY: 1, blur: 2, opacity: 0.06 },
  level2: { offsetY: 4, blur: 12, opacity: 0.1 },
  level3: { offsetY: 12, blur: 32, opacity: 0.18 },
} as const satisfies ShadowElevation;

export interface ThemeBg {
  /** app 底：工作區外框、page 背景 */
  readonly base: string;
  /** 卡片 / 表格 / panel 底，抬起的紙面 */
  readonly surface: string;
  /** row hover 底 */
  readonly surface_hover: string;
  /** 比 surface 淡一階的子區塊底（toolbar、table header） */
  readonly surface_dim: string;
}

/** 三階文字全數承 WCAG 1.4.3 的 4.5:1——placeholder、時間戳、meta 都算文字，沒有豁免。 */
export interface ThemeText {
  readonly primary: string;
  readonly secondary: string;
  /** meta 資訊、placeholder、時間戳 */
  readonly tertiary: string;
}

/**
 * border 三鍵依「是不是必要 UI 元件邊界」分流，1.4.11 的 3:1 只約束 input。
 * 消費端不得以 strong 代 input；strong 只是更重的裝飾線、不保證 3:1。
 */
export interface ThemeBorder {
  /** 裝飾性：卡片外框、表格細線 */
  readonly base: string;
  /** 裝飾性加重：分區邊、hover 態容器邊 */
  readonly strong: string;
  /** 必要邊界：輸入框、select、textarea、checkbox 等可聚焦控件外框 */
  readonly input: string;
}

export interface ThemeDivider {
  readonly base: string;
  /** 表格 row 分隔等最細分隔線 */
  readonly hairline: string;
}

/**
 * pine 十階加上 main 與 on_main。
 * on_main 為疊在 main 上的前景色；消費端一律讀此鍵、不 hardcode 白字——
 * dark 的 main 取 pine[400] 是亮色，白字只有 2.43:1。
 */
export type ThemePrimary = PineScale & {
  readonly main: string;
  readonly on_main: string;
};

/**
 * status 三件套：`<name>` 為色彩身份（圖示、圓點、邊線），
 * `<name>_bg` 為 badge 與 callout 淡底，`<name>_fg` 為疊在 _bg 上的文字色。
 *
 * 為何拆出 _fg：暖紙底把 badge 淡底一併推暖，semantic 基準色壓在自家淡底上只剩
 * 2.67–3.83:1，四色全數落在 AA 之下。修法不動基準值，改由 _bg 換成同色 12% 暖淡底、
 * _fg 換成同色系深兩階文字色，實測四色 5.94–6.58 全過 AA。
 * badge 文字只吃 _fg；基準色留給圓點與圖示等非文字元素。
 */
export interface ThemeStatus {
  readonly success: string;
  readonly success_bg: string;
  readonly success_fg: string;
  readonly warning: string;
  readonly warning_bg: string;
  readonly warning_fg: string;
  readonly error: string;
  readonly error_bg: string;
  readonly error_fg: string;
  readonly info: string;
  readonly info_bg: string;
  readonly info_fg: string;
}

export interface ThemeState {
  readonly hover: { readonly bg: string };
  readonly selected: {
    readonly bg: string;
    readonly fg: string;
    readonly border: string;
  };
  /** 停用元件不受 1.4.3 與 1.4.11 約束，故 fg 容許低於 4.5:1。 */
  readonly disabled: { readonly fg: string; readonly opacity: number };
  readonly focus: { readonly ring: string; readonly ringWidth: number };
}

export interface ThemeShadow {
  readonly color: string;
  readonly elevation: ShadowElevation;
}

export interface Theme {
  readonly id: ThemeId;
  readonly name: string;
  readonly bg: ThemeBg;
  readonly text: ThemeText;
  readonly border: ThemeBorder;
  readonly divider: ThemeDivider;
  readonly primary: ThemePrimary;
  readonly status: ThemeStatus;
  readonly state: ThemeState;
  readonly shadow: ThemeShadow;
}

export const THEME_LIGHT: Theme = {
  id: 'light',
  name: 'Light（預設）',
  bg: {
    base: PALETTE.sand[0],
    surface: PALETTE.sand[0],
    surface_hover: PALETTE.sand[50],
    surface_dim: '#F8F9FB',
  },
  text: {
    primary: PALETTE.sand[900],
    secondary: PALETTE.sand[700],
    tertiary: PALETTE.sand[600],
  },
  border: {
    base: PALETTE.sand[200],
    strong: PALETTE.sand[300],
    input: PALETTE.sand[500],
  },
  divider: {
    base: PALETTE.sand[200],
    hairline: '#E5E8ED',
  },
  primary: { main: PRIMARY_PINE[800], on_main: '#FFFFFF', ...PRIMARY_PINE },
  status: {
    success: PALETTE.semantic.success,
    success_bg: '#E0EFE0',
    success_fg: '#166534',
    warning: PALETTE.semantic.warning,
    warning_bg: '#F7E9D7',
    warning_fg: '#92400E',
    error: PALETTE.semantic.error,
    error_bg: '#F7E0DB',
    error_fg: '#991B1B',
    info: PALETTE.semantic.info,
    info_bg: '#DDEBEF',
    info_fg: '#075985',
  },
  state: {
    hover: { bg: PALETTE.sand[50] },
    selected: { bg: PRIMARY_PINE[50], fg: PRIMARY_PINE[800], border: PRIMARY_PINE[700] },
    disabled: { fg: PALETTE.sand[400], opacity: 0.45 },
    focus: { ring: PRIMARY_PINE[700], ringWidth: 2 },
  },
  shadow: { color: PALETTE.sand[900], elevation: SHADOW_ELEVATION },
};

export const THEME_DARK: Theme = {
  id: 'dark',
  name: 'Dark',
  bg: {
    base: PALETTE.sand[950],
    surface: PALETTE.sand[900],
    surface_hover: PALETTE.sand[800],
    surface_dim: 'rgba(255,255,255,0.04)',
  },
  text: {
    primary: PALETTE.sand[100],
    secondary: PALETTE.sand[300],
    tertiary: PALETTE.sand[400],
  },
  border: {
    base: PALETTE.sand[800],
    strong: PALETTE.sand[700],
    input: PALETTE.sand[500],
  },
  divider: {
    base: PALETTE.sand[800],
    hairline: 'rgba(165,175,191,0.14)',
  },
  primary: { main: PRIMARY_PINE[400], on_main: PALETTE.sand[1000], ...PRIMARY_PINE },
  status: {
    success: '#4ADE80',
    success_bg: '#293824',
    success_fg: '#4ADE80',
    warning: '#FBBF24',
    warning_bg: '#3F3419',
    warning_fg: '#FBBF24',
    error: '#F87171',
    error_bg: '#3E2B23',
    error_fg: '#F87171',
    info: '#38BDF8',
    info_bg: '#273433',
    info_fg: '#38BDF8',
  },
  state: {
    hover: { bg: PALETTE.sand[800] },
    selected: { bg: 'rgba(162,179,255,0.10)', fg: PRIMARY_PINE[300], border: PRIMARY_PINE[400] },
    disabled: { fg: PALETTE.sand[600], opacity: 0.45 },
    focus: { ring: PRIMARY_PINE[400], ringWidth: 2 },
  },
  shadow: { color: PALETTE.sand[1000], elevation: SHADOW_ELEVATION },
};

export const THEMES: { readonly [K in ThemeId]: Theme } = {
  light: THEME_LIGHT,
  dark: THEME_DARK,
};

export const DEFAULT_THEME_ID: ThemeId = 'light';

export const DEFAULT_THEME: Theme = THEMES[DEFAULT_THEME_ID];
