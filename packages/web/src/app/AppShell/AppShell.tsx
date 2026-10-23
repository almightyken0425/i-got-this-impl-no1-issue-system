// AppShell · 應用外殼
//
// 側邊四段：品牌、當前檢視、畫面形態導覽、帳號；右側是路由出口。
//
// 來源：design git 的 `30_screens/no4_app_shell/no4_app_shell.jsx`。
// 對側 spec：no3_product_specs/no1_issue_system/no2_screens/no4_app_shell.md
//   佈局四段與互動五條逐條對位。
//
// 已知落差：
// - spec 的 selectCurrentView（ViewLogic）要求選了檢視後資料來源／篩選／欄位顯示
//   設定／排序值都跟著切換，目前完全沒有實作——CurrentViewContext 只是一個
//   本地 React state（currentViewId），選擇動作不連動任何資料；各畫面各自拿
//   currentView.id 打自己的端點。「切換畫面形態時當前檢視不變」是這個架構自然的
//   副作用（Provider 掛在 AppShell、不因路由換頁重新掛載），不是落地了
//   selectCurrentView 規則。
// - 內容區不比照 design 在無檢視時切 EmptyState，維持無條件 <Outlet/>——ListScreen／
//   KanbanScreen 已各自在畫面內判斷 currentView === null 顯示空狀態，AppShell 層級
//   不需要重複攔一次；DevOrderScreen 待接時比照辦理。
// - DevOrderScreen 尚未改接當前檢視（仍呼叫 workspaceApi）——甘特圖需要的座標轉換
//   （工單起訖日期換算時間軸格子、三層級同時載入）後端完全沒有，另開獨立主題處理。
// - 新增檢視表單（AddViewForm）與帳號預設日曆選用比照 design add-view variant 定案。
//
// 主題切換：ThemeProvider 在更上層（App.tsx），本檔只提供切換入口。

import { NavLink, Outlet, useLocation } from 'react-router';
import { useEffect, useState } from 'react';

import { accountsApi } from '../../api';
import { useAuth } from '../../auth/AuthContext';
import { F4Action, F4Icon } from '../../components/controls/F4Icon';
import type { F4IconName } from '../../components/controls/F4Icon';
import { Button, Select } from '../../components/controls';
import { useCalendars } from '../../hooks/useCalendars';
import {
  F4_LAYOUT,
  FONT_FAMILY,
  SPACING,
  useTheme,
} from '../../theme';
import type { Theme } from '../../theme';
import { CurrentViewProvider, useCurrentView } from '../CurrentViewContext';
import { NAV_ITEMS } from '../routes';
import { AddViewForm } from './AddViewForm';

interface NavItemProps {
  readonly theme: Theme;
  readonly to: string;
  readonly label: string;
}

const NAV_ICONS: Record<string, F4IconName> = { '/list': 'list', '/kanban': 'kanban', '/dev-order': 'timeline', '/types': 'types', '/workflow': 'workflow', '/organization': 'organization' };
function NavItem({ theme, to, label }: NavItemProps) {
  return <NavLink to={to} aria-label={label} title={label} className="f4-nav-link"
    style={({ isActive }) => ({ display: 'grid', placeItems: 'center', width: F4_LAYOUT.touchTarget, minHeight: F4_LAYOUT.touchTarget, borderRadius: F4_LAYOUT.controlRadius,
      textDecoration: 'none', color: isActive ? theme.primary.main : theme.text.secondary, background: isActive ? theme.state.selected.bg : 'transparent' })}>
    <F4Icon name={NAV_ICONS[to] ?? 'issue'} />
  </NavLink>;
}

function CurrentViewSection({ theme }: { readonly theme: Theme }) {
  const { views, currentView, selectView, loading, error, retry } = useCurrentView();
  const [adding, setAdding] = useState(false);
  return <div style={{ display: 'flex', alignItems: 'center', gap: SPACING.sm, position: 'relative', minWidth: 0, flex: 1 }}>
    {views.length > 0 ? <Select label="當前檢視" options={views.map(v => ({ value: v.id, label: v.name }))}
      {...(currentView !== null ? { value: currentView.id } : {})} onChange={selectView} style={{ maxWidth: '100%' }} /> :
      <span role={error ? 'alert' : 'status'} style={{ color: theme.text.secondary }}>{error ? '檢視載入失敗' : loading ? '載入中…' : '尚無檢視'}</span>}
    {error && <Button variant="ghost" label="重試" onClick={retry} />}
    <F4Action name={adding ? 'close' : 'plus'} label={adding ? '取消新增檢視' : '新增檢視'} aria-expanded={adding} onClick={() => setAdding(open => !open)} />
    {adding && <div style={{ position: 'absolute', top: '100%', left: 0, zIndex: 30, width: 'min(440px, calc(100vw - 32px))', maxHeight: 'calc(100dvh - 160px)', overflowY: 'auto', boxSizing: 'border-box', background: theme.bg.surface, border: `1px solid ${theme.border.base}`, borderRadius: F4_LAYOUT.moduleRadius, padding: SPACING.lg }}>
      <AddViewForm onCancel={() => setAdding(false)} onCreated={() => setAdding(false)} />
    </div>}
  </div>;
}

