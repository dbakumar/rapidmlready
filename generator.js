/***********************************************************************
 OMOP Spine Initializr – generator.js
 ----------------------------------------------------------------------
 Generates FULL SQL for longitudinal prediction studies using OMOP CDM.

 ✅ Debug mode: step-by-step TEMP TABLE SQL (inspectable)
 ✅ Production mode: single CTE SQL (optimized)
 ✅ Correct spine logic
 ✅ Correct outcome-based censoring
 ✅ Correct observation-period censoring
 ✅ No leakage, no invalid baseline windows

 Authoritative version – replace existing generator.js
***********************************************************************/


/* =======================
   Utility: download file
   ======================= */
function download(filename, text) {
  const a = document.createElement("a");
  a.href = "data:text/plain;charset=utf-8," + encodeURIComponent(text);
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
}


/* =======================
   Utility: fill template
   ======================= */
function fillTemplate(template, values) {
  let result = template;
  for (const key in values) {
    result = result.replace(new RegExp("\\{\\{" + key + "\\}\\}", "g"), values[key]);
  }
  return result;
}


/* =======================
   SQL TEMPLATES
   ======================= */
const TEMPLATES = {};


/* ====================================================================
   DEBUG MODE – POSTGRESQL (TEMP TABLES, INSPECTABLE)
   ==================================================================== */
