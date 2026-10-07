// API 對外型別 · 與後端回應形狀逐名對齊
//
// 單一真相：前端所有畫面與資料層只引用本檔的型別，不各自重造。
// 形狀對應後端路由的 send 內容（packages/server/src/api/routes/*）。

/** 對外帳號投影，永不含密碼雜湊。對齊 auth service 的 PublicAccount。 */
export interface Account {
  readonly id: string;
  readonly companyId: string;
  readonly name: string;
  readonly email: string;
}

/** 一份工作日曆。對齊 calendarRepo 的 WorkCalendar；前端只需要 name 給 Select 用，仍保留完整形狀對齊後端。 */
export interface WorkCalendar {
  readonly companyId: string;
  readonly name: string;
  readonly weeklyOff: readonly string[];
  readonly exceptions: readonly { readonly date: string; readonly isWorking: boolean }[];
}

/** 公司。對齊 containerRepo 的 Company。 */
export interface Company {
  readonly id: string;
  readonly name: string;
}

/** 工作區脈絡：登入後啟動點回傳，含工單集、型別、流程狀態與結案原因選項。 */
export interface WorkspaceContext {
  readonly company: Company;
  readonly issueSet: { readonly id: string; readonly name: string; readonly key: string };
  readonly issueType: { readonly id: string; readonly name: string; readonly label: string };
  readonly statuses: readonly WorkspaceStatus[];
  readonly resolutionOptions: readonly WorkspaceResolutionOption[];
}

/** 流程狀態：name 即看板欄與清單狀態的識別，isTerminal 決定是否為結案欄。 */
export interface WorkspaceStatus {
  readonly name: string;
  readonly isTerminal: boolean;
}

/** 結案原因選項：getResolutionOptions 的產出投影。 */
export interface WorkspaceResolutionOption {
  readonly value: string;
}

/** 工單 + 欄位單值摺疊而成的加值列。三個畫面共用的工單資料形狀。 */
export interface WorkspaceIssue {
  readonly restrictedFields?: readonly string[];
  readonly fields?: Readonly<Record<string, unknown>>;
  readonly id: string;
  readonly issueTypeId: string;
  readonly key: string;
  readonly title: string;
  readonly status: string;
  readonly assignee: string;
  readonly point: number | null;
  readonly due: string | null;
  readonly resolution: string | null;
}

/** 建立工單的輸入。 */
export interface CreateIssueInput {
  readonly issueSetId?: string;
  readonly issueTypeId?: string;
  readonly title: string;
  readonly status?: string;
  readonly assignee?: string;
  readonly point?: number;
  readonly due?: string;
}

/** 更新工單欄位的輸入；帶到的欄位就寫、null 清除、未帶不動。resolution 只能隨一次真正的 status 轉換一併提供。 */
export interface UpdateIssueInput {
  readonly title?: string;
  readonly status?: string;
  readonly resolution?: string;
  readonly assignee?: string | '';
  readonly point?: number | null;
  readonly due?: string | null;
}

/** 團隊。對齊 containerRepo 的 Team。 */
export interface Team {
  readonly id: string;
  readonly companyId: string;
  readonly name: string;
}

/** 產品。對齊 containerRepo 的 Product。 */
export interface Product {
  readonly id: string;
  readonly companyId: string;
  readonly teamId: string;
  readonly name: string;
}

/** 管理域。對齊 containerRepo 的 Mgmt。 */
export interface Mgmt {
  readonly id: string;
  readonly companyId: string;
  readonly productId: string;
  readonly name: string;
  readonly containerIssueSetId: string;
}

export interface IssueSet {
  readonly id: string;
  readonly companyId: string;
  readonly mgmtId: string;
  readonly name: string;
  readonly key: string;
}

export interface OrganizationMgmt extends Mgmt {
  readonly canStructure: boolean;
  readonly issueSets: readonly IssueSet[];
}

export interface OrganizationProduct extends Product {
  readonly canStructure: boolean;
  readonly mgmts: readonly OrganizationMgmt[];
}

export interface OrganizationTeam extends Team {
  readonly products: readonly OrganizationProduct[];
}

export interface Organization {
  readonly id: string;
  readonly name: string;
  readonly orgAdmin: boolean;
  readonly teams: readonly OrganizationTeam[];
}

export interface IssueCreationOptions {
  readonly issueSets: readonly { readonly id: string; readonly label: string; readonly key: string }[];
  readonly issueTypes: readonly IssueTypeDefinition[];
}

/** 檢視。對齊 viewRepo 的 View。 */
export interface View {
  readonly id: string;
  readonly companyId: string;
  readonly name: string;
  readonly ownerId: string;
  readonly viewType: string;
  readonly sourceMgmtIds: readonly string[];
  readonly filterConfig: unknown;
  readonly displayLevel: number;
  readonly columnConfig: unknown;
  readonly calendarName: string | null;
}

