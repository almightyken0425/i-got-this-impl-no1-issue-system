import { randomUUID } from 'node:crypto';
import { computeRollupValue, evaluateDeviation, findSubordinateIds, recordFieldChange, resolveEffectiveMode } from '../../domain/index.js';
import type { RollupMode, RollupSnapshot, WorkCalendar } from '../../domain/index.js';
import { containerRepo, fieldRepo, issueRepo, relationRepo } from './index.js';
import type { Executor } from './executor.js';

export class FieldWriteError extends Error {
  readonly statusCode = 422;
  constructor(readonly code: string, message: string) { super(message); }
}

export async function readIssueRecipes(exec: Executor, companyId: string) {
  const result = await exec.query<{ id: string; issueSetId: string; fieldSets: string[] }>(
    `SELECT i.id, i.issue_set_id AS "issueSetId", t.field_sets AS "fieldSets"
     FROM issues i JOIN issue_type_definitions t ON t.id = i.issue_type_id AND t.company_id = i.company_id
     WHERE i.company_id = $1`, [companyId]);
  return new Map(result.rows.map((row) => [row.id, row]));
}

/** 同一交易內取有效工單圖。封存工單保留資料，但不再作為彙總來源。 */
export async function readSnapshot(exec: Executor, companyId: string): Promise<RollupSnapshot> {
  const active = await exec.query<{ id: string }>(`SELECT id FROM issues i WHERE company_id = $1
    AND NOT EXISTS (SELECT 1 FROM issue_field_values v WHERE v.company_id = i.company_id
      AND v.issue_id = i.id AND v.field_name = 'Archived' AND v.value = 'true'::jsonb)`, [companyId]);
  const ids = active.rows.map((row) => row.id);
  const relationTypes = await relationRepo.listRelationTypes(companyId, exec);
  const fieldDefs = await fieldRepo.listFieldDefs(companyId, exec);
  const recipes = await readIssueRecipes(exec, companyId);
  const fieldSetByName = new Map(fieldDefs.map((field) => [field.name, field.fieldSetName]));
  const inRecipe = (issueId: string, fieldName: string) => recipes.get(issueId)?.fieldSets.includes(fieldSetByName.get(fieldName) ?? '') === true;
  const edges = await exec.query<{ fromIssueId: string; toIssueId: string; relationTypeId: string }>(
    `SELECT from_issue_id AS "fromIssueId", to_issue_id AS "toIssueId", relation_type_id AS "relationTypeId"
     FROM issue_relations WHERE company_id = $1 AND from_issue_id = ANY($2::uuid[]) AND to_issue_id = ANY($2::uuid[])`, [companyId, ids]);
  const values = await exec.query<{ issueId: string; fieldName: string; value: unknown; rollupMode: RollupMode | null }>(
    `SELECT issue_id AS "issueId", field_name AS "fieldName", value, rollup_mode AS "rollupMode"
     FROM issue_field_values WHERE company_id = $1 AND issue_id = ANY($2::uuid[])`, [companyId, ids]);
  const records = await exec.query<{ id: string; issueId: string; fieldName: string; value: number }>(
    `SELECT id, issue_id AS "issueId", field_name AS "fieldName", value
     FROM issue_field_records WHERE company_id = $1 AND field_name = 'WorkLog' AND issue_id = ANY($2::uuid[])`, [companyId, ids]);
  return {
    companyId, relationTypes, fieldDefs,
    relations: edges.rows.map((row) => ({ companyId, ...row })),
    fieldValues: values.rows.filter((row) => inRecipe(row.issueId, row.fieldName)).flatMap((row) => typeof row.value === 'string' || typeof row.value === 'number' || row.value === null
      ? [{ ...row, value: row.value, companyId }] : []),
    fieldRecords: records.rows.filter((row) => inRecipe(row.issueId, row.fieldName) && typeof row.value === 'number').map((row) => ({ companyId, ...row })),
  };
}

