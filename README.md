# Rapid ML-Ready Wizard

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

A browser-based wizard that generates ML-ready datasets from clinical databases. No build step, no server — open `index.html` and go.

This is **not** a replacement for [ATLAS/OHDSI](https://www.ohdsi.org/analytic-tools/atlas/). It is a lightweight, wizard-driven template tool for:

- Evidence-block study definitions (composable diagnosis, lab, drug, and procedure rows)
- Pluggable data model adapters (OMOP CDM included; FHIR and i2b2 documented for future work)
- Longitudinal window-based study design (repeated-index spine)
- ML-ready dataset preparation (features + binary outcome labels)
- Generating SQL + Python analysis scripts as a downloadable package

---

## Quick Start

1. Open `index.html` in a browser.
2. Set database type, schema, study years, and data model.
3. Define cohort entry and outcome using evidence blocks (add rows for diagnoses, labs, drugs, procedures).
4. Configure time windows and pick covariates.
5. Click **Generate Package** → download zip with `study.sql`, `README.md`, `run.py`.

---

## What Gets Generated

| File | Purpose |
|------|---------|
| `study.sql` | Complete SQL query (CTE pipeline or debug temp tables) |
| `README.md` | Study summary with all selected parameters |
| `run.py` | Python analysis script (logistic regression or decision tree) |
| `manifest.json` | Detailed study manifest with full evidence logic documentation (best-practice mode only) |

---

## Project Structure

```
index.html                        Main UI — open this in a browser
README.md                         This file
CONTRIBUTING.md                   How to add adapters, methodologies, templates
LICENSE                           MIT licence

core/                             Generic engine (data-model-independent)
  generator.js                      Central orchestrator + all plugin registries
                                     (adapters, methodologies, templates),
                                     form collection, validation, zip packaging
  dialects.js                       PostgreSQL vs SQL Server syntax helpers
  evidence-ui.js                    Dynamic evidence row forms + data collection
  wizard-ui.js                      Wizard form logic, navigation, presets,
                                     self-check validation panel

omop/                             OMOP CDM data model implementation
  evidence-sql.js                   OMOP evidence adapter — converts evidence
                                     blocks into OMOP-specific SQL CTEs
  compiler.js                       Compiler TOOLKIT — reusable SQL building
                                     blocks (concepts, cohort, anchor, spine,
                                     censoring, final select, debug helpers)
  censoring.js                      Censoring rules (observation period checks)
  covariates.js                     Feature engineering SQL (demographics,
                                     baseline counts, labs, prior history)
  concepts.js                       OMOP concept ID reference library for the
                                     wizard sidebar (click-to-copy)
  artifacts.js                      Best-practice artifacts (detailed manifest
                                     with full evidence logic documentation)

methodologies/                    Study design plugins (self-registering)
  longitudinal-prediction.js        Repeated-index yearly spine (many rows
                                     per patient with yearly index dates)
  single-window.js                  One row per patient (single baseline +
                                     outcome window)

templates/                        Analysis script generators (self-registering)
  logistic-regression.js            Python logistic regression (scikit-learn)
  decision-tree.js                  Python decision tree (scikit-learn)

docs/                             Reference specifications (not loaded at runtime)
  study-config.schema.json          JSON schema for study configuration
  rule-types.json                   Evidence row type definitions
  pack.schema.json                  Output package schema
  fhir-map.json                     Future: FHIR mapping stub
  i2b2-map.json                     Future: i2b2 mapping stub

examples/                         Example generated studies
  diabetes_nephropathy/             Sample output from a diabetes → nephropathy
                                     study (study.sql, run.py, README, etc.)
```

---

## Architecture — How Everything Fits Together

### High-Level Data Flow

```
User fills wizard form (index.html)
        │
        ▼
generator.js  collects config + evidence blocks
        │
        ├── getFormConfig()       reads all HTML inputs
        ├── normalizeConfig()     applies defaults
        └── validateConfig()      checks for errors
        │
        ▼
Methodology plugin  (e.g. longitudinal-prediction.js)
        │
        ├── buildSQL(config)      generates study.sql content
        │     │
        │     │  calls compiler BUILDING BLOCKS:
        │     ├── compiler.buildConceptCTEs()    concept resolution
        │     ├── compiler.buildCohortCTE()      cohort entry
        │     ├── compiler.buildAnchorCTE()      date anchoring
        │     ├── [methodology's own spine CTE]  ← this is what makes 
        │     │                                    each methodology unique
        │     ├── compiler.buildFirstOutcomeCTE()  outcome tracking
        │     ├── compiler.buildCensoredSpineCTE() censoring
        │     └── compiler.buildFinalSelect()      covariates + label
        │
        └── describeRules(config) generates README.md content
        │
        ▼
Analysis template plugin  (e.g. logistic-regression.js)
        │
        └── buildScript(config)   generates run.py content
        │
        ▼
downloadPackage()  creates timestamped zip with all files
```

### Three-Layer Design

```
Study Definition          Data Model Adapter        Query Builder
(what to study)           (how to map)              (SQL output)
─────────────────    →    ─────────────────    →    ──────────────
Evidence blocks           OMOP adapter              CTE pipeline
 - entry rows             (evidence-sql.js)         or debug temp
 - outcome rows                                     tables
 - exclusions             Future: FHIR, i2b2
 - confounders            adapters
```

1. **Study Definition** — Data-model-agnostic evidence blocks. Each row specifies a type (diagnosis, lab, drug, procedure), concept ID, and optional operator/value.
2. **Data Model Adapter** — Converts evidence blocks into data-model-specific SQL (currently OMOP CDM). New adapters register via `RapidML.Adapters.register()`.
3. **Query Builder** — The compiler toolkit assembles CTE chains. Each methodology plugin owns the spine (window strategy).

### Plugin Model

Methodologies, analysis templates, and data model adapters are **self-registering plugins**. Each file calls one of these on load:
- `RapidML.Methodologies.register(plugin)` — study design plugins
- `RapidML.AnalysisTemplates.register(plugin)` — analysis script generators
- `RapidML.Adapters.register(adapter)` — data model adapters

The wizard auto-populates dropdowns from whatever plugins are loaded.

---

## Script File Details

### core/generator.js — Central Orchestrator

**What it does:**
- Sets up the `window.RapidML` global namespace
- Provides three plugin registries (Adapters, Methodologies, AnalysisTemplates)
- Reads HTML form inputs → normalises → validates
- Orchestrates the generate() function that ties everything together
- Handles file download (individual files or zip package)

**Key functions:**
| Function | Purpose |
|----------|---------|
| `getFormConfig()` | Reads all form inputs into a raw config object |
| `normalizeConfig(raw)` | Applies defaults, coerces types |
| `validateConfig(config)` | Returns array of error strings (empty = valid) |
| `generate()` | Main entry point — collects, validates, generates, downloads |
| `downloadPackage(files, ts)` | Creates zip or falls back to individual downloads |
| `sanitizeIdentifier(value)` | Prevents SQL injection in schema names |
| `validateOperator(op)` | Whitelist-checks SQL comparison operators |

**Adapter registry (built-in):**
| Method | Purpose |
|--------|---------|
| `RapidML.Adapters.register(adapter)` | Store an adapter keyed by `adapter.id` |
| `RapidML.Adapters.get(id)` | Retrieve adapter by ID |
| `RapidML.Adapters.list()` | Get all registered adapters |

---

### core/dialects.js — Database Dialect Helpers

**What it does:**
- Provides a thin abstraction over PostgreSQL and SQL Server syntax differences.
- Every other file that builds SQL calls these helpers.

**Key functions:**
| Function | PostgreSQL Output | SQL Server Output |
|----------|------------------|------------------|
| `quoteDateLiteral(db, y, m, d)` | `DATE '2024-01-15'` | `CAST('2024-01-15' AS DATE)` |
| `addDaysExpr(db, expr, days)` | `(expr + (days) * INTERVAL '1 day')` | `DATEADD(DAY, days, expr)` |
| `addYearsExpr(db, expr, yrs)` | `(expr + (yrs) * INTERVAL '1 year')` | `DATEADD(YEAR, yrs, expr)` |
| `seriesCTE(db, alias, maxN)` | `generate_series(0, N)` | `TOP(N+1) ROW_NUMBER()` |

---

### core/evidence-ui.js — Evidence Block UI

**What it does:**
- Renders interactive evidence row forms in the Study Definition step.
- Handles add/remove rows, type-switching (show/hide lab fields, visit context, etc.).
- Collects all evidence data from the DOM into a study definition object.

**Block types rendered:**
| Block | Container ID | Purpose |
|-------|-------------|---------|
| Entry | `entryBlock` | Who enters the cohort |
| Outcome | `outcomeBlock` | What event to predict |
| Exclusions | `exclusionsBlock` | Patients to remove |
| Confounders | `confoundersBlock` | Binary flag columns |

**Key API:**
| Function | Returns |
|----------|---------|
| `renderBlock(containerId, options)` | Block handle with `addRow()` and `getRows()` |
| `collectStudyDefinition()` | `{ entry, outcome, exclusions, confounders }` |

---

### core/wizard-ui.js — Wizard UI Controller

**What it does:**
- Manages the 3-panel layout (left sidebar, centre form, right reference).
- Handles step navigation (5 steps), covariate presets, example buttons.
- Populates methodology/template dropdowns from plugin registries.
- Runs real-time self-check validation on every input change.

**11 sections (in execution order):**
1. Tab navigation — show/hide wizard sections
2. Covariate presets — minimal, clinical baseline, extended
2b. Custom covariates — add/remove rows for user-defined concept ID features
3. Visit filter — custom visit concept fields
4. Evidence block setup — initialise the 4 evidence containers
5. Example buttons — pre-fill with diabetes study examples
6. Concept reference panel — render OMOP concepts in right sidebar
7. Right panel toggle — show/hide button in header
8. Dropdown population — fill selects from registries
9. Self-check panel — live config validation
10. Initialisation — boot sequence via setTimeout(10ms)

---

### omop/evidence-sql.js — OMOP Evidence Adapter

**What it does:**
- Converts evidence blocks into OMOP CDM-specific SQL.
- Registered as the `"omop"` adapter via `RapidML.Adapters.register()`.
- Maps each evidence row type to the correct OMOP table and column.

**Row type mapping:**
| Row Type | OMOP Table | Concept Column |
|----------|-----------|---------------|
| diagnosis | `condition_occurrence` | `condition_concept_id` |
| lab | `measurement` | `measurement_concept_id` |
| drug | `drug_exposure` | `drug_concept_id` |
| procedure | `procedure_occurrence` | `procedure_concept_id` |
| observation | `observation` | `observation_concept_id` |
| visit | `visit_occurrence` | `visit_concept_id` |

**Per-row SQL generation:**
1. **Concept CTE** — resolves descendants via `concept_ancestor`
2. **Event subquery** — finds matching events (`person_id`, `MIN(date)`)
3. **HAVING clause** — enforces `minCount` / `distinctVisits`
4. **Visit JOIN** — filters by inpatient/outpatient/ER visit context

---

### omop/compiler.js — Compiler Toolkit

**What it does:**
- Provides reusable SQL building blocks. Does NOT build complete SQL.
- Each methodology calls these functions and adds its own spine.
- Routes all data-model-specific calls through the registered adapter.

**Building blocks:**
| Function | Output |
|----------|--------|
| `prepareContext(config)` | Shared context object (dialects, dates, covariates) |
| `buildConceptCTEs(config, ctx)` | Concept-resolution CTEs |
| `buildCohortCTE(config, ctx)` | `cohort` CTE (person_id, t0) |
| `buildAnchorCTE(config, ctx, days)` | `index_anchor` CTE (clamped dates) |
| `buildFirstOutcomeCTE(config, ctx)` | `first_outcome` CTE |
| `buildCensoredSpineCTE(config, ctx)` | `final_spine` CTE (censored) |
| `buildFinalSelect(config, ctx)` | SELECT columns + JOIN clauses |
| `buildDebugHelpers(config, ctx)` | Temp-table helper functions |

---

### omop/censoring.js — Censoring Rules

**What it does:**
- Builds the WHERE clause fragment that removes rows falling outside valid periods.
- Uses EXISTS subqueries for observation period checks (avoids row
  duplication from overlapping periods).

**Censoring conditions:**
1. Outcome date >= outcome window start (no pre-existing outcomes)
2. Baseline start >= observation period start (via EXISTS)
3. Outcome end <= observation period end (via EXISTS)
4. Outcome end <= study end date

---

### omop/covariates.js — Feature Engineering

**What it does:**
- Builds SQL SELECT columns and JOINs for patient-level features.
- Supports three encoding modes: count, binary, or both.
- Handles both predefined covariates (checkboxes) and custom covariates
  (user-defined concept IDs from any OMOP domain).

**Covariate groups:**
| Group | Examples |
|-------|---------|
| Demographics | age_at_index, sex, race, ethnicity |
| Baseline counts | condition_count, drug_count, visit_count, measurement_count |
| Baseline labs | eGFR, creatinine, HbA1c, BP, BMI |
| Prior history | prior_outcome, hospitalisation, ER visit, procedure |
| Custom | Any OMOP concept ID with count/binary/last/first/min/max aggregation |

---

### omop/concepts.js — Concept Reference Library

**What it does:**
- Stores common OMOP concept IDs for the right sidebar.
- Renders click-to-copy HTML for conditions, measurements, drugs, procedures.
- Extensible via `addConcept()` and `addConcepts()`.

---

### omop/artifacts.js — Best-Practice Artifacts

**What it does:**
- When "Best-Practice Mode" is enabled, generates a detailed manifest:
  - `manifest.json` — comprehensive study manifest with full evidence logic
    documentation, OMOP table mappings, match mode explanations, visit context
    details, threshold logic, covariate descriptions, and raw config snapshot

---

### methodologies/longitudinal-prediction.js — Repeated-Index Spine

**What it does:**
- Creates multiple rows per patient with yearly index dates.
- Uses `generate_series` (PostgreSQL) or `ROW_NUMBER()` (SQL Server) to create yearly offsets.
- Each row has its own baseline look-back and outcome look-forward window.

**Use case:** When you need temporal prediction over multiple time points.

---

### methodologies/single-window.js — One Row Per Patient

**What it does:**
- Creates exactly one row per patient.
- Single baseline + outcome window anchored at cohort entry date.
- Simpler and faster than longitudinal when repetition is not needed.

**Use case:** Cross-sectional prediction, case-control matching.

---

### templates/logistic-regression.js — Python Logistic Regression

**What it does:**
- Generates a `run.py` script using pandas + scikit-learn.
- Connects to database, runs study SQL, saves CSV, trains model.
- Handles missing values (mean imputation) and feature standardisation.

---

### templates/decision-tree.js — Python Decision Tree

**What it does:**
- Generates a `run_decision_tree.py` script.
- Same database workflow as logistic regression.
- Uses median imputation, train/test split, classification report.

---

## Evidence Blocks

The wizard uses a composable **evidence block** model instead of predefined rules.

### Row Types

| Type | Fields | Example |
|------|--------|---------|
| Diagnosis | Concept ID, descendants | Type 2 Diabetes (201826) |
| Lab | Concept ID, operator, value | eGFR < 60 (3020460) |
| Drug | Concept ID, descendants | Metformin (1545999) |
| Procedure | Concept ID, descendants | Dialysis (4039057) |
| Observation | Concept ID, descendants, operator, value | various |
| Visit | Concept ID | Inpatient (9201) |

### Match Modes

- **all** — Patient must match every row. Uses the latest event date as t0.
- **any** — Patient matches if any row matches. Uses the earliest event date.

### Visit Context Filtering

Every evidence row can optionally filter by visit type: inpatient (9201), outpatient (9202), ER (9203), or custom IDs.

---

## SQL Pipeline (Production Mode)

```sql
WITH
  -- 1. Concept resolution (per evidence row)
  entry_r0_concepts AS (...),

  -- 2. Cohort entry (person_id, t0)
  cohort AS (...),

  -- 3. Index anchor (clamp t0 to study start)
  index_anchor AS (...),

  -- 4. Integer series (for yearly offsets)
  nums AS (...),

  -- 5. Spine (one row per person per index year)
  spine AS (...),

  -- 6. First outcome (person_id, outcome_date)
  first_outcome AS (...),

  -- 7. Censored spine (remove invalid rows)
  final_spine AS (...)

-- 8. Final labelled dataset with covariates
SELECT s.*, outcome_label, covariates...
FROM final_spine s
LEFT JOIN person p ON ...
ORDER BY s.person_id, s.index_date;
```

Debug mode generates this as step-by-step temp tables with row counts.

---

## Supported Databases

| Feature | PostgreSQL | SQL Server |
|---------|-----------|------------|
| Date literals | `DATE '2024-01-15'` | `CAST('...' AS DATE)` |
| Date arithmetic | `INTERVAL '1 day'` | `DATEADD(DAY, ...)` |
| Integer series | `generate_series()` | `TOP(N) ROW_NUMBER()` |
| Temp tables (debug) | `CREATE TEMP TABLE` | `SELECT INTO #tmp` |

---

## Script Load Order (index.html)

Scripts must be loaded in this exact order due to dependencies:

```
1. core/generator.js          ← sets up RapidML namespace + registries
2. core/dialects.js           ← DB syntax helpers
3. core/evidence-ui.js        ← evidence row forms
4. omop/concepts.js           ← concept reference data
5. omop/covariates.js         ← feature SQL builder
6. omop/censoring.js          ← censoring WHERE clause
7. omop/artifacts.js          ← best-practice file generator
8. omop/compiler.js           ← compiler toolkit (needs 2, 5, 6)
9. omop/evidence-sql.js       ← OMOP adapter (needs 1, 8)
10. methodologies/*.js        ← study design plugins (need 8)
11. templates/*.js            ← analysis script generators (need 1)
12. core/wizard-ui.js         ← UI controller (needs everything above)
```

---

## Want to Contribute?

See **[CONTRIBUTING.md](CONTRIBUTING.md)** for step-by-step instructions on how to add:

- **Data model adapters** — create a file in `omop/` (or your own data model folder)
- **Methodologies** — add a file in `methodologies/`
- **Analysis templates** — add a file in `templates/`
- **Covariates** — edit `omop/covariates.js`
- **Concept references** — edit `omop/concepts.js`

## Covariates

### Predefined Covariates

**Demographics:** age, sex, race, ethnicity
**Baseline counts:** conditions, drugs, visits, measurements
**Baseline labs:** eGFR, creatinine, HbA1c, systolic/diastolic BP, BMI
**Prior history:** prior outcome, hospitalization, ER visit, procedure

Presets: Minimal (age+sex), Clinical Baseline (recommended), Extended (full).
Encoding: count, binary, or both.

### Custom Covariates (Any Concept ID)

In addition to the predefined checkboxes, you can add **any OMOP concept**
as a covariate feature. Click "+ Add Custom Covariate" in the Covariates
step to create rows with:

| Field | Description |
|-------|-------------|
| Domain | OMOP domain: condition, drug, lab/measurement, procedure, observation, visit |
| Concept ID | Any valid OMOP concept ID (e.g. 201826 for Type 2 Diabetes) |
| Aggregation | How to compute the feature: count, binary (0/1), last value, first value, min, max |
| Column Label | The SQL column alias for the feature (auto-sanitised to safe identifier) |

**Domain-to-table mapping:**

| Domain | OMOP Table | Concept Column | Date Column |
|--------|-----------|---------------|-------------|
| condition | `condition_occurrence` | `condition_concept_id` | `condition_start_date` |
| drug | `drug_exposure` | `drug_concept_id` | `drug_exposure_start_date` |
| lab | `measurement` | `measurement_concept_id` | `measurement_date` |
| procedure | `procedure_occurrence` | `procedure_concept_id` | `procedure_date` |
| observation | `observation` | `observation_concept_id` | `observation_date` |
| visit | `visit_occurrence` | `visit_concept_id` | `visit_start_date` |

**Aggregation modes:**

| Mode | SQL Expression |
|------|---------------|
| count | `COUNT(*)` of matching records in baseline window |
| binary | `1` if any match exists, `0` otherwise |
| last_value | `value_as_number` from the most recent record in baseline |
| first_value | `value_as_number` from the earliest record in baseline |
| min_value | `MIN(value_as_number)` in baseline |
| max_value | `MAX(value_as_number)` in baseline |

Custom covariates are stored in `config.customCovariates[]` and processed
by `covariates.js` alongside the predefined set.

## Current Scope

- OMOP CDM adapter included (FHIR and i2b2 mappings documented in `docs/` for future adapters)
- PostgreSQL and SQL Server
- Evidence-block study definitions (composable rows, not a generic query builder)
- Browser-only, no backend required

## Example

The `examples/diabetes_nephropathy/` folder contains a complete generated package for a Type 2 Diabetes → Nephropathy prediction study.

## External Dependencies

This project uses two external CDN libraries — no `npm install` required:

| Library | Version | License | Purpose |
|---------|---------|---------|---------|
| [Tailwind CSS](https://tailwindcss.com/) | CDN (latest) | MIT | Utility-first CSS styling |
| [JSZip](https://stuk.github.io/jszip/) | 3.10.1 | MIT / GPL-3.0 (dual) | Zip package generation |

Both are loaded via `<script>` tags in `index.html`. No data is sent to these CDNs — they serve static JavaScript files only.

## Browser Requirements

- Chrome 51+, Firefox 54+, Safari 10+, Edge 15+
- Requires ES2015 (ES6) support
- No server required — runs entirely in the browser

## Generated Script Requirements

The generated `run.py` scripts require:

- Python 3.8+
- `pandas`, `sqlalchemy`, `scikit-learn`, `psycopg` (for PostgreSQL)
- Database credentials via environment variables (`DATABASE_URL` or `PGUSER` + `PGPASSWORD`)

## License

This project is licensed under the MIT License. See [LICENSE](LICENSE) for details.
