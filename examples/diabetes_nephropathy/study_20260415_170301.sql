/***********************************************************************
 DEBUG SQL (step-by-step temp tables) - PostgreSQL
 Entry condition concept: 201826
 Outcome concept: 443767
 Cohort entry mode: condition_lab_diff_visits
***********************************************************************/
-- DEBUG HINTS:
--   PostgreSQL: run EXPLAIN (ANALYZE, BUFFERS) on heavy steps for query-plan diagnostics.
--   PostgreSQL: inspect temp tables with SELECT COUNT(*) and LIMIT samples at each step.
--   PostgreSQL: disable expensive debug diagnostics when done to keep output clean.
-- ---------------------------------------------------------------------
-- DEBUG WALKTHROUGH EXAMPLE (conceptual, not executed)
-- Person A: t0=2020-01-15; no outcome until 2023-03-10
-- Person B: t0=2018-06-01; outcome on 2021-02-05
-- Steps below let you inspect where each person is kept or censored.
-- ---------------------------------------------------------------------
-- STEP 1: Resolve entry condition root concept
DROP TABLE IF EXISTS tmp_entry_condition_root;
CREATE TEMP TABLE tmp_entry_condition_root AS
SELECT
  concept_id
FROM cdm_synthea10.concept
WHERE concept_id = 201826
  AND standard_concept = 'S';
SELECT * FROM tmp_entry_condition_root;
-- STEP 2: Expand entry condition descendants
DROP TABLE IF EXISTS tmp_entry_condition_descendants;
CREATE TEMP TABLE tmp_entry_condition_descendants AS
SELECT
  descendant_concept_id AS concept_id
FROM cdm_synthea10.concept_ancestor
WHERE ancestor_concept_id IN (SELECT concept_id FROM tmp_entry_condition_root);
SELECT COUNT(*) AS entry_descendant_count FROM tmp_entry_condition_descendants;
-- STEP 3: Resolve outcome root concept
DROP TABLE IF EXISTS tmp_outcome_root;
CREATE TEMP TABLE tmp_outcome_root AS
SELECT
  concept_id
FROM cdm_synthea10.concept
WHERE concept_id = 443767
  AND standard_concept = 'S';
SELECT * FROM tmp_outcome_root;
-- STEP 4: Expand outcome descendants
DROP TABLE IF EXISTS tmp_outcome_descendants;
CREATE TEMP TABLE tmp_outcome_descendants AS
SELECT
  descendant_concept_id AS concept_id
FROM cdm_synthea10.concept_ancestor
WHERE ancestor_concept_id IN (SELECT concept_id FROM tmp_outcome_root);
SELECT COUNT(*) AS outcome_descendant_count FROM tmp_outcome_descendants;
-- STEP 5: Build cohort entry table (t0 per person)
DROP TABLE IF EXISTS tmp_cohort;
CREATE TEMP TABLE tmp_cohort AS
WITH entry_condition_descendants AS (
  SELECT concept_id FROM tmp_entry_condition_descendants
),
-- Cohort mode: condition + lab threshold on different visits
cohort AS (
  SELECT person_id, MIN(entry_date) AS t0
  FROM (
    SELECT DISTINCT
      co.person_id,
      co.condition_start_date AS entry_date
    FROM cdm_synthea10.condition_occurrence co
    JOIN cdm_synthea10.visit_occurrence vco
      ON vco.person_id = co.person_id
      AND (
        (co.visit_occurrence_id IS NOT NULL AND vco.visit_occurrence_id = co.visit_occurrence_id)
        OR
        (co.visit_occurrence_id IS NULL AND co.condition_start_date BETWEEN vco.visit_start_date AND COALESCE(vco.visit_end_date, vco.visit_start_date))
      )
      AND vco.visit_concept_id IN (9202)
    JOIN cdm_synthea10.measurement m
      ON co.person_id = m.person_id
    JOIN cdm_synthea10.visit_occurrence vm
      ON vm.person_id = m.person_id
      AND (
        (m.visit_occurrence_id IS NOT NULL AND vm.visit_occurrence_id = m.visit_occurrence_id)
        OR
        (m.visit_occurrence_id IS NULL AND m.measurement_date BETWEEN vm.visit_start_date AND COALESCE(vm.visit_end_date, vm.visit_start_date))
      )
      AND vm.visit_concept_id IN (9202)
      AND COALESCE(vco.visit_occurrence_id, -1) != COALESCE(vm.visit_occurrence_id, -1)
    WHERE co.condition_concept_id IN (SELECT concept_id FROM entry_condition_descendants)
      AND m.measurement_concept_id = 3020460
      AND CAST(m.value_as_number AS NUMERIC) > 11.5
  ) combined
  GROUP BY person_id
)
SELECT * FROM cohort;
SELECT COUNT(*) AS cohort_size FROM tmp_cohort;
-- STEP 6: Build index anchor (respect study start and baseline offset)
DROP TABLE IF EXISTS tmp_index_anchor;
CREATE TEMP TABLE tmp_index_anchor AS
SELECT
  c.person_id,
  c.t0,
  CASE
    WHEN c.t0 < DATE '2016-01-01' THEN DATE '2016-01-01'
    ELSE c.t0
  END AS exposure_index_date,
  (a.exposure_index_date + (365) * INTERVAL '1 day') AS first_index_date