async function writeTracked(exec: Executor, companyId: string, issueId: string, fieldName: string, value: unknown, actor: string, rollupMode: RollupMode | null) {
  const old = await issueRepo.getFieldValue(companyId, issueId, fieldName, exec);
  const written = await issueRepo.setFieldValue({ companyId, issueId, fieldName, value, rollupMode }, exec);
  const fieldDefs = await fieldRepo.listFieldDefs(companyId, exec);
  const entries = recordFieldChange({ changes: [{ fieldName, oldValue: old?.value ?? null, newValue: value }], actor, now: Date.now(), fieldDefs });
  for (const entry of entries) await fieldRepo.appendChangeLog({ id: randomUUID(), companyId, issueId, entry, authorId: actor, createdOn: entry.time }, exec);
  return written;
}

/** 呼叫端先鎖 Company，再異動來源。依子至父排序，手動值保持不動。 */
export async function refreshRollups(exec: Executor, companyId: string, actor: string): Promise<void> {
  await exec.query(`INSERT INTO rollup_access_sources (company_id, holder_id, source_id)
    SELECT r.company_id, r.from_issue_id, r.to_issue_id FROM issue_relations r
    JOIN relation_type_definitions t ON t.company_id = r.company_id AND t.id = r.relation_type_id
    WHERE r.company_id = $1 AND t.rollup = true ON CONFLICT DO NOTHING`, [companyId]);
  const snapshot = await readSnapshot(exec, companyId);
  const fields = snapshot.fieldDefs.filter((field) => field.rollupable && field.rollupFn !== null && field.name !== 'WorkLog');
  const recipes = await readIssueRecipes(exec, companyId);
  const fieldDefs = await fieldRepo.listFieldDefs(companyId, exec);
  const ids = new Set([...snapshot.relations.flatMap((edge) => [edge.fromIssueId, edge.toIssueId]),
    ...snapshot.fieldValues.filter((row) => row.rollupMode !== null).map((row) => row.issueId)]);
  const complete = new Set<string>();
  const visiting = new Set<string>();
  async function visit(issueId: string): Promise<void> {
    if (complete.has(issueId)) return;
    if (visiting.has(issueId)) throw new FieldWriteError('RELATION_CYCLE', '彙總關聯不可成環');
    visiting.add(issueId);
    const children = findSubordinateIds(snapshot, issueId);
    for (const child of children) await visit(child);
    for (const field of fields) {
      const set = fieldDefs.find((def) => def.name === field.name)?.fieldSetName;
      if (!set || !recipes.get(issueId)?.fieldSets.includes(set)) continue;
      const index = snapshot.fieldValues.findIndex((row) => row.issueId === issueId && row.fieldName === field.name);
      const current = snapshot.fieldValues[index];
      if (children.length === 0 && current?.rollupMode !== 'auto') continue;
      const mode = resolveEffectiveMode(snapshot, issueId, field.name);
      const value = mode === 'auto' ? computeRollupValue(snapshot, issueId, field.name) : current?.value ?? null;
      if (current?.value !== value || current?.rollupMode !== mode) {
        await writeTracked(exec, companyId, issueId, field.name, value, actor, mode);
        const next = { companyId, issueId, fieldName: field.name, value, rollupMode: mode };
        if (index < 0) snapshot.fieldValues.push(next); else snapshot.fieldValues[index] = next;
      }
    }
    visiting.delete(issueId);
    complete.add(issueId);
  }
  for (const id of ids) await visit(id);
}

