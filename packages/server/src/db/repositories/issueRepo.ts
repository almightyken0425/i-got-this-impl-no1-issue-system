import type { Issue, RollupMode } from '../../domain/index.js';
import { getPool } from '../pool.js';
import type { Executor } from './executor.js';
import { run, runOne } from './executor.js';
import type {
  IssueTypeDefinition,
  ResolutionOption,
  StoredFieldValue,
  WorkflowState,
  WorkflowTransition,
} from './types.js';

// 工單 repository。
//
// 角色：Issues、IssueTypeDefinitions、WorkflowStates / WorkflowTransitions、
//       ResolutionOptions 的讀寫，與工單欄位單值的存取。
// 邊界：
// - 唯一碰工單相關表的一層；SQL 不外流。
// - 工單實體沿用 domain 的 `Issue`；型別與流程類實體沿用本層 types。
// - 每個讀寫都帶 companyId 租戶鍵，跨 Company 的資料互不可見。
// - jsonb 欄位（欄位組配方、必填欄位、欄位值）寫入前序列化、讀出後即為解析值。

// ============================================================
// row 型別與對映
// ============================================================

interface IssueRow {
  id: string;
  company_id: string;
  issue_set_id: string;
  issue_type_id: string;
  issue_key: string;
}
interface IssueTypeRow {
  id: string;
  company_id: string;
  name: string;
  label: string;
  field_sets: string[];
  system: boolean;
}
interface WorkflowStateRow {
  company_id: string;
  issue_type_id: string;
  name: string;
  sort_order: number;
  is_initial: boolean;
  is_terminal: boolean;
}
interface WorkflowTransitionRow {
  company_id: string;
  issue_type_id: string;
  from_state: string;
  to_state: string;
  required_role: string | null;
  required_fields: string[];
}
interface ResolutionOptionRow {
  company_id: string;
  issue_type_id: string;
  value: string;
  sort_order: number;
  system: boolean;
}
interface FieldValueRow {
  company_id: string;
  issue_id: string;
  field_name: string;
  value: unknown;
  rollup_mode: RollupMode | null;
}

function toIssue(row: IssueRow): Issue {
  return {
    id: row.id,
    companyId: row.company_id,
    issueSetId: row.issue_set_id,
    issueTypeId: row.issue_type_id,
    issueKey: row.issue_key,
  };
}
function toIssueType(row: IssueTypeRow): IssueTypeDefinition {
  return {
    id: row.id,
    companyId: row.company_id,
    name: row.name,
    label: row.label,
    fieldSets: row.field_sets,
    system: row.system,
  };
}
function toWorkflowState(row: WorkflowStateRow): WorkflowState {
  return {
    companyId: row.company_id,
    issueTypeId: row.issue_type_id,
    name: row.name,
    sortOrder: row.sort_order,
    isInitial: row.is_initial,
    isTerminal: row.is_terminal,
  };
}
function toWorkflowTransition(row: WorkflowTransitionRow): WorkflowTransition {
  return {
    companyId: row.company_id,
    issueTypeId: row.issue_type_id,
    fromState: row.from_state,
    toState: row.to_state,
    requiredRole: row.required_role,
    requiredFields: row.required_fields,
  };
}
function toResolutionOption(row: ResolutionOptionRow): ResolutionOption {
  return {
    companyId: row.company_id,
    issueTypeId: row.issue_type_id,
    value: row.value,
    sortOrder: row.sort_order,
    system: row.system,
  };
}
function toFieldValue(row: FieldValueRow): StoredFieldValue {
  return {
    companyId: row.company_id,
    issueId: row.issue_id,
    fieldName: row.field_name,
    value: row.value,
    rollupMode: row.rollup_mode,
  };
}

// ============================================================
// Issues
// ============================================================