FROM tmp_cohort c;
SELECT * FROM tmp_index_anchor ORDER BY person_id LIMIT 20;
-- STEP 7: Build repeated yearly spine rows
DROP TABLE IF EXISTS tmp_spine;
CREATE TEMP TABLE tmp_spine AS
WITH nums AS (
  SELECT generate_series(0, 20) AS n
)
SELECT
  a.person_id,
  a.t0,
  a.exposure_index_date,
  (a.first_index_date + (nums.n) * INTERVAL '1 year') AS index_date,
  (a.first_index_date + ((nums.n * 365) - 365) * INTERVAL '1 day') AS baseline_start,
  (a.first_index_date + ((nums.n * 365) - 1) * INTERVAL '1 day') AS baseline_end,
  (a.first_index_date + (nums.n) * INTERVAL '1 year') AS outcome_start,
  ((a.first_index_date + (nums.n) * INTERVAL '1 year') + (365) * INTERVAL '1 day') AS outcome_end
FROM tmp_index_anchor a
JOIN nums ON ((a.first_index_date + (nums.n) * INTERVAL '1 year') + (365) * INTERVAL '1 day') <= DATE '2024-12-31';
SELECT COUNT(*) AS spine_rows FROM tmp_spine;
-- STEP 8: Compute first outcome date per person
DROP TABLE IF EXISTS tmp_first_outcome;
CREATE TEMP TABLE tmp_first_outcome AS
WITH outcome_descendants AS (
  SELECT concept_id FROM tmp_outcome_descendants
),
-- Earliest condition-based outcome date per person
first_outcome AS (
  SELECT person_id, MIN(condition_start_date) AS outcome_date
  FROM cdm_synthea10.condition_occurrence
  WHERE condition_concept_id IN (SELECT concept_id FROM outcome_descendants)
  GROUP BY person_id
)
SELECT * FROM first_outcome;
SELECT COUNT(*) AS first_outcome_rows FROM tmp_first_outcome;
-- STEP 9: Apply censoring rules (outcome, observation period, study end)
DROP TABLE IF EXISTS tmp_final_spine;
CREATE TEMP TABLE tmp_final_spine AS
SELECT
  s.*, o.outcome_date AS first_outcome_date
FROM tmp_spine s
LEFT JOIN tmp_first_outcome o ON s.person_id = o.person_id
JOIN cdm_synthea10.observation_period op ON s.person_id = op.person_id
WHERE (o.outcome_date IS NULL OR s.outcome_start <= o.outcome_date)
    AND s.baseline_start >= op.observation_period_start_date
    AND s.outcome_end <= op.observation_period_end_date
    AND s.outcome_end <= DATE '2024-12-31';
SELECT COUNT(*) AS final_spine_rows FROM tmp_final_spine;
-- STEP 10: Build final labeled dataset with selected covariates
WITH outcome_descendants AS (
  SELECT concept_id FROM tmp_outcome_descendants
)
SELECT
  s.*,
  CASE
    WHEN EXISTS (
      SELECT 1
      FROM cdm_synthea10.condition_occurrence co
      WHERE co.person_id = s.person_id
        AND co.condition_concept_id IN (SELECT concept_id FROM outcome_descendants)
        AND co.condition_start_date BETWEEN s.outcome_start AND s.outcome_end
    )
    THEN 1 ELSE 0
  END AS outcome_label,
  (EXTRACT(YEAR FROM s.index_date)::INT - p.year_of_birth) AS age_at_index,
  p.gender_concept_id AS sex_concept_id,
  (SELECT COUNT(*) FROM cdm_synthea10.condition_occurrence x WHERE x.person_id = s.person_id AND x.condition_start_date BETWEEN s.baseline_start AND s.baseline_end) AS baseline_condition_count,
  (SELECT COUNT(*) FROM cdm_synthea10.drug_exposure x WHERE x.person_id = s.person_id AND x.drug_exposure_start_date BETWEEN s.baseline_start AND s.baseline_end) AS baseline_drug_count,
  (SELECT COUNT(*) FROM cdm_synthea10.visit_occurrence x WHERE x.person_id = s.person_id AND x.visit_start_date BETWEEN s.baseline_start AND s.baseline_end) AS baseline_visit_count,
  (SELECT COUNT(*) FROM cdm_synthea10.measurement x WHERE x.person_id = s.person_id AND x.measurement_date BETWEEN s.baseline_start AND s.baseline_end) AS baseline_measurement_count
FROM tmp_final_spine s
LEFT JOIN cdm_synthea10.person p ON p.person_id = s.person_id
ORDER BY s.person_id, s.index_date;