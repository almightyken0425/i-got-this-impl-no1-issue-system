// ListScreen · 清單表格畫面
//
// 角色：工單系統的主檢視。一列一張工單攤在表格上，工具列承載排序、分組與欄位
// 顯示設定；頂部提供建立工單入口——建立後即時回列表，是首波端到端驗收的核心。
//
// 來源：design git 的 `30_screens/no1_list_screen/no1_list_screen.jsx`。
// 對側 spec：no3_product_specs/no1_issue_system/no2_screens/no1_list_screen.md
//
// 資料來源：依當前檢視（CurrentViewContext）查 /api/views/:id/workspace-issues，
// 狀態值集合仍由 /api/workspace 的流程狀態決定（型別/流程定義是公司層級，非
// 檢視層級）。無當前檢視（帳號名下尚無檢視）時顯示空狀態，不發請求。原 design
// 的 variant 與假資料不搬——狀態差異由真實資料與互動產生。
//
// 消費元件：
//   gantt/Toolbar、controls（Select / Button / IconButton / Checkbox / TextInput）、
//   data（DataTable / EmptyState）。
//
// 排序、分組皆為當次瀏覽狀態，存在 React state、不寫回檢視設定。欄位顯示設定
// （顯示哪幾欄／欄序／欄寬）會寫回 Views.columnConfig，見 columnConfig.ts。

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { useNavigate } from 'react-router';

import { ApiError, fieldsApi, viewsApi, workspaceApi } from '../../api';
import type { CreateIssueInput, FieldDef, WorkspaceContext, WorkspaceIssue } from '../../api';
import { useCurrentView } from '../../app/CurrentViewContext';
import { Button, Checkbox, Chip, IconButton, Select, TextInput } from '../../components/controls';
import type { SelectOption } from '../../components/controls';
import { DataTable, EmptyState, FilterNotice } from '../../components/data';
import type {
  DueTone,
  SortState,
  StatusTone,
  TableColumn,
  TableRow,
} from '../../components/data';
import { Toolbar } from '../../components/gantt';
import {
  controlShadow,
  DATA_DISPLAY_TOKENS,
  FONT_FAMILY,
  NUMERIC_FONT_VARIANT,
  SPACING,
  useTheme,
} from '../../theme';
import type { Theme } from '../../theme';
import { useAsync } from '../../hooks/useAsync';
import { typeStyle } from '../typeStyle';
import {
  columnsFromConfig,
  moveColumnEntry,
  parseColumnConfig,
  resizeColumnEntry,
  toColumnConfigJson,
  toggleColumnEntry,
} from './columnConfig';
import type { ColumnConfigEntry } from './columnConfig';
import {
  addFilterConditionRow,
  buildFilterConfig,
  filterFieldOptions,
  parseFilterConditionRows,
  removeFilterConditionRow,
  updateFilterConditionRow,
} from './filterConfig';
import type { FilterConditionRow } from './filterConfig';
import {
  LIST_COLUMNS,
  LIST_DEFAULT_SORT,
  LIST_GROUP_NONE,
} from './fixtures';
import type { ListFilterChip } from './fixtures';
import { LIST_SCREEN_TOKENS } from './tokens';
import { buildFieldColumns, fieldCells, sortFieldRows } from './dynamicFields';

const T = LIST_SCREEN_TOKENS;
// 欄寬調整下限：沿用 DataTable 未指定欄寬時的同一個下界，兩者語意上是同一件事
// ——欄寬不該小到不可用。
const COLUMN_WIDTH_MIN = DATA_DISPLAY_TOKENS.TABLE.COLUMN_MIN_WIDTH;

// ─── 狀態值 → 表格格 ─────────────────────────────────────────
// 狀態的顯示順序與色彩身份由工作區流程狀態決定：終止狀態走 success，其餘依名稱
// 與位置給一個 tone，讓排序與分組有穩定次序，不落字典序。

interface StatusMeta {
  readonly sortKey: number;
  readonly tone: StatusTone | undefined;
}

function toneForStatus(name: string, index: number, isTerminal: boolean): StatusTone | undefined {
  if (isTerminal) return 'success';
  if (name.includes('阻')) return 'error';
  if (name.includes('審') || name.includes('驗')) return 'warning';
  if (index >= 1) return 'info';
  return undefined;
}

function buildStatusMeta(
  statuses: WorkspaceContext['statuses'],
): ReadonlyMap<string, StatusMeta> {
  const map = new Map<string, StatusMeta>();
  statuses.forEach((s, index) => {
    map.set(s.name, { sortKey: index, tone: toneForStatus(s.name, index, s.isTerminal) });
  });
  return map;
}