/** 建單者是系統維護的稽核欄位。舊工單無可靠來源時不猜測作者。 */
export async function recordCreator(companyId: string, issueId: string, accountId: string, exec: Executor): Promise<void> {
  await exec.query('INSERT INTO field_set_defs (company_id, name, system) VALUES ($1, $2, true) ON CONFLICT DO NOTHING', [companyId, '基本']);
  await exec.query(`INSERT INTO field_defs
    (company_id, name, field_set_name, kind, value_type, system, readonly, rollupable, rollup_fn, tracked, label)
    VALUES ($1, 'CreateBy', '基本', 'single', 'user', true, true, false, null, false, '建立者')
    ON CONFLICT (company_id, name) DO UPDATE SET readonly = true, system = true`, [companyId]);
  await setFieldValue({ companyId, issueId, fieldName: 'CreateBy', value: accountId }, exec);
}

/** 建立工單；`issueKey` 由呼叫端以 domain 的 assignIssueKey 產生後傳入。 */
export async function createIssue(input: Issue, exec: Executor = getPool()): Promise<Issue> {
  const row = await runOne<IssueRow>(
    exec,
    `INSERT INTO issues (id, company_id, issue_set_id, issue_type_id, issue_key)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING id, company_id, issue_set_id, issue_type_id, issue_key`,
    [input.id, input.companyId, input.issueSetId, input.issueTypeId, input.issueKey],
  );
  return toIssue(row!);
}

export async function getIssue(
  companyId: string,
  id: string,
  exec: Executor = getPool(),
): Promise<Issue | undefined> {
  const row = await runOne<IssueRow>(
    exec,
    `SELECT id, company_id, issue_set_id, issue_type_id, issue_key
     FROM issues WHERE company_id = $1 AND id = $2
       AND NOT EXISTS (SELECT 1 FROM issue_field_values v WHERE v.company_id = issues.company_id
         AND v.issue_id = issues.id AND v.field_name = 'Archived' AND v.value = 'true'::jsonb)`,
    [companyId, id],
  );
  return row ? toIssue(row) : undefined;
}

export async function getIssueByKey(
  companyId: string,
  issueKey: string,
  exec: Executor = getPool(),
): Promise<Issue | undefined> {
  const row = await runOne<IssueRow>(
    exec,
    `SELECT id, company_id, issue_set_id, issue_type_id, issue_key
     FROM issues WHERE company_id = $1 AND issue_key = $2
       AND NOT EXISTS (SELECT 1 FROM issue_field_values v WHERE v.company_id = issues.company_id
         AND v.issue_id = issues.id AND v.field_name = 'Archived' AND v.value = 'true'::jsonb)`,
    [companyId, issueKey],
  );
  return row ? toIssue(row) : undefined;
}

export async function listIssuesByIssueSet(
  companyId: string,
  issueSetId: string,
  exec: Executor = getPool(),
): Promise<Issue[]> {
  const rows = await run<IssueRow>(
    exec,
    `SELECT id, company_id, issue_set_id, issue_type_id, issue_key
     FROM issues WHERE company_id = $1 AND issue_set_id = $2
       AND NOT EXISTS (SELECT 1 FROM issue_field_values v WHERE v.company_id = issues.company_id
         AND v.issue_id = issues.id AND v.field_name = 'Archived' AND v.value = 'true'::jsonb)
     ORDER BY issue_key`,
    [companyId, issueSetId],
  );
  return rows.map(toIssue);
}

/** 將工單移至其他工單集；編號 issueKey 保留原號不變。 */
export async function moveIssue(
  companyId: string,
  id: string,
  issueSetId: string,
  exec: Executor = getPool(),
): Promise<Issue | undefined> {
  const row = await runOne<IssueRow>(
    exec,
    `UPDATE issues SET issue_set_id = $3 WHERE company_id = $1 AND id = $2
     RETURNING id, company_id, issue_set_id, issue_type_id, issue_key`,
    [companyId, id, issueSetId],
  );
  return row ? toIssue(row) : undefined;
}

