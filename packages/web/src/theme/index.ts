// design token 的 impl 落點 · 統一匯出口
//
// 仲裁關係：
// - design git 是視覺標準的唯一仲裁端，impl 逐名對齊、不自行設值
// - 對應來源為 Module Design git 的 `10_foundations/` 目錄，檔案切分逐一對應：
//     no1_atomic_tokens.jsx                     → atomicTokens.ts
//     no2_typography.jsx                        → typography.ts
//     no3_layout_tokens.jsx                     → layoutTokens.ts
//     component_tokens/no1_control_tokens.jsx   → componentTokens/controlTokens.ts
//     component_tokens/no2_data_display_tokens  → componentTokens/dataDisplayTokens.ts
//     component_tokens/no3_gantt_tokens.jsx     → componentTokens/ganttTokens.ts
// - export 名稱與 design 端逐名相同，兩層對照零翻譯成本
// - design 端吃 theme 求值的 resolver 在此保留同樣形態，只補上型別
//
// 不在對應範圍：
// - design 的 TOKENS 是 canvas 渲染快照，design 端已註明 impl 不對齊，故不搬
// - ThemeProvider.tsx 是 impl 專屬的切換機制，不新增 token
//
// F4 視覺錨點由 Design Foundations 仲裁。
//
// 用法：色彩一律經 useTheme() 取當下 Theme，再餵給 component token 的 resolver；
// 尺寸與字級直接讀本檔匯出的常數。元件層不 hardcode 任何 hex 與 raw number。

export * from './atomicTokens';
export * from './typography';
export * from './layoutTokens';
export * from './componentTokens/controlTokens';
export * from './componentTokens/dataDisplayTokens';
export * from './componentTokens/ganttTokens';
export * from './ThemeProvider';
