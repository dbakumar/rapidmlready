-- Data quality checks for study_result
SELECT 'null_person_id' AS check_name, COUNT(*) AS issue_rows FROM study_result WHERE person_id IS NULL
UNION ALL
SELECT 'null_index_date' AS check_name, COUNT(*) AS issue_rows FROM study_result WHERE index_date IS NULL
UNION ALL
SELECT 'label_out_of_range' AS check_name, COUNT(*) AS issue_rows FROM study_result WHERE outcome_label NOT IN (0, 1);