// ─── 到期日 → 表格格 ─────────────────────────────────────────
// ISO 日期轉「MM/DD」顯示；已過期標 overdue、七日內標 soon，其餘中性。

const DAY_MS = 24 * 60 * 60 * 1000;

function dueTone(iso: string): DueTone | undefined {
  const target = new Date(`${iso}T00:00:00`);
  if (Number.isNaN(target.getTime())) return undefined;
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const diffDays = Math.round((target.getTime() - today.getTime()) / DAY_MS);
  if (diffDays < 0) return 'overdue';
  if (diffDays <= 7) return 'soon';
  return undefined;
}

// 帶 sortKey 的格值：sortKey 供畫面端排序讀取，DataTable 正規化時會忽略未知鍵。
interface StatusCell {
  readonly label: string;
  readonly sortKey: number;
  readonly tone?: StatusTone;
}
interface DueCell {
  readonly label: string;
  readonly sortKey: string;
  readonly tone?: DueTone;
}

function dueCell(iso: string | null): DueCell | null {
  if (iso === null) return null;
  const target = new Date(`${iso}T00:00:00`);
  const label = Number.isNaN(target.getTime())
    ? iso
    : `${String(target.getMonth() + 1).padStart(2, '0')}/${String(target.getDate()).padStart(2, '0')}`;
  const tone = dueTone(iso);
  return tone === undefined ? { label, sortKey: iso } : { label, sortKey: iso, tone };
}

/** 把 API 工單摺成表格列。 */
function toTableRow(issue: WorkspaceIssue, statusMeta: ReadonlyMap<string, StatusMeta>, fieldDefs: readonly FieldDef[]): TableRow {
  const meta = statusMeta.get(issue.status);
  const status: StatusCell = {
    label: issue.status,
    sortKey: meta?.sortKey ?? 0,
    ...(meta?.tone === undefined ? {} : { tone: meta.tone }),
  };
  return {
    id: issue.id,
    cells: {
      ...fieldCells(issue.fields ?? {}, fieldDefs),
      key: issue.key,
      title: issue.title,
      status,
      assignee: issue.assignee,
      point: issue.point,
      due: dueCell(issue.due),
      ...Object.fromEntries((issue.restrictedFields ?? []).map(name => [name, '來源權限不足'])),
    },
  };
}

// ─── ViewTitle ───────────────────────────────────────────────

interface ViewTitleProps {
  readonly theme: Theme;
  readonly name: string;
  readonly count: number;
}

function ViewTitle({ theme, name, count }: ViewTitleProps) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', minWidth: 0 }}>
      <span style={{ ...typeStyle(T.VIEW_TITLE_TYPE), color: theme.text.primary, whiteSpace: 'nowrap' }}>
        {name}
      </span>
      <span
        style={{
          ...typeStyle(T.VIEW_META_TYPE),
          color: theme.text.tertiary,
          fontVariantNumeric: NUMERIC_FONT_VARIANT,
          whiteSpace: 'nowrap',
        }}
      >
        {`${count} 筆工單`}
      </span>
    </div>
  );
}

// ─── FilterChipBar ───────────────────────────────────────────
// 已套用篩選條件列，design 定案：唯讀標籤，條件本身要改走「篩選」入口，
// 互動清單沒有「在條件列上直接移除」。條件為空時不渲染本列。
//
// 寫入路徑見下方 FilterPanel；本列只管讀取展示，兩者共用同一份
// currentView.filterConfig，FilterPanel 套用成功後這裡自動反映。

function fieldLabel(fieldName: string): string {
  return LIST_COLUMNS.find((c) => c.key === fieldName)?.label ?? fieldName;
}

/** 把 View.filterConfig（unknown）安全解析成 Chip 展示清單；格式不符 fail-open 回空陣列，比照後端 parseFilterConfig 同一套寬容度。 */
function parseFilterChips(filterConfig: unknown): readonly ListFilterChip[] {
  if (typeof filterConfig !== 'object' || filterConfig === null) return [];
  const conditions = (filterConfig as { conditions?: unknown }).conditions;
  if (!Array.isArray(conditions)) return [];
  const chips: ListFilterChip[] = [];
  for (const condition of conditions) {
    if (typeof condition !== 'object' || condition === null) continue;
    const fieldName = (condition as { fieldName?: unknown }).fieldName;
    const value = (condition as { value?: unknown }).value;
    if (typeof fieldName !== 'string') continue;
    chips.push({ label: fieldLabel(fieldName), value: String(value) });
  }
  return chips;
}