export async function deleteIssue(
  companyId: string,
  id: string,
  exec: Executor = getPool(),
): Promise<boolean> {
  if (await getIssue(companyId, id, exec) === undefined) return false;
  await exec.query('INSERT INTO field_set_defs (company_id, name, system) VALUES ($1, $2, true) ON CONFLICT DO NOTHING', [companyId, '基本']);
  await exec.query(`INSERT INTO field_defs
    (company_id, name, field_set_name, kind, value_type, system, readonly, rollupable, rollup_fn, tracked, label)
    VALUES ($1, 'Archived', '基本', 'single', 'boolean', true, true, false, null, false, '已封存')
    ON CONFLICT (company_id, name) DO UPDATE SET readonly = true, system = true`, [companyId]);
  await setFieldValue({ companyId, issueId: id, fieldName: 'Archived', value: true }, exec);
  return true;
}

// ============================================================
// IssueTypeDefinitions
// ============================================================

export async function createIssueType(
  input: IssueTypeDefinition,
  exec: Executor = getPool(),
): Promise<IssueTypeDefinition> {
  const row = await runOne<IssueTypeRow>(
    exec,
    `INSERT INTO issue_type_definitions (id, company_id, name, label, field_sets, system)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING id, company_id, name, label, field_sets, system`,
    [input.id, input.companyId, input.name, input.label, JSON.stringify(input.fieldSets), input.system],
  );
  return toIssueType(row!);
}

export async function getIssueType(
  companyId: string,
  id: string,
  exec: Executor = getPool(),
): Promise<IssueTypeDefinition | undefined> {
  const row = await runOne<IssueTypeRow>(
    exec,
    `SELECT id, company_id, name, label, field_sets, system
     FROM issue_type_definitions WHERE company_id = $1 AND id = $2`,
    [companyId, id],
  );
  return row ? toIssueType(row) : undefined;
}

export async function getIssueTypeByName(
  companyId: string,
  name: string,
  exec: Executor = getPool(),
): Promise<IssueTypeDefinition | undefined> {
  const row = await runOne<IssueTypeRow>(
    exec,
    `SELECT id, company_id, name, label, field_sets, system
     FROM issue_type_definitions WHERE company_id = $1 AND name = $2`,
    [companyId, name],
  );
  return row ? toIssueType(row) : undefined;
}

export async function listIssueTypes(
  companyId: string,
  exec: Executor = getPool(),
): Promise<IssueTypeDefinition[]> {
  const rows = await run<IssueTypeRow>(
    exec,
    `SELECT id, company_id, name, label, field_sets, system
     FROM issue_type_definitions WHERE company_id = $1 ORDER BY name`,
    [companyId],
  );
  return rows.map(toIssueType);
}

/** 更新工單型別的顯示名稱與欄位組配方；識別名稱 name 與系統旗標不動。 */
export async function updateIssueType(
  companyId: string,
  id: string,
  patch: { readonly label: string; readonly fieldSets: readonly string[] },
  exec: Executor = getPool(),
): Promise<IssueTypeDefinition | undefined> {
  const row = await runOne<IssueTypeRow>(
    exec,
    `UPDATE issue_type_definitions SET label = $3, field_sets = $4
     WHERE company_id = $1 AND id = $2
     RETURNING id, company_id, name, label, field_sets, system`,
    [companyId, id, patch.label, JSON.stringify(patch.fieldSets)],
  );
  return row ? toIssueType(row) : undefined;
}

export async function deleteIssueType(
  companyId: string,
  id: string,
  exec: Executor = getPool(),
): Promise<boolean> {
  const rows = await run<IssueTypeRow>(
    exec,
    'DELETE FROM issue_type_definitions WHERE company_id = $1 AND id = $2 RETURNING id',
    [companyId, id],
  );
  return rows.length > 0;
}

