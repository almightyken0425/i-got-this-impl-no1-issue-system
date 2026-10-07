import type { ResolvedIdentity } from '../auth/service.js';
import type { Executor } from '../db/repositories/executor.js';
import { containerRepo, fieldRepo, permissionRepo } from '../db/repositories/index.js';
import { readIssueRecipes, readSnapshot } from '../db/repositories/rollupRepo.js';
import { buildContainerIndex, computeEffectivePermission } from '../permission/index.js';

/** 完整圖維護總值，讀取端遮蔽含不可讀來源的彙總，不把部分值冒充總值。 */
export async function createIssueReadProjection(exec: Executor, identity: ResolvedIdentity) {
  const { companyId, accountId } = identity;
  const [tree, bundles, recipes, snapshot, defs] = await Promise.all([
    containerRepo.getContainerTree(companyId, exec),
    permissionRepo.getEffectivePermissionInputs(exec, companyId, accountId),
    readIssueRecipes(exec, companyId), readSnapshot(exec, companyId), fieldRepo.listFieldDefs(companyId, exec),
  ]);
  const index = buildContainerIndex(tree ?? { id: companyId, name: '', teams: [] });
  const readableSets = new Set<string>();
  for (const team of tree?.teams ?? []) for (const product of team.products) for (const mgmt of product.mgmts) {
    if (computeEffectivePermission(bundles, index, { kind: 'mgmt', id: mgmt.id }).canRead) {
      for (const set of mgmt.issueSets) readableSets.add(set.id);
    }
  }
  const canRead = (id: string) => readableSets.has(recipes.get(id)?.issueSetId ?? '');
  const rollupNames = new Set(defs.filter((field) => field.rollupable).map((field) => field.name));
  const rollupTypes = new Set(snapshot.relationTypes.filter((type) => type.rollup).map((type) => type.id));
  const holders = new Map<string, string[]>();
  const history = await exec.query<{ fromIssueId: string; toIssueId: string }>(
    'SELECT holder_id AS "fromIssueId", source_id AS "toIssueId" FROM rollup_access_sources WHERE company_id = $1', [companyId]);
  for (const edge of history.rows) holders.set(edge.toIssueId, [...holders.get(edge.toIssueId) ?? [], edge.fromIssueId]);
  for (const edge of snapshot.relations) {
    if (!rollupTypes.has(edge.relationTypeId)) continue;
    holders.set(edge.toIssueId, [...holders.get(edge.toIssueId) ?? [], edge.fromIssueId]);
  }
  const restricted = new Set([...recipes.keys()].filter((id) => !canRead(id)));
  const queue = [...restricted];
  for (let i = 0; i < queue.length; i++) for (const holder of holders.get(queue[i]!) ?? []) {
    if (!restricted.has(holder)) { restricted.add(holder); queue.push(holder); }
  }
  const restrictedField = (issueId: string, fieldName: string) => restricted.has(issueId) && rollupNames.has(fieldName);
  const inRecipe = (issueId: string, fieldName: string) => ['CreateBy', 'Archived'].includes(fieldName) ||
    recipes.get(issueId)?.fieldSets.includes(defs.find((field) => field.name === fieldName)?.fieldSetName ?? '') === true;
  const fields = (issueId: string, input: Readonly<Record<string, unknown>>) => Object.fromEntries(
    Object.entries(input).filter(([name]) => inRecipe(issueId, name)).map(([name, value]) => [name, restrictedField(issueId, name) ? null : value]));
  const restrictedFields = (issueId: string) => [...rollupNames].filter(name => inRecipe(issueId, name) && restrictedField(issueId, name));
  return { canRead, restricted, restrictedField, restrictedFields, inRecipe, fields };
}

export type IssueReadProjection = Awaited<ReturnType<typeof createIssueReadProjection>>;
