import { useCallback, useState } from 'react';
import { calendarsApi, relationsApi } from '../../api';
import type { WorkCalendar } from '../../api';
import { Button, Checkbox, Select, TextInput } from '../../components/controls';
import { DataTable, EmptyState } from '../../components/data';
import { useAsync } from '../../hooks/useAsync';
import { useTheme } from '../../theme';
import { TYPE_DEFINITION_SCREEN_TOKENS as T } from './tokens';

const WEEK = [['MON', '一'], ['TUE', '二'], ['WED', '三'], ['THU', '四'], ['FRI', '五'], ['SAT', '六'], ['SUN', '日']] as const;
const FLAGS = [['exclusive', '獨佔'], ['acyclic', '禁環'], ['ordered', '有序'], ['symmetric', '對稱'], ['rollup', '彙總']] as const;
const stack = { display: 'flex', flexDirection: 'column', gap: T.GROUP_GAP } as const;
const row = { display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: T.ROW_GAP } as const;

export function DefinitionPlanningTabs({ tab, canEdit }: { tab: 'relations' | 'calendars'; canEdit: boolean }) {
  const { theme } = useTheme();
  const fetcher = useCallback(async () => ({ calendars: await calendarsApi.listCalendars(), relations: await relationsApi.listRelationTypes() }), []);
  const { data, loading, error, reload } = useAsync(fetcher);
  const [name, setName] = useState('');
  const [selected, setSelected] = useState('');
  const [flags, setFlags] = useState({ exclusive: false, acyclic: false, ordered: false, symmetric: false, rollup: false });
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState('');
  async function run(action: () => Promise<unknown>) {
    if (busy) return false;
    setBusy(true); setActionError('');
    try { await action(); await reload(); return true; }
    catch (err) { setActionError(err instanceof Error ? err.message : '操作失敗'); return false; }
    finally { setBusy(false); }
  }
  if (error) return <EmptyState title="載入失敗" description={error} action={{ label: '重試', onClick: () => void reload() }} />;
  if (loading && !data) return <span>載入中…</span>;
  const calendar = data?.calendars.find(item => item.name === selected) ?? data?.calendars[0];
  return <div style={stack}>
    {actionError && <div role="alert" style={{ color: theme.status.error_fg }}>{actionError}</div>}
    {tab === 'relations' ? <>
      <DataTable columns={[{ key: 'name', label: '名稱', type: 'key' }, { key: 'rules', label: '規則', type: 'text' }]}
        rows={(data?.relations ?? []).map(type => ({ id: type.id, cells: { name: type.name, rules: FLAGS.filter(([flag]) => type[flag]).map(([, label]) => label).join('、') || '一般有向關聯' } }))} />
      {canEdit && <form aria-label="新增關聯型別" style={stack} onSubmit={event => { event.preventDefault(); void run(() => relationsApi.createRelationType({ name: name.trim(), ...flags })).then(ok => { if (ok) setName(''); }); }}>
        <label>關聯型別名稱<TextInput value={name} onChange={setName} disabled={busy} /></label>
        <div style={row}>{FLAGS.map(([flag, label]) => <Checkbox key={flag} label={label} checked={flags[flag]} disabled={busy} onChange={checked => setFlags({ ...flags, [flag]: checked })} />)}</div>
        <Button type="submit" label="新增關聯型別" disabled={busy || !name.trim()} />
      </form>}
    </> : <>
      <Select prefix="日曆" value={calendar?.name ?? ''} onChange={setSelected} options={(data?.calendars ?? []).map(item => ({ value: item.name, label: item.name }))} />
      {canEdit && <form aria-label="新增日曆" style={row} onSubmit={event => {
        event.preventDefault(); void run(() => calendarsApi.createCalendar(name.trim(), ['SAT', 'SUN'])).then(ok => { if (ok) { setSelected(name.trim()); setName(''); } });
      }}>
        <label>新日曆名稱<TextInput value={name} onChange={setName} disabled={busy} /></label>
        <Button type="submit" variant="secondary" label="新增日曆" disabled={busy || !name.trim()} />
      </form>}
      {calendar ? <CalendarEditor key={calendar.name} calendar={calendar} canEdit={canEdit} busy={busy} run={run} /> : <EmptyState compact title="尚無工作日曆" description="建立日曆後，可在檢視或帳號設定中選用。" />}
    </>}
  </div>;
}

function CalendarEditor({ calendar, canEdit, busy, run }: { calendar: WorkCalendar; canEdit: boolean; busy: boolean; run: (action: () => Promise<unknown>) => Promise<boolean> }) {
  const [off, setOff] = useState(calendar.weeklyOff);
  const [date, setDate] = useState('');
  const [working, setWorking] = useState(false);
  return <div style={stack}>
    <span>每週休假日</span>
    <div style={row}>{WEEK.map(([key, label]) => <Checkbox key={key} label={`週${label}`} checked={off.includes(key)} disabled={!canEdit || busy}
      onChange={checked => setOff(checked ? [...off, key] : off.filter(day => day !== key))} />)}</div>
    {canEdit && <Button label="儲存週規則" disabled={busy} onClick={() => void run(() => calendarsApi.updateWeeklyOff(calendar.name, off))} />}
    <span>日期例外</span>
    {calendar.exceptions.length === 0 && <span>尚無例外，依每週規則計算。</span>}
    {calendar.exceptions.map(exception => <div key={exception.date} style={row}>
      <span>{exception.date} · {exception.isWorking ? '工作日' : '休假日'}</span>
      {canEdit && <Button variant="ghost" size="sm" label="移除例外" disabled={busy} onClick={() => void run(() => calendarsApi.removeCalendarException(calendar.name, exception.date))} />}
    </div>)}
    {canEdit && <form aria-label="日期例外" style={row} onSubmit={event => { event.preventDefault(); void run(() => calendarsApi.setCalendarException(calendar.name, date, working)); }}>
      <label>日期<TextInput value={date} onChange={setDate} placeholder="YYYY-MM-DD" disabled={busy} /></label>
      <Checkbox label="工作日" checked={working} onChange={setWorking} disabled={busy} />
      <Button type="submit" label="儲存例外" disabled={busy || !/^\d{4}-\d{2}-\d{2}$/.test(date)} />
    </form>}
  </div>;
}