TEMPLATES.debug_postgres = `
/***********************************************************************
 DEBUG SQL – STEP BY STEP (PostgreSQL)
 Study: {{EXPOSURE}} → {{OUTCOME}}
 Schema: {{SCHEMA}}
 Study period: {{START_YEAR}}-01-01 to {{END_YEAR}}-12-31
 Baseline: {{BASELINE_YEARS}} year(s)
 Outcome window: {{OUTCOME_YEARS}} year(s)
***********************************************************************/

-- =====================================================
-- STEP 1: Resolve exposure concept (root)
-- =====================================================
DROP TABLE IF EXISTS tmp_exposure_root;
CREATE TEMP TABLE tmp_exposure_root AS
SELECT concept_id, concept_name
FROM {{SCHEMA}}.concept
WHERE concept_name = '{{EXPOSURE}}'
  AND domain_id = 'Condition'
  AND standard_concept = 'S';

SELECT * FROM tmp_exposure_root;


-- =====================================================
-- STEP 2: Expand exposure descendants
-- =====================================================
DROP TABLE IF EXISTS tmp_exposure_descendants;
CREATE TEMP TABLE tmp_exposure_descendants AS
SELECT descendant_concept_id AS concept_id
FROM {{SCHEMA}}.concept_ancestor
WHERE ancestor_concept_id IN (SELECT concept_id FROM tmp_exposure_root);

SELECT COUNT(*) AS exposure_concept_count FROM tmp_exposure_descendants;


-- =====================================================
-- STEP 3: Resolve outcome concept (root)
-- =====================================================
DROP TABLE IF EXISTS tmp_outcome_root;
CREATE TEMP TABLE tmp_outcome_root AS
SELECT concept_id, concept_name
FROM {{SCHEMA}}.concept
WHERE concept_name = '{{OUTCOME}}'
  AND domain_id = 'Condition'
  AND standard_concept = 'S';

SELECT * FROM tmp_outcome_root;


-- =====================================================
-- STEP 4: Expand outcome descendants
-- =====================================================
DROP TABLE IF EXISTS tmp_outcome_descendants;
CREATE TEMP TABLE tmp_outcome_descendants AS
SELECT descendant_concept_id AS concept_id
FROM {{SCHEMA}}.concept_ancestor
WHERE ancestor_concept_id IN (SELECT concept_id FROM tmp_outcome_root);

SELECT COUNT(*) AS outcome_concept_count FROM tmp_outcome_descendants;


-- =====================================================
-- STEP 5: Cohort entry (t0 = first exposure)
-- =====================================================
DROP TABLE IF EXISTS tmp_cohort;
CREATE TEMP TABLE tmp_cohort AS
SELECT
  co.person_id,
  MIN(co.condition_start_date) AS t0
FROM {{SCHEMA}}.condition_occurrence co
WHERE co.condition_concept_id IN (SELECT concept_id FROM tmp_exposure_descendants)
GROUP BY co.person_id;

SELECT COUNT(*) AS cohort_size FROM tmp_cohort;


-- =====================================================
-- STEP 6: Compute exposure anchor and first predictive date
--   - If exposed before study start, anchor at study start
--   - First predictive date is anchor + baseline window
-- =====================================================
DROP TABLE IF EXISTS tmp_index_anchor;
CREATE TEMP TABLE tmp_index_anchor AS
SELECT
  c.person_id,
  c.t0,
  CASE
    WHEN c.t0 < DATE '{{START_YEAR}}-01-01' THEN DATE '{{START_YEAR}}-01-01'
    ELSE c.t0
  END AS exposure_index_date,
  (
    CASE
      WHEN c.t0 < DATE '{{START_YEAR}}-01-01' THEN DATE '{{START_YEAR}}-01-01'
      ELSE c.t0
    END
  ) + INTERVAL '{{BASELINE_DAYS}} days' AS first_index_date
FROM tmp_cohort c;

SELECT * FROM tmp_index_anchor LIMIT 20;


-- =====================================================
-- STEP 7: Generate SPINE (person × time)
-- =====================================================
DROP TABLE IF EXISTS tmp_spine;
CREATE TEMP TABLE tmp_spine AS
SELECT
  a.person_id,
  a.t0,
  a.exposure_index_date,
  a.first_index_date + (n * INTERVAL '365 days') AS index_date,
  a.first_index_date + (n * INTERVAL '365 days') - INTERVAL '{{BASELINE_DAYS}} days' AS baseline_start,
  a.first_index_date + (n * INTERVAL '365 days') - INTERVAL '1 day' AS baseline_end,
  a.first_index_date + (n * INTERVAL '365 days') AS outcome_start,
  a.first_index_date + (n * INTERVAL '365 days') + INTERVAL '{{OUTCOME_DAYS}} days' AS outcome_end
FROM tmp_index_anchor a
JOIN generate_series(0, 20) n
  ON a.first_index_date + (n * INTERVAL '365 days') + INTERVAL '{{OUTCOME_DAYS}} days'
     <= DATE '{{END_YEAR}}-12-31';

SELECT * FROM tmp_spine ORDER BY person_id, index_date LIMIT 20;


-- =====================================================
-- STEP 8: Identify FIRST outcome date per person
-- =====================================================
DROP TABLE IF EXISTS tmp_first_outcome;
CREATE TEMP TABLE tmp_first_outcome AS
SELECT
  person_id,
  MIN(condition_start_date) AS outcome_date
FROM {{SCHEMA}}.condition_occurrence
WHERE condition_concept_id IN (SELECT concept_id FROM tmp_outcome_descendants)
GROUP BY person_id;

SELECT * FROM tmp_first_outcome LIMIT 20;


-- =====================================================
-- STEP 9: Outcome-based censoring
--   KEEP row if outcome occurs within its window
--   REMOVE all future rows
-- =====================================================
DROP TABLE IF EXISTS tmp_spine_outcome_censored;
CREATE TEMP TABLE tmp_spine_outcome_censored AS
SELECT s.*
FROM tmp_spine s
LEFT JOIN tmp_first_outcome o
  ON s.person_id = o.person_id
WHERE o.outcome_date IS NULL
   OR s.outcome_start <= o.outcome_date;

SELECT COUNT(*) AS rows_after_outcome_censor FROM tmp_spine_outcome_censored;


-- =====================================================
-- STEP 10: Observation-period censoring
-- =====================================================
DROP TABLE IF EXISTS tmp_final_spine;
CREATE TEMP TABLE tmp_final_spine AS
SELECT s.*
FROM tmp_spine_outcome_censored s
JOIN {{SCHEMA}}.observation_period op
  ON s.person_id = op.person_id
WHERE s.baseline_start >= op.observation_period_start_date
  AND s.outcome_end   <= op.observation_period_end_date
  AND s.outcome_end   <= DATE '{{END_YEAR}}-12-31';

SELECT COUNT(*) AS final_spine_rows FROM tmp_final_spine;


-- =====================================================
-- STEP 11: Outcome labeling (final output)
-- =====================================================
SELECT
  s.*,
  CASE
    WHEN EXISTS (
      SELECT 1
      FROM {{SCHEMA}}.condition_occurrence co
      WHERE co.person_id = s.person_id
        AND co.condition_concept_id IN (SELECT concept_id FROM tmp_outcome_descendants)
        AND co.condition_start_date BETWEEN s.outcome_start AND s.outcome_end
    )
    THEN 1 ELSE 0
  END AS outcome_label
FROM tmp_final_spine s
ORDER BY s.person_id, s.index_date;
`;


/* ====================================================================
   PRODUCTION MODE – POSTGRESQL (CTE)
   ==================================================================== */
