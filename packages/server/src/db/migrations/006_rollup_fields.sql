-- 沿用既有 point 主值，不另建第二份 StoryPoint。
UPDATE field_defs SET rollupable = true, rollup_fn = 'sum'
WHERE name = 'point' AND system = true AND kind = 'single' AND value_type = 'number';

INSERT INTO field_defs (company_id, name, field_set_name, kind, value_type, system,
  readonly, rollupable, rollup_fn, tracked, label)
SELECT company_id, 'WorkLog', name, 'multi', 'number', true, false, true, 'sum', false, '工時'
FROM field_set_defs WHERE name = '基本' AND system = true
ON CONFLICT (company_id, name) DO NOTHING;
