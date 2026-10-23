// KanbanScreen · 看板畫面
//
// 角色：依 Status 分欄呈現工單，拖曳卡片完成狀態轉換。欄集合由工作區各工單型別
// 的流程狀態聯集產出，不隨資料增減。
//
// 來源：design git 的 `30_screens/no2_kanban_screen/no2_kanban_screen.jsx`。
// 對側 spec：no3_product_specs/no1_issue_system/no2_screens/no2_kanban_screen.md
//
// 資料來源：欄由 /api/views/kanban-columns 取回（工作區層級，非依檢視資料來源
// 算，仍待縮到檢視範圍）；卡片依當前檢視（CurrentViewContext）查
// /api/views/:id/workspace-issues 並依 status 欄位分欄；拖入他欄即 PATCH 該
// 工單 status。拖進終止欄先跳結案原因選單，通過 changeIssueStatus 驗證才落地；
// 非終止欄仍直接送出，若後端 422 則行內提示、卡片留在原欄。無當前檢視時顯示
// 空狀態，不發請求。design 的多資料來源不搬——單一工作區、狀態即欄。
//
// 消費元件：gantt/Toolbar、controls（TextInput / Button / Chip）、
//           data（KanbanColumn / KanbanCard / EmptyState），
//           本檔私有 KanbanDropSlot / KanbanResolutionPrompt。

import { useCallback, useEffect, useMemo, useState } from 'react';
import type { DragEvent } from 'react';
import { useLocation, useNavigate } from 'react-router';

import { ApiError, workspaceApi } from '../../api';
import type { View } from '../../api';
import { useCurrentView } from '../../app/CurrentViewContext';
import { Chip, TextInput } from '../../components/controls';
import { EmptyState, FilterNotice, KanbanCard, KanbanColumn } from '../../components/data';
import type { DueTone } from '../../components/data';
import { F4Action } from '../../components/controls/F4Icon';
import { useAsync } from '../../hooks/useAsync';
import { F4_LAYOUT, FONT_FAMILY, SPACING, useTheme } from '../../theme';
import { typeStyle } from '../typeStyle';
import { isTerminalStatus, loadKanbanData } from './data';
import type { KanbanData, KanbanIssue } from './data';
import { KanbanDropSlot, KanbanResolutionPrompt } from './internal';
import { KANBAN_SCREEN_TOKENS } from './tokens';

const K = KANBAN_SCREEN_TOKENS;
let pendingReturnFocus: { locationKey: string; issueId: string } | null = null;

const DAY_MS = 24 * 60 * 60 * 1000;

interface DueDisplay {
  readonly label: string;
  readonly tone?: DueTone;
}

/** ISO 到期日轉卡片顯示。過期 overdue、七日內 soon。 */
function dueDisplay(iso: string | null): DueDisplay | undefined {
  if (iso === null) return undefined;
  const target = new Date(`${iso}T00:00:00`);
  if (Number.isNaN(target.getTime())) return { label: iso };
  const label = `${String(target.getMonth() + 1).padStart(2, '0')}/${String(target.getDate()).padStart(2, '0')}`;
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const diff = Math.round((target.getTime() - today.getTime()) / DAY_MS);
  if (diff < 0) return { label, tone: 'overdue' };
  if (diff <= 7) return { label, tone: 'soon' };
  return { label };
}

export function KanbanScreen() {
  const { currentView } = useCurrentView();
  // 換檢視時清掉拖曳與待結案操作，也不顯示上一檢視留下的卡片。
  return <KanbanView key={currentView?.id ?? ''} currentView={currentView} />;
}

