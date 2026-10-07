// TypeDefinitionScreen 內部子元件 · 不對外匯出
//
// FieldSetRow 比照 design 端的 TD_FieldSetRow：區域性小元件，現有元件組沒有
// 對應件，且只有本畫面用得到，留在畫面檔內（design 檔頭原話）。
//
// 各表單（NewFieldSetForm／FieldForm／EditFieldLabelForm／IssueTypeForm／
// EditIssueTypeRecipeForm）：design 畫面稿只展開清單與觸發按鈕，未展開表單
// 內容本身；本檔依 spec no6_type_definition_screen.md「互動」段十條逐條組出，
// 走現有 controls（TextInput／Select／Checkbox／Button），不引入畫面稿沒有的
// 元件（如 Modal — controls 組本無此件）。

import { useState } from 'react';

import { Badge, Button, Checkbox, Select, TextInput } from '../../components/controls';
import type { FieldDef } from '../../api';
import { useTheme } from '../../theme';
import { FONT_FAMILY, TYPE_STYLES } from '../../theme';
import { TYPE_DEFINITION_SCREEN_TOKENS as TD } from './tokens';

const KIND_OPTIONS = [
  { value: 'single', label: '單值' },
  { value: 'multi', label: '多筆' },
  { value: 'relation', label: '關聯' },
];

const ROLLUP_FN_OPTIONS = [
  { value: 'earliest', label: '最早' },
  { value: 'latest', label: '最晚' },
  { value: 'sum', label: '加總' },
];

function rowType(t: { readonly size: number; readonly weight: number; readonly lineHeight: number; readonly letterSpacing?: number }) {
  return {
    fontSize: t.size,
    fontWeight: t.weight,
    lineHeight: `${t.lineHeight}px`,
    letterSpacing: t.letterSpacing,
  };
}

// ─── FieldSetRow · 欄位組清單一列 ──────────────────────────────

export interface FieldSetRowProps {
  readonly name: string;
  readonly system: boolean;
  readonly selected: boolean;
  readonly onClick: () => void;
}

export function FieldSetRow({ name, system, selected, onClick }: FieldSetRowProps) {
  const { theme } = useTheme();
  const [hover, setHover] = useState(false);
  return (
    <button
      onClick={onClick}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        width: '100%',
        height: TD.ROW_HEIGHT,
        padding: `0 ${TD.ROW_PADDING_X}px`,
        border: 'none',
        borderRadius: TD.ROW_RADIUS,
        background: selected ? theme.state.selected.bg : hover ? theme.state.hover.bg : 'transparent',
        color: selected ? theme.state.selected.fg : theme.text.primary,
        cursor: 'pointer',
        textAlign: 'left',
        fontFamily: FONT_FAMILY.base,
        ...rowType(TD.ROW_TYPE),
      }}
    >
      <span>{name}</span>
      {system && <Badge label="系統" tone="neutral" dot={false} />}
    </button>
  );
}

// ─── 表單共用外框 ───────────────────────────────────────────────

interface FormShellProps {
  readonly children: React.ReactNode;
}

function FormShell({ children }: FormShellProps) {
  const { theme } = useTheme();
  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: TD.FORM_GAP,
        padding: TD.FORM_PADDING,
        borderRadius: TD.FORM_RADIUS,
        border: `1px solid ${theme.divider.hairline}`,
        width: TD.FORM_FIELD_WIDTH,
      }}
    >
      {children}
    </div>
  );
}

interface FormActionsProps {
  readonly onConfirm: () => void;
  readonly onCancel: () => void;
  readonly confirmLabel?: string;
  readonly disabled?: boolean;
  readonly submitting?: boolean;
}

function FormActions({
  onConfirm,
  onCancel,
  confirmLabel = '確認',
  disabled = false,
  submitting = false,
}: FormActionsProps) {
  return (
    <div style={{ display: 'flex', gap: TD.ACTION_GAP, justifyContent: 'flex-end' }}>
      <Button variant="ghost" size="sm" label="取消" onClick={onCancel} disabled={submitting} />
      <Button
        variant="primary"
        size="sm"
        label={confirmLabel}
        onClick={onConfirm}
        disabled={disabled}
        loading={submitting}
      />
    </div>
  );
}

