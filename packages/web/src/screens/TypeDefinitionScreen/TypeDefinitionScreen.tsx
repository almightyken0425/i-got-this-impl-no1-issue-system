// TypeDefinitionScreen · 型別定義畫面
//
// 角色：管理欄位組、欄位定義，與工單型別的欄位組配方。分「欄位」「工單型別」
// 兩個分頁，前者左欄選欄位組、右欄列該組欄位；後者列工單型別與已勾選配方。
//
// 來源：design git 的
// `30_screens/no6_type_definition_screen/no6_type_definition_screen.jsx`。
// 對側 spec：no3_product_specs/no1_issue_system/no2_screens/no6_type_definition_screen.md
//   佈局四段（頁面工具列／欄位組清單／欄位清單／工單型別清單）與互動十條
//   （切換分頁／選取欄位組／新增與刪除欄位組／新增與編輯與刪除欄位／
//   新增工單型別／編輯工單型別配方）逐條對位。
//
// 資料來源：一次抓 listFieldSets + listFieldDefs + listIssueTypes，三支皆為
// 全 Company 範圍查詢，不依賴當前檢視（CurrentViewContext）。

import { useCallback, useMemo, useState } from 'react';

import { ApiError, apiFetch, fieldsApi, issueTypesApi } from '../../api';
import { DefinitionPlanningTabs } from './DefinitionPlanningTabs';
import type { FieldDef, FieldSetDef, IssueTypeDefinition } from '../../api';
import { Button } from '../../components/controls';
import { DataTable, EmptyState } from '../../components/data';
import type { TableColumn, TableRow } from '../../components/data';
import { Toolbar, LevelSwitcher } from '../../components/gantt';
import { useAsync } from '../../hooks/useAsync';
import { FONT_FAMILY, useTheme } from '../../theme';
import {
  EditFieldLabelForm,
  EditIssueTypeRecipeForm,
  FieldForm,
  FieldSetRow,
  IssueTypeForm,
  NewFieldSetForm,
  type NewFieldInput,
  type NewIssueTypeInput,
} from './internal';
import { TYPE_DEFINITION_SCREEN_TOKENS as TD } from './tokens';

const TABS = [
  { id: 'fields', label: '欄位' },
  { id: 'types', label: '工單型別' },
  { id: 'relations', label: '關聯型別' },
  { id: 'calendars', label: '工作日曆' },
] as const;

const KIND_LABEL: Record<FieldDef['kind'], string> = { single: '單值', multi: '多筆', relation: '關聯' };
const ROLLUP_FN_LABEL: Record<'earliest' | 'latest' | 'sum', string> = {
  earliest: '最早',
  latest: '最晚',
  sum: '加總',
};

interface TypeDefinitionData {
  readonly typeAdmin: boolean;
  readonly fieldSets: readonly FieldSetDef[];
  readonly fieldDefs: readonly FieldDef[];
  readonly issueTypes: readonly IssueTypeDefinition[];
}

function toActionError(error: unknown): string {
  return error instanceof ApiError ? error.message : '操作失敗，請重試';
}