interface FilterChipBarProps {
  readonly chips: readonly ListFilterChip[];
}

function FilterChipBar({ chips }: FilterChipBarProps) {
  const { theme } = useTheme();
  if (chips.length === 0) return null;
  return (
    <div style={{ display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: SPACING.xs }}>
      <span style={{ ...typeStyle(T.VIEW_META_TYPE), color: theme.text.tertiary, whiteSpace: 'nowrap' }}>
        已套用篩選
      </span>
      {chips.map((chip) => (
        <Chip key={`${chip.label}-${chip.value}`} label={chip.label} value={chip.value} />
      ))}
    </div>
  );
}

// ─── FilterPanel ── 篩選條件編輯面板
// design 定案：比照 ColumnConfigPanel 模式（見 AGENTS.md「設計待辦」），錨定
// 「篩選」按鈕下方、點外部收合；量體本身屬 impl 自訂範圍。後端 FilterCondition
// 只認 equals、多條件全 AND，面板不呈現不存在的運算子選項。

interface FilterPanelProps {
  readonly theme: Theme;
  readonly rows: readonly FilterConditionRow[];
  readonly fieldOptions: readonly SelectOption[];
  readonly fieldOptionsLoading: boolean;
  readonly error: string | undefined;
  readonly saving: boolean;
  readonly onFieldChange: (id: string, fieldName: string) => void;
  readonly onValueChange: (id: string, value: string) => void;
  readonly onRemoveRow: (id: string) => void;
  readonly onAddRow: () => void;
  readonly onApply: () => void;
  readonly onCancel: () => void;
}

function FilterPanel({
  theme,
  rows,
  fieldOptions,
  fieldOptionsLoading,
  error,
  saving,
  onFieldChange,
  onValueChange,
  onRemoveRow,
  onAddRow,
  onApply,
  onCancel,
}: FilterPanelProps) {
  return (
    <div
      role="group"
      aria-label="篩選條件"
      style={{
        position: 'absolute',
        top: `calc(100% + ${T.FILTER_PANEL_OFFSET}px)`,
        right: 0,
        zIndex: T.FILTER_PANEL_Z,
        width: T.FILTER_PANEL_WIDTH,
        display: 'flex',
        flexDirection: 'column',
        gap: T.FILTER_PANEL_GAP,
        padding: T.FILTER_PANEL_PADDING,
        background: theme.bg.surface,
        border: `${T.FILTER_PANEL_BORDER_WIDTH}px solid ${theme.border.base}`,
        borderRadius: T.FILTER_PANEL_RADIUS,
        boxShadow: controlShadow(theme, 'level2'),
        fontFamily: FONT_FAMILY.base,
      }}
    >
      <span style={{ ...typeStyle(T.FILTER_PANEL_TITLE_TYPE), color: theme.text.secondary }}>
        篩選條件
      </span>

      {rows.length === 0 && (
        <span style={{ ...typeStyle(T.FILTER_PANEL_HINT_TYPE), color: theme.text.tertiary }}>
          尚無條件，點下方新增
        </span>
      )}

      {rows.map((row) => (
        <div key={row.id} style={{ display: 'flex', alignItems: 'center', gap: T.FILTER_PANEL_ROW_GAP }}>
          <Select
            options={fieldOptions}
            value={row.fieldName}
            placeholder={fieldOptionsLoading ? '載入中…' : '選欄位'}
            disabled={fieldOptionsLoading}
            onChange={(fieldName) => onFieldChange(row.id, fieldName)}
            style={{ flex: 1, minWidth: 0 }}
          />
          <TextInput
            value={row.value}
            placeholder="值"
            onChange={(value) => onValueChange(row.id, value)}
            style={{ flex: 1, minWidth: 0 }}
          />
          <IconButton icon="x" title="移除條件" size="sm" onClick={() => onRemoveRow(row.id)} />
        </div>
      ))}

      <Button variant="ghost" iconLeft="plus" label="新增條件" onClick={onAddRow} />

      {error !== undefined && (
        <span style={{ ...typeStyle(T.FILTER_PANEL_HINT_TYPE), color: theme.status.error_fg }}>
          {error}
        </span>
      )}

      <div style={{ display: 'flex', gap: T.FILTER_PANEL_ROW_GAP, justifyContent: 'flex-end' }}>
        <Button variant="ghost" label="取消" onClick={onCancel} disabled={saving} />
        <Button variant="primary" label="套用" onClick={onApply} disabled={saving} />
      </div>
    </div>
  );
}