// ─── NewFieldSetForm · 新增欄位組：只填名稱 ────────────────────

export interface NewFieldSetFormProps {
  readonly onSubmit: (name: string) => void;
  readonly onCancel: () => void;
  readonly submitting: boolean;
}

export function NewFieldSetForm({ onSubmit, onCancel, submitting }: NewFieldSetFormProps) {
  const [name, setName] = useState('');
  return (
    <FormShell>
      <TextInput value={name} onChange={setName} placeholder="欄位組名稱" fullWidth />
      <FormActions
        onConfirm={() => onSubmit(name.trim())}
        onCancel={onCancel}
        disabled={name.trim() === ''}
        submitting={submitting}
      />
    </FormShell>
  );
}

// ─── FieldForm · 新增欄位：識別名稱、顯示名稱、值型別、形狀、追蹤、可彙總 ───

export interface NewFieldInput {
  readonly name: string;
  readonly label: string;
  readonly kind: FieldDef['kind'];
  readonly valueType: string;
  readonly tracked: boolean;
  readonly rollupable: boolean;
  readonly rollupFn: FieldDef['rollupFn'];
}

export interface FieldFormProps {
  readonly onSubmit: (input: NewFieldInput) => void;
  readonly onCancel: () => void;
  readonly submitting: boolean;
}

export function FieldForm({ onSubmit, onCancel, submitting }: FieldFormProps) {
  const [name, setName] = useState('');
  const [label, setLabel] = useState('');
  const [kind, setKind] = useState<FieldDef['kind']>('single');
  const [valueType, setValueType] = useState('');
  const [tracked, setTracked] = useState(false);
  const [rollupable, setRollupable] = useState(false);
  const [rollupFn, setRollupFn] = useState<FieldDef['rollupFn']>(null);

  const validRollup = !rollupable || (kind === 'single' && rollupFn !== null &&
    (rollupFn === 'sum' ? valueType === 'number' : valueType === 'date'));
  const canSubmit = name.trim() !== '' && label.trim() !== '' && valueType.trim() !== '' && validRollup;

  return (
    <FormShell>
      <TextInput value={name} onChange={setName} placeholder="識別名稱" fullWidth />
      <TextInput value={label} onChange={setLabel} placeholder="顯示名稱" fullWidth />
      <TextInput value={valueType} onChange={setValueType} placeholder="值型別，如 text、number" fullWidth />
      <Select
        prefix="形狀"
        options={KIND_OPTIONS}
        value={kind}
        onChange={(v) => setKind(v as FieldDef['kind'])}
        fullWidth
      />
      <Checkbox checked={tracked} onChange={setTracked} label="追蹤異動" />
      <Checkbox
        checked={rollupable}
        onChange={(checked) => {
          setRollupable(checked);
          if (!checked) setRollupFn(null);
        }}
        label="可彙總"
      />
      {rollupable && (
        <Select
          prefix="彙總算法"
          options={ROLLUP_FN_OPTIONS}
          {...(rollupFn !== null ? { value: rollupFn } : {})}
          onChange={(v) => setRollupFn(v as FieldDef['rollupFn'])}
          fullWidth
        />
      )}
      <FormActions
        onConfirm={() =>
          onSubmit({
            name: name.trim(),
            label: label.trim(),
            kind,
            valueType: valueType.trim(),
            tracked,
            rollupable,
            rollupFn,
          })
        }
        onCancel={onCancel}
        disabled={!canSubmit}
        submitting={submitting}
      />
    </FormShell>
  );
}

// ─── EditFieldLabelForm · 編輯欄位顯示名稱 ─────────────────────

export interface EditFieldLabelFormProps {
  readonly initialLabel: string;
  readonly onSubmit: (label: string) => void;
  readonly onCancel: () => void;
  readonly submitting: boolean;
}