function KanbanView({ currentView }: { readonly currentView: View | null }) {
  const { theme } = useTheme();
  const navigate = useNavigate();
  const location = useLocation();

  const fetcher = useCallback(async (): Promise<KanbanData | null> => {
    if (currentView === null) return null;
    return loadKanbanData(currentView.id);
  }, [currentView]);
  const { data, loading, error, reload } = useAsync(fetcher);

  const [search, setSearch] = useState('');
  useEffect(() => {
    if (!data || pendingReturnFocus?.locationKey !== location.key) return;
    document.getElementById(`issue-${pendingReturnFocus.issueId}`)?.focus();
    pendingReturnFocus = null;
  }, [data, location.key]);
  const [draggingKey, setDraggingKey] = useState<string | null>(null);
  const [dropColumnId, setDropColumnId] = useState<string | null>(null);
  const [pendingKey, setPendingKey] = useState<string | null>(null);
  const [resolutionPrompt, setResolutionPrompt] = useState<{
    readonly issue: KanbanIssue;
    readonly targetColumnId: string;
  } | null>(null);
  const [dropError, setDropError] = useState<string | undefined>(undefined);

  const columns = data?.columns ?? [];
  const issues = data?.issues ?? [];

  const visibleIssues = useMemo(() => {
    const term = search.trim().toLocaleLowerCase();
    if (term === '') return issues;
    return issues.filter(
      (issue) =>
        issue.key.toLocaleLowerCase().includes(term) ||
        issue.title.toLocaleLowerCase().includes(term),
    );
  }, [issues, search]);

  const endDrag = useCallback(() => {
    setDraggingKey(null);
    setDropColumnId(null);
  }, []);

  const onCardDragStart = useCallback((issueKey: string, event: DragEvent<HTMLElement>) => {
    event.dataTransfer.effectAllowed = 'move';
    event.dataTransfer.setData('text/plain', issueKey);
    setDraggingKey(issueKey);
  }, []);

  const onColumnDragOver = useCallback(
    (columnId: string, event: DragEvent<HTMLElement>) => {
      if (draggingKey === null) return;
      event.preventDefault();
      event.dataTransfer.dropEffect = 'move';
      if (dropColumnId !== columnId) setDropColumnId(columnId);
    },
    [draggingKey, dropColumnId],
  );

  const applyStatusChange = useCallback(
    async (issue: KanbanIssue, status: string, resolution?: string) => {
      setPendingKey(issue.key);
      setDropError(undefined);
      try {
        await workspaceApi.updateIssue(issue.id, {
          status,
          ...(resolution !== undefined ? { resolution } : {}),
        });
        await reload();
      } catch (err: unknown) {
        setDropError(err instanceof ApiError ? err.message : '狀態更新失敗');
      } finally {
        setPendingKey(null);
      }
    },
    [reload],
  );

  const onColumnDrop = useCallback(
    async (columnId: string, event: DragEvent<HTMLElement>) => {
      event.preventDefault();
      const issueKey = draggingKey;
      endDrag();
      if (issueKey === null) return;
      const issue = issues.find((i) => i.key === issueKey);
      if (issue === undefined || issue.status === columnId) return;
      if (isTerminalStatus(issue, columnId)) {
        setResolutionPrompt({ issue, targetColumnId: columnId });
        return;
      }
      await applyStatusChange(issue, columnId);
    },
    [draggingKey, endDrag, issues, applyStatusChange],
  );

  const onResolutionConfirm = useCallback(
    (resolutionValue: string) => {
      if (resolutionPrompt === null) return;
      const { issue, targetColumnId } = resolutionPrompt;
      setResolutionPrompt(null);
      void applyStatusChange(issue, targetColumnId, resolutionValue);
    },
    [resolutionPrompt, applyStatusChange],
  );

  const onResolutionCancel = useCallback(() => setResolutionPrompt(null), []);

  const chips = search.trim() === '' ? [] : [{ id: 'search', value: search.trim() }];

  return (
    <div
      style={{
        width: '100%',
        containerType: 'inline-size',
        minHeight: '100%',
        display: 'flex',
        flexDirection: 'column',
        background: theme.bg.base,
        color: theme.text.primary,
        fontFamily: FONT_FAMILY.base,
      }}
    >
      <style>{`
        .f4-board { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: ${F4_LAYOUT.boardGap}px; padding: 0 ${F4_LAYOUT.pagePadding}px 32px; }
        .f4-board-heading { display: flex; flex-wrap: wrap; align-items: center; gap: 16px; padding: 16px ${F4_LAYOUT.pagePadding}px 12px; }
        .f4-board-search { margin-left: auto; width: min(300px, 100%); }
        @container (max-width: ${F4_LAYOUT.singleColumnBreakpoint}px) {
          .f4-board { grid-template-columns: minmax(0, 1fr); padding: 0 16px 24px; }
          .f4-board-heading { padding: 12px 16px; }
          .f4-board-heading h1 { width: 100%; }
          .f4-board-search { margin-left: 0; flex: 1; }
          .f4-issue-card { grid-template-columns: 64px minmax(0, 1fr) !important; }
        }
      `}</style>
      <header className="f4-board-heading">
        <h1 style={{ margin: 0, fontSize: 29, lineHeight: 1.3, fontWeight: 600 }}>工單看板</h1>
        <div className="f4-board-search"><TextInput leadingIcon="search" placeholder="搜尋工單" value={search} onChange={setSearch} clearable fullWidth /></div>
        <F4Action name="refresh" label="重新整理看板" onClick={() => void reload()} />
      </header>

      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: K.FILTER_BAR_GAP,
          flexWrap: 'wrap',
          padding: `${SPACING.sm}px ${F4_LAYOUT.pagePadding}px`,
        }}
      >
        {chips.map((chip) => (
          <Chip key={chip.id} label="搜尋" value={chip.value} onRemove={() => setSearch('')} />
        ))}
        {dropError !== undefined && (
          <span role="alert" style={{ ...typeStyle(K.META_TYPE), color: theme.status.error_fg }}>
            {dropError}
          </span>
        )}
        <span style={{ marginLeft: 'auto', ...typeStyle(K.META_TYPE), color: theme.text.tertiary }}>
          {`共 ${columns.length} 欄 · ${visibleIssues.length} 張工單`}
        </span>
      </div>

      {currentView === null ? (
        <div style={{ padding: `0 ${K.PADDING_X}px` }}>
          <EmptyState
            title="尚無檢視"
            description="從上方新增檢視，選擇要看的工單範圍。"
          />
        </div>
      ) : error !== undefined ? (
        <div style={{ padding: `0 ${K.PADDING_X}px` }}>
          <EmptyState
            icon="clock"
            title="載入看板失敗"
            description={error}
            action={{ label: '重試', onClick: () => void reload() }}
          />
        </div>
      ) : loading && data === undefined ? (
        <div style={{ padding: `0 ${K.PADDING_X}px`, ...typeStyle(K.META_TYPE), color: theme.text.tertiary }}>
          載入中…
        </div>
      ) : (
        <div className="f4-board">
          {columns.map((columnId) => {
            const cards = visibleIssues.filter((issue) => issue.status === columnId);
            const isDropTarget = draggingKey !== null && dropColumnId === columnId;
            return (
              <div key={columnId} style={{ minWidth: 0, position: 'relative' }}>
                <KanbanColumn
                  title={columnId}
                  count={cards.length}
                  isDropTarget={isDropTarget}
                  maxHeight={K.COLUMN_BODY_MAX_HEIGHT}
                  onDragOver={(event) => onColumnDragOver(columnId, event)}
                  onDrop={(event) => void onColumnDrop(columnId, event)}
                >
                  {isDropTarget && <KanbanDropSlot label={`放到「${columnId}」`} />}
                  {cards.length === 0 && !isDropTarget ? (
                    <EmptyState compact title="這一欄沒有工單" description="拖曳工單至此階段。" />
                  ) : (
                    cards.map((issue) => (
                      <KanbanCard
                        key={issue.key}
                        id={`issue-${issue.id}`}
                        issueKey={issue.key}
                        title={issue.title}
                        assignee={issue.assignee === '' ? undefined : issue.assignee}
                        due={isTerminalStatus(issue, issue.status) ? undefined : dueDisplay(issue.due)}
                        ghost={draggingKey === issue.key}
                        loading={pendingKey === issue.key}
                        draggable
                        onClick={() => {
                          pendingReturnFocus = { locationKey: location.key, issueId: issue.id };
                          navigate(`/issues/${issue.id}`);
                        }}
                        onDragStart={(event) => onCardDragStart(issue.key, event)}
                        onDragEnd={endDrag}
                      />
                    ))
                  )}
                </KanbanColumn>
                {resolutionPrompt !== null && resolutionPrompt.targetColumnId === columnId && (
                  <KanbanResolutionPrompt
                    key={`${resolutionPrompt.issue.id}:${columnId}`}
                    issue={resolutionPrompt.issue}
                    targetLabel={columnId}
                    options={resolutionPrompt.issue.workflow.resolutionOptions}
                    onCancel={onResolutionCancel}
                    onConfirm={onResolutionConfirm}
                  />
                )}
              </div>
            );
          })}
        </div>
      )}

      <FilterNotice count={data?.permissionExcludedCount} />
    </div>
  );
}