/** 建立檢視的輸入：資料來源以組織範圍表示，展開由後端 expandDataSource 執行。calendarName 留空即跟隨帳號預設日曆。 */
export interface CreateViewInput {
  readonly name: string;
  readonly scopeType: 'team' | 'product' | 'mgmt';
  readonly scopeId: string;
  readonly calendarName?: string;
}

/** 更新檢視的輸入：帶到的欄位就寫、未帶不動，對齊後端 PATCH /api/views/:id 的 body 契約。 */
export interface UpdateViewInput {
  readonly columnConfig?: unknown;
  readonly filterConfig?: unknown;
  readonly calendarName?: string | null;
  readonly displayLevel?: number;
}

/** 甘特橫軸的一個日曆天。對齊 devOrderGantt.ts 的 GanttDay，後端一律回滿八個欄位。 */
export interface GanttDay {
  readonly key: string;
  readonly dayNumber: number;
  readonly weekdayLabel: string;
  readonly monthLabel: string;
  readonly isHoliday: boolean;
  readonly isMonthStart: boolean;
  readonly isWeekStart: boolean;
  readonly isToday: boolean;
}

/** 工單起訖日換算成時間軸格子座標。對齊 devOrderGantt.ts 的 GanttBarSpan；無 overrun 欄位。 */
export interface GanttBarSpan {
  readonly start: number;
  readonly span: number;
}

/** 單一顯示層級的甘特長條集合。bars 為 null 代表該主題單在此層級無內容。 */
export interface DevOrderLevelGroup {
  readonly level: number;
  readonly bars: readonly GanttBarSpan[] | null;
}

/** 工單工期。對齊 domain/view/types.ts 的 IssueDuration；MVP 種子資料無 StartTime，目前恆為 hasDuration:false。 */
export type IssueDuration =
  | { readonly hasDuration: true; readonly days: number; readonly unit: 'workingDay' | 'calendarDay' }
  | { readonly hasDuration: false };

/** 主題單清單的一列，帶三個顯示層級（主題/需求/工項）一次算好的甘特座標。 */
export interface TopicIssueRow {
  readonly id: string;
  readonly key: string;
  readonly title: string;
  readonly duration: IssueDuration;
  readonly levels: readonly DevOrderLevelGroup[];
}

/** 檢視主題單視角內容：/api/views/:id/issues 回應，供 DevOrderScreen 使用。 */
export interface DevOrderIssuesResult {
  readonly sortedIssues: readonly TopicIssueRow[];
  readonly unsortedIssues: readonly TopicIssueRow[];
  readonly calendarName: string | null;
  readonly excludedCount: number;
  readonly permissionExcludedCount: number;
  readonly days: readonly GanttDay[];
}

/** 檢視內一筆手動排序項。對齊 viewRepo 的 ViewSortEntry。 */
export interface ViewSortEntry {
  readonly id: string;
  readonly companyId: string;
  readonly viewId: string;
  readonly issueId: string;
  readonly sortValue: number;
}

/** 檢視資料來源範圍內的完整欄位工單列：/api/views/:id/workspace-issues 回應，供 ListScreen／KanbanScreen 使用。 */
export interface WorkspaceIssuesResult {
  readonly issues: readonly WorkspaceIssue[];
  readonly excludedCount: number;
  readonly permissionExcludedCount: number;
}

// ─── 工單詳情頁：基本識別、欄位定義、關聯、異動歷史 ──────────
// 供 IssueDetailScreen 使用。對齊後端 fieldRepo／issueRepo／relationRepo／
// domain 的同名實體；relations.ts／issues.ts／fields.ts 三個 API 檔共用。

/** 工單基本識別，不含欄位值。對齊 issueRepo／domain 的 Issue。 */
export interface IssueSummary {
  readonly id: string;
  readonly companyId: string;
  readonly issueSetId: string;
  readonly issueTypeId: string;
  readonly issueKey: string;
}

/** 欄位定義：label／readonly／kind 等中繼資料。對齊 fieldRepo 的 FieldDef。 */
export interface FieldDef {
  readonly companyId: string;
  readonly name: string;
  readonly fieldSetName: string;
  readonly kind: 'single' | 'multi' | 'relation';
  readonly valueType: string;
  readonly system: boolean;
  /** 為真代表值由系統寫入，使用者不可編輯。 */
  readonly readonly: boolean;
  readonly rollupable: boolean;
  readonly rollupFn: 'earliest' | 'latest' | 'sum' | null;
  /** 為真的欄位每次異動寫進變更歷史。 */
  readonly tracked: boolean;
  readonly label: string;
}

/** 欄位組定義。對齊 fieldRepo 的 FieldSetDef。供 TypeDefinitionScreen 使用。 */
export interface FieldSetDef {
  readonly companyId: string;
  readonly name: string;
  /** 為真代表系統內建，不可刪除。 */
  readonly system: boolean;
}

