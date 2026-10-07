import { useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';

import { Button, Select } from '../../components/controls';
import type { SelectOption } from '../../components/controls';
import {
  FONT_FAMILY,
  NUMERIC_FONT_VARIANT,
  TYPE_STYLES,
  useTheme,
} from '../../theme';
import type { WorkspaceResolutionOption } from '../../api';
import { typeStyle } from '../typeStyle';
import { ISSUE_DETAIL_SCREEN_TOKENS } from './tokens';

const T = ISSUE_DETAIL_SCREEN_TOKENS;

/** 任意欄位值 → 可讀文字；null/undefined/空字串統一顯示「(無)」。 */
export function displayValue(value: unknown): string {
  if (value === null || value === undefined || value === '') return '未填寫';
  if (typeof value === 'number' || typeof value === 'string') return String(value);
  if (typeof value === 'boolean') return value ? '是' : '否';
  return JSON.stringify(value);
}

/** 異動歷史時間戳 → "YYYY-MM-DD HH:mm"，對齊 Spec 線框圖格式。 */
export function formatChangeLogTime(ms: number): string {
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

// ─── SectionPanel · 區塊容器 ─────────────────────────────────
// 欄位區／關聯區／異動歷史區共用的卡片外框：標題 + 內容堆疊。

export interface SectionPanelProps {
  readonly title: string;
  readonly children: ReactNode;
}

export function SectionPanel({ title, children }: SectionPanelProps) {
  const { theme } = useTheme();
  return (
    <section
      aria-label={title}
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: T.PANEL_GAP,
        minWidth: 0,
        padding: `${T.PANEL_PADDING}px 0`,
        background: theme.bg.surface,
        borderTop: `${T.PANEL_BORDER_WIDTH}px solid ${theme.border.base}`,
      }}
    >
      <h2 style={{ ...typeStyle(T.PANEL_TITLE_TYPE), margin: 0, color: theme.text.primary }}>{title}</h2>
      {children}
    </section>
  );
}

// ─── FieldRow · 欄位區一列 ───────────────────────────────────
// label 定寬左欄 + 控件右欄；唯讀與可編輯共用同一列殼，切換時列高不跳動。

export interface FieldRowProps {
  readonly label: string;
  readonly children: ReactNode;
}

export function FieldRow({ label, children }: FieldRowProps) {
  const { theme } = useTheme();
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: T.FIELD_ROW_GAP,
        minHeight: T.FIELD_ROW_MIN_HEIGHT,
      }}
    >
      <span
        style={{
          width: T.FIELD_LABEL_WIDTH,
          flexShrink: 0,
          ...typeStyle(TYPE_STYLES.bodySm),
          color: theme.text.secondary,
        }}
      >
        {label}
      </span>
      <div style={{ flex: 1, minWidth: 0, display: 'flex', alignItems: 'center', gap: T.FIELD_CONFIRM_GAP }}>
        {children}
      </div>
    </div>
  );
}

/** 唯讀欄位值：純文字，超長截斷。 */
export function ReadOnlyValue({ text }: { readonly text: string }) {
  const { theme } = useTheme();
  return (
    <span
      title={text}
      style={{
        ...typeStyle(T.FIELD_VALUE_TYPE),
        color: theme.text.primary,
        minWidth: 0,
        overflowWrap: 'anywhere',
      }}
    >
      {text}
    </span>
  );
}

// ─── EditableTextField · 可編輯欄位的文字輸入 ────────────────
// 草稿與已提交值分離：Enter 或按確認鈕才呼叫 onCommit，值型別轉換
// （StoryPoint 轉數字、空字串轉 null 等）交給呼叫端在 onCommit 內處理，
// 本元件只管文字草稿與「何時算使用者確認了」。
//
// Enter 鍵透過事件冒泡在外層 div 接（TextInput 本身不轉發 onKeyDown），
// 比照 ListScreen 的 CreateIssueBar 同一手法。

export interface EditableTextFieldProps {
  readonly value: string;
  readonly label?: string;
  readonly placeholder?: string;
  readonly disabled?: boolean;
  readonly heading?: boolean;
  readonly onCancel?: () => void;
  readonly onCommit: (next: string) => void | boolean | Promise<void | boolean>;
}

