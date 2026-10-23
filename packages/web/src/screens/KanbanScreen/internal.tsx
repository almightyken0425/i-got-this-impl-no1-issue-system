// KanbanScreen · 私有小元件
//
// 來源：design git 的 `30_screens/no2_kanban_screen/no2_kanban_screen.jsx` 內
// KanbanDropSlot 與 KanbanResolutionPrompt 兩段。
//
// 只服務 KanbanScreen，既有元件組無對應件。KanbanDragOverlay 不搬——
// 那是 canvas 為了靜態演出「抬起的卡片」而做的浮層，app 走瀏覽器原生拖放，
// 拖曳影像由瀏覽器產生。

import { useState } from 'react';

import { Button, Select } from '../../components/controls';
import {
  controlShadow,
  DATA_DISPLAY_COLORS,
  FONT_FAMILY,
  NUMERIC_FONT_VARIANT,
  useTheme,
} from '../../theme';
import { typeStyle } from '../typeStyle';
import type { WorkspaceIssue, WorkspaceResolutionOption } from '../../api';
import { KANBAN_SCREEN_TOKENS } from './tokens';

const K = KANBAN_SCREEN_TOKENS;

// ─── KanbanDropSlot · 放置指示槽 ─────────────────────────────
// 目標欄內的落點。虛線框吃 state.selected.border，與 KanbanColumn 的 dropTarget
// 邊框同色，兩者讀作同一組「這裡可以放」的訊號。

export interface KanbanDropSlotProps {
  readonly label: string;
}

export function KanbanDropSlot({ label }: KanbanDropSlotProps) {
  const { theme } = useTheme();
  const c = DATA_DISPLAY_COLORS.KANBAN(theme);
  return (
    <div
      role="presentation"
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        height: K.DROP_SLOT_HEIGHT,
        flexShrink: 0,
        border: `${K.DROP_SLOT_BORDER_WIDTH}px dashed ${c.dropTargetBorder}`,
        borderRadius: K.DROP_SLOT_RADIUS,
        background: 'transparent',
        color: theme.state.selected.fg,
        fontFamily: FONT_FAMILY.base,
        ...typeStyle(K.DROP_SLOT_TYPE),
      }}
    >
      {label}
    </div>
  );
}

// ─── KanbanResolutionPrompt · 結案原因選擇 ───────────────────
// 拖入終止欄釋放後出現。選項資料由 getResolutionOptions 產出。
// 未選任何原因時「確認結案」停用——對應 validateStatusTransition 的
// 「目標狀態為終止狀態且結案原因未提供則禁止」，把禁止原因擋在送出之前。
// 取消則卡片留在原欄，浮層收起、不呼叫 changeIssueStatus。

export interface KanbanResolutionPromptProps {
  readonly issue: Pick<WorkspaceIssue, 'key'>;
  readonly targetLabel: string;
  readonly options: readonly WorkspaceResolutionOption[];
  readonly onCancel: () => void;
  readonly onConfirm: (resolutionValue: string) => void;
}

export function KanbanResolutionPrompt({
  issue,
  targetLabel,
  options,
  onCancel,
  onConfirm,
}: KanbanResolutionPromptProps) {
  const { theme } = useTheme();
  const [picked, setPicked] = useState<string | null>(null);

  return (
    <div
      role="dialog"
      aria-label="選擇結案原因"
      style={{
        position: 'absolute',
        zIndex: 10,
        top: K.PROMPT_TOP,
        left: 0,
        right: 0,
        display: 'flex',
        flexDirection: 'column',
        gap: K.PROMPT_GAP,
        padding: K.PROMPT_PADDING,
        background: theme.bg.surface,
        border: `${K.PROMPT_BORDER_WIDTH}px solid ${theme.border.base}`,
        borderRadius: K.PROMPT_RADIUS,
        boxShadow: controlShadow(theme, 'level3'),
        fontFamily: FONT_FAMILY.base,
      }}
    >
      <div style={{ ...typeStyle(K.PROMPT_TITLE_TYPE), color: theme.text.primary }}>
        選擇結案原因
      </div>
      <div style={{ ...typeStyle(K.PROMPT_SUBTITLE_TYPE), color: theme.text.secondary }}>
        <span
          style={{
            fontFamily: FONT_FAMILY.mono,
            fontVariantNumeric: NUMERIC_FONT_VARIANT,
            color: theme.primary.main,
          }}
        >
          {issue.key}
        </span>
        {` 拖入 ${targetLabel}`}
      </div>

      <Select label="結案原因" placeholder="選擇結案原因" fullWidth
        options={options.map(option => ({ value: option.value, label: option.value }))}
        {...(picked === null ? {} : { value: picked })} onChange={setPicked} />

      <div
        style={{
          ...typeStyle(K.PROMPT_HINT_TYPE),
          color: picked === null ? theme.status.warning_fg : theme.text.tertiary,
          borderTop: `${K.PROMPT_DIVIDER_WIDTH}px solid ${theme.divider.base}`,
          paddingTop: K.PROMPT_GAP,
        }}
      >
        {picked === null
          ? '請先選擇結案原因。'
          : '確認後移至目標階段。'}
      </div>

      <div
        style={{
          display: 'flex',
          justifyContent: 'flex-end',
          gap: K.PROMPT_FOOTER_GAP,
          marginTop: K.PROMPT_FOOTER_MARGIN_TOP,
        }}
      >
        <Button variant="ghost" size="sm" label="取消" onClick={onCancel} />
        <Button
          variant="primary"
          size="sm"
          label="確認結案"
          disabled={picked === null}
          onClick={() => {
            if (picked !== null) onConfirm(picked);
          }}
        />
      </div>
    </div>
  );
}
