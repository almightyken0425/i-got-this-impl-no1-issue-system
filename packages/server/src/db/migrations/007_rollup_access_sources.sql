-- 權限用來源索引保留曾參與彙總的工單，解除關聯不解除衍生資料的讀取限制。
CREATE TABLE rollup_access_sources (
  company_id uuid NOT NULL REFERENCES companies(id),
  holder_id uuid NOT NULL REFERENCES issues(id),
  source_id uuid NOT NULL REFERENCES issues(id),
  PRIMARY KEY (company_id, holder_id, source_id)
);

INSERT INTO rollup_access_sources (company_id, holder_id, source_id)
SELECT r.company_id, r.from_issue_id, r.to_issue_id
FROM issue_relations r JOIN relation_type_definitions t
  ON t.company_id = r.company_id AND t.id = r.relation_type_id
WHERE t.rollup = true
ON CONFLICT DO NOTHING;
