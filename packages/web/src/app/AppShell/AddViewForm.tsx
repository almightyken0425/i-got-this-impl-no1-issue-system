// AddViewForm · 新增檢視的行內表單
//
// design（no4_app_shell.jsx add-view variant）定案：檢視名稱 + Team→Product→Mgmt
// 串接式選擇（對應 spec ViewLogic / expandDataSource 的組織範圍輸入）+ 日曆選用。
// 日曆選用留白即跟隨帳號預設日曆（spec ViewLogic / resolveViewCalendar）。

import { useCallback, useState } from 'react';

import { ApiError, containersApi } from '../../api';
import { Button, Select, TextInput } from '../../components/controls';
import { SPACING } from '../../theme';
import { useAsync } from '../../hooks/useAsync';
import { useCalendars } from '../../hooks/useCalendars';
import { useCurrentView } from '../CurrentViewContext';

interface AddViewFormProps {
  readonly onCancel: () => void;
  readonly onCreated: () => void;
}

export function AddViewForm({ onCancel, onCreated }: AddViewFormProps) {
  const { addView } = useCurrentView();
  const [name, setName] = useState('');
  const [teamId, setTeamId] = useState<string | undefined>(undefined);
  const [productId, setProductId] = useState<string | undefined>(undefined);
  const [mgmtId, setMgmtId] = useState<string | undefined>(undefined);
  const [calendarName, setCalendarName] = useState<string | undefined>(undefined);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);

  const teams = useAsync(useCallback(() => containersApi.listTeams(), []));
  const products = useAsync(
    useCallback(
      () => (teamId === undefined ? Promise.resolve([]) : containersApi.listProductsByTeam(teamId)),
      [teamId],
    ),
  );
  const mgmts = useAsync(
    useCallback(
      () =>
        productId === undefined ? Promise.resolve([]) : containersApi.listMgmtsByProduct(productId),
      [productId],
    ),
  );
  const calendars = useCalendars();

  // 換上層選擇時，下層選擇失效——比照容器樹「僅屬一個上層」的嚴格歸屬。
  const onTeamChange = (id: string) => {
    setTeamId(id);
    setProductId(undefined);
    setMgmtId(undefined);
  };
  const onProductChange = (id: string) => {
    setProductId(id);
    setMgmtId(undefined);
  };

  const scope =
    mgmtId !== undefined
      ? { scopeType: 'mgmt' as const, scopeId: mgmtId }
      : productId !== undefined
        ? { scopeType: 'product' as const, scopeId: productId }
        : teamId !== undefined
          ? { scopeType: 'team' as const, scopeId: teamId }
          : undefined;

  const canSubmit = name.trim() !== '' && scope !== undefined && !submitting;

  const submit = async () => {
    if (!canSubmit || scope === undefined) return;
    setSubmitting(true);
    setError(undefined);
    try {
      await addView({
        name: name.trim(),
        ...scope,
        ...(calendarName !== undefined ? { calendarName } : {}),
      });
      onCreated();
    } catch (err: unknown) {
      setError(err instanceof ApiError ? err.message : '建立檢視失敗');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: SPACING.xs }}>
      <TextInput placeholder="檢視名稱" value={name} onChange={setName} size="sm" fullWidth />
      <Select
        prefix="Team"
        size="sm"
        options={(teams.data ?? []).map((t) => ({ value: t.id, label: t.name }))}
        {...(teamId !== undefined ? { value: teamId } : {})}
        onChange={onTeamChange}
        fullWidth
      />
      <Select
        prefix="Product"
        size="sm"
        options={(products.data ?? []).map((p) => ({ value: p.id, label: p.name }))}
        {...(productId !== undefined ? { value: productId } : {})}
        onChange={onProductChange}
        // 也擋 loading：Team 剛切換、新清單還沒抓回來前，products.data 仍是舊 Team 的
        // 舊清單，不擋會讓使用者點到跟畫面顯示的 Team 對不上的 Product。
        disabled={teamId === undefined || products.loading}
        fullWidth
      />
      <Select
        prefix="Mgmt"
        size="sm"
        options={(mgmts.data ?? []).map((m) => ({ value: m.id, label: m.name }))}
        {...(mgmtId !== undefined ? { value: mgmtId } : {})}
        onChange={setMgmtId}
        disabled={productId === undefined || mgmts.loading}
        fullWidth
      />
      <Select
        prefix="日曆"
        size="sm"
        placeholder="跟隨帳號預設"
        options={calendars.data?.map((c) => ({ value: c.name, label: c.name })) ?? []}
        {...(calendarName !== undefined ? { value: calendarName } : {})}
        onChange={setCalendarName}
        fullWidth
      />
      {error !== undefined && <span role="alert">{error}</span>}
      <div style={{ display: 'flex', gap: SPACING.xs }}>
        <Button
          variant="primary"
          size="sm"
          label="建立"
          disabled={!canSubmit}
          loading={submitting}
          onClick={() => void submit()}
        />
        <Button variant="ghost" size="sm" label="取消" onClick={onCancel} />
      </div>
    </div>
  );
}
