import { useState } from 'react';
import type { ReactNode } from 'react';
import { issuesApi, relationsApi } from '../../api';
import type { IssueContext, RelationTypeDefinition, RollupStatus } from '../../api';
import { Button, Select, TextInput } from '../../components/controls';
import { SPACING, TYPE_STYLES, useTheme } from '../../theme';
import { displayValue, EditableTextField, formatChangeLogTime, personLabel, relationLabel, SectionPanel } from './internal';
import { useAuth } from '../../auth/AuthContext';
import { typeStyle } from '../typeStyle';
import { ISSUE_DETAIL_SCREEN_TOKENS as T } from './tokens';

function useAction(onSaved: () => Promise<void>) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  async function run(action: () => Promise<unknown>) {
    if (busy) return false;
    setBusy(true);
    setError('');
    try { await action(); await onSaved(); return true; }
    catch (err) { setError(err instanceof Error ? err.message : '操作失敗'); return false; }
    finally { setBusy(false); }
  }
  return { busy, error, run };
}

export function ConfirmAction({ label, disabled = false, onConfirm }: { label: string; disabled?: boolean; onConfirm: () => Promise<boolean> }) {
  const [confirming, setConfirming] = useState(false);
  return <div style={{ display: 'flex', flexWrap: 'wrap', gap: T.GROUP_GAP }}>
    <Button variant="ghost" size="sm" label={confirming ? `確認${label}` : label} disabled={disabled}
      onClick={() => { if (!confirming) setConfirming(true); else void onConfirm().then(ok => { if (ok) setConfirming(false); }); }} />
    {confirming && <Button variant="ghost" size="sm" label="取消" disabled={disabled} onClick={() => setConfirming(false)} />}
  </div>;
}

export function RollupField({ issueId, status, value, canEdit, onSaved, children }: {
  issueId: string; status: RollupStatus; value: unknown; canEdit: boolean; onSaved: () => Promise<void>; children: ReactNode;
}) {
  const { theme } = useTheme();
  const action = useAction(onSaved);
  const [confirmAuto, setConfirmAuto] = useState(false);
  const switchMode = (mode: 'auto' | 'manual') => action.run(() => issuesApi.updateFieldValue(issueId, status.fieldName, value ?? null, mode));
  if (status.restricted) return <span>彙總來源權限不足</span>;
  return <div style={{ display: 'flex', flexDirection: 'column', gap: T.GROUP_GAP, flex: 1, minWidth: 0 }}>
    <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: T.FIELD_ROW_GAP }}>
      {children}
      {status.hasChildren && <Select prefix="模式" value={status.mode} disabled={!canEdit || action.busy}
        options={[{ value: 'manual', label: '手動' }, { value: 'auto', label: '自動' }]}
        onChange={mode => { if (mode === 'auto') setConfirmAuto(true); else void switchMode('manual'); }} />}
    </div>
    {status.hasChildren && status.mode === 'manual' && <span style={{ color: theme.text.secondary }}>
      下級彙總 {displayValue(status.value)}
      {status.deviation.deviated && ` · 差距 ${status.deviation.delta} ${status.deviation.unit === 'point' ? '點' : status.deviation.unit === 'workingDay' ? '工作天' : '日曆天'}${status.deviation.calendarName ? ` · ${status.deviation.calendarName}` : ''}`}
    </span>}
    {confirmAuto && <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: T.GROUP_GAP }}>
      <span>自動彙總會取代目前主值。</span>
      <Button label="確認切換" disabled={action.busy} onClick={() => void switchMode('auto').then(ok => { if (ok) setConfirmAuto(false); })} />
      <Button variant="ghost" label="取消" disabled={action.busy} onClick={() => setConfirmAuto(false)} />
    </div>}
    {action.error && <span role="alert" style={{ color: theme.status.error_fg }}>{action.error}</span>}
  </div>;
}