export function EditFieldLabelForm({ initialLabel, onSubmit, onCancel, submitting }: EditFieldLabelFormProps) {
  const [label, setLabel] = useState(initialLabel);
  return (
    <div style={{ display: 'flex', gap: TD.ACTION_GAP, alignItems: 'center' }}>
      <TextInput value={label} onChange={setLabel} placeholder="顯示名稱" />
      <FormActions
        onConfirm={() => onSubmit(label.trim())}
        onCancel={onCancel}
        disabled={label.trim() === ''}
        submitting={submitting}
      />
    </div>
  );
}

// ─── IssueTypeForm · 新增工單型別：識別名稱、顯示名稱、勾選欄位組 ───

export interface NewIssueTypeInput {
  readonly name: string;
  readonly label: string;
  readonly fieldSets: readonly string[];
}

export interface IssueTypeFormProps {
  readonly availableFieldSets: readonly string[];
  readonly onSubmit: (input: NewIssueTypeInput) => void;
  readonly onCancel: () => void;
  readonly submitting: boolean;
}

export function IssueTypeForm({ availableFieldSets, onSubmit, onCancel, submitting }: IssueTypeFormProps) {
  const [name, setName] = useState('');
  const [label, setLabel] = useState('');
  const [fieldSets, setFieldSets] = useState<readonly string[]>([]);

  const toggle = (fs: string, checked: boolean): void => {
    setFieldSets((prev) => (checked ? [...prev, fs] : prev.filter((x) => x !== fs)));
  };

  return (
    <FormShell>
      <TextInput value={name} onChange={setName} placeholder="識別名稱" fullWidth />
      <TextInput value={label} onChange={setLabel} placeholder="顯示名稱" fullWidth />
      <FieldSetCheckboxList availableFieldSets={availableFieldSets} selected={fieldSets} onToggle={toggle} />
      <FormActions
        onConfirm={() => onSubmit({ name: name.trim(), label: label.trim(), fieldSets })}
        onCancel={onCancel}
        disabled={name.trim() === '' || label.trim() === ''}
        submitting={submitting}
      />
    </FormShell>
  );
}

// ─── EditIssueTypeRecipeForm · 編輯工單型別配方：只調整勾選 ────

export interface EditIssueTypeRecipeFormProps {
  readonly availableFieldSets: readonly string[];
  readonly initialFieldSets: readonly string[];
  readonly onSubmit: (fieldSets: readonly string[]) => void;
  readonly onCancel: () => void;
  readonly submitting: boolean;
}

export function EditIssueTypeRecipeForm({
  availableFieldSets,
  initialFieldSets,
  onSubmit,
  onCancel,
  submitting,
}: EditIssueTypeRecipeFormProps) {
  const [fieldSets, setFieldSets] = useState<readonly string[]>(initialFieldSets);

  const toggle = (fs: string, checked: boolean): void => {
    setFieldSets((prev) => (checked ? [...prev, fs] : prev.filter((x) => x !== fs)));
  };

  return (
    <FormShell>
      <FieldSetCheckboxList availableFieldSets={availableFieldSets} selected={fieldSets} onToggle={toggle} />
      <FormActions onConfirm={() => onSubmit(fieldSets)} onCancel={onCancel} submitting={submitting} />
    </FormShell>
  );
}

interface FieldSetCheckboxListProps {
  readonly availableFieldSets: readonly string[];
  readonly selected: readonly string[];
  readonly onToggle: (fieldSet: string, checked: boolean) => void;
}

function FieldSetCheckboxList({ availableFieldSets, selected, onToggle }: FieldSetCheckboxListProps) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: TD.ACTION_GAP }}>
      <span style={{ ...rowType(TYPE_STYLES.overline), fontFamily: FONT_FAMILY.base }}>欄位組</span>
      {availableFieldSets.map((fs) => (
        <Checkbox
          key={fs}
          checked={selected.includes(fs)}
          onChange={(checked) => onToggle(fs, checked)}
          label={fs}
        />
      ))}
    </div>
  );
}