// ─── ColumnConfigPanel ────────────────────────────────────────
// 顯示/隱藏、順序（上下移動鈕）、寬度（+/- 鈕，僅目錄有數字寬度的欄開放）三組
// 控制。可視欄依目前顯示順序渲染（不是固定目錄順序）——按上移/下移時面板列要
// 跟著動，否則使用者看不出按鈕有反應。隱藏中的欄附加在最後，只給 checkbox。
// 上下鈕重用既有 chevron-up/down glyph，寬度鈕重用既有 minus/plus glyph，皆已
// 存在於 ControlGlyph，不新增視覺元素；面板本身的量體是既有的 impl 自訂範圍
// （design 的欄位顯示設定只到「按鈕有 active 態」，見 tokens.ts 開頭註解）。

interface ColumnConfigPanelProps {
  readonly theme: Theme;
  readonly catalog: readonly TableColumn[];
  readonly entries: readonly ColumnConfigEntry[];
  readonly widthStep: number;
  readonly widthMin: number;
  readonly error: string | undefined;
  readonly onToggle: (key: string) => void;
  readonly onMove: (key: string, direction: 'up' | 'down') => void;
  readonly onWidthChange: (key: string, delta: number) => void;
}

function ColumnConfigPanel({
  theme,
  catalog,
  entries,
  widthStep,
  widthMin,
  error,
  onToggle,
  onMove,
  onWidthChange,
}: ColumnConfigPanelProps) {
  const visibleKeys = new Set(entries.map((entry) => entry.key));
  const hiddenColumns = catalog.filter((column) => !visibleKeys.has(column.key));

  return (
    <div
      role="group"
      aria-label="欄位顯示設定"
      style={{
        position: 'absolute',
        top: `calc(100% + ${T.COLUMN_PANEL_OFFSET}px)`,
        right: 0,
        zIndex: T.COLUMN_PANEL_Z,
        width: T.COLUMN_PANEL_WIDTH,
        display: 'flex',
        flexDirection: 'column',
        gap: T.COLUMN_PANEL_GAP,
        padding: T.COLUMN_PANEL_PADDING,
        background: theme.bg.surface,
        border: `${T.COLUMN_PANEL_BORDER_WIDTH}px solid ${theme.border.base}`,
        borderRadius: T.COLUMN_PANEL_RADIUS,
        boxShadow: controlShadow(theme, 'level2'),
        fontFamily: FONT_FAMILY.base,
      }}
    >
      <span style={{ ...typeStyle(T.COLUMN_PANEL_TITLE_TYPE), color: theme.text.secondary }}>
        欄位顯示設定
      </span>

      {entries.map((entry, index) => {
        const column = catalog.find((c) => c.key === entry.key);
        if (column === undefined) return null;
        const catalogWidth = typeof column.width === 'number' ? column.width : undefined;
        const effectiveWidth = entry.width ?? catalogWidth;
        return (
          <div
            key={entry.key}
            style={{ display: 'flex', alignItems: 'center', gap: T.COLUMN_PANEL_ROW_GAP }}
          >
            <Checkbox
              label={column.label}
              checked
              disabled={entries.length === 1}
              onChange={() => onToggle(entry.key)}
              style={{ flex: 1, minWidth: 0 }}
            />
            <IconButton
              icon="chevron-up"
              title={`上移${column.label}`}
              size="sm"
              disabled={index === 0}
              onClick={() => onMove(entry.key, 'up')}
            />
            <IconButton
              icon="chevron-down"
              title={`下移${column.label}`}
              size="sm"
              disabled={index === entries.length - 1}
              onClick={() => onMove(entry.key, 'down')}
            />
            {catalogWidth !== undefined && (
              <>
                <IconButton
                  icon="minus"
                  title={`縮小${column.label}欄寬`}
                  size="sm"
                  disabled={effectiveWidth !== undefined && effectiveWidth <= widthMin}
                  onClick={() => onWidthChange(entry.key, -widthStep)}
                />
                <IconButton
                  icon="plus"
                  title={`加大${column.label}欄寬`}
                  size="sm"
                  onClick={() => onWidthChange(entry.key, widthStep)}
                />
              </>
            )}
          </div>
        );
      })}

      {hiddenColumns.map((column) => (
        <Checkbox
          key={column.key}
          label={column.label}
          checked={false}
          onChange={() => onToggle(column.key)}
        />
      ))}

      {error !== undefined && (
        <span style={{ ...typeStyle(T.COLUMN_PANEL_HINT_TYPE), color: theme.status.error_fg }}>
          {error}
        </span>
      )}
    </div>
  );
}