export function EditableTextField({ value, label = '欄位', placeholder, disabled = false, heading = false, onCancel, onCommit }: EditableTextFieldProps) {
  const { theme } = useTheme();
  const [draft, setDraft] = useState(value);
  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const savingRef = useRef(false);
  useEffect(() => { if (!editing) setDraft(value); }, [value, editing]);
  useEffect(() => { if (editing) input.current?.focus(); }, [editing]);
  const close = () => { setEditing(false); requestAnimationFrame(() => trigger.current?.focus()); };
  const cancel = () => { if (savingRef.current) return; setDraft(value); onCancel?.(); close(); };
  const commit = async () => {
    if (disabled || savingRef.current) return;
    if (draft === value) { close(); return; }
    savingRef.current = true;
    setSaving(true);
    try { if (await onCommit(draft) !== false) close(); }
    finally { savingRef.current = false; setSaving(false); }
  };
  if (!editing) return <button ref={trigger} type="button" className="issue-editable" aria-label={`編輯${label}：${value || '未填寫'}`} disabled={disabled}
    onClick={() => { setDraft(value); setEditing(true); }}
    style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: T.GROUP_GAP, width: '100%', minWidth: 0, minHeight: T.EDIT_HEIGHT,
      padding: 0, border: 0, borderRadius: T.PANEL_RADIUS, background: 'transparent', color: value ? theme.text.primary : theme.text.tertiary,
      fontFamily: FONT_FAMILY.base, ...typeStyle(heading ? T.TITLE_TYPE : T.FIELD_VALUE_TYPE), textAlign: 'left', cursor: disabled ? 'default' : 'pointer' }}>
    <span style={{ overflowWrap: 'anywhere', minWidth: 0 }}>{value || '未填寫'}</span>
    <span className="issue-edit-hint" aria-hidden="true" style={{ ...typeStyle(TYPE_STYLES.label), color: theme.text.tertiary, flexShrink: 0 }}>編輯</span>
  </button>;
  return <div style={{ display: 'flex', flexDirection: 'column', gap: T.GROUP_GAP, flex: 1, minWidth: 0 }}>
    <input ref={input} aria-label={label} value={draft} disabled={saving || disabled} placeholder={placeholder}
      onChange={event => setDraft(event.target.value)}
      onKeyDown={event => { if (event.nativeEvent.isComposing) return; if (event.key === 'Enter') { event.preventDefault(); void commit(); } if (event.key === 'Escape') { event.preventDefault(); cancel(); } }}
      style={{ width: '100%', minWidth: 0, minHeight: T.EDIT_HEIGHT, boxSizing: 'border-box', padding: T.GROUP_GAP, border: `1px solid ${theme.border.input}`, borderRadius: T.PANEL_RADIUS,
        fontFamily: FONT_FAMILY.base, ...typeStyle(T.FIELD_VALUE_TYPE), color: theme.text.primary, background: theme.bg.surface }} />
    <div style={{ display: 'flex', gap: T.GROUP_GAP }}>
      <Button size="sm" label={saving ? '儲存中…' : '儲存'} disabled={saving || disabled} onClick={() => void commit()} />
      <Button size="sm" variant="ghost" label="取消" disabled={saving} onClick={cancel} />
    </div>
  </div>;
}

/** 姓名不可得時保留可區分的短編號，完整編號由 title 提供。 */
export function personLabel(id: string, account?: { id: string; name: string } | null): string {
  if (account?.id === id) return account.name;
  return /^[0-9a-f]{8}-[0-9a-f-]{27}$/i.test(id) ? `成員 ${id.slice(0, 8)}` : id;
}

export function relationLabel(name: string): string {
  return ({ Children: '子工單', parent_child: '父子關聯', Before: '前置工單', RelatedTo: '相關工單', Container: '主題綁定' } as Record<string, string>)[name] ?? name;
}

// ─── RelationGroup · 關聯區一個分組 ──────────────────────────
// 標題 + 對側工單編號清單；空清單不畫（由呼叫端決定是否要整體空狀態）。

export interface RelationGroupItem {
  readonly id: string;
  readonly key: string;
  readonly relationId?: string;
  readonly canRemove?: boolean;
  readonly readable?: boolean;
  readonly direction?: 'outgoing' | 'incoming';
}

export interface RelationGroupProps {
  readonly title: string;
  readonly items: readonly RelationGroupItem[];
  readonly onRemove?: (id: string) => Promise<boolean>;
  readonly onOpen?: (id: string) => void;
}

export function RelationGroup({ title, items, onRemove, onOpen }: RelationGroupProps) {
  const { theme } = useTheme();
  const [confirmId, setConfirmId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  if (items.length === 0) return null;
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: T.GROUP_GAP, minWidth: 0 }}>
      <span style={{ ...typeStyle(T.GROUP_TITLE_TYPE), color: theme.text.tertiary }}>{title}</span>
      <div style={{ display: 'flex', flexDirection: 'column', gap: T.RELATION_ITEM_GAP }}>
        {items.map((item) => (
          <div key={item.relationId ?? item.id} style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: T.GROUP_GAP }}>
          {item.direction && <span style={{ ...typeStyle(TYPE_STYLES.label), color: theme.text.secondary }}>{item.direction === 'outgoing' ? '連至 →' : '來自 ←'}</span>}
          <span
            style={{
              ...typeStyle(T.RELATION_ITEM_TYPE),
              fontFamily: FONT_FAMILY.mono,
              fontVariantNumeric: NUMERIC_FONT_VARIANT,
              color: theme.primary.main,
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}
          >
            {item.readable && onOpen ? <Button variant="ghost" size="sm" label={item.key} onClick={() => onOpen(item.id)} /> : `${item.key}${item.readable === false ? ' · 無讀取權' : ''}`}
          </span>
          {item.canRemove && item.relationId && onRemove && <Button variant="ghost" size="sm" disabled={busy}
            label={confirmId === item.relationId ? '確認移除' : '移除'} onClick={() => {
              if (confirmId !== item.relationId) { setConfirmId(item.relationId!); return; }
              setBusy(true);
              void onRemove(item.relationId!).then(ok => { if (ok) setConfirmId(null); }).finally(() => setBusy(false));
            }} />}
          {confirmId === item.relationId && <Button variant="ghost" size="sm" label="取消" disabled={busy} onClick={() => setConfirmId(null)} />}
          </div>
        ))}
      </div>
    </div>
  );
}

