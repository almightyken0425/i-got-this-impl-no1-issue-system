import { viewsApi, workflowApi, workspaceApi } from '../../api';
import type { WorkflowDefinition, WorkspaceIssue } from '../../api';

export interface KanbanIssue extends WorkspaceIssue {
  readonly workflow: WorkflowDefinition;
}

export interface KanbanData {
  readonly columns: readonly string[];
  readonly issues: readonly KanbanIssue[];
  readonly permissionExcludedCount: number;
}

export function isTerminalStatus(issue: KanbanIssue, status: string): boolean {
  return issue.workflow.states.some((state) => state.name === status && state.isTerminal);
}

export async function loadKanbanData(viewId: string): Promise<KanbanData> {
  await workspaceApi.getWorkspace();
  const [columns, workspaceIssues] = await Promise.all([
    workspaceApi.getKanbanColumns(),
    viewsApi.getWorkspaceIssues(viewId),
  ]);
  const typeIds = [...new Set(workspaceIssues.issues.map((issue) => issue.issueTypeId))];
  const workflows = new Map(await Promise.all(typeIds.map(async (id) =>
    [id, await workflowApi.getWorkflowDefinition(id)] as const,
  )));
  return {
    columns,
    issues: workspaceIssues.issues.map((issue) => ({
      ...issue,
      // typeIds 與 workflows 由同一批工單產生，讀取失敗會使整次載入失敗。
      workflow: workflows.get(issue.issueTypeId)!,
    })),
    permissionExcludedCount: workspaceIssues.permissionExcludedCount,
  };
}