// ─── CreateIssueBar ── 建立工單的行內入口
// 建單選項依當前檢視與管理域權限提供。

interface CreateIssueBarProps {
  readonly theme: Theme;
  readonly viewId: string;
  readonly submitting: boolean;
  readonly error: string | undefined;
  readonly onSubmit: (input: CreateIssueInput) => void;
  readonly onCancel: () => void;
}

function CreateIssueBar({ theme, viewId, submitting, error, onSubmit, onCancel }: CreateIssueBarProps) {
  const [title, setTitle] = useState('');
  const [selectedSet, setSelectedSet] = useState('');
  const [selectedType, setSelectedType] = useState('');
  const fetcher = useCallback(() => workspaceApi.getCreationOptions(viewId), [viewId]);
  const options = useAsync(fetcher);
  const issueSets = options.data?.issueSets ?? [];
  const issueTypes = options.data?.issueTypes ?? [];
  const issueSetId = selectedSet || (issueSets.length === 1 ? issueSets[0]?.id ?? '' : '');
  const issueTypeId = selectedType || issueTypes.find(type => type.name === 'task')?.id || issueTypes[0]?.id || '';
  const valid = title.trim() !== '' && issueSets.some(set => set.id === issueSetId) && issueTypes.some(type => type.id === issueTypeId) && !options.loading && !options.error;
  const submit = () => {
    if (!valid || submitting) return;
    onSubmit({ title: title.trim(), issueSetId, issueTypeId });
  };
  return (
    <form aria-label="建立工單" onSubmit={event => { event.preventDefault(); submit(); }}
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: SPACING.sm,
        padding: SPACING.sm,
        background: theme.bg.surface,
        border: `1px solid ${theme.border.base}`,
        borderRadius: T.COLUMN_PANEL_RADIUS,
      }}
    >
      {options.loading && <div role="status">載入建單選項…</div>}
      {options.error && <div role="alert">{options.error}<Button label="重試" onClick={() => void options.reload()} /></div>}
      {!options.loading && !options.error && issueSets.length === 0 && <div role="status">此檢視沒有可建立工單的範圍。請確認資料來源與建單權限。</div>}
      <Select prefix="工單集" fullWidth placeholder="請選擇工單集" value={issueSetId} onChange={setSelectedSet}
        options={issueSets.map(set => ({ value: set.id, label: set.label }))} disabled={submitting || options.loading || issueSets.length === 0} />
      <Select prefix="工單型別" fullWidth value={issueTypeId} onChange={setSelectedType}
        options={issueTypes.map(type => ({ value: type.id, label: type.label }))} disabled={submitting || options.loading || issueTypes.length === 0} />
      <label>標題
      <TextInput
        leadingIcon="plus"
        placeholder="輸入工單標題後按 Enter 建立"
        value={title}
        onChange={setTitle}
        disabled={submitting}
        clearable={false}
        fullWidth
        style={{ flex: 1 }}
      />
      </label>
      <div style={{ display: 'flex', gap: SPACING.sm }}>
      <Button type="submit" variant="primary" label="建立" loading={submitting} disabled={!valid} />
      <Button variant="ghost" label="取消" disabled={submitting} onClick={onCancel} />
      </div>
      {error !== undefined && (
        <span role="alert" style={{ ...typeStyle(T.VIEW_META_TYPE), color: theme.status.error_fg }}>{error}</span>
      )}
    </form>
  );
}

// ─── ListScreen ──────────────────────────────────────────────

