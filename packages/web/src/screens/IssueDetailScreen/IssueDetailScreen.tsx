// IssueDetailScreen · 工單詳情頁
//
// 角色：檢視與編輯單張工單的完整欄位、關聯、異動歷史。List／Kanban／
// DevOrder 三畫面的工單列點擊（雙擊 / 點卡 / 點列）導覽至此。
//
// 對側 spec：no3_product_specs/no1_issue_system/no2_screens/no5_issue_detail_screen.md
// 另讀 no3_logics/no6_changelog_logic.md（listIssueChangelog）與
// no3_logics/no1_relation_integrity_logic.md（listIssueRelations）。
// 對側 design：30_screens/no5_issue_detail_screen/no5_issue_detail_screen.jsx。
//
// 資料來源：工單、欄位值、歷史與關聯並行讀取，再依工單型別取得欄位配方與
// 流程。關聯的對側工單編號在同一 fetcher 內解析（見 resolveCounterpartKeys）。
// 任一欄位／Status 寫入成功後整個 reload()，不做樂觀本地更新——失敗時畫面
// 自然維持原資料，滿足 Spec「操作失敗時 Status 維持原值」而不必另寫回滾。
//
// 編輯範圍：status/resolution 走 Status 控件觸發的 changeIssueStatus 流程；
// title/assignee/point/due 四個白名單欄位走 workspace.ts PATCH 的一般欄位
// 寫入；其餘 readonly=false 的欄位（含自訂欄位）走 issues.ts 泛用路徑
// PUT /issues/:issueId/fields/:fieldName，對齊 design 定案：非唯讀欄位一律
// 可編輯，不分值型別，值一律當字串送出（見下方 renderFieldValue）。

