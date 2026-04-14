-- =========================================================
-- PRODUCTION MODE SQL (PostgreSQL)
-- Study: Type 2 diabetes mellitus -> Diabetic nephropathy
-- Schema: cdm_synthea10
-- Study Period: 2016-01-01 to 2024-12-31
-- Baseline: 1 year(s)  |  Outcome window: 1 year(s)
-- =========================================================
/**
HP 

*/
WITH exposure_root AS (
  SELECT concept_id
  FROM cdm_synthea10.concept
  WHERE concept_name = 'Type 2 diabetes mellitus'
    AND standard_concept = 'S'
),
exposure_descendants AS (
  SELECT descendant_concept_id AS concept_id
  FROM cdm_synthea10.concept_ancestor
  WHERE ancestor_concept_id IN (SELECT concept_id FROM exposure_root)
),
outcome_root AS (
  SELECT concept_id
  FROM cdm_synthea10.concept
  WHERE concept_name = 'Diabetic nephropathy'
    AND standard_concept = 'S'
),
outcome_descendants AS (
  SELECT descendant_concept_id AS concept_id
  FROM cdm_synthea10.concept_ancestor
  WHERE ancestor_concept_id IN (SELECT concept_id FROM outcome_root)
),
cohort AS (
  SELECT person_id, MIN(condition_start_date) AS t0
  FROM cdm_synthea10.condition_occurrence
  WHERE condition_concept_id IN (SELECT concept_id FROM exposure_descendants)
  GROUP BY person_id
),
index_anchor AS (
  SELECT
    c.person_id,
    c.t0,
    CASE
      WHEN c.t0 < DATE '2016-01-01' THEN DATE '2016-01-01'
      ELSE c.t0
    END AS exposure_index_date,
    (
      CASE
        WHEN c.t0 < DATE '2016-01-01' THEN DATE '2016-01-01'
        ELSE c.t0
      END
    ) + INTERVAL '365 days' AS first_index_date
  FROM cohort c
),
spine AS (
  SELECT
    a.person_id,
    a.t0,
    a.exposure_index_date,
    a.first_index_date + (n * INTERVAL '365 days') AS index_date,
    a.first_index_date + (n * INTERVAL '365 days') - INTERVAL '365 days' AS baseline_start,
    a.first_index_date + (n * INTERVAL '365 days') - INTERVAL '1 day' AS baseline_end,
    a.first_index_date + (n * INTERVAL '365 days') AS outcome_start,
    a.first_index_date + (n * INTERVAL '365 days') + INTERVAL '365 days' AS outcome_end
  FROM index_anchor a
  JOIN generate_series(0, 20) n
    ON a.first_index_date + (n * INTERVAL '365 days') + INTERVAL '365 days'
       <= DATE '2024-12-31'
),
first_outcome AS (
  SELECT person_id, MIN(condition_start_date) AS outcome_date
  FROM cdm_synthea10.condition_occurrence
  WHERE condition_concept_id IN (SELECT concept_id FROM outcome_descendants)
  GROUP BY person_id
),
final_spine AS (
  SELECT s.*
  FROM spine s
  LEFT JOIN first_outcome o ON s.person_id = o.person_id
  JOIN cdm_synthea10.observation_period op ON s.person_id = op.person_id
  WHERE (o.outcome_date IS NULL OR s.outcome_start <= o.outcome_date)
    AND s.baseline_start >= op.observation_period_start_date
    AND s.outcome_end   <= op.observation_period_end_date
    AND s.outcome_end   <= DATE '2024-12-31'
)
SELECT
  s.*,
  CASE
    WHEN EXISTS (
      SELECT 1 FROM cdm_synthea10.condition_occurrence co
      WHERE co.person_id = s.person_id
        AND co.condition_concept_id IN (SELECT concept_id FROM outcome_descendants)
        AND co.condition_start_date BETWEEN s.outcome_start AND s.outcome_end
    ) THEN 1 ELSE 0
  END AS outcome_label
FROM final_spine s
ORDER BY s.person_id, s.index_date;