// ─── ChangeLogRow · 異動歷史一列 ─────────────────────────────
// 依執行者、欄位、變更內容、時間排列，窄版不固定四欄。

export interface ChangeLogRowEntry {
  readonly restricted?: boolean;
  readonly id: string;
  readonly fieldName: string;
  readonly oldValue: unknown;
  readonly newValue: unknown;
  readonly actor: string;
  readonly time: number;
}

export interface ChangeLogRowProps {
  readonly entry: ChangeLogRowEntry;
  readonly fieldLabel: string;
}

export function ChangeLogRow({ entry, fieldLabel, actorLabel }: ChangeLogRowProps & { actorLabel?: string }) {
  const { theme } = useTheme();
  return <div style={{ display: 'flex', gap: T.GROUP_GAP, padding: `${T.CHANGELOG_ROW_PADDING_Y}px 0`, borderBottom: `1px solid ${theme.divider.base}` }}>
    <span aria-hidden="true" style={{ color: theme.primary.main }}>•</span>
    <div style={{ flex: 1, minWidth: 0 }}>
      <div style={{ ...typeStyle(T.CHANGELOG_TYPE), color: theme.text.secondary, overflowWrap: 'anywhere' }}><strong title={entry.actor} style={{ color: theme.text.primary }}>{actorLabel ?? personLabel(entry.actor)}</strong> 更新了 {fieldLabel}</div>
      <div style={{ ...typeStyle(T.CHANGELOG_TYPE), color: theme.text.primary, marginTop: T.FIELD_CONFIRM_GAP, overflowWrap: 'anywhere' }}>{entry.restricted ? '彙總來源權限不足' : `${displayValue(entry.oldValue)} → ${displayValue(entry.newValue)}`}</div>
      <time dateTime={new Date(entry.time).toISOString()} style={{ display: 'block', ...typeStyle(T.CHANGELOG_META_TYPE), color: theme.text.tertiary, marginTop: T.FIELD_CONFIRM_GAP }}>{formatChangeLogTime(entry.time)}</time>
    </div>
  </div>;
}

// ─── StatusResolutionPrompt · Status 轉終止狀態的結案原因選擇 ─
// 比照 KanbanScreen 的 KanbanResolutionPrompt 語意（未選不得確認、取消則
// Status 維持原值），視覺改走行內面板（本畫面 Status 是欄位列而非看板卡，
// 不需要浮層蓋版）。

export interface StatusResolutionPromptProps {
  readonly targetStatus: string;
  readonly options: readonly WorkspaceResolutionOption[];
  readonly submitting: boolean;
  readonly onCancel: () => void;
  readonly onConfirm: (resolutionValue: string) => void;
}

export function StatusResolutionPrompt({
  targetStatus,
  options,
  submitting,
  onCancel,
  onConfirm,
}: StatusResolutionPromptProps) {
  const { theme } = useTheme();
  const [picked, setPicked] = useState<string | undefined>(undefined);
  const selectOptions: readonly SelectOption[] = options.map((o) => ({ value: o.value, label: o.value }));

  return (
    <div
      role="dialog"
      aria-label="選擇結案原因"
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: T.PROMPT_GAP,
        padding: T.PROMPT_PADDING,
        background: theme.bg.surface_dim,
        border: `${T.PROMPT_BORDER_WIDTH}px solid ${theme.border.base}`,
        borderRadius: T.PROMPT_RADIUS,
      }}
    >
      <span style={{ ...typeStyle(T.PROMPT_TYPE), color: theme.text.secondary }}>
        {`轉為「${targetStatus}」須選擇結案原因`}
      </span>
      <Select
        placeholder="選擇結案原因"
        options={selectOptions}
        onChange={setPicked}
        disabled={submitting}
        {...(picked === undefined ? {} : { value: picked })}
      />
      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: T.FIELD_CONFIRM_GAP }}>
        <Button variant="ghost" size="sm" label="取消" disabled={submitting} onClick={onCancel} />
        <Button
          variant="primary"
          size="sm"
          label="確認結案"
          loading={submitting}
          disabled={picked === undefined}
          onClick={() => {
            if (picked !== undefined) onConfirm(picked);
          }}
        />
      </div>
    </div>
  );
}