import { useCallback, useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router';

import {
  ApiError,
  issuesApi,
  issueTypesApi,
  relationsApi,
  workspaceApi,
} from '../../api';
import type {
  ChangeLogEntry,
  FieldDef,
  IssueFieldValue,
  IssueContext,
  IssueRelation,
  IssueSummary,
  RelationTypeDefinition,
  UpdateIssueInput,
  WorkflowDefinition,
} from '../../api';
import { Button, Select } from '../../components/controls';
import { useCurrentView } from '../../app/CurrentViewContext';
import { RelationForm, RollupField, WorkLogPanel } from './PlanningControls';
import { EmptyState } from '../../components/data';
import { useAuth } from '../../auth/AuthContext';
import { useAsync } from '../../hooks/useAsync';
import { FONT_FAMILY, SPACING, TYPE_STYLES, useTheme } from '../../theme';
import { typeStyle } from '../typeStyle';
import {
  ChangeLogRow,
  displayValue,
  personLabel,
  relationLabel,
  EditableTextField,
  FieldRow,
  ReadOnlyValue,
  RelationGroup,
  SectionPanel,
  StatusResolutionPrompt,
} from './internal';
import type { RelationGroupItem } from './internal';
import { ISSUE_DETAIL_SCREEN_TOKENS } from './tokens';

const T = ISSUE_DETAIL_SCREEN_TOKENS;

/** 對齊 server domain/relation/types.ts 的 CHILDREN_RELATION_TYPE_NAME；web 無法跨包 import domain 常數，逐名複製。 */
const CHILDREN_RELATION_TYPE_NAME = 'Children';

/** workspace.ts PATCH 認得的白名單欄位裡，走「一般欄位寫入」這條、非 Status/Resolution 的四個。 */
const GENERIC_EDITABLE_FIELDS = new Set(['title', 'assignee', 'point', 'due']);

/** 欄位區顯示順序：白名單依 Spec 線框圖順序在前，其餘（含未來自訂欄位）依名稱字母序接在後面。 */
const FIELD_DISPLAY_ORDER = ['title', 'status', 'resolution', 'assignee', 'point', 'due'];

function asString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function orderFieldDefs(defs: readonly FieldDef[]): readonly FieldDef[] {
  const rank = new Map(FIELD_DISPLAY_ORDER.map((name, i) => [name, i]));
  return [...defs].sort((a, b) => {
    const ra = rank.get(a.name) ?? FIELD_DISPLAY_ORDER.length;
    const rb = rank.get(b.name) ?? FIELD_DISPLAY_ORDER.length;
    if (ra !== rb) return ra - rb;
    return a.name.localeCompare(b.name);
  });
}

interface IssueDetailData {
  readonly context: IssueContext;
  readonly issue: IssueSummary;
  readonly fieldDefs: readonly FieldDef[];
  readonly singleFieldDefs: readonly FieldDef[];
  readonly fieldValues: readonly IssueFieldValue[];
  readonly changeLog: readonly ChangeLogEntry[];
  readonly relationTypes: readonly RelationTypeDefinition[];
  readonly relationsFrom: readonly IssueRelation[];
  readonly relationsTo: readonly IssueRelation[];
  /** 關聯對側工單 id → issueKey；查無（如已刪除）的項不進表，顯示端回退用 id。 */
  readonly counterpartKeys: ReadonlyMap<string, string>;
  readonly workflow: WorkflowDefinition;
}

/** 關聯清單的對側工單 id 集合去重後並行解析 issueKey；單筆查詢失敗（如已刪除）不拖垮整頁，跳過即可。 */
async function resolveCounterpartKeys(
  relationsFrom: readonly IssueRelation[],
  relationsTo: readonly IssueRelation[],
): Promise<ReadonlyMap<string, string>> {
  return new Map([
    ...relationsFrom.map(r => [r.toIssueId, r.counterpartKey ?? r.toIssueId] as const),
    ...relationsTo.map(r => [r.fromIssueId, r.counterpartKey ?? r.fromIssueId] as const),
  ]);
}

interface RelationsView {
  readonly parents: readonly RelationGroupItem[];
  readonly children: readonly RelationGroupItem[];
  readonly otherGroups: readonly { readonly relationTypeId: string; readonly typeName: string; readonly items: readonly RelationGroupItem[] }[];
  readonly isEmpty: boolean;
}

/** 依關聯型別分組；母子鏈拆父／子兩組，其餘型別各自一組。對齊 listIssueRelations 的分組契約。 */
function buildRelationsView(data: IssueDetailData): RelationsView {
  const typesById = new Map(data.relationTypes.map((t) => [t.id, t]));
  const childrenType = data.relationTypes.find((t) => t.name === CHILDREN_RELATION_TYPE_NAME);
  const keyOf = (id: string): string => data.counterpartKeys.get(id) ?? id;

  const parents: RelationGroupItem[] = [];
  const children: RelationGroupItem[] = [];
  const otherByType = new Map<string, { typeName: string; items: RelationGroupItem[] }>();

  const itemOf = (relation: IssueRelation, id: string): RelationGroupItem => ({ id, key: keyOf(id),
    relationId: relation.id, canRemove: relation.canRemove ?? false, readable: relation.counterpartReadable ?? false });
  const addOther = (relation: IssueRelation, counterpartId: string, direction: 'outgoing' | 'incoming') => {
    const relationTypeId = relation.relationTypeId;
    const typeName = typesById.get(relationTypeId)?.name ?? '未知關聯型別';
    const bucket = otherByType.get(relationTypeId) ?? { typeName, items: [] };
    if (!bucket.items.some((item) => item.relationId === relation.id)) {
      bucket.items.push({ ...itemOf(relation, counterpartId),
        ...(!typesById.get(relationTypeId)?.symmetric ? { direction } : {}) });
    }
    otherByType.set(relationTypeId, bucket);
  };

  // 正查（this issue 為持有端）：母子鏈下對側為子工單，其餘型別對側走一般分組。
  for (const r of data.relationsFrom) {
    if (childrenType !== undefined && r.relationTypeId === childrenType.id) {
      children.push(itemOf(r, r.toIssueId));
    } else {
      addOther(r, r.toIssueId, 'outgoing');
    }
  }
  // 反查（this issue 為被指端）：母子鏈下對側為上層（母），其餘型別對側走一般分組。
  for (const r of data.relationsTo) {
    if (childrenType !== undefined && r.relationTypeId === childrenType.id) {
      parents.push(itemOf(r, r.fromIssueId));
    } else {
      addOther(r, r.fromIssueId, 'incoming');
    }
  }

  const otherGroups = [...otherByType.entries()]
    .map(([relationTypeId, bucket]) => ({ relationTypeId, typeName: bucket.typeName, items: bucket.items }))
    .sort((a, b) => a.typeName.localeCompare(b.typeName));

  const isEmpty = parents.length === 0 && children.length === 0 && otherGroups.length === 0;
  return { parents, children, otherGroups, isEmpty };
}

export function IssueDetailScreen() {
  const { issueId = '' } = useParams<{ issueId: string }>();
  // 換工單時一起重建資料與編輯狀態，避免沿用前張工單的流程選擇。
  return <IssueDetailContent key={issueId} issueId={issueId} />;
}

function IssueDetailContent({ issueId }: { readonly issueId: string }) {
  const { theme } = useTheme();
  const navigate = useNavigate();
  const goBack = () => navigate(-1);
  const { account } = useAuth();
  const { currentView } = useCurrentView();

  const fetcher = useCallback(async (): Promise<IssueDetailData> => {
    const [issue, fieldValues, changeLog, relationTypes, relationsFrom, relationsTo, context] =
      await Promise.all([
        issuesApi.getIssue(issueId),
        issuesApi.listFieldValues(issueId),
        issuesApi.listChangelog(issueId),
        relationsApi.listRelationTypes(),
        relationsApi.listRelationsFrom(issueId),
        relationsApi.listRelationsTo(issueId),
        issuesApi.getIssueContext(issueId, currentView?.calendarName),
      ]);
    const [typeDetails, counterpartKeys] = await Promise.all([
      issueTypesApi.getIssueTypeDetails(issue.issueTypeId),
      resolveCounterpartKeys(relationsFrom, relationsTo),
    ]);
    return {
      issue,
      context,
      ...typeDetails,
      fieldValues,
      changeLog,
      relationTypes,
      relationsFrom,
      relationsTo,
      counterpartKeys,
    };
  }, [issueId, currentView?.calendarName]);
  const { data, loading, error, reload } = useAsync(fetcher);

  const [pendingField, setPendingField] = useState<string | null>(null);
  const [fieldError, setFieldError] = useState<string | undefined>(undefined);
  const [resolutionTarget, setResolutionTarget] = useState<string | null>(null);

  const commitField = useCallback(
    async (fieldName: string, patch: UpdateIssueInput) => {
      // 同一時間只允許一筆欄位寫入在飛行中，避免兩筆並發 PATCH 互相踩到
      // pendingField 的記帳（比照 KanbanScreen 的 pendingKey 單筆語意）。
      if (pendingField !== null) return false;
      setPendingField(fieldName);
      setFieldError(undefined);
      try {
        await workspaceApi.updateIssue(issueId, patch);
        await reload();
        return true;
      } catch (err: unknown) {
        setFieldError(err instanceof ApiError ? err.message : '更新失敗');
        return false;
      } finally {
        setPendingField(null);
      }
    },
    [issueId, reload, pendingField],
  );

  // 白名單外的一般欄位（含自訂欄位）提交：走 issues.ts 泛用路徑，值一律當字串，
  // 不做型別轉換——對齊 design 定案，只有 point（白名單內）特殊處理數字。
  const commitGenericField = useCallback(
    async (fieldName: string, text: string) => {
      if (pendingField !== null) return false;
      setPendingField(fieldName);
      setFieldError(undefined);
      try {
        const def = data?.singleFieldDefs.find(field => field.name === fieldName);
        const value = text.trim() === '' ? null : def?.valueType === 'number' ? Number(text) :
          def?.valueType === 'boolean' ? text === 'true' : text;
        if (typeof value === 'number' && !Number.isFinite(value)) throw new Error('請填寫有效數字');
        await issuesApi.updateFieldValue(issueId, fieldName, value);
        await reload();
        return true;
      } catch (err: unknown) {
        setFieldError(err instanceof Error ? err.message : '更新失敗');
        return false;
      } finally {
        setPendingField(null);
      }
    },
    [issueId, reload, pendingField, data?.singleFieldDefs],
  );

  // 一般欄位（非 Status）文字提交：型別轉換與空值語意集中於此，EditableTextField 只管字串草稿。
  const commitTextField = useCallback(
    (fieldName: string, text: string) => {
      const trimmed = text.trim();
      switch (fieldName) {
        case 'title':
          // title 不可清空；未通過驗證就靜默忽略，草稿留在編輯框待補內容。
          if (trimmed === '') { setFieldError('標題不能留白'); return false; }
          return commitField('title', { title: trimmed });
        case 'assignee':
          return commitField('assignee', { assignee: text });
        case 'point': {
          if (trimmed === '') {
            return commitField('point', { point: null });
          }
          const parsed = Number(trimmed);
          if (!Number.isFinite(parsed)) {
            setFieldError('StoryPoint 須為數字');
            return false;
          }
          return commitField('point', { point: parsed });
        }
        case 'due':
          return commitField('due', { due: trimmed === '' ? null : trimmed });
        default:
          return;
      }
    },
    [commitField],
  );

  const fieldValueByName = useMemo(
    () => new Map((data?.fieldValues ?? []).map((v) => [v.fieldName, v.value])),
    [data?.fieldValues],
  );
  const fieldLabelByName = useMemo(
    () => new Map((data?.fieldDefs ?? []).map((d) => [d.name, d.label])),
    [data?.fieldDefs],
  );
  const singleFieldDefs = useMemo(
    () => orderFieldDefs(data?.singleFieldDefs ?? []),
    [data?.singleFieldDefs],
  );

  const currentStatus = asString(fieldValueByName.get('status'));
  const terminalSet = useMemo(
    () => new Set((data?.workflow.states ?? []).filter((s) => s.isTerminal).map((s) => s.name)),
    [data?.workflow.states],
  );

  const applyStatusChange = useCallback(
    (targetStatus: string, resolution?: string) => {
      const patch: UpdateIssueInput =
        resolution === undefined ? { status: targetStatus } : { status: targetStatus, resolution };
      return commitField('status', patch);
    },
    [commitField],
  );

  const onStatusChange = useCallback(
    (targetStatus: string) => {
      if (targetStatus === currentStatus) return;
      if (terminalSet.has(targetStatus)) {
        setResolutionTarget(targetStatus);
        return;
      }
      // 清掉可能殘留的舊結案原因選擇面板：使用者若在面板開著時又選了非終止
      // 狀態，這筆直接送出，不該留一片對不上目前選擇的舊面板在下面。
      setResolutionTarget(null);
      void applyStatusChange(targetStatus);
    },
    [currentStatus, terminalSet, applyStatusChange],
  );

  const onResolutionConfirm = useCallback(
    (resolutionValue: string) => {
      const target = resolutionTarget;
      if (target === null) return;
      setResolutionTarget(null);
      void applyStatusChange(target, resolutionValue);
    },
    [resolutionTarget, applyStatusChange],
  );
  const onResolutionCancel = useCallback(() => setResolutionTarget(null), []);

  const relationsView = useMemo(() => (data === undefined ? undefined : buildRelationsView(data)), [data]);

  async function removeRelation(id: string): Promise<boolean> {
    if (pendingField !== null) return false;
    setPendingField('relation');
    setFieldError(undefined);
    try { await relationsApi.removeRelation(id); await reload(); return true; }
    catch (err) { setFieldError(err instanceof Error ? err.message : '移除失敗'); return false; }
    finally { setPendingField(null); }
  }

  // ─── 欄位區單列渲染 ──────────────────────────────────────────
  function renderFieldValue(def: FieldDef) {
    const stored = fieldValueByName.get(def.name);
    const raw = def.name === 'CreateBy' ? personLabel(String(stored ?? ''), account) : stored;
    const rollup = data?.context.rollups.find(row => row.fieldName === def.name);
    if (!data?.context.canEdit || rollup?.restricted || (rollup?.hasChildren && rollup.mode === 'auto')) {
      return <ReadOnlyValue text={rollup?.restricted ? '彙總來源權限不足' : displayValue(raw)} />;
    }

    if (def.name === 'status') {
      const statusOptions = (data?.workflow.states ?? []).map((s) => ({ value: s.name, label: s.name }));
      return (
        <div style={{ display: 'flex', flexDirection: 'column', gap: T.FIELD_CONFIRM_GAP, flex: 1, minWidth: 0 }}>
          <Select
            prefix="狀態"
            options={statusOptions}
            disabled={pendingField !== null}
            onChange={onStatusChange}
            {...(currentStatus === '' ? {} : { value: currentStatus })}
          />
          {resolutionTarget !== null && (
            <StatusResolutionPrompt
              targetStatus={resolutionTarget}
              options={data?.workflow.resolutionOptions ?? []}
              submitting={pendingField === 'status'}
              onCancel={onResolutionCancel}
              onConfirm={onResolutionConfirm}
            />
          )}
        </div>
      );
    }

    if (def.name === 'resolution') {
      // Resolution 只隨一次真正的 Status 轉換一併寫入（見 workspace.ts PATCH 的
      // RESOLUTION_REQUIRES_STATUS_CHANGE 規則），本畫面不給獨立輸入框，
      // 空值顯示對齊 Spec 線框圖的「尚未結案」而非泛用的「(無)」。
      const text = typeof raw === 'string' && raw !== '' ? raw : '尚未結案';
      return <ReadOnlyValue text={text} />;
    }

    if (def.readonly) {
      return <ReadOnlyValue text={displayValue(raw)} />;
    }

    if (GENERIC_EDITABLE_FIELDS.has(def.name)) {
      const textValue = def.name === 'point' ? (typeof raw === 'number' ? String(raw) : '') : asString(raw);
      return (
        <EditableTextField
          label={def.label}
          onCancel={() => setFieldError(undefined)}
          value={textValue}
          disabled={pendingField !== null}
          onCommit={(text) => commitTextField(def.name, text)}
        />
      );
    }

    if (def.valueType === 'boolean') return <Select value={raw === null || raw === undefined ? '' : String(raw)}
      options={[{ value: '', label: '未填寫' }, { value: 'false', label: '否' }, { value: 'true', label: '是' }]}
      disabled={pendingField !== null} onChange={text => void commitGenericField(def.name, text)} />;
    return (
      <EditableTextField
        label={def.label}
        onCancel={() => setFieldError(undefined)}
        value={raw === null || raw === undefined ? '' : String(raw)}
        disabled={pendingField !== null}
        onCommit={(text) => commitGenericField(def.name, text)}
      />
    );
  }

  const title = asString(fieldValueByName.get('title'));
  const titleDef = singleFieldDefs.find(def => def.name === 'title');
  const statusDef = singleFieldDefs.find(def => def.name === 'status');
  const remainingFields = singleFieldDefs.filter(def => !['title', 'status'].includes(def.name));
  return <div className="issue-detail" style={{ width: '100%', minHeight: '100%', containerType: 'inline-size', background: theme.bg.surface, color: theme.text.primary, fontFamily: FONT_FAMILY.base }}>
    <style>{`
      .issue-content { max-width: ${T.CONTENT_MAX_WIDTH}px; margin: 0 auto; padding: ${T.PAGE_PADDING_Y}px ${T.PAGE_PADDING_X}px; box-sizing: border-box; }
      .issue-body { display: grid; grid-template-columns: ${T.DETAIL_COLUMNS}; gap: ${T.CONTENT_GAP}px; align-items: start; }
      .issue-properties { grid-column: 2; grid-row: 1; min-width: 0; }
      .issue-detail select { width: 100%; }
      .issue-detail * { box-sizing: border-box; }
      .issue-main { grid-column: 1; grid-row: 1; min-width: 0; }
      .issue-editable:hover, .issue-editable:focus-visible { background: ${theme.bg.surface_hover} !important; }
      .issue-editable:focus-visible { outline: 2px solid ${theme.state.focus.ring}; outline-offset: 2px; }
      .issue-edit-hint { opacity: 0; }
      .issue-editable:hover .issue-edit-hint, .issue-editable:focus-visible .issue-edit-hint { opacity: 1; }
      .issue-detail summary { cursor: pointer; color: ${theme.primary.main}; padding: ${SPACING.sm}px 0; font-size: ${TYPE_STYLES.bodySm.size}px; }
      .issue-detail summary:focus-visible { outline: 2px solid ${theme.state.focus.ring}; }
      @container (max-width: ${T.RESPONSIVE_WIDTH}px) {
        .issue-content { padding: ${T.MOBILE_PADDING}px; }
        .issue-body { display: flex; flex-direction: column; gap: 0; }
        .issue-properties, .issue-main { width: 100%; }
        .issue-detail section { padding: 16px !important; }
        .issue-edit-hint { opacity: 1; }
      }
    `}</style>
    <div className="issue-content">
      <div style={{ display: 'flex', alignItems: 'center', gap: T.HEADER_GAP, color: theme.text.secondary, ...typeStyle(TYPE_STYLES.bodySm) }}>
        <Button variant="ghost" label="← 返回" onClick={goBack} /><span aria-hidden="true">/</span><span style={{ fontFamily: FONT_FAMILY.mono }}>{data?.issue.issueKey ?? '工單詳情'}</span>
      </div>
      {error !== undefined ? <EmptyState icon="clock" title="載入工單失敗" description={error} action={{ label: '重試', onClick: () => void reload() }} /> : loading && data === undefined ? <p role="status">載入中…</p> : data !== undefined ? <>
        <h1 style={{ ...typeStyle(T.TITLE_TYPE), margin: `${SPACING.xl}px 0 ${SPACING.md}px`, overflowWrap: 'anywhere' }}>
          {titleDef && !titleDef.readonly && data.context.canEdit ? <EditableTextField heading label={titleDef.label} value={title} disabled={pendingField !== null} onCancel={() => setFieldError(undefined)} onCommit={text => commitTextField('title', text)} /> : title || data.issue.issueKey}
        </h1>
        <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'flex-start', gap: SPACING.md, marginBottom: SPACING['2xl'] }}>
          {statusDef && <div style={{ minWidth: 0 }}>{renderFieldValue(statusDef)}</div>}
          {!data.context.canEdit && <span style={{ ...typeStyle(TYPE_STYLES.bodySm), color: theme.text.secondary }}>唯讀工單</span>}
        </div>
        {fieldError && <p role="alert" style={{ ...typeStyle(TYPE_STYLES.bodySm), color: theme.status.error_fg }}>{fieldError}</p>}
        <div className="issue-body">
          <aside className="issue-properties">
            <SectionPanel title="工單資訊">
              {remainingFields.map(def => <FieldRow key={def.name} label={def.label}>
                {data.context.rollups.find(row => row.fieldName === def.name) ? <RollupField issueId={issueId} status={data.context.rollups.find(row => row.fieldName === def.name)!} value={fieldValueByName.get(def.name)} canEdit={data.context.canEdit} onSaved={reload}>{renderFieldValue(def)}</RollupField> : renderFieldValue(def)}
              </FieldRow>)}
            </SectionPanel>
            <WorkLogPanel issueId={issueId} context={data.context} onSaved={reload} />
          </aside>
          <div className="issue-main">
            <SectionPanel title="關聯工單">
              {relationsView === undefined || relationsView.isEmpty ? <span style={{ ...typeStyle(TYPE_STYLES.bodySm), color: theme.text.secondary }}>尚無關聯工單。</span> : <>
                <RelationGroup title="上層工單" items={relationsView.parents} onRemove={removeRelation} onOpen={id => navigate(`/issues/${id}`)} />
                <RelationGroup title="子工單" items={relationsView.children} onRemove={removeRelation} onOpen={id => navigate(`/issues/${id}`)} />
                {relationsView.otherGroups.map(group => <RelationGroup key={group.relationTypeId} title={relationLabel(group.typeName)} items={group.items} onRemove={removeRelation} onOpen={id => navigate(`/issues/${id}`)} />)}
              </>}
              {data.context.canEdit && <details><summary>新增關聯</summary><RelationForm issueId={issueId} types={data.relationTypes} onSaved={reload} /></details>}
            </SectionPanel>
            <SectionPanel title="異動歷史">
              {data.changeLog.length === 0 ? <span style={{ ...typeStyle(TYPE_STYLES.bodySm), color: theme.text.secondary }}>尚無異動記錄。</span> : <div>{data.changeLog.map(entry => <ChangeLogRow key={entry.id} entry={entry} actorLabel={personLabel(entry.actor, account)} fieldLabel={fieldLabelByName.get(entry.fieldName) ?? entry.fieldName} />)}</div>}
            </SectionPanel>
          </div>
        </div>
      </> : null}
    </div>
  </div>;
}