/** 工單型別定義。對齊 issueRepo 的 IssueTypeDefinition。供 TypeDefinitionScreen 使用。 */
export interface IssueTypeDefinition {
  readonly id: string;
  readonly companyId: string;
  readonly name: string;
  readonly label: string;
  readonly fieldSets: readonly string[];
  readonly system: boolean;
}

/** 流程狀態。對齊 issueRepo 的 WorkflowState。供流程轉換規則管理使用。 */
export interface WorkflowState {
  readonly companyId: string;
  readonly issueTypeId: string;
  readonly name: string;
  readonly sortOrder: number;
  readonly isInitial: boolean;
  readonly isTerminal: boolean;
}

/** 流程轉換。對齊 issueRepo 的 WorkflowTransition。 */
export interface WorkflowTransition {
  readonly companyId: string;
  readonly issueTypeId: string;
  readonly fromState: string;
  readonly toState: string;
  /** 執行者角色限定；null 代表不限角色。 */
  readonly requiredRole: string | null;
  /** 必填欄位名稱清單；空清單代表無必填。 */
  readonly requiredFields: readonly string[];
}

/** 結案原因選項。對齊 issueRepo 的 ResolutionOption。 */
export interface ResolutionOption {
  readonly companyId: string;
  readonly issueTypeId: string;
  readonly value: string;
  readonly sortOrder: number;
  readonly system: boolean;
}

/** 單一型別的完整流程定義，GET /:id/workflow 的回傳形狀。 */
export interface WorkflowDefinition {
  readonly states: readonly WorkflowState[];
  readonly transitions: readonly WorkflowTransition[];
  readonly resolutionOptions: readonly ResolutionOption[];
}

/** PUT /:id/workflow 的輸入：三清單整包替換，比照後端 WorkflowPutBody 契約。 */
export interface UpdateWorkflowDefinitionInput {
  readonly states: readonly { name: string; isInitial: boolean; isTerminal: boolean }[];
  readonly transitions: readonly {
    fromState: string;
    toState: string;
    requiredRole: string | null;
    requiredFields: readonly string[];
  }[];
  readonly resolutionOptions: readonly { value: string }[];
}

/** 工單單一欄位值。對齊 issueRepo 的 StoredFieldValue。 */
export interface IssueFieldValue {
  readonly restricted?: boolean;
  readonly companyId: string;
  readonly issueId: string;
  readonly fieldName: string;
  readonly value: unknown;
  readonly rollupMode: 'auto' | 'manual' | null;
}

/** 一筆變更歷史：對齊 domain 的 ChangeLogEntry，另帶 id 供列表 key 使用。 */
export interface ChangeLogEntry {
  readonly restricted?: boolean;
  readonly id: string;
  readonly fieldName: string;
  readonly oldValue: unknown;
  readonly newValue: unknown;
  readonly actor: string;
  readonly time: number;
}

/** 關聯型別定義。對齊 domain 的 RelationTypeDefinition。 */
export interface RelationTypeDefinition {
  readonly id: string;
  readonly companyId: string;
  readonly name: string;
  readonly exclusive: boolean;
  readonly acyclic: boolean;
  readonly ordered: boolean;
  /** 為真時關聯無方向，正反查詢視為同一關係。 */
  readonly symmetric: boolean;
  readonly rollup: boolean;
  readonly system: boolean;
  readonly createdOn: number;
  readonly updatedOn: number;
}

/** 工單關聯。對齊 domain 的 IssueRelation；只存持有端一側，正反查見 relations.ts。 */
export interface IssueRelation {
  readonly counterpartKey?: string;
  readonly counterpartReadable?: boolean;
  readonly canRemove?: boolean;
  readonly id: string;
  readonly companyId: string;
  readonly fromIssueId: string;
  readonly toIssueId: string;
  readonly relationTypeId: string;
  readonly ordinal: number;
  readonly exclusive: boolean;
  readonly createdOn: number;
  readonly updatedOn: number;
}

export interface WorkLogRecord {
  readonly id: string;
  readonly value: number;
  readonly authorId: string;
  readonly createdOn: number;
}

export interface RollupStatus {
  readonly fieldName: string;
  readonly mode: 'auto' | 'manual';
  readonly hasChildren: boolean;
  readonly value: string | number | null;
  readonly restricted?: boolean;
  readonly deviation: { readonly deviated: false } | {
    readonly deviated: true;
    readonly delta: number;
    readonly unit: 'calendarDay' | 'workingDay' | 'point';
    readonly calendarName: string | null;
    readonly mainValue: string | number;
    readonly rollupValue: string | number;
  };
}

export interface IssueContext {
  readonly canEdit: boolean;
  readonly canArchive: boolean;
  readonly calendarName: string | null;
  readonly rollups: readonly RollupStatus[];
  readonly worklogs: readonly WorkLogRecord[];
}