export function RelationForm({ issueId, types, onSaved }: { issueId: string; types: readonly RelationTypeDefinition[]; onSaved: () => Promise<void> }) {
  const { theme } = useTheme();
  const action = useAction(onSaved);
  const [selected, setSelected] = useState('');
  const [targetKey, setTargetKey] = useState('');
  const typeId = selected || types[0]?.id || '';
  async function submit() {
    const ok = await action.run(async () => {
      const target = await issuesApi.getIssueByKey(targetKey.trim());
      await relationsApi.createRelation(issueId, target.id, typeId);
    });
    if (ok) setTargetKey('');
  }
  return <form aria-label="新增工單關聯" onSubmit={event => { event.preventDefault(); void submit(); }}
    style={{ display: 'flex', flexDirection: 'column', gap: T.GROUP_GAP }}>
    <Select prefix="型別" value={typeId} onChange={setSelected} disabled={action.busy}
      options={types.map(type => ({ value: type.id, label: relationLabel(type.name) }))} />
    <label>目標工單編號<TextInput fullWidth value={targetKey} onChange={setTargetKey} placeholder="例如 IGT-12" disabled={action.busy} /></label>
    <Button type="submit" variant="secondary" label="新增關聯" disabled={action.busy || !typeId || !targetKey.trim()} />
    {types.length === 0 && <span>先到型別定義新增關聯型別。</span>}
    {action.error && <span role="alert" style={{ color: theme.status.error_fg }}>{action.error}</span>}
  </form>;
}

export function WorkLogPanel({ issueId, context, onSaved }: { issueId: string; context: IssueContext; onSaved: () => Promise<void> }) {
  const { theme } = useTheme();
  const action = useAction(onSaved);
  const [hours, setHours] = useState('');
  const { account } = useAuth();
  const status = context.rollups.find(row => row.fieldName === 'WorkLog');
  if (!status) return null;
  const editable = context.canEdit && !status.hasChildren;
  const validHours = Number.isFinite(Number(hours)) && Number(hours) > 0;
  return <SectionPanel title="工時">
    <div>{status.restricted ? '彙總來源權限不足' : <><strong style={typeStyle(T.TITLE_TYPE)}>{status.value ?? 0}</strong><span style={{ marginLeft: SPACING.sm, ...typeStyle(TYPE_STYLES.bodySm), color: theme.text.secondary }}>小時</span>{status.hasChildren && <p style={{ margin: `${SPACING.sm}px 0 0`, ...typeStyle(TYPE_STYLES.bodySm), color: theme.text.secondary }}>由下級工單填報彙總</p>}</>}</div>
    {!status.hasChildren && context.worklogs.map(record => <div key={record.id} style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: T.GROUP_GAP }}>
      <span title={record.authorId} style={{ ...typeStyle(TYPE_STYLES.label), color: theme.text.secondary }}>{personLabel(record.authorId, account)} · {formatChangeLogTime(record.createdOn)}</span>
      {editable ? <>
        <EditableTextField label="工時" value={String(record.value)} disabled={action.busy} onCommit={text => action.run(() => issuesApi.writeWorkLog(issueId, Number(text), record.id))} />
        <ConfirmAction label="移除工時" disabled={action.busy} onConfirm={() => action.run(() => issuesApi.removeWorkLog(issueId, record.id))} />
      </> : <span>{record.value} 小時</span>}
    </div>)}
    {editable && <details><summary>填報工時</summary><form aria-label="填報工時" style={{ display: 'flex', flexWrap: 'wrap', gap: T.GROUP_GAP }} onSubmit={event => {
      event.preventDefault();
      if (validHours) void action.run(() => issuesApi.writeWorkLog(issueId, Number(hours))).then(ok => { if (ok) setHours(''); });
    }}>
      <label>工時，小時<TextInput value={hours} onChange={setHours} disabled={action.busy} placeholder="例如 2.5" /></label>
      <Button type="submit" label="填報工時" disabled={action.busy || !validHours} />
    </form></details>}
    {action.error && <span role="alert" style={{ color: theme.status.error_fg }}>{action.error}</span>}
  </SectionPanel>;
}