export async function writeField(exec: Executor, companyId: string, issueId: string, fieldName: string,
  value: unknown, actor: string, requestedMode?: RollupMode | null) {
  await containerRepo.lockCompanyForUpdate(companyId, exec);
  const def = await fieldRepo.findFieldDef(companyId, fieldName, exec);
  if (def === undefined) throw new FieldWriteError('FIELD_NOT_DEFINED', '該欄位未在此 Company 定義');
  const recipe = (await readIssueRecipes(exec, companyId)).get(issueId);
  if (!recipe?.fieldSets.includes(def.fieldSetName) || def.kind !== 'single') {
    throw new FieldWriteError('FIELD_NOT_IN_RECIPE', '此型別沒有這個單值欄位');
  }
  let mode: RollupMode | null = null;
  if (def.rollupable) {
    const snapshot = await readSnapshot(exec, companyId);
    const hasChildren = findSubordinateIds(snapshot, issueId).length > 0;
    if (fieldName === 'WorkLog') throw new FieldWriteError('WORKLOG_MODE_LOCKED', '工時請由填報記錄維護');
    mode = hasChildren ? requestedMode ?? resolveEffectiveMode(snapshot, issueId, fieldName) : 'manual';
    if (hasChildren && mode === 'auto') {
      if (requestedMode !== 'auto') throw new FieldWriteError('AUTO_FIELD_READONLY', '自動彙總欄位不可直接修改');
      value = computeRollupValue(snapshot, issueId, fieldName);
    }
    if (value !== null && ((def.rollupFn === 'sum' && (typeof value !== 'number' || !Number.isFinite(value))) ||
      (def.rollupFn !== 'sum' && (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value) || Number.isNaN(Date.parse(value)))))) {
      throw new FieldWriteError('INVALID_FIELD_VALUE', '彙總欄位需要有效日期或數字');
    }
  } else if (requestedMode != null) {
    throw new FieldWriteError('FIELD_NOT_ROLLUPABLE', '此欄位不支援彙總模式');
  }
  const written = await writeTracked(exec, companyId, issueId, fieldName, value, actor, mode);
  if (def.rollupable) await refreshRollups(exec, companyId, actor);
  return written;
}

export async function readRollupStatus(exec: Executor, companyId: string, issueId: string, calendar: WorkCalendar | null) {
  const snapshot = await readSnapshot(exec, companyId);
  const issue = await issueRepo.getIssue(companyId, issueId, exec);
  const type = issue && await issueRepo.getIssueType(companyId, issue.issueTypeId, exec);
  const defs = await fieldRepo.listFieldDefs(companyId, exec);
  const names = new Set(defs.filter((field) => type?.fieldSets.includes(field.fieldSetName)).map((field) => field.name));
  return snapshot.fieldDefs.filter((field) => field.rollupable && field.rollupFn !== null && names.has(field.name)).map((field) => {
    const mode = resolveEffectiveMode(snapshot, issueId, field.name);
    const hasChildren = findSubordinateIds(snapshot, issueId).length > 0;
    return {
      fieldName: field.name, mode, hasChildren,
      value: field.name === 'WorkLog' && !hasChildren
        ? snapshot.fieldRecords.filter((row) => row.issueId === issueId && row.fieldName === 'WorkLog').reduce((sum, row) => sum + row.value, 0)
        : computeRollupValue(snapshot, issueId, field.name),
      deviation: mode === 'manual' && hasChildren ? evaluateDeviation(snapshot, issueId, field.name, calendar) : { deviated: false },
    };
  });
}

export async function assertWorkLogWritable(exec: Executor, companyId: string, issueId: string) {
  const issue = await issueRepo.getIssue(companyId, issueId, exec);
  const type = issue && await issueRepo.getIssueType(companyId, issue.issueTypeId, exec);
  const def = await fieldRepo.findFieldDef(companyId, 'WorkLog', exec);
  if (!def || !type?.fieldSets.includes(def.fieldSetName)) throw new FieldWriteError('WORKLOG_UNAVAILABLE', '此工單型別沒有工時欄位');
  if (findSubordinateIds(await readSnapshot(exec, companyId), issueId).length > 0) {
    throw new FieldWriteError('WORKLOG_HOLDER_READONLY', '持有下級工單時，工時由下級填報彙總');
  }
}
