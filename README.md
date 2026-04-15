# Rapid ML-Ready Wizard

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

A browser-based wizard that generates ML-ready datasets from OMOP CDM databases. No build step, no server — open `index.html` and go.

This is **not** a replacement for [ATLAS/OHDSI](https://www.ohdsi.org/analytic-tools/atlas/). It is a lightweight, wizard-driven template tool for:

- Predefined cohort entry rules (not a generic cohort builder)
- Longitudinal window-based study design (repeated-index spine)
- ML-ready dataset preparation (features + binary outcome labels)
- Generating SQL + Python analysis scripts as a downloadable package

## Quick Start

1. Open `index.html` in a browser.
2. Set database type, schema, and study years.
3. Choose a cohort entry rule and fill concept IDs.
4. Choose an outcome rule.
5. Pick covariates (features) and a methodology.
6. Click **Generate Package** → download zip with `study.sql`, `README.md`, `run.py`.

## What Gets Generated

| File | Purpose |
|------|---------|
| `study.sql` | Complete SQL query (CTE pipeline or debug temp tables) |
| `README.md` | Study summary with all selected parameters |
| `run.py` | Python analysis script (logistic regression or decision tree) |
| `manifest.json` | Config snapshot (best-practice mode) |
| `attrition.sql` | Cohort flow counts (best-practice mode) |
| `data_quality_report.sql` | Null checks and label validation (best-practice mode) |

## Project Structure

```text
index.html              ← Open this in a browser
CONTRIBUTING.md         ← How to add rules, methodologies, templates
README.md               ← This file

core/                   ← Generic engine (data-model independent)
  generator.js            Config collection + zip packaging
  wizard-ui.js            Wizard form logic, presets, self-check panel
  dialects.js             PostgreSQL vs SQL Server syntax
  windows.js              Baseline/outcome window expressions

omop/                   ← OMOP CDM data model
  compiler.js             OMOP SQL pipeline (debug + production)
  censoring.js            OMOP censoring (observation_period)
  concepts.js             Concept ID reference library
  covariates.js           Feature engineering SQL
  artifacts.js            Manifest, attrition, data quality

rules/                  ← Cohort and outcome rules (definitions + SQL)
  cohort-rules.js         Cohort entry rule registry + UI behavior
  cohort-sql.js           Cohort entry SQL builder per rule
  outcome-rules.js        Outcome rule registry + UI behavior
  outcome-sql.js          Outcome SQL builder per rule

methodologies/          ← Study design plugins (self-registering)
  longitudinal-prediction.js
  surveillance-analysis.js (placeholder)

templates/              ← Analysis script generators (self-registering)
  logistic-regression.js
  decision-tree.js

docs/                   ← Reference specifications
  study-config.schema.json
  rule-types.json
  pack.schema.json
  fhir-map.json
  i2b2-map.json

examples/               ← Example generated studies
  diabetes_nephropathy/
```

## Want to Contribute?

See **[CONTRIBUTING.md](CONTRIBUTING.md)** for step-by-step instructions on how to add:

- **Cohort rules** → edit files in `rules/`
- **Outcome rules** → edit files in `rules/`
- **Methodologies** → add a file in `methodologies/`
- **Analysis templates** → add a file in `templates/`
- **Covariates** → edit `omop/covariates.js`
- **Concept references** → edit `omop/concepts.js`

## Architecture

```
User fills wizard form (index.html)
        │
        ▼
generator.js collects config
        │
        ▼
Methodology plugin builds SQL via omop/compiler.js
        │
        ├── core/dialects.js    (DB syntax — generic)
        ├── core/windows.js     (date windows — generic)
        ├── omop/censoring.js   (censoring — OMOP)
        ├── rules/cohort-sql.js (cohort CTE — OMOP)
        ├── rules/outcome-sql.js(outcome CTE — OMOP)
        └── omop/covariates.js  (features — OMOP)
        │
        ▼
Template plugin generates analysis script
        │
        ▼
Zip package → download
```

### Plugin Model

Methodologies and analysis templates are **self-registering plugins**. Each file calls `RapidML.Methodologies.register()` or `RapidML.AnalysisTemplates.register()` when loaded. The wizard dropdown auto-populates from whatever plugins are loaded.

### SQL Pipeline

The compiler builds SQL as CTE chains (production mode) or staged temp tables (debug mode):

1. **Concept resolution** → Find entry/outcome concept IDs + descendants via `concept_ancestor`
2. **Cohort entry** → Apply selected rule to build `cohort` CTE with `person_id` and `t0`
3. **Spine generation** → Create repeated yearly index dates per patient
4. **Censoring** → Remove rows outside observation period, after outcome, or past study end
5. **Outcome labeling** → Binary label per row (0/1/NULL)
6. **Covariates** → Join demographics, baseline counts, labs, prior history

### Supported Databases

- **PostgreSQL** — `generate_series()`, `INTERVAL`, `DATE` literals
- **SQL Server** — recursive CTE series, `DATEADD()`, `CAST(... AS DATE)`

Debug mode generates step-by-step temp tables with row counts for both databases.

## Available Rules

### Cohort Entry Rules

| Rule | Logic | When to Use |
|------|-------|-------------|
| 1 condition record | First diagnosis date | Largest cohort, simplest |
| 2 conditions on 2 visits | 2+ distinct visits with diagnosis | Reduce false positives |
| Condition + lab on different visits | Diagnosis AND lab threshold met | Dual clinical evidence |
| Condition OR lab | Either marker, whichever first | Flexible entry |

### Outcome Rules

| Rule | Logic | When to Use |
|------|-------|-------------|
| 1 condition in window | Condition appears in follow-up | Simple condition outcome |
| 2 conditions in window | 2+ occurrences in follow-up | Higher specificity |
| Lab threshold in window | Lab value crosses threshold | Quantitative outcome |
| Condition OR lab in window | Either marker in follow-up | Composite outcome |

All cohort rules join through `visit_occurrence` and support visit-type filtering (inpatient, outpatient, ER, custom).

## Covariates

**Demographics:** age, sex, race, ethnicity
**Baseline counts:** conditions, drugs, visits, measurements
**Baseline labs:** eGFR, creatinine, HbA1c, systolic/diastolic BP, BMI
**Prior history:** prior outcome, hospitalization, ER visit, procedure

Presets: Minimal (age+sex), Clinical Baseline (recommended), Extended (full).
Encoding: count, binary, or both.

## Current Scope

- OMOP CDM only (FHIR and i2b2 mappings documented in `docs/` for future work)
- PostgreSQL and SQL Server
- Predefined rules (not a generic rule builder)
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