// ============================================================
// WorkflowStates
// ============================================================

export type WorkflowStateInput = Omit<WorkflowState, 'companyId' | 'issueTypeId'>;

export async function listWorkflowStates(
  companyId: string,
  issueTypeId: string,
  exec: Executor = getPool(),
): Promise<WorkflowState[]> {
  const rows = await run<WorkflowStateRow>(
    exec,
    `SELECT company_id, issue_type_id, name, sort_order, is_initial, is_terminal
     FROM workflow_states WHERE company_id = $1 AND issue_type_id = $2 ORDER BY sort_order`,
    [companyId, issueTypeId],
  );
  return rows.map(toWorkflowState);
}

/**
 * 整批取代某工單型別的流程狀態：先清空、再逐筆插入。
 * 兩步須在同一交易內，`exec` 須為交易中的連線。
 */
export async function replaceWorkflowStates(
  companyId: string,
  issueTypeId: string,
  states: readonly WorkflowStateInput[],
  exec: Executor,
): Promise<WorkflowState[]> {
  await run(
    exec,
    'DELETE FROM workflow_states WHERE company_id = $1 AND issue_type_id = $2',
    [companyId, issueTypeId],
  );
  for (const s of states) {
    await run(
      exec,
      `INSERT INTO workflow_states
         (company_id, issue_type_id, name, sort_order, is_initial, is_terminal)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [companyId, issueTypeId, s.name, s.sortOrder, s.isInitial, s.isTerminal],
    );
  }
  return listWorkflowStates(companyId, issueTypeId, exec);
}

// ============================================================
// WorkflowTransitions
// ============================================================

export type WorkflowTransitionInput = Omit<WorkflowTransition, 'companyId' | 'issueTypeId'>;

export async function listWorkflowTransitions(
  companyId: string,
  issueTypeId: string,
  exec: Executor = getPool(),
): Promise<WorkflowTransition[]> {
  const rows = await run<WorkflowTransitionRow>(
    exec,
    `SELECT company_id, issue_type_id, from_state, to_state, required_role, required_fields
     FROM workflow_transitions WHERE company_id = $1 AND issue_type_id = $2
     ORDER BY from_state, to_state`,
    [companyId, issueTypeId],
  );
  return rows.map(toWorkflowTransition);
}

/**
 * 整批取代某工單型別的流程轉換：先清空、再逐筆插入。
 * 轉換的 from/to 對流程狀態有外鍵，取代狀態與轉換時須同交易且先狀態後轉換。
 */
export async function replaceWorkflowTransitions(
  companyId: string,
  issueTypeId: string,
  transitions: readonly WorkflowTransitionInput[],
  exec: Executor,
): Promise<WorkflowTransition[]> {
  await run(
    exec,
    'DELETE FROM workflow_transitions WHERE company_id = $1 AND issue_type_id = $2',
    [companyId, issueTypeId],
  );
  for (const t of transitions) {
    await run(
      exec,
      `INSERT INTO workflow_transitions
         (company_id, issue_type_id, from_state, to_state, required_role, required_fields)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [
        companyId,
        issueTypeId,
        t.fromState,
        t.toState,
        t.requiredRole,
        JSON.stringify(t.requiredFields),
      ],
    );
  }
  return listWorkflowTransitions(companyId, issueTypeId, exec);
}

// ============================================================
// ResolutionOptions
// ============================================================

export type ResolutionOptionInput = Omit<ResolutionOption, 'companyId' | 'issueTypeId'>;

export async function listResolutionOptions(
  companyId: string,
  issueTypeId: string,
  exec: Executor = getPool(),
): Promise<ResolutionOption[]> {
  const rows = await run<ResolutionOptionRow>(
    exec,
    `SELECT company_id, issue_type_id, value, sort_order, system
     FROM resolution_options WHERE company_id = $1 AND issue_type_id = $2 ORDER BY sort_order`,
    [companyId, issueTypeId],
  );
  return rows.map(toResolutionOption);
}