TEMPLATES.prod_postgres = `
/***********************************************************************
 PRODUCTION SQL (PostgreSQL)
 Study: {{EXPOSURE}} → {{OUTCOME}}
***********************************************************************/

WITH exposure_root AS (
  SELECT concept_id
  FROM {{SCHEMA}}.concept
  WHERE concept_name = '{{EXPOSURE}}'
    AND standard_concept = 'S'
),
exposure_descendants AS (
  SELECT descendant_concept_id AS concept_id
  FROM {{SCHEMA}}.concept_ancestor
  WHERE ancestor_concept_id IN (SELECT concept_id FROM exposure_root)
),
outcome_root AS (
  SELECT concept_id
  FROM {{SCHEMA}}.concept
  WHERE concept_name = '{{OUTCOME}}'
    AND standard_concept = 'S'
),
outcome_descendants AS (
  SELECT descendant_concept_id AS concept_id
  FROM {{SCHEMA}}.concept_ancestor
  WHERE ancestor_concept_id IN (SELECT concept_id FROM outcome_root)
),
cohort AS (
  SELECT person_id, MIN(condition_start_date) AS t0
  FROM {{SCHEMA}}.condition_occurrence
  WHERE condition_concept_id IN (SELECT concept_id FROM exposure_descendants)
  GROUP BY person_id
),
index_anchor AS (
  SELECT
    c.person_id,
    c.t0,
    CASE
      WHEN c.t0 < DATE '{{START_YEAR}}-01-01' THEN DATE '{{START_YEAR}}-01-01'
      ELSE c.t0
    END AS exposure_index_date,
    (
      CASE
        WHEN c.t0 < DATE '{{START_YEAR}}-01-01' THEN DATE '{{START_YEAR}}-01-01'
        ELSE c.t0
      END
    ) + INTERVAL '{{BASELINE_DAYS}} days' AS first_index_date
  FROM cohort c
),
spine AS (
  SELECT
    a.person_id,
    a.t0,
    a.exposure_index_date,
    a.first_index_date + (n * INTERVAL '365 days') AS index_date,
    a.first_index_date + (n * INTERVAL '365 days') - INTERVAL '{{BASELINE_DAYS}} days' AS baseline_start,
    a.first_index_date + (n * INTERVAL '365 days') - INTERVAL '1 day' AS baseline_end,
    a.first_index_date + (n * INTERVAL '365 days') AS outcome_start,
    a.first_index_date + (n * INTERVAL '365 days') + INTERVAL '{{OUTCOME_DAYS}} days' AS outcome_end
  FROM index_anchor a
  JOIN generate_series(0, 20) n
    ON a.first_index_date + (n * INTERVAL '365 days') + INTERVAL '{{OUTCOME_DAYS}} days'
       <= DATE '{{END_YEAR}}-12-31'
),
first_outcome AS (
  SELECT person_id, MIN(condition_start_date) AS outcome_date
  FROM {{SCHEMA}}.condition_occurrence
  WHERE condition_concept_id IN (SELECT concept_id FROM outcome_descendants)
  GROUP BY person_id
),
final_spine AS (
  SELECT s.*
  FROM spine s
  LEFT JOIN first_outcome o
    ON s.person_id = o.person_id
  JOIN {{SCHEMA}}.observation_period op
    ON s.person_id = op.person_id
  WHERE (o.outcome_date IS NULL OR s.outcome_start <= o.outcome_date)
    AND s.baseline_start >= op.observation_period_start_date
    AND s.outcome_end   <= op.observation_period_end_date
    AND s.outcome_end   <= DATE '{{END_YEAR}}-12-31'
)
SELECT
  s.*,
  CASE
    WHEN EXISTS (
      SELECT 1
      FROM {{SCHEMA}}.condition_occurrence co
      WHERE co.person_id = s.person_id
        AND co.condition_concept_id IN (SELECT concept_id FROM outcome_descendants)
        AND co.condition_start_date BETWEEN s.outcome_start AND s.outcome_end
    )
    THEN 1 ELSE 0
  END AS outcome_label
FROM final_spine s
ORDER BY s.person_id, s.index_date;
`;


/* =======================
   SQL generation wrapper
   ======================= */
function generateSQL(config) {
  const key = (config.debug ? "debug_" : "prod_") + config.db;
  return fillTemplate(TEMPLATES[key], {
    SCHEMA: config.schema,
    EXPOSURE: config.exposure,
    OUTCOME: config.outcome,
    START_YEAR: config.startYear,
    END_YEAR: config.endYear,
    BASELINE_YEARS: config.baselineYears,
    OUTCOME_YEARS: config.outcomeYears,
    BASELINE_DAYS: String(Number(config.baselineYears) * 365),
    OUTCOME_DAYS: String(Number(config.outcomeYears) * 365)
  });
}


/* =======================
   Entry point
   ======================= */
function generate() {
  const config = {
    db: document.getElementById("db").value,
    schema: document.getElementById("schema").value || "cdm_synthea10",
    startYear: document.getElementById("startYear").value,
    endYear: document.getElementById("endYear").value,
    exposure: document.getElementById("exposure").value,
    outcome: document.getElementById("outcome").value,
    baselineYears: document.getElementById("baselineYears").value,
    outcomeYears: document.getElementById("outcomeYears").value,
    debug: document.getElementById("debugMode").checked
  };

  const sql = generateSQL(config);
  download("study.sql", sql);
}
