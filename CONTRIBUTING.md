# Contributing to Rapid ML-Ready Wizard

Welcome! This guide is a complete developer reference for understanding,
extending, and debugging the Rapid ML-Ready Wizard. If you just want to
use the tool, see [README.md](README.md).

---

## Table of Contents

1. [Getting Started](#getting-started)
2. [Architecture Overview](#architecture-overview)
3. [Project Structure (File-by-File)](#project-structure-file-by-file)
4. [Global Namespace Reference](#global-namespace-reference)
5. [The Config Object](#the-config-object)
6. [How Evidence Blocks Work](#how-evidence-blocks-work)
7. [The SQL Compilation Pipeline](#the-sql-compilation-pipeline)
8. [Create a New Data Model Adapter](#create-a-new-data-model-adapter)
9. [Add a New Methodology](#add-a-new-methodology)
10. [Add a New Analysis Template](#add-a-new-analysis-template)
11. [Add New Covariates](#add-new-covariates)
12. [Add New Concept References](#add-new-concept-references)
13. [Coding Standards](#coding-standards)
14. [Naming Conventions](#naming-conventions)
15. [Script Load Order](#script-load-order)
16. [Testing Checklist](#testing-checklist)
17. [Debugging Tips](#debugging-tips)
18. [Questions?](#questions)

---

## Getting Started

### Prerequisites

- A modern web browser (Chrome, Firefox, Edge, Safari)
- A text editor (VS Code recommended)
- No build tools, no package manager, no Node.js required

### Running the project

1. Clone or download the repository.
2. Open `index.html` in your browser. That is it — everything runs client-side.
3. The wizard renders a 3-panel layout:
   - **Left** — step navigation sidebar (5 steps)
   - **Centre** — form sections (one visible at a time)
   - **Right** — OMOP concept reference (click-to-copy)

### Making changes

1. Edit any `.js` file in a text editor.
2. Refresh the browser to see changes (no build step).
3. Open the browser console (`F12`) to check for errors.
4. Use the self-check panel on step 5 to verify your changes work end-to-end.

### Important rules

- **No ES6.** All JavaScript must be ES5-compatible (`var` not `const`/`let`,
  no arrow functions, no template literals, no `async`/`await`, no `import`/`export`).
- **No build tools.** Everything is loaded via `<script>` tags in `index.html`.
- **No bundler.** All inter-file communication uses the `window.RapidML` global.

---

## Architecture Overview

### How the pieces connect

```
 User fills wizard form (index.html)
          │
          ▼
 ┌─────────────────────────────────────────────────────────┐
 │  core/generator.js                                       │
 │                                                          │
 │  1. getFormConfig()                                      │
 │     reads all HTML inputs + evidence blocks              │
 │                                                          │
 │  2. normalizeConfig(raw)                                 │
 │     applies defaults, coerces types                      │
 │                                                          │
 │  3. validateConfig(config)                               │
 │     checks for errors (returns [] if ok)                 │
 │                                                          │
 │  4. generate()                                           │
 │     routes to methodology + template + artifacts         │
 │     packages into zip                                    │
 └────────────┬────────────────────────┬────────────────────┘
              │                        │
              ▼                        ▼
 ┌────────────────────┐   ┌────────────────────────┐
 │  Methodology Plugin │   │  Analysis Template      │
 │  (builds SQL)       │   │  (builds run.py)        │
 │                     │   │                          │
 │  buildSQL(config)   │   │  buildScript(config)     │
 │  describeRules(cfg) │   │  → Python source code    │
 └────────┬───────────┘   └────────────────────────┘
          │
          │  calls compiler BUILDING BLOCKS
          ▼
 ┌──────────────────────────────────────────────────────────┐
 │  omop/compiler.js  — TOOLKIT (not an orchestrator)       │
 │                                                          │
 │  Building blocks:                                        │
 │    prepareContext(config)         → shared context        │
 │    buildConceptCTEs(config, ctx)  → concept resolution    │
 │    buildCohortCTE(config, ctx)    → cohort entry          │
 │    buildAnchorCTE(config, ctx, d) → date anchoring        │
 │    buildFirstOutcomeCTE(config)   → first outcome         │
 │    buildCensoredSpineCTE(config)  → censoring filters     │
 │    buildFinalSelect(config, ctx)  → covariates + label    │
 │    buildDebugHelpers(config, ctx) → temp-table utilities  │
 │                                                          │
 │  The compiler does NOT build the spine.                  │
 │  Each methodology owns the spine strategy.               │
 └────────┬─────────────────────────────────────────────────┘
          │
          │  delegates to the registered data model adapter
          ▼
 ┌──────────────────────────────────────────────────────────┐
 │  omop/evidence-sql.js  — OMOP CDM adapter                │
 │    converts evidence rows → OMOP-specific SQL            │
 │                                                          │
 │  SHARED modules:                                         │
 │    omop/censoring.js    → observation period checks       │
 │    omop/covariates.js   → feature SQL (demographics,     │
 │                           baseline counts, labs, history) │
 │    core/dialects.js     → PostgreSQL / SQL Server syntax  │
 └──────────────────────────────────────────────────────────┘
```

### Three design principles

1. **Methodologies own the spine.**
   The compiler is a bag of reusable SQL-building functions. A methodology
   calls these functions and adds its own window/spine strategy. This is
   the *only* thing that differs between longitudinal-prediction
   (repeated yearly rows) and single-window (one row per patient).

2. **Evidence blocks are data-model-agnostic.**
   Each row specifies a type (diagnosis, lab, drug, procedure), a concept
   ID, and optional operator/value. The adapter translates rows into
   data-model-specific SQL. You could swap OMOP for FHIR by writing a
   new adapter — the rest of the system does not change.

3. **Self-registering plugins.**
   Methodologies, templates, and adapters register themselves when loaded.
   No wiring code is needed — just add a `<script>` tag and the plugin
   appears in the dropdown.

---

## Project Structure (File-by-File)

### Root files

| File | Purpose |
|------|---------|
| `index.html` | Main UI — 3-panel wizard layout, all HTML form elements, script tags. Open this to use the tool. |
| `README.md` | User-facing project overview, architecture diagrams, per-file documentation. |
| `CONTRIBUTING.md` | This file — developer guide for extending the project. |
| `LICENSE` | MIT licence. |

### core/ — Generic engine (data-model-independent)

| File | Responsibility | Key Exports |
|------|---------------|-------------|
| `generator.js` | Central orchestrator. Sets up the `window.RapidML` global namespace. Contains **all three plugin registries** (Adapters, Methodologies, AnalysisTemplates). Reads HTML form inputs, normalises them into a config object, validates, orchestrates SQL generation via plugins, and packages output into a zip file. | `RapidML.Adapters.register/get/list`, `RapidML.Methodologies.register/get/list`, `RapidML.AnalysisTemplates.register/get/list`, `getFormConfig()`, `normalizeConfig()`, `validateConfig()`, `generate()`, `download()`, `downloadPackage()` |
| `dialects.js` | Database-specific SQL syntax. Every other file that builds SQL calls these helpers so that one dialect switch produces correct SQL for PostgreSQL or SQL Server. Standalone — no dependencies. | `RapidML.Compiler.Dialects.dialectFor()`, `.quoteDateLiteral()`, `.addDaysExpr()`, `.addYearsExpr()`, `.seriesCTE()` |
| `evidence-ui.js` | Dynamic evidence row forms. Renders the add/remove row UI for each evidence block (entry, outcome, exclusions, confounders). Collects all row data from the DOM into a study definition object. Pure DOM manipulation — no dependencies. | `RapidML.EvidenceUI.renderBlock()`, `.collectBlockData()`, `.collectListData()`, `.collectStudyDefinition()`, `.applyDiabetesExample()`, `.applyDiabetesLabExample()` |
| `wizard-ui.js` | All browser-side UI logic. Manages 3-panel layout, step navigation, covariate presets, example buttons, concept reference sidebar, dropdown population from registries, and real-time self-check validation. Must be loaded **last** because it depends on everything else. | `goToSection()`, `updateSelfCheck()`, `applyCovariatePreset()`, `populateDropdowns()` |

### omop/ — OMOP CDM data model

| File | Responsibility | Key Exports |
|------|---------------|-------------|
| `evidence-sql.js` | **OMOP adapter** — converts evidence block rows into OMOP-specific SQL CTEs. Maps row types to OMOP tables (condition_occurrence, measurement, drug_exposure, procedure_occurrence, observation, visit_occurrence). Handles concept descendants, visit context filtering, minCount thresholds. Registers as `RapidML.Adapters.register({ id: "omop", ... })`. | Adapter methods: `buildConceptCTEs`, `buildCohortCTE`, `buildFirstOutcomeCTE`, `buildOutcomeLabelExpr`, `buildExclusionWhere`, `buildConfounderColumns`, `buildDomainBridge` |
| `compiler.js` | **Compiler toolkit** — provides reusable SQL building blocks that methodologies assemble. Routes data-model-specific calls through the registered adapter. Does NOT build the spine — that is the methodology's job. | `RapidML.Compiler.prepareContext()`, `.buildConceptCTEs()`, `.buildCohortCTE()`, `.buildAnchorCTE()`, `.buildFirstOutcomeCTE()`, `.buildCensoredSpineCTE()`, `.outcomeLabelExpr()`, `.buildFinalSelect()`, `.buildHeader()`, `.buildPerformanceHints()`, `.buildDebugHelpers()`, `.buildDebug*Step()`, `.sqlLines()` |
| `censoring.js` | Builds the WHERE clause fragment that removes spine rows falling outside valid time periods: outcome date check, observation period boundaries, study end date. | `RapidML.Compiler.Censoring.buildCensoringWhere(config)` |
| `covariates.js` | Builds SQL SELECT columns and JOINs for patient-level features. Supports demographics (age, sex, race, ethnicity), baseline counts (conditions, drugs, visits, measurements), baseline labs (eGFR, creatinine, HbA1c, BP, BMI), and prior history (outcome, hospitalisation, ER, procedure). Supports three encoding modes: count, binary, or both. | `RapidML.Compiler.Covariates.buildSelect(config)`, `.STANDARD_CONCEPTS` |
| `concepts.js` | Stores common OMOP concept IDs (conditions, measurements, drugs, procedures) for the wizard right sidebar. Renders click-to-copy HTML. Extensible via `addConcept()` and `addConcepts()`. | `RapidML.ConceptReference.getCategories()`, `.getByCategory()`, `.renderCategory()`, `.renderAll()`, `.addConcept()`, `.addConcepts()` |
| `artifacts.js` | Generates a detailed `manifest.json` when best-practice mode is enabled — includes full evidence logic descriptions, OMOP table mappings, match mode explanations, SQL logic summaries, covariate details, and raw config snapshot. | `RapidML.Compiler.buildArtifacts(config, methodologyId)` |

### methodologies/ — Study design plugins

| File | Strategy | Rows Per Patient |
|------|----------|-----------------|
| `longitudinal-prediction.js` | Repeated-index yearly spine. Uses `generate_series` (PostgreSQL) or `ROW_NUMBER()` (SQL Server) to create yearly index offsets from cohort entry date. Each row has its own baseline look-back and outcome look-forward window. | Multiple (one per year) |
| `single-window.js` | Single baseline + outcome window anchored at cohort entry date. No yearly repetition. Simpler and faster when a repeated-index design is not needed. | Exactly one |

### templates/ — Analysis script generators

| File | Language | Output File | Algorithm |
|------|----------|------------|-----------|
| `logistic-regression.js` | Python | `run.py` | scikit-learn LogisticRegression with StandardScaler, mean imputation |
| `decision-tree.js` | Python | `run_decision_tree.py` | scikit-learn DecisionTreeClassifier with median imputation, classification report |

### docs/ — Reference specifications (not loaded at runtime)

| File | Purpose |
|------|---------|
| `study-config.schema.json` | JSON schema for the study configuration object |
| `rule-types.json` | Evidence row type definitions |
| `pack.schema.json` | Output package schema |
| `fhir-map.json` | Future: FHIR data model mapping stub |
| `i2b2-map.json` | Future: i2b2 data model mapping stub |

### examples/ — Example generated output

The `diabetes_nephropathy/` folder contains a complete sample package
generated by the tool (study SQL, Python script, README, manifest,
detailed manifest with evidence logic).

---

## Global Namespace Reference

Everything attaches to `window.RapidML`. Here is the complete namespace map:

```
window.RapidML
  ├── .Adapters                    ← Data model adapter registry
  │     .register(adapter)           store adapter by adapter.id
  │     .get(id)                     retrieve by id
  │     .list()                      all registered adapters
  │
  ├── .Methodologies               ← Study methodology plugin registry
  │     .register(plugin)            store plugin by plugin.id
  │     .get(id)                     retrieve by id
  │     .list()                      all registered methodologies
  │
  ├── .AnalysisTemplates           ← Analysis template plugin registry
  │     .register(plugin)            store plugin by plugin.id
  │     .get(id)                     retrieve by id
  │     .list()                      all registered templates
  │
  ├── .Compiler                    ← Shared compiler namespace
  │     .Dialects                    DB syntax helpers (core/dialects.js)
  │     .Censoring                   censoring WHERE builder (omop/censoring.js)
  │     .Covariates                  feature SQL builder (omop/covariates.js)
  │     .prepareContext()            shared context (omop/compiler.js)
  │     .buildConceptCTEs()          concept resolution
  │     .buildCohortCTE()            cohort entry
  │     .buildAnchorCTE()            date anchoring
  │     .buildFirstOutcomeCTE()      first outcome
  │     .buildCensoredSpineCTE()     censoring
  │     .outcomeLabelExpr()          outcome CASE expression
  │     .buildFinalSelect()          SELECT columns + JOINs
  │     .buildHeader()               SQL file header comment
  │     .buildPerformanceHints()     DB-specific ANALYZE hints
  │     .buildDebugHelpers()         temp-table utilities
  │     .buildDebug*Step()           debug step builders
  │     .buildArtifacts()            detailed manifest (omop/artifacts.js)
  │     .sqlLines()                  join non-empty lines
  │
  ├── .EvidenceUI                  ← Evidence block forms (core/evidence-ui.js)
  │     .renderBlock()               render an evidence block container
  │     .collectBlockData()          collect rows from a block
  │     .collectListData()           collect flat list (exclusions/confounders)
  │     .collectStudyDefinition()    collect all four blocks
  │     .applyDiabetesExample()      pre-fill diabetes example
  │     .applyDiabetesLabExample()   pre-fill diabetes + lab example
  │
  └── .ConceptReference            ← Concept ID library (omop/concepts.js)
        .conditions[]                condition concepts
        .measurements[]              lab/measurement concepts
        .drugs[]                     drug concepts
        .procedures[]                procedure concepts
        .getCategories()             category metadata
        .renderAll()                 HTML for the sidebar
        .addConcept(cat, id, name)   extend the library
```

---

## The Config Object

The config object is the central data structure that flows through the
entire system. It is created by `normalizeConfig()` and consumed by
every plugin.

```javascript
{
  // ── Database settings ──────────────────────────────
  db: "postgres",              // "postgres" or "sqlserver"
  schema: "cdm_synthea10",     // OMOP schema name (SQL identifier)
  dataModel: "omop",           // adapter ID — selects the registered adapter

  // ── Study period ───────────────────────────────────
  startYear: "2016",           // study start (string — used in date literals)
  endYear: "2024",             // study end

  // ── Time windows (in days) ─────────────────────────
  baselineDays: "365",         // look-back from index date
  outcomeDays: "365",          // look-forward for outcome events

  // ── Mode flags ─────────────────────────────────────
  debug: false,                // true → generate step-by-step temp tables
  bestPracticeMode: false,     // true → include detailed manifest.json

  // ── Plugin selections ──────────────────────────────
  methodology: "longitudinal-prediction",   // methodology plugin ID
  analysisTemplate: "logistic-regression",  // template plugin ID

  // ── Covariates ─────────────────────────────────────
  covariateEncoding: "count",  // "count" | "binary" | "count_and_binary"
  covariates: [                // array of selected covariate IDs
    "age_at_index",
    "sex_concept_id",
    "baseline_condition_count",
    "baseline_drug_count",
    "baseline_visit_count",
    "baseline_measurement_count"
  ],

  // ── Study definition (evidence blocks) ─────────────
  study: {
    entry: {                   // cohort entry criteria
      match: "all",            //   "all" = every row must match
      rows: [                  //   "any" = at least one row
        {
          type: "diagnosis",        // row type (see table below)
          conceptId: "201826",      // OMOP concept ID
          descendants: true,        // include concept_ancestor descendants?
          operator: null,           // lab/observation only: ">","<",">=","<="
          value: null,              // lab/observation only: numeric threshold
          label: null,              // human-readable label
          minCount: 1,              // minimum matching records
          distinctVisits: false,    // count distinct visit_occurrence IDs?
          visitContext: "all",      // "all"|"inpatient"|"outpatient"|"emergency"|"custom"
          visitContextIds: []       // custom visit concept IDs (when visitContext="custom")
        }
      ]
    },
    outcome: {                 // outcome to predict (same format as entry)
      match: "any",
      rows: [...]
    },
    exclusions: [              // patients to exclude (flat array, no match mode)
      { type: "...", conceptId: "...", label: "...", ... }
    ],
    confounders: [             // binary flag columns (flat array, no match mode)
      { type: "...", conceptId: "...", label: "hypertension", ... }
    ]
  }
}
```

### Evidence row types

| Type | When to use | Extra fields |
|------|-------------|-------------|
| `diagnosis` | Match a condition/disease | `descendants`, `visitContext` |
| `lab` | Match a lab value with threshold | `operator`, `value`, `visitContext` |
| `drug` | Match a drug exposure | `descendants`, `visitContext` |
| `procedure` | Match a procedure | `descendants`, `visitContext` |
| `observation` | Match an observation value | `descendants`, `operator`, `value`, `visitContext` |
| `visit` | Match a specific visit type | (concept ID = visit type) |

### Covariate IDs

| ID | Group | Description |
|----|-------|-------------|
| `age_at_index` | Demographics | Age in years at index date |
| `sex_concept_id` | Demographics | Gender concept ID from person table |
| `race_concept_id` | Demographics | Race concept ID |
| `ethnicity_concept_id` | Demographics | Ethnicity concept ID |
| `baseline_condition_count` | Baseline counts | Number of conditions in baseline period |
| `baseline_drug_count` | Baseline counts | Number of drug exposures in baseline period |
| `baseline_visit_count` | Baseline counts | Number of visits in baseline period |
| `baseline_measurement_count` | Baseline counts | Number of measurements in baseline period |
| `baseline_egfr` | Baseline labs | Most recent eGFR in baseline period |
| `baseline_creatinine` | Baseline labs | Most recent creatinine |
| `baseline_hba1c` | Baseline labs | Most recent HbA1c |
| `baseline_systolic_bp` | Baseline labs | Most recent systolic blood pressure |
| `baseline_diastolic_bp` | Baseline labs | Most recent diastolic blood pressure |
| `baseline_bmi` | Baseline labs | Most recent BMI |
| `prior_outcome_history` | Prior history | 1 if outcome occurred before baseline |
| `prior_hospitalization_flag` | Prior history | 1 if any inpatient visit before baseline |
| `prior_er_visit_flag` | Prior history | 1 if any ER visit before baseline |
| `prior_procedure_flag` | Prior history | 1 if any procedure before baseline |

---

## How Evidence Blocks Work

### Overview

The wizard uses a composable **evidence block** model instead of
predefined rules. Each block contains one or more rows, and rows can
be combined with "all" (intersection) or "any" (union).

### Data collection flow

```
 User adds rows in the "Study Definition" step (step 2)
        │
        ├─► EvidenceUI.renderBlock("entryBlock", {...})
        │     renders row forms with type dropdown + inputs
        │     returns a handle with addRow() and getRows()
        │
        ├─► User interacts: adds rows, selects types,
        │     enters concept IDs, checks descendants, etc.
        │
        ├─► EvidenceUI.collectStudyDefinition()
        │     reads all DOM elements → returns the study
        │     definition object (entry, outcome, exclusions,
        │     confounders)
        │
        └─► updateSelfCheck()
              validates: entry rows > 0 AND outcome rows > 0
              shows green/red indicator on step 5
```

### How a single row becomes SQL

Each evidence row goes through three transformations in the OMOP adapter
(`omop/evidence-sql.js`):

```
 Evidence row (data-model-agnostic)
        │
        ▼
 1. CONCEPT CTE
    Resolves concept ID + descendants via concept_ancestor table.
    Example: entry_r0_concepts AS (
      SELECT descendant_concept_id AS concept_id
      FROM schema.concept_ancestor
      WHERE ancestor_concept_id = 201826
    )
        │
        ▼
 2. EVENT SUBQUERY
    Finds matching events in the OMOP table.
    Example: SELECT co.person_id, MIN(co.condition_start_date) AS event_date
             FROM schema.condition_occurrence co
             WHERE co.condition_concept_id IN (SELECT concept_id FROM entry_r0_concepts)
             GROUP BY co.person_id
        │
        ▼
 3. COMBINER CTE
    Applies the match mode across multiple rows.
    - match="all" → HAVING COUNT(DISTINCT row_idx) = N, uses MAX(event_date)
    - match="any" → UNION ALL, uses MIN(event_date)
```

### Row type to OMOP table mapping

| Row Type | OMOP Table | Concept Column | Date Column |
|----------|-----------|---------------|-------------|
| `diagnosis` | `condition_occurrence` | `condition_concept_id` | `condition_start_date` |
| `lab` | `measurement` | `measurement_concept_id` | `measurement_date` |
| `drug` | `drug_exposure` | `drug_concept_id` | `drug_exposure_start_date` |
| `procedure` | `procedure_occurrence` | `procedure_concept_id` | `procedure_date` |
| `observation` | `observation` | `observation_concept_id` | `observation_date` |
| `visit` | `visit_occurrence` | `visit_concept_id` | `visit_start_date` |

### Visit context filtering

Any evidence row (except `visit` and `lab` by default) can optionally
filter by visit type. The adapter builds a JOIN to `visit_occurrence`:

| Visit Context | Concept IDs used |
|--------------|-----------------|
| `all` | No filter (any visit) |
| `inpatient` | 9201 |
| `outpatient` | 9202 |
| `emergency` | 9203 |
| `custom` | User-provided list |

### MinCount and Distinct Visits

- **minCount** — requires at least N matching records (uses HAVING COUNT).
- **distinctVisits** — when true, counts distinct `visit_occurrence_id`
  instead of raw records (uses HAVING COUNT(DISTINCT v.visit_occurrence_id)).

---

## The SQL Compilation Pipeline

### Production mode (single CTE chain)

```sql
WITH
  -- 1. Concept resolution (one CTE per evidence row with descendants)
  entry_r0_concepts AS (...),
  outcome_r0_concepts AS (...),

  -- 2. Cohort entry (person_id, t0 = earliest qualifying event date)
  cohort AS (...),

  -- 3. Index anchor (clamp t0 to study start, compute first_index_date)
  index_anchor AS (...),

  -- 4. Integer series (longitudinal only — for yearly offsets)
  nums AS (SELECT generate_series(0, 20) AS n),

  -- 5. Spine (the methodology's unique contribution)
  --    Longitudinal: one row per (person, year)
  --    Single-window: one row per person
  spine AS (...),

  -- 6. First outcome (person_id, outcome_date)
  first_outcome AS (...),

  -- 7. Censored spine (remove rows outside valid periods)
  final_spine AS (...)

-- 8. Final labelled dataset
SELECT
  s.*,                           -- time window columns
  CASE WHEN ... END AS outcome_label,  -- 0 or 1
  age_at_index,                  -- covariates
  sex_concept_id,
  (SELECT COUNT(*) ...) AS baseline_condition_count,
  ...
FROM final_spine s
LEFT JOIN person p ON p.person_id = s.person_id
ORDER BY s.person_id, s.index_date;
```

### Debug mode (step-by-step temp tables)

In debug mode, each step creates a temporary table with a row count
checkpoint. This allows running each step independently and inspecting
intermediate results:

```sql
-- STEP 5: Build cohort
DROP TABLE IF EXISTS tmp_cohort;    -- or #tmp_cohort on SQL Server
CREATE TEMP TABLE tmp_cohort AS ...;
SELECT COUNT(*) AS cohort_size FROM tmp_cohort;

-- STEP 6: Build index anchor
DROP TABLE IF EXISTS tmp_index_anchor;
CREATE TEMP TABLE tmp_index_anchor AS ...;
SELECT TOP 20 * FROM tmp_index_anchor ORDER BY person_id;

-- ... and so on for each step
```

### Censoring rules

The compiler applies four censoring conditions (via `omop/censoring.js`):

1. **Outcome timing**: outcome_date must be on or after outcome_start (no
   pre-existing outcomes counted)
2. **Observation start**: baseline_start must be >= observation_period_start_date
3. **Observation end**: outcome_end must be <= observation_period_end_date
4. **Study boundary**: outcome_end must be <= study end date

---

## Create a New Data Model Adapter

**Goal:** Make the wizard work with a non-OMOP clinical database (e.g.
FHIR, i2b2, PCORnet).

**Files to create:** `<model>/evidence-sql.js`

An adapter converts evidence blocks (data-model-agnostic) into
data-model-specific SQL. The adapter must implement seven methods and
call `RapidML.Adapters.register()` on load.

### Step 1: Create the adapter file

Create `fhir/evidence-sql.js`:

```javascript
(function () {

  // ── Helper functions ────────────────────────────────
  // Put your SQL-building helpers here.

  // ── Adapter registration ────────────────────────────
  RapidML.Adapters.register({
    id: "fhir",                          // unique ID (matches dataModel config key)
    label: "FHIR R4",                    // human-readable name for dropdown

    /**
     * Return array of concept-resolution CTE strings.
     * These resolve each evidence row's concept ID into the full set
     * of related codes for your data model.
     *
     * @param  {object} config  normalised study configuration
     * @return {string[]}       array of "cte_name AS (...)" strings
     */
    buildConceptCTEs: function (config) {
      // For FHIR: might query a ValueSet expansion table instead
      // of OMOP's concept_ancestor.
      return [];
    },

    /**
     * Return a single CTE string that produces the cohort.
     * Must output columns: person_id, t0
     *
     * @param  {object} config
     * @return {string}         "cohort AS (...)" CTE text
     */
    buildCohortCTE: function (config) {
      // Build from config.study.entry block
      return "cohort AS (SELECT ...)";
    },

    /**
     * Return a single CTE string that finds the first outcome event.
     * Must output columns: person_id, outcome_date
     *
     * @param  {object} config
     * @return {string}         "first_outcome AS (...)" CTE text
     */
    buildFirstOutcomeCTE: function (config) {
      return "first_outcome AS (SELECT ...)";
    },

    /**
     * Return a SQL CASE expression string for the outcome label.
     * The expression is used in the final SELECT and must alias
     * to outcome_label.
     *
     * @param  {object} config
     * @return {string}         "CASE WHEN ... END AS outcome_label"
     */
    buildOutcomeLabelExpr: function (config) {
      return "CASE WHEN ... THEN 1 ELSE 0 END AS outcome_label";
    },

    /**
     * Return a WHERE clause fragment for exclusions.
     * Return null or empty string if no exclusions defined.
     *
     * @param  {object} config
     * @return {string|null}    "AND NOT EXISTS (...)" fragment
     */
    buildExclusionWhere: function (config) {
      return null;
    },

    /**
     * Return confounder column expressions and any extra JOINs.
     *
     * @param  {object} config
     * @return {object}         { columns: string[], joins: string[] }
     */
    buildConfounderColumns: function (config) {
      return { columns: [], joins: [] };
    },

    /**
     * Return backward-compatibility bridge objects.
     * The compiler uses these for shared operations like censoring.
     *
     * @param  {object} config
     * @return {object}         { outcomes: {...}, cohortEntry: {...} }
     */
    buildDomainBridge: function (config) {
      var self = this;
      return {
        outcomes: {
          entryConditionRootCTE: function () { return null; },
          entryConditionDescendantsCTE: function () { return null; },
          outcomeRootCTE: function () { return null; },
          outcomeDescendantsCTE: function () { return null; },
          firstOutcomeCTE: function (cfg) { return self.buildFirstOutcomeCTE(cfg); },
          outcomeLabelExpr: function (cfg) { return self.buildOutcomeLabelExpr(cfg); }
        },
        cohortEntry: {
          buildCohortCTE: function (cfg) { return self.buildCohortCTE(cfg); }
        }
      };
    }
  });

})();
```

### Step 2: Add the script tag to index.html

Insert after the OMOP evidence adapter script tag:

```html
<!-- FHIR data model adapter -->
<script src="fhir/evidence-sql.js?v=18"></script>
```

### Step 3: Add the data model option to the dropdown

In `index.html`, find the `<select id="dataModel">` element and add:

```html
<option value="fhir">FHIR R4</option>
```

### Step 4: Test

1. Open `index.html` in a browser.
2. Select your data model from the dropdown.
3. Add evidence rows for entry and outcome.
4. Check the self-check panel on the Review step (step 5).
5. Click Generate Package and inspect `study.sql`.
6. Test with both PostgreSQL and SQL Server.

### Adapter contract reference

| Method | Must Return | Used By |
|--------|------------|---------|
| `buildConceptCTEs(config)` | Array of CTE strings | `compiler.buildConceptCTEs` |
| `buildCohortCTE(config)` | Single CTE string (`cohort AS (...)`) | `compiler.buildCohortCTE` |
| `buildFirstOutcomeCTE(config)` | Single CTE string (`first_outcome AS (...)`) | `compiler.buildFirstOutcomeCTE` |
| `buildOutcomeLabelExpr(config)` | SQL expression ending with `AS outcome_label` | `compiler.outcomeLabelExpr` |
| `buildExclusionWhere(config)` | SQL WHERE fragment or `null` | `compiler.buildCensoredSpineCTE` |
| `buildConfounderColumns(config)` | `{ columns: string[], joins: string[] }` | `compiler.buildFinalSelect` |
| `buildDomainBridge(config)` | `{ outcomes: {...}, cohortEntry: {...} }` | `compiler.prepareContext` |

---

## Add a New Methodology

**Goal:** Add a new study design (e.g. case-control matching, sliding
window, event-driven).

**Folder:** `methodologies/`

A methodology owns the **spine strategy** — how patient time-window rows
are structured. It uses the compiler toolkit for everything else
(concepts, cohort, censoring, covariates).

### Step 1: Create the plugin file

Create `methodologies/my-methodology.js`:

```javascript
/**
 * ============================================================================
 * MY-METHODOLOGY.JS - Methodology Plugin: [Your Description]
 * ============================================================================
 *
 * PURPOSE:
 *   [Describe how patient rows are structured]
 *
 * SELF-REGISTERS on RapidML.Methodologies
 * DEPENDS ON: core/generator.js, core/dialects.js, omop/compiler.js
 * ============================================================================
 */
(function () {

  // ── Production SQL ──────────────────────────────────
  function buildProductionSQL(config) {
    var C = RapidML.Compiler;
    var ctx = C.prepareContext(config);
    var baselineDays = String(Number(config.baselineDays) || 365);

    // Assemble CTEs using compiler building blocks
    var ctes = C.buildConceptCTEs(config, ctx).concat([
      C.buildCohortCTE(config, ctx),
      C.buildAnchorCTE(config, ctx, baselineDays),

      // ═══ YOUR SPINE STRATEGY HERE ═══
      // This is the ONLY part that differs between methodologies.
      // Example: one row per patient
      "spine AS (\n" +
      "  SELECT a.person_id, a.t0, a.exposure_index_date,\n" +
      "    a.first_index_date AS index_date,\n" +
      "    a.exposure_index_date AS baseline_start,\n" +
      "    " + ctx.d.addDaysExpr(config.db, "a.first_index_date", "-1") +
              " AS baseline_end,\n" +
      "    a.first_index_date AS outcome_start,\n" +
      "    " + ctx.d.addDaysExpr(config.db, "a.first_index_date", baselineDays) +
              " AS outcome_end\n" +
      "  FROM index_anchor a\n" +
      ")",
      // ═══ END SPINE STRATEGY ═══

      C.buildFirstOutcomeCTE(config, ctx),
      C.buildCensoredSpineCTE(config, ctx)
    ]);

    var sel = C.buildFinalSelect(config, ctx);

    return C.sqlLines([
      C.buildHeader(config, "My Methodology"),
      C.buildPerformanceHints(config),
      "WITH " + ctes.join(",\n"),
      "SELECT",
      "  " + sel.columns.join(",\n  "),
      "FROM final_spine s",
      sel.joins.join("\n"),
      "ORDER BY s.person_id;"
    ]);
  }

  // ── Debug SQL ───────────────────────────────────────
  function buildDebugSQL(config) {
    var C = RapidML.Compiler;
    var ctx = C.prepareContext(config);
    var dbg = C.buildDebugHelpers(config, ctx);
    var baselineDays = String(Number(config.baselineDays) || 365);

    // Steps 1-5 are shared (concepts + cohort)
    var conceptSteps = C.buildDebugConceptSteps(config, ctx, dbg);
    var cohortStep = C.buildDebugCohortStep(config, ctx, dbg);

    // Step 6: your anchor (shared)
    var anchorStep = C.sqlLines([
      "",
      "-- STEP 6: Build index anchor",
      dbg.dropTemp("index_anchor"),
      dbg.createTempFromSelect(
        "index_anchor",
        "  c.person_id,\n  c.t0,\n  c.t0 AS exposure_index_date,\n" +
        "  " + ctx.d.addDaysExpr(config.db, "c.t0", baselineDays) +
        " AS first_index_date",
        "FROM " + dbg.tmpName("cohort") + " c"
      ),
      dbg.selectTop(dbg.tmpName("index_anchor"), "person_id")
    ]);

    // Step 7: YOUR SPINE as a temp table
    var spineStep = C.sqlLines([
      "",
      "-- STEP 7: Build spine (your methodology)",
      dbg.dropTemp("spine"),
      dbg.createTempFromSelect(
        "spine",
        "  a.person_id,\n  a.t0,\n  a.exposure_index_date,\n" +
        "  a.first_index_date AS index_date,\n" +
        "  a.exposure_index_date AS baseline_start,\n" +
        "  " + ctx.d.addDaysExpr(config.db, "a.first_index_date", "-1") +
        " AS baseline_end,\n" +
        "  a.first_index_date AS outcome_start,\n" +
        "  " + ctx.d.addDaysExpr(config.db, "a.first_index_date", baselineDays) +
        " AS outcome_end",
        "FROM " + dbg.tmpName("index_anchor") + " a"
      ),
      "SELECT COUNT(*) AS spine_rows FROM " + dbg.tmpName("spine") + ";"
    ]);

    // Steps 8-10: outcome, censoring, final (shared)
    var outcomeStep = C.buildDebugOutcomeStep(config, ctx, dbg, 8);
    var censorStep  = C.buildDebugCensoringStep(config, ctx, dbg, 9, dbg.tmpName("spine"));
    var finalStep   = C.buildDebugFinalStep(config, ctx, dbg, 10);

    return C.sqlLines([
      C.buildHeader(config, "My Methodology DEBUG"),
      conceptSteps,
      cohortStep,
      anchorStep,
      spineStep,
      outcomeStep,
      censorStep,
      finalStep
    ]);
  }

  // ── README builder ──────────────────────────────────
  function describeRules(config) {
    return [
      "# Study: My Methodology",
      "",
      "## Configuration",
      "",
      "| Item | Value |",
      "|------|-------|",
      "| Database | " + config.db + " |",
      "| Schema | " + config.schema + " |",
      "| Study period | " + config.startYear + " to " + config.endYear + " |",
      "",
      "## SQL Pipeline",
      "",
      "1. Resolve concept descendants.",
      "2. Build cohort.",
      "3. Build spine (your strategy description here).",
      "4. Apply censoring.",
      "5. Compute outcome_label and covariates."
    ].join("\n");
  }

  // ── Plugin registration ─────────────────────────────
  RapidML.Methodologies.register({
    id: "my-methodology",
    label: "My Methodology",
    buildSQL: function (config) {
      return config.debug ? buildDebugSQL(config) : buildProductionSQL(config);
    },
    describeRules: describeRules
  });

})();
```

### Step 2: Add the script tag to index.html

Insert after the existing methodology script tags:

```html
<script src="methodologies/my-methodology.js?v=18"></script>
```

### Step 3: Test

The methodology automatically appears in the Study Methodology dropdown —
no other wiring needed. Select it, generate a package, and verify the SQL.

### Methodology plugin interface

| Property | Type | Required | Description |
|----------|------|----------|-------------|
| `id` | string | Yes | Unique ID, used in config.methodology |
| `label` | string | Yes | Display name for the dropdown |
| `buildSQL(config)` | function | Yes | Returns complete SQL string |
| `describeRules(config)` | function | Yes | Returns Markdown README string |

---

## Add a New Analysis Template

**Goal:** Generate a different analysis script (e.g. random forest, XGBoost,
R script).

**Folder:** `templates/`

### Step 1: Create the template file

Create `templates/random-forest.js`:

```javascript
/**
 * ============================================================================
 * RANDOM-FOREST.JS - Analysis Template Plugin: Random Forest
 * ============================================================================
 *
 * SELF-REGISTERS on RapidML.AnalysisTemplates
 * DEPENDS ON: core/generator.js
 * ============================================================================
 */
(function () {

  RapidML.AnalysisTemplates.register({
    id: "random-forest",
    label: "Random Forest (Python)",
    language: "python",
    filename: "run_random_forest.py",

    /**
     * Generate the Python analysis script.
     *
     * @param  {object} config  normalised study configuration
     * @return {string}         complete Python source code
     */
    buildScript: function (config) {
      return [
        "import os",
        "from pathlib import Path",
        "",
        "import pandas as pd",
        "from sqlalchemy import create_engine, text",
        "from sklearn.ensemble import RandomForestClassifier",
        "from sklearn.impute import SimpleImputer",
        "from sklearn.metrics import classification_report",
        "from sklearn.model_selection import train_test_split",
        "",
        "# ... your template code here ...",
        "",
        "if __name__ == '__main__':",
        "    main()"
      ].join("\\n");
    }
  });

})();
```

> **Important:** Use `[...].join("\\n")` instead of template literals
> (backticks) to stay ES5-compatible.

### Step 2: Add the script tag to index.html

```html
<script src="templates/random-forest.js?v=18"></script>
```

### Step 3: Test

The template automatically appears in the Analysis Template dropdown.

### Template plugin interface

| Property | Type | Required | Description |
|----------|------|----------|-------------|
| `id` | string | Yes | Unique ID, used in config.analysisTemplate |
| `label` | string | Yes | Display name for the dropdown |
| `language` | string | No | Language identifier (informational) |
| `filename` | string | Yes | Output file name in the zip package |
| `buildScript(config)` | function | Yes | Returns complete script content string |

---

## Add New Covariates

**File to edit:** `omop/covariates.js`

### Step 1: Add the covariate ID to buildSelect()

Inside the `buildSelect()` function, add a new `if` block in the
`selected.forEach` loop:

```javascript
if (id === "my_new_covariate") {
  cols.push("(SELECT COUNT(*) FROM " + config.schema +
    ".my_table x WHERE x.person_id = s.person_id " +
    "AND x.my_date BETWEEN s.baseline_start AND s.baseline_end" +
    ") AS my_new_covariate");
  return;
}
```

### Step 2: Add the checkbox to index.html

In the covariates section (step 4), add a checkbox inside the
appropriate `<fieldset>`:

```html
<label class="flex items-center gap-2 cursor-pointer">
  <input type="checkbox" name="covariates" value="my_new_covariate"
         class="w-3.5 h-3.5 rounded"/>
  <span>My new covariate</span>
</label>
```

### Step 3: Add to presets (optional)

In `core/wizard-ui.js`, add your covariate ID to the `extended` preset
(or create a new preset) in `getCovariatePresetMap()`.

### Step 4: Test

Check the box, generate a package, and verify the covariate appears in
the SQL output and the generated README.

---

## Add New Concept References

**File to edit:** `omop/concepts.js`

### Option A: Add directly to the source

Add entries to the appropriate array (`conditions`, `measurements`,
`drugs`, or `procedures`):

```javascript
// In the conditions array:
{ id: "12345", name: "My Condition" },

// Or add a new category entirely:
my_category: [
  { id: "100", name: "New Item A" },
  { id: "200", name: "New Item B" }
],
```

If adding a new category, also update `getCategories()`:

```javascript
{ key: "my_category", label: "My Category", icon: "🔍" },
```

### Option B: Add at runtime

```javascript
RapidML.ConceptReference.addConcept("conditions", "12345", "My Condition");
RapidML.ConceptReference.addConcepts("drugs", [
  { id: "111", name: "Drug A" },
  { id: "222", name: "Drug B" }
]);
```

---

## Coding Standards

### ES5 only — no ES6 features

| Do This (ES5) | Do NOT Do This (ES6) |
|---------------|---------------------|
| `var x = 1;` | `const x = 1;` or `let x = 1;` |
| `function(x) { return x; }` | `(x) => x` |
| `"hello " + name` | `` `hello ${name}` `` |
| `[...].join("\\n")` for multiline strings | backtick template literals |
| `.then(function(result) {...})` | `async/await` |
| Manual loop or `Array.prototype.forEach` | `Array.from()`, `Object.values()` |

### File headers

Every `.js` file should have a documentation header block explaining:
- **PURPOSE** — what the file does
- **HOW IT WORKS** — the mechanism or data flow
- **DEPENDS ON** — which files must be loaded first
- **USED BY** — which files consume this one
- **PUBLIC API** — all exported functions/objects

### IIFE pattern

Wrap all file code in an Immediately Invoked Function Expression to
avoid polluting the global scope:

```javascript
(function () {
  // ... all code here ...
  // expose public API at the end:
  RapidML.MyModule = { ... };
})();
```

Exception: `generator.js` and `wizard-ui.js` expose some functions
globally because `index.html` calls them directly (e.g. `generate()`,
`updateSelfCheck()`).

### SQL safety

- Use `sanitizeIdentifier()` for user-provided schema names.
- Use `validateOperator()` for SQL comparison operators (whitelist only).
- Never concatenate raw user input into SQL. All concept IDs are
  stripped to digits only via `String(val).replace(/[^0-9]/g, "")`.

---

## Naming Conventions

| Category | Pattern | Example |
|----------|---------|---------|
| Adapter IDs | `kebab-case` | `omop`, `fhir` |
| Methodology IDs | `kebab-case` | `longitudinal-prediction` |
| Template IDs | `kebab-case` | `logistic-regression` |
| File names | `kebab-case.js` | `evidence-sql.js` |
| SQL CTE names | `snake_case` | `entry_r0_concepts` |
| Config keys | `camelCase` | `dataModel`, `baselineDays` |
| Covariate IDs | `snake_case` | `baseline_condition_count` |
| HTML element IDs | `camelCase` | `entryBlock`, `selfCheckPanel` |
| CSS classes | `kebab-case` with prefixes | `ev-type`, `ev-concept` |

---

## Script Load Order

Scripts must be loaded in this exact order in `index.html` because of
dependencies between files:

```
 1. core/generator.js          ← sets up RapidML namespace + all registries
 2. core/dialects.js           ← DB syntax helpers (standalone)
 3. core/evidence-ui.js        ← evidence row forms (standalone)
 4. omop/concepts.js           ← concept reference data (standalone)
 5. omop/covariates.js         ← feature SQL builder (standalone)
 6. omop/censoring.js          ← censoring WHERE clause (needs dialects)
 7. omop/artifacts.js          ← best-practice artefacts (standalone)
 8. omop/compiler.js           ← compiler toolkit (needs dialects, censoring,
                                  covariates, adapter registry)
 9. omop/evidence-sql.js       ← OMOP adapter (needs generator for
                                  Adapters.register, needs compiler)
10. methodologies/*.js         ← study design plugins (need compiler)
11. templates/*.js             ← analysis script generators (need generator
                                  for AnalysisTemplates.register)
12. core/wizard-ui.js          ← UI controller (needs EVERYTHING above)
```

When adding a new file, insert its `<script>` tag at the correct position
based on its dependencies.

---

## Testing Checklist

### Core functionality

- [ ] Evidence blocks render correctly (entry, outcome, exclusions, confounders)
- [ ] Adding/removing rows works for all block types
- [ ] Type dropdown changes show/hide the correct fields (lab fields, descendants checkbox, visit context)
- [ ] Visit context dropdown shows/hides custom IDs input
- [ ] Match mode toggles (all/any) reflect in generated SQL
- [ ] Self-check panel shows green/red for required field validation
- [ ] All five wizard steps are navigable via sidebar and next/prev buttons

### SQL generation

- [ ] Generated SQL is syntactically valid for PostgreSQL
- [ ] Generated SQL is syntactically valid for SQL Server
- [ ] Concept descendants are resolved via `concept_ancestor` table
- [ ] Multi-row blocks with `match=all` use `HAVING COUNT(DISTINCT row_idx) = N`
- [ ] Multi-row blocks with `match=any` use `UNION ALL` + `MIN(event_date)`
- [ ] Exclusion rows correctly generate `NOT EXISTS` clauses
- [ ] Confounder rows correctly generate binary flag columns
- [ ] Covariates appear in the final SELECT with correct JOINs
- [ ] Debug mode produces step-by-step temp tables with row counts
- [ ] Production mode produces a single CTE chain

### Generated output

- [ ] Generated README describes the study configuration accurately
- [ ] Generated Python script connects to DB and runs the SQL
- [ ] Detailed manifest.json is included in best-practice mode with full evidence logic
- [ ] All files have correct timestamps in filenames
- [ ] Zip package downloads correctly (when JSZip is loaded)
- [ ] Individual file fallback works (when JSZip is unavailable)

### Plugin system

- [ ] New methodology appears in the dropdown after adding `<script>` tag
- [ ] New template appears in the dropdown after adding `<script>` tag
- [ ] New adapter appears via data model dropdown after adding `<script>` + `<option>`
- [ ] Example buttons pre-fill evidence rows correctly

### Edge cases

- [ ] Empty schema name is caught by validation
- [ ] Start year >= end year is caught by validation
- [ ] Zero or negative baseline/outcome days are caught
- [ ] Invalid operators are sanitised to safe default (`>`)
- [ ] Schema names with special characters are rejected
- [ ] Concept IDs with non-numeric characters are stripped

---

## Debugging Tips

### Browser console

Open `F12` → Console tab. Common things to check:

```javascript
// Inspect the current config
getFormConfig()

// Check registered plugins
RapidML.Methodologies.list()
RapidML.AnalysisTemplates.list()
RapidML.Adapters.list()

// Check evidence data
RapidML.EvidenceUI.collectStudyDefinition()

// Check compiler readiness
RapidML.Compiler.prepareContext(getFormConfig())
```

### Common issues

| Symptom | Likely Cause |
|---------|-------------|
| Methodology dropdown says "Loading..." | generator.js failed to load or syntax error in a methodology file |
| "Compiler modules not loaded" error | Script load order is wrong — check that dialects, censoring, covariates, and adapter-registry load before compiler.js |
| Generated SQL has `undefined` in it | A compiler building block returned `undefined` — check that evidence rows have valid concept IDs |
| Self-check panel shows "Missing" for entry/outcome | Evidence blocks are empty — add at least one row to entry and outcome |
| Zip download does not start | JSZip CDN may be blocked — check network tab for failed loads |
| Evidence rows do not appear | evidence-ui.js failed to load or container element ID does not match |

### Inspecting generated SQL

Before downloading, you can preview the SQL in the console:

```javascript
var config = getFormConfig();
var methodology = RapidML.Methodologies.get(config.methodology);
console.log(methodology.buildSQL(config));
```

---

## Questions?

Open an issue describing what you want to add. Include:

- **Which extension point** — adapter, methodology, template, or covariate
- **The clinical use case** — what study design you are trying to support
- **The target data model** — OMOP, FHIR, i2b2, PCORnet, or other
- **Sample concept IDs** — if applicable
- **Expected SQL output** — a hand-written example of the SQL you want generated
