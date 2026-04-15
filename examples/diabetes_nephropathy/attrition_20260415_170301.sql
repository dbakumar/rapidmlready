-- Attrition summary (run after loading study.sql output into temp/result table)
SELECT
  COUNT(*) AS total_rows,
  COUNT(DISTINCT person_id) AS unique_people,
  SUM(CASE WHEN outcome_label = 1 THEN 1 ELSE 0 END) AS positive_rows
FROM study_result;