/** 整批取代某工單型別的結案原因選項：先清空、再逐筆插入。 */
export async function replaceResolutionOptions(
  companyId: string,
  issueTypeId: string,
  options: readonly ResolutionOptionInput[],
  exec: Executor,
): Promise<ResolutionOption[]> {
  await run(
    exec,
    'DELETE FROM resolution_options WHERE company_id = $1 AND issue_type_id = $2',
    [companyId, issueTypeId],
  );
  for (const o of options) {
    await run(
      exec,
      `INSERT INTO resolution_options (company_id, issue_type_id, value, sort_order, system)
       VALUES ($1, $2, $3, $4, $5)`,
      [companyId, issueTypeId, o.value, o.sortOrder, o.system],
    );
  }
  return listResolutionOptions(companyId, issueTypeId, exec);
}

// ============================================================
// 型別流程初始化
// ============================================================

/** 流程狀態：順序即 sortOrder，第一個為初始、最後一個為終止。 */
const DEFAULT_STATES = ['待處理', '處理中', '審查中', '已完成'] as const;

/**
 * 預設流程轉換：待處理→處理中→審查中→已完成的正向鏈，加審查中→處理中的退回路徑。
 * 沒有退回路徑，審查不過的工單會卡死無路可走。不開放其他跳躍——待處理直接到
 * 已完成正是要拆掉的舊行為。四條轉換皆不限角色、無額外必填欄位，不預先發明
 * 沒人要求的限制；終止狀態須提供結案原因由 validateStatusTransition 統一把關。
 */
const DEFAULT_TRANSITIONS: readonly WorkflowTransitionInput[] = [
  { fromState: '待處理', toState: '處理中', requiredRole: null, requiredFields: [] },
  { fromState: '處理中', toState: '審查中', requiredRole: null, requiredFields: [] },
  { fromState: '審查中', toState: '已完成', requiredRole: null, requiredFields: [] },
  { fromState: '審查中', toState: '處理中', requiredRole: null, requiredFields: [] },
];

/** 沿用 spec 標準結案原因（no7_issue_model.md 的 StandardResolutionOptions）。 */
const DEFAULT_RESOLUTIONS: readonly string[] = ['已完成', '不做'];

export interface TypeWorkflowResult {
  readonly states: readonly WorkflowState[];
  readonly transitions: readonly WorkflowTransition[];
  readonly resolutionOptions: readonly ResolutionOption[];
}

/**
 * 初始化一個工單型別的流程定義：帶複製來源時全份複製，否則帶入預設最小流程。
 * 對應 Spec：WorkflowLogic 的 initializeTypeWorkflow。三張表同交易內清空重建，
 * `exec` 須為交易中的連線（轉換對狀態有外鍵，見 replaceWorkflowTransitions）。
 *
 * 預設結案原因統一落 system=false：目前沒有任何畫面依此欄位分流結案原因的
 * 編輯權限，不論走預設或複製都不代入使用者無法理解的差異狀態。
 */