/** 帳號預設日曆選用：個人偏好，選了立即持久化（對應 spec PermissionLogic / setDefaultCalendar）。 */
function AccountCalendarSelect() {
  const [defaultCalendar, setDefaultCalendar] = useState<string | undefined>(undefined);

  useEffect(() => {
    void accountsApi.getMyDefaultCalendar().then((value) => setDefaultCalendar(value ?? undefined));
  }, []);

  const calendars = useCalendars();

  const onChange = (value: string) => {
    const previous = defaultCalendar;
    setDefaultCalendar(value);
    void accountsApi.updateMyDefaultCalendar(value).catch(() => setDefaultCalendar(previous));
  };

  return (
    <Select
      size="sm"
      prefix="日曆"
      placeholder="未設定"
      options={calendars.data?.map((c) => ({ value: c.name, label: c.name })) ?? []}
      {...(defaultCalendar !== undefined ? { value: defaultCalendar } : {})}
      onChange={onChange}
      fullWidth
    />
  );
}

function AppShellInner() {
  const { theme, themeId, toggleTheme } = useTheme();
  const { account, logout } = useAuth();
  const location = useLocation();
  const [settingsOpen, setSettingsOpen] = useState(false);
  useEffect(() => setSettingsOpen(false), [location.pathname]);
  return <div className="f4-shell" style={{ height: '100%', display: 'flex', gap: F4_LAYOUT.railGap, padding: SPACING.lg, boxSizing: 'border-box', color: theme.text.primary, background: theme.bg.base, fontFamily: FONT_FAMILY.base }}>
    <style>{`
      .f4-rail { width: ${F4_LAYOUT.rail}px; display: flex; flex-direction: column; align-items: center; gap: 20px; flex-shrink: 0; padding: 16px 0; border-radius: 18px; }
      .f4-nav { display: flex; flex-direction: column; gap: 8px; }
      .f4-workspace { min-width: 0; flex: 1; display: flex; flex-direction: column; }
      .f4-topbar { display: flex; align-items: center; gap: 12px; padding: 8px 16px 20px; position: relative; }
      .f4-nav-link:hover { outline: 1px solid ${theme.border.strong}; }
      @media (max-width: ${F4_LAYOUT.mobileBreakpoint}px) {
        .f4-shell { flex-direction: column; padding: 0 !important; gap: 0 !important; }
        .f4-rail { order: 2; width: 100%; border-radius: 0; padding: 6px 0 max(6px, env(safe-area-inset-bottom)); border-top: 1px solid ${theme.border.base}; }
        .f4-brand { display: none; }
        .f4-nav { flex-direction: row; gap: 2px; justify-content: space-evenly; width: 100%; }
        .f4-workspace { min-height: 0; }
        .f4-topbar { padding: 12px 16px; }
      }
    `}</style>
    <aside className="f4-rail" style={{ background: theme.bg.surface_hover }}>
      <span className="f4-brand" aria-label="I Got This" style={{ color: theme.primary.main, fontWeight: 800, fontSize: 17 }}>IG<span aria-hidden="true">↗</span></span>
      <nav className="f4-nav" aria-label="主導覽">{NAV_ITEMS.map(item => <NavItem key={item.path} theme={theme} to={item.path} label={item.label} />)}</nav>
    </aside>
    <div className="f4-workspace">
      <header className="f4-topbar">
        <CurrentViewSection theme={theme} />
        <F4Action name="account" label="帳號設定" aria-expanded={settingsOpen} aria-controls="f4-account" onClick={() => setSettingsOpen(open => !open)} />
        {settingsOpen && <section id="f4-account" aria-label="帳號設定" onKeyDown={event => { if (event.key === 'Escape') { setSettingsOpen(false); (document.querySelector('button[aria-controls="f4-account"]') as HTMLButtonElement)?.focus(); } }}
          style={{ position: 'absolute', right: SPACING.lg, top: '100%', zIndex: 40, width: 'min(280px, calc(100vw - 32px))', boxSizing: 'border-box', padding: SPACING.lg, borderRadius: F4_LAYOUT.moduleRadius, border: `1px solid ${theme.border.base}`, background: theme.bg.surface, display: 'flex', flexDirection: 'column', gap: SPACING.md }}>
          <strong>{account?.name}</strong><AccountCalendarSelect />
          <Button variant="secondary" fullWidth label={themeId === 'dark' ? '切換為淺色主題' : '切換為深色主題'} onClick={toggleTheme} />
          <Button variant="ghost" fullWidth label="登出" onClick={() => void logout()} />
        </section>}
      </header>
      <main style={{ flex: 1, minWidth: 0, overflow: 'auto' }}><Outlet /></main>
    </div>
  </div>;
}

export function AppShell() {
  return (
    <CurrentViewProvider>
      <AppShellInner />
    </CurrentViewProvider>
  );
}