export function TypeDefinitionScreen() {
  const { theme } = useTheme();
  const fetcher = useCallback(async (): Promise<TypeDefinitionData> => {
    const [fieldSets, fieldDefs, issueTypes, permission] = await Promise.all([
      fieldsApi.listFieldSets(),
      fieldsApi.listFieldDefs(),
      issueTypesApi.listIssueTypes(),
      apiFetch<{ effective: { typeAdmin: boolean } }>('/api/permissions/effective'),
    ]);
    return { fieldSets, fieldDefs, issueTypes, typeAdmin: permission.effective.typeAdmin };
  }, []);
  const { data, loading, error, reload } = useAsync(fetcher);

  const [tab, setTab] = useState<(typeof TABS)[number]['id']>('fields');
  const [selectedFieldSet, setSelectedFieldSet] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | undefined>(undefined);
  const [submitting, setSubmitting] = useState(false);

  const [showNewFieldSetForm, setShowNewFieldSetForm] = useState(false);
  const [showNewFieldForm, setShowNewFieldForm] = useState(false);
  const [editingFieldName, setEditingFieldName] = useState<string | null>(null);
  const [showNewIssueTypeForm, setShowNewIssueTypeForm] = useState(false);
  const [editingIssueTypeId, setEditingIssueTypeId] = useState<string | null>(null);

  const fieldSets = data?.fieldSets ?? [];
  const fieldDefs = data?.fieldDefs ?? [];
  const issueTypes = data?.issueTypes ?? [];
  const fieldSetNames = useMemo(() => fieldSets.map((fs) => fs.name), [fieldSets]);
  const fieldsInSelectedSet = useMemo(
    () => (selectedFieldSet === null ? [] : fieldDefs.filter((f) => f.fieldSetName === selectedFieldSet)),
    [fieldDefs, selectedFieldSet],
  );

  async function runAction(action: () => Promise<void>): Promise<void> {
    setSubmitting(true);
    setActionError(undefined);
    try {
      await action();
      await reload();
    } catch (err: unknown) {
      setActionError(toActionError(err));
    } finally {
      setSubmitting(false);
    }
  }

  const onCreateFieldSet = (name: string): void => {
    void runAction(async () => {
      await fieldsApi.createFieldSet(name);
      setShowNewFieldSetForm(false);
    });
  };

  const onDeleteFieldSet = (name: string): void => {
    void runAction(async () => {
      await fieldsApi.deleteFieldSet(name);
      if (selectedFieldSet === name) setSelectedFieldSet(null);
    });
  };

  const onCreateField = (input: NewFieldInput): void => {
    if (selectedFieldSet === null) return;
    void runAction(async () => {
      await fieldsApi.createFieldDef({ ...input, fieldSetName: selectedFieldSet });
      setShowNewFieldForm(false);
    });
  };

  const onUpdateFieldLabel = (name: string, label: string): void => {
    void runAction(async () => {
      await fieldsApi.updateFieldLabel(name, label);
      setEditingFieldName(null);
    });
  };

  const onDeleteField = (name: string): void => {
    void runAction(async () => {
      await fieldsApi.deleteFieldDef(name);
    });
  };

  const onCreateIssueType = (input: NewIssueTypeInput): void => {
    void runAction(async () => {
      await issueTypesApi.createIssueType(input);
      setShowNewIssueTypeForm(false);
    });
  };

  const onUpdateIssueTypeRecipe = (issueType: IssueTypeDefinition, fieldSetsSelection: readonly string[]): void => {
    void runAction(async () => {
      await issueTypesApi.updateIssueType(issueType.id, { label: issueType.label, fieldSets: fieldSetsSelection });
      setEditingIssueTypeId(null);
    });
  };

  const fieldColumns: readonly TableColumn[] = [
    { key: 'name', label: '識別名稱', type: 'key' },
    { key: 'label', label: '顯示名稱', type: 'text' },
    { key: 'valueType', label: '值型別', type: 'text' },
    { key: 'kind', label: '形狀', type: 'text' },
    { key: 'tracked', label: '追蹤', type: 'text' },
    { key: 'rollup', label: '可彙總', type: 'text' },
    {
      key: 'actions',
      label: '',
      align: 'right',
      render: (_value, row) => {
        const field = fieldsInSelectedSet.find((f) => f.name === row.id);
        if (field === undefined) return null;
        if (field.system || !data?.typeAdmin) return null;
        if (editingFieldName === field.name) {
          return (
            <EditFieldLabelForm
              initialLabel={field.label}
              onSubmit={(label) => onUpdateFieldLabel(field.name, label)}
              onCancel={() => setEditingFieldName(null)}
              submitting={submitting}
            />
          );
        }
        return (
          <div style={{ display: 'flex', gap: TD.ACTION_GAP, justifyContent: 'flex-end' }}>
            <Button variant="ghost" size="sm" label="編輯" onClick={() => setEditingFieldName(field.name)} />
            <Button variant="ghost" size="sm" label="移除" onClick={() => onDeleteField(field.name)} />
          </div>
        );
      },
    },
  ];

  const fieldRows: readonly TableRow[] = fieldsInSelectedSet.map((f) => ({
    id: f.name,
    cells: {
      name: f.name,
      label: f.label,
      valueType: f.valueType,
      kind: KIND_LABEL[f.kind],
      tracked: f.tracked ? '開' : '',
      rollup: f.rollupable && f.rollupFn !== null ? ROLLUP_FN_LABEL[f.rollupFn] : '',
      system: f.system,
    },
  }));

  const typeColumns: readonly TableColumn[] = [
    { key: 'label', label: '顯示名稱', type: 'text' },
    { key: 'fieldSets', label: '欄位組配方', type: 'text' },
    {
      key: 'actions',
      label: '',
      align: 'right',
      render: (_value, row) => {
        const issueType = issueTypes.find((t) => t.id === row.id);
        if (issueType === undefined || !data?.typeAdmin) return null;
        if (editingIssueTypeId === issueType.id) {
          return (
            <EditIssueTypeRecipeForm
              availableFieldSets={fieldSetNames}
              initialFieldSets={issueType.fieldSets}
              onSubmit={(fs) => onUpdateIssueTypeRecipe(issueType, fs)}
              onCancel={() => setEditingIssueTypeId(null)}
              submitting={submitting}
            />
          );
        }
        return (
          <Button
            variant="ghost"
            size="sm"
            label="編輯配方"
            onClick={() => setEditingIssueTypeId(issueType.id)}
          />
        );
      },
    },
  ];

  const typeRows: readonly TableRow[] = issueTypes.map((t) => ({
    id: t.id,
    cells: { label: t.system ? `${t.label}（系統）` : t.label, fieldSets: t.fieldSets.join('、') },
  }));

  const toolbarLeft = (
    <>
      <span style={{ ...typeStyleFromToken(), color: theme.text.primary, whiteSpace: 'nowrap' }}>型別定義</span>
      <LevelSwitcher levels={[...TABS]} value={tab} onChange={(id) => setTab(id as (typeof TABS)[number]['id'])} ariaLabel="切換分頁" />
    </>
  );

  function typeStyleFromToken() {
    const t = TD.SCREEN_TITLE_TYPE;
    return { fontSize: t.size, fontWeight: t.weight, lineHeight: `${t.lineHeight}px`, fontFamily: FONT_FAMILY.base };
  }

  if (loading) return null;
  if (error !== undefined) {
    return (
      <div style={{ padding: TD.CONTENT_PADDING_Y }}>
        <EmptyState title="型別定義載入失敗" description={error} />
      </div>
    );
  }

  return (
    <div style={{ width: '100%', minHeight: '100%', display: 'flex', flexDirection: 'column', background: theme.bg.base, color: theme.text.primary, fontFamily: FONT_FAMILY.base }}>
      <Toolbar left={toolbarLeft} />

      <div style={{ display: 'flex', flexDirection: 'column', gap: TD.SECTION_GAP, padding: `${TD.CONTENT_PADDING_Y}px ${TD.CONTENT_PADDING_X}px` }}>
        {actionError !== undefined && (
          <div style={{ color: theme.status.error_fg }}>{actionError}</div>
        )}

        {tab === 'fields' ? (
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: TD.COLUMN_GAP, alignItems: 'flex-start' }}>
            <div style={{ width: TD.FIELD_SET_COL_WIDTH, flexShrink: 0, display: 'flex', flexDirection: 'column', gap: TD.GROUP_GAP }}>
              <span style={{ color: theme.text.tertiary, padding: `0 ${TD.ROW_PADDING_X}px` }}>欄位組</span>
              <div style={{ display: 'flex', flexDirection: 'column', gap: TD.ACTION_GAP }}>
                {fieldSets.map((fs) => (
                  <div key={fs.name} style={{ display: 'flex', alignItems: 'center', gap: TD.ACTION_GAP }}>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <FieldSetRow
                        name={fs.name}
                        system={fs.system}
                        selected={fs.name === selectedFieldSet}
                        onClick={() => setSelectedFieldSet(fs.name)}
                      />
                    </div>
                    {!fs.system && data?.typeAdmin && (
                      <Button variant="ghost" size="sm" label="移除" onClick={() => onDeleteFieldSet(fs.name)} />
                    )}
                  </div>
                ))}
              </div>
              {data?.typeAdmin && (showNewFieldSetForm ? (
                <NewFieldSetForm
                  onSubmit={onCreateFieldSet}
                  onCancel={() => setShowNewFieldSetForm(false)}
                  submitting={submitting}
                />
              ) : (
                <Button variant="secondary" size="sm" iconLeft="plus" fullWidth label="新增欄位組" onClick={() => setShowNewFieldSetForm(true)} />
              ))}
            </div>

            <div style={{ flex: '1 1 320px', minWidth: 0, display: 'flex', flexDirection: 'column', gap: TD.GROUP_GAP }}>
              {selectedFieldSet === null ? (
                <EmptyState title="尚未選取欄位組" description="從左側選一個欄位組，檢視與管理組內的欄位定義。" />
              ) : (
                <>
                  <DataTable columns={fieldColumns} rows={fieldRows} />
                  {data?.typeAdmin && (showNewFieldForm ? (
                    <FieldForm onSubmit={onCreateField} onCancel={() => setShowNewFieldForm(false)} submitting={submitting} />
                  ) : (
                    <Button variant="secondary" size="sm" iconLeft="plus" label="新增欄位" onClick={() => setShowNewFieldForm(true)} />
                  ))}
                </>
              )}
            </div>
          </div>
        ) : tab === 'types' ? (
          <>
            <DataTable columns={typeColumns} rows={typeRows} />
            {data?.typeAdmin && (showNewIssueTypeForm ? (
              <IssueTypeForm
                availableFieldSets={fieldSetNames}
                onSubmit={onCreateIssueType}
                onCancel={() => setShowNewIssueTypeForm(false)}
                submitting={submitting}
              />
            ) : (
              <Button variant="secondary" size="sm" iconLeft="plus" label="新增工單型別" onClick={() => setShowNewIssueTypeForm(true)} />
            ))}
          </>
        ) : <DefinitionPlanningTabs key={tab} tab={tab} canEdit={data?.typeAdmin ?? false} />}
      </div>
    </div>
  );
}