export async function initializeTypeWorkflow(
  companyId: string,
  issueTypeId: string,
  sourceTypeId: string | undefined,
  exec: Executor,
): Promise<TypeWorkflowResult> {
  let stateInputs: readonly WorkflowStateInput[];
  let transitionInputs: readonly WorkflowTransitionInput[];
  let resolutionInputs: readonly ResolutionOptionInput[];

  if (sourceTypeId !== undefined) {
    const [sourceStates, sourceTransitions, sourceResolutions] = await Promise.all([
      listWorkflowStates(companyId, sourceTypeId, exec),
      listWorkflowTransitions(companyId, sourceTypeId, exec),
      listResolutionOptions(companyId, sourceTypeId, exec),
    ]);
    stateInputs = sourceStates.map(({ name, sortOrder, isInitial, isTerminal }) => ({
      name,
      sortOrder,
      isInitial,
      isTerminal,
    }));
    transitionInputs = sourceTransitions.map(({ fromState, toState, requiredRole, requiredFields }) => ({
      fromState,
      toState,
      requiredRole,
      requiredFields,
    }));
    resolutionInputs = sourceResolutions.map(({ value, sortOrder, system }) => ({
      value,
      sortOrder,
      system,
    }));
  } else {
    stateInputs = DEFAULT_STATES.map((name, index) => ({
      name,
      sortOrder: index,
      isInitial: index === 0,
      isTerminal: index === DEFAULT_STATES.length - 1,
    }));
    transitionInputs = DEFAULT_TRANSITIONS;
    resolutionInputs = DEFAULT_RESOLUTIONS.map((value, index) => ({
      value,
      sortOrder: index + 1,
      system: false,
    }));
  }

  const states = await replaceWorkflowStates(companyId, issueTypeId, stateInputs, exec);
  const transitions = await replaceWorkflowTransitions(companyId, issueTypeId, transitionInputs, exec);
  const resolutionOptions = await replaceResolutionOptions(companyId, issueTypeId, resolutionInputs, exec);
  return { states, transitions, resolutionOptions };
}

// ============================================================
// 工單欄位單值 (IssueFieldValues)
// ============================================================

export async function listFieldValues(
  companyId: string,
  issueId: string,
  exec: Executor = getPool(),
): Promise<StoredFieldValue[]> {
  const rows = await run<FieldValueRow>(
    exec,
    `SELECT company_id, issue_id, field_name, value, rollup_mode
     FROM issue_field_values WHERE company_id = $1 AND issue_id = $2 ORDER BY field_name`,
    [companyId, issueId],
  );
  return rows.map(toFieldValue);
}

export async function getFieldValue(
  companyId: string,
  issueId: string,
  fieldName: string,
  exec: Executor = getPool(),
): Promise<StoredFieldValue | undefined> {
  const row = await runOne<FieldValueRow>(
    exec,
    `SELECT company_id, issue_id, field_name, value, rollup_mode
     FROM issue_field_values WHERE company_id = $1 AND issue_id = $2 AND field_name = $3`,
    [companyId, issueId, fieldName],
  );
  return row ? toFieldValue(row) : undefined;
}

/**
 * 寫入或覆蓋工單的單一欄位值。
 *
 * 以 (issue_id, field_name) 為主鍵做 upsert；`value` 以 jsonb 儲存、不得為 undefined。
 * `rollupMode` 僅可彙總欄位使用，其餘傳 null。
 */
export async function setFieldValue(
  input: {
    readonly companyId: string;
    readonly issueId: string;
    readonly fieldName: string;
    readonly value: unknown;
    readonly rollupMode?: RollupMode | null;
  },
  exec: Executor = getPool(),
): Promise<StoredFieldValue> {
  const row = await runOne<FieldValueRow>(
    exec,
    `INSERT INTO issue_field_values (company_id, issue_id, field_name, value, rollup_mode)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (issue_id, field_name)
     DO UPDATE SET value = EXCLUDED.value, rollup_mode = EXCLUDED.rollup_mode
     RETURNING company_id, issue_id, field_name, value, rollup_mode`,
    [
      input.companyId,
      input.issueId,
      input.fieldName,
      JSON.stringify(input.value),
      input.rollupMode ?? null,
    ],
  );
  return toFieldValue(row!);
}

export async function deleteFieldValue(
  companyId: string,
  issueId: string,
  fieldName: string,
  exec: Executor = getPool(),
): Promise<boolean> {
  const rows = await run<FieldValueRow>(
    exec,
    `DELETE FROM issue_field_values
     WHERE company_id = $1 AND issue_id = $2 AND field_name = $3 RETURNING field_name`,
    [companyId, issueId, fieldName],
  );
  return rows.length > 0;
}