export function ListScreen() {
  const { theme } = useTheme();
  const navigate = useNavigate();
  const { currentView, updateView } = useCurrentView();
  const fieldDefsFetcher = useCallback(() => fieldsApi.listFieldDefs(), []);
  const { data: fieldDefs, loading: fieldDefsLoading } = useAsync(fieldDefsFetcher);
  const catalog = useMemo(() => buildFieldColumns(fieldDefs ?? []), [fieldDefs]);
  const sortOptions = useMemo(() => catalog.map(column => ({ value: column.key, label: column.label })), [catalog]);

  const fetcher = useCallback(
    async (): Promise<
      | {
          context: WorkspaceContext;
          issues: readonly WorkspaceIssue[];
          permissionExcludedCount: number;
        }
      | null
    > => {
      if (currentView === null) return null;
      const [context, workspaceIssues] = await Promise.all([
        workspaceApi.getWorkspace(),
        viewsApi.getWorkspaceIssues(currentView.id),
      ]);
      return {
        context,
        issues: workspaceIssues.issues,
        permissionExcludedCount: workspaceIssues.permissionExcludedCount,
      };
    },
    // 只用到 currentView.id：換一張檢視（id 變）才需要重抓整份工單清單。
    // 不能拿整個 currentView 物件當依賴——persistColumnConfig 存檔後會觸發
    // CurrentViewContext 的 reload，讓 currentView 換成新物件參照（id 不變、
    // 只有 columnConfig 變），若依賴整個物件會被誤判成「換檢視」，白白多打一次
    // workspace 與 workspace-issues 兩支 API 重抓整份工單清單。
    [currentView?.id],
  );
  const { data, loading, error, reload } = useAsync(fetcher);

  // 當次瀏覽狀態：排序、分組不寫回。
  const [sort, setSort] = useState<SortState | null>(LIST_DEFAULT_SORT);
  const [groupBy, setGroupBy] = useState<string>(LIST_GROUP_NONE);
  const [selectedIds, setSelectedIds] = useState<readonly string[]>([]);

  // 欄位顯示設定草稿：初始值與切換檢視時都由 currentView.columnConfig 解析；
  // 每次互動立即反映在畫面上（樂觀更新），同時觸發 persistColumnConfig 寫回。
  const [columnConfigDraft, setColumnConfigDraft] = useState<readonly ColumnConfigEntry[]>(() =>
    parseColumnConfig(currentView?.columnConfig, catalog),
  );
  const [saveError, setSaveError] = useState<string | undefined>(undefined);
  const [columnPanelOpen, setColumnPanelOpen] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | undefined>(undefined);

  const columnPanelAnchor = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    setColumnConfigDraft(parseColumnConfig(currentView?.columnConfig, catalog));
    setSaveError(undefined);
    setCreateOpen(false);
    setCreateError(undefined);
  }, [currentView?.id, catalog]);

  useEffect(() => {
    if (!columnPanelOpen) return undefined;
    const onPointerDown = (event: PointerEvent) => {
      const anchor = columnPanelAnchor.current;
      if (anchor !== null && event.target instanceof Node && anchor.contains(event.target)) return;
      setColumnPanelOpen(false);
    };
    document.addEventListener('pointerdown', onPointerDown);
    return () => document.removeEventListener('pointerdown', onPointerDown);
  }, [columnPanelOpen]);

  // 篩選面板：草稿與 currentView.filterConfig 脫鉤，開面板時才由目前條件初始化，
  // 「套用」才寫回；跟欄位顯示設定的樂觀即時寫回是兩種互動，不能共用同一套邏輯
  // ——欄位顯示設定每動一下就存，篩選要讓使用者組完整組條件才送出。
  const [filterPanelOpen, setFilterPanelOpen] = useState(false);
  const [filterRows, setFilterRows] = useState<readonly FilterConditionRow[]>([]);
  const [filterSaving, setFilterSaving] = useState(false);
  const [filterError, setFilterError] = useState<string | undefined>(undefined);
  const filterRowSeq = useRef(0);
  const filterPanelAnchor = useRef<HTMLDivElement | null>(null);

  const fieldOptions = useMemo(() => filterFieldOptions(fieldDefs ?? []), [fieldDefs]);

  useEffect(() => {
    if (!filterPanelOpen) return undefined;
    const onPointerDown = (event: PointerEvent) => {
      const anchor = filterPanelAnchor.current;
      if (anchor !== null && event.target instanceof Node && anchor.contains(event.target)) return;
      setFilterPanelOpen(false);
    };
    document.addEventListener('pointerdown', onPointerDown);
    return () => document.removeEventListener('pointerdown', onPointerDown);
  }, [filterPanelOpen]);

  const openFilterPanel = useCallback(() => {
    setFilterRows(parseFilterConditionRows(currentView?.filterConfig));
    setFilterError(undefined);
    setFilterPanelOpen(true);
  }, [currentView?.filterConfig]);

  const addFilterRow = useCallback(() => {
    filterRowSeq.current += 1;
    setFilterRows((rows) => addFilterConditionRow(rows, `new-${filterRowSeq.current}`));
  }, []);

  const removeFilterRow = useCallback((id: string) => {
    setFilterRows((rows) => removeFilterConditionRow(rows, id));
  }, []);

  const changeFilterField = useCallback((id: string, fieldName: string) => {
    setFilterRows((rows) => updateFilterConditionRow(rows, id, { fieldName }));
  }, []);

  const changeFilterValue = useCallback((id: string, value: string) => {
    setFilterRows((rows) => updateFilterConditionRow(rows, id, { value }));
  }, []);

  const applyFilter = useCallback(async () => {
    if (currentView === null) return;
    setFilterSaving(true);
    setFilterError(undefined);
    try {
      await updateView(currentView.id, { filterConfig: buildFilterConfig(filterRows) });
      await reload();
      setFilterPanelOpen(false);
    } catch (err: unknown) {
      setFilterError(err instanceof ApiError ? err.message : '套用篩選失敗');
    } finally {
      setFilterSaving(false);
    }
  }, [currentView, filterRows, updateView, reload]);

  const cancelFilterPanel = useCallback(() => {
    setFilterPanelOpen(false);
  }, []);

  const statusMeta = useMemo(
    () => buildStatusMeta(data?.context.statuses ?? []),
    [data?.context.statuses],
  );

  const allRows = useMemo<readonly TableRow[]>(
    () => (data?.issues ?? []).map((issue) => toTableRow(issue, statusMeta, fieldDefs ?? [])),
    [data?.issues, statusMeta, fieldDefs],
  );

  const rows = useMemo(() => sortFieldRows(allRows, sort), [allRows, sort]);

  const filterChips = useMemo(
    () => parseFilterChips(currentView?.filterConfig),
    [currentView?.filterConfig],
  );

  const columns = useMemo(
    () => columnsFromConfig(columnConfigDraft, catalog),
    [columnConfigDraft, catalog],
  );

  // 樂觀更新：本地草稿立即反映，失敗只記錯誤不回滾——使用者已經看到變更生效，
  // 回滾會製造「明明點了卻又跳回去」的錯覺，錯誤訊息已足夠交代狀況。
  const persistColumnConfig = useCallback(
    async (next: readonly ColumnConfigEntry[]) => {
      if (currentView === null) return;
      setSaveError(undefined);
      try {
        await updateView(currentView.id, { columnConfig: toColumnConfigJson(next) });
      } catch (err: unknown) {
        setSaveError(err instanceof ApiError ? err.message : '欄位顯示設定儲存失敗');
      }
    },
    [currentView, updateView],
  );

  // 三個 handler 直接讀 closure 內的 columnConfigDraft（列進 useCallback 依賴），
  // 不包在 setState 的函式型更新裡——main.tsx 有 <StrictMode>，若把
  // persistColumnConfig 這類副作用混進 updater，開發模式下會被重複呼叫兩次，
  // 對同一次點擊多打一支重複的 PATCH。
  const toggleColumn = useCallback(
    (key: string) => {
      const next = toggleColumnEntry(columnConfigDraft, key, catalog);
      if (next === columnConfigDraft) return;
      setColumnConfigDraft(next);
      void persistColumnConfig(next);
    },
    [columnConfigDraft, persistColumnConfig, catalog],
  );

  const moveColumn = useCallback(
    (key: string, direction: 'up' | 'down') => {
      const next = moveColumnEntry(columnConfigDraft, key, direction);
      if (next === columnConfigDraft) return;
      setColumnConfigDraft(next);
      void persistColumnConfig(next);
    },
    [columnConfigDraft, persistColumnConfig],
  );

  const adjustColumnWidth = useCallback(
    (key: string, delta: number) => {
      const next = resizeColumnEntry(columnConfigDraft, key, delta, catalog, COLUMN_WIDTH_MIN);
      if (next === columnConfigDraft) return;
      setColumnConfigDraft(next);
      void persistColumnConfig(next);
    },
    [columnConfigDraft, persistColumnConfig, catalog],
  );

  const onRowSelect = useCallback((row: TableRow) => {
    setSelectedIds((ids) => (ids.includes(row.id) ? [] : [row.id]));
  }, []);

  // 列的第二動作：雙擊開啟工單詳情頁。row.id 即 WorkspaceIssue.id（見 toTableRow）。
  const onRowActivate = useCallback(
    (row: TableRow) => navigate(`/issues/${row.id}`),
    [navigate],
  );

  const visibleColumnKeys = useMemo(
    () => new Set(columnConfigDraft.map((entry) => entry.key)),
    [columnConfigDraft],
  );
  const effectiveGroupBy =
    groupBy !== LIST_GROUP_NONE && visibleColumnKeys.has(groupBy) ? groupBy : undefined;

  const submitCreate = useCallback(
    async (input: CreateIssueInput) => {
      setCreating(true);
      setCreateError(undefined);
      try {
        await workspaceApi.createIssue(input);
        await reload();
        setCreateOpen(false);
      } catch (err: unknown) {
        setCreateError(err instanceof Error ? err.message : '建立失敗');
      } finally {
        setCreating(false);
      }
    },
    [reload],
  );

  const viewName = currentView?.name ?? '工單清單';

  const toolbarLeft: ReactNode = <ViewTitle theme={theme} name={viewName} count={allRows.length} />;

  const toolbarRight: ReactNode = (
    <>
      <Button
        variant="primary"
        iconLeft="plus"
        label="建立工單"
        disabled={currentView === null || creating}
        onClick={() => setCreateOpen((open) => !open)}
      />
      <div ref={filterPanelAnchor} style={{ position: 'relative', display: 'inline-flex' }}>
        <Button
          variant="secondary"
          iconLeft="filter"
          label="篩選"
          disabled={currentView === null}
          onClick={() => (filterPanelOpen ? setFilterPanelOpen(false) : openFilterPanel())}
        />
        {filterPanelOpen && (
          <FilterPanel
            theme={theme}
            rows={filterRows}
            fieldOptions={fieldOptions}
            fieldOptionsLoading={fieldDefsLoading}
            error={filterError}
            saving={filterSaving}
            onFieldChange={changeFilterField}
            onValueChange={changeFilterValue}
            onRemoveRow={removeFilterRow}
            onAddRow={addFilterRow}
            onApply={() => void applyFilter()}
            onCancel={cancelFilterPanel}
          />
        )}
      </div>
      <Select
        prefix="排序"
        options={sortOptions}
        value={sort?.key ?? ''}
        onChange={(key) => setSort({ key, direction: 'asc' })}
      />
      <Select prefix="分組" options={[{ value: LIST_GROUP_NONE, label: '不分組' }, ...sortOptions]} value={groupBy} onChange={setGroupBy} />
      <div ref={columnPanelAnchor} style={{ position: 'relative', display: 'inline-flex' }}>
        <IconButton
          icon="columns"
          title="欄位顯示設定"
          active={columnPanelOpen}
          disabled={currentView === null}
          onClick={() => setColumnPanelOpen((open) => !open)}
        />
        {columnPanelOpen && (
          <ColumnConfigPanel
            theme={theme}
            catalog={catalog}
            entries={columnConfigDraft}
            widthStep={T.COLUMN_PANEL_WIDTH_STEP}
            widthMin={COLUMN_WIDTH_MIN}
            error={saveError}
            onToggle={toggleColumn}
            onMove={moveColumn}
            onWidthChange={adjustColumnWidth}
          />
        )}
      </div>
    </>
  );

  return (
    <div
      style={{
        width: '100%',
        minHeight: '100%',
        display: 'flex',
        flexDirection: 'column',
        background: theme.bg.base,
        color: theme.text.primary,
        fontFamily: FONT_FAMILY.base,
      }}
    >
      <Toolbar left={toolbarLeft} right={toolbarRight} />

      <div
        style={{
          display: 'flex',
          flexDirection: 'column',
          gap: T.SECTION_GAP,
          padding: `${T.CONTENT_PADDING_Y}px ${T.CONTENT_PADDING_X}px`,
        }}
      >
        <FilterChipBar chips={filterChips} />

        <FilterNotice count={data?.permissionExcludedCount} />

        {createOpen && currentView !== null && (
          <CreateIssueBar
            key={currentView.id}
            viewId={currentView.id}
            theme={theme}
            submitting={creating}
            error={createError}
            onSubmit={(input) => void submitCreate(input)}
            onCancel={() => {
              setCreateOpen(false);
              setCreateError(undefined);
            }}
          />
        )}

        {currentView === null ? (
          <EmptyState
            title="尚無檢視"
            description="請先在左側「當前檢視」新增一張檢視，才能載入工單清單。"
          />
        ) : error !== undefined ? (
          <EmptyState
            icon="clock"
            title="載入工單失敗"
            description={error}
            action={{ label: '重試', onClick: () => void reload() }}
          />
        ) : loading && data === undefined ? (
          <div style={{ ...typeStyle(T.VIEW_META_TYPE), color: theme.text.tertiary }}>載入中…</div>
        ) : (
          <DataTable
            columns={columns}
            rows={rows}
            density={T.TABLE_DENSITY}
            sort={sort}
            onSortChange={setSort}
            groupBy={effectiveGroupBy}
            selectedIds={selectedIds}
            onRowSelect={onRowSelect}
            onRowActivate={onRowActivate}
            emptyState={
              <EmptyState
                title="還沒有工單"
                description="這個工單集目前是空的。點右上角「建立工單」開出第一張。"
                action={{ label: '建立工單', icon: 'plus', onClick: () => setCreateOpen(true) }}
              />
            }
          />
        )}
      </div>
    </div>
  );
}
