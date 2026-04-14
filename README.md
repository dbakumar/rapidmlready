# OMOP Spine Initializr

Generate longitudinal, ML-ready datasets from an [OMOP CDM](https://ohdsi.github.io/CommonDataModel/) database in seconds. Define an exposure condition and an outcome, set study parameters, and download production-ready SQL plus a Python analysis script — no coding required.

---

## How It Works

The tool uses a **spine-based approach** to build a person × time matrix for cohort studies:

1. **Concept resolution** — Find the OMOP standard concept for your exposure and outcome conditions, then expand to all descendant concepts via `concept_ancestor`.
2. **Cohort entry** — Identify each patient's first exposure date (t0).
3. **Index anchoring** — Set `exposure_index_date` to study start for patients exposed before study start; otherwise use the first exposure date.
4. **Spine generation** — Set first predictive index date to `exposure_index_date + baseline window`, then create repeated yearly rows.
5. **Censoring** — Remove rows outside observation periods, after first outcome, or with outcome windows extending past study end.
6. **Outcome labeling** — Flag each row with `1` if the outcome condition appears in the outcome window, `0` otherwise.

The result is a flat table ready for logistic regression, survival analysis, or any ML pipeline.

---

## Project Structure

```
├── index.html                          # Web UI — open in browser to generate code
├── generator.js                        # All generation logic and SQL templates (inline)
└── examples/
    └── diabetes_nephropathy/
        ├── study.sql                   # Example generated SQL (Postgres, production)
        ├── run.py                      # Example Python analysis script
        └── README.md                   # Example study description
```

---

## Quick Start

### 1. Open the UI

Open `index.html` in any modern browser (works locally via `file://` or hosted on GitHub Pages).

### 2. Configure your study

| Parameter | Description | Example |
|-----------|-------------|---------|
| **Database** | PostgreSQL or SQL Server | PostgreSQL |
| **Study Start Year** | First calendar year of the study window | 2016 |
| **Study End Year** | Last calendar year of the study window | 2024 |
| **Exposure** | The condition that defines cohort entry | Type 2 diabetes mellitus |
| **Outcome** | The condition to predict | Diabetic nephropathy |
| **Baseline (years)** | Look-back window before each index date (1, 3, or 5) | 1 |
| **Outcome window (years)** | Look-forward window after each index date (1 or 2) | 1 |
| **Debug mode** | Check to get step-by-step SQL with intermediate SELECTs |  |

### 3. Click **Generate Package**

Three files are downloaded:

| File | Contents |
|------|----------|
| `study.sql` | Complete SQL query with all parameters filled in |
| `run.py` | Python script that executes the SQL and fits a logistic regression model |
| `README.md` | Summary of your study configuration |

### 4. Run

```bash
# Execute the SQL on your OMOP database (PostgreSQL example)
psql -h host -d omop_db -f study.sql -o results.csv

# Or use the Python script directly
# PowerShell example:
$env:PGHOST = 'localhost'
$env:PGPORT = '5432'
$env:PGDATABASE = 'omop_db'
$env:PGUSER = 'username'
$env:PGPASSWORD = 'password'
python run.py
```

The example Python runner reads `study.sql`, executes it against PostgreSQL, writes `results.csv`, and trains a simple logistic regression only when an `outcome_label` column and numeric feature columns are present.

---

## Debug vs Production Mode

### Production Mode (default)

Generates a single query using Common Table Expressions (CTEs). All steps run in one pass — ideal for large databases and final analysis.

```sql
WITH exposure_root AS ( ... ),
     exposure_descendants AS ( ... ),
     ...
     final_spine AS ( ... )
SELECT ... FROM final_spine;
```

### Debug Mode

Each step is materialized as a temporary table with `SELECT` statements after each one, so you can inspect intermediate results (concept counts, cohort size, spine rows, censoring effects).

```sql
CREATE TEMP TABLE tmp_exposure_root AS ...;
SELECT * FROM tmp_exposure_root;            -- inspect

CREATE TEMP TABLE tmp_cohort AS ...;
SELECT COUNT(*) AS cohort_size FROM tmp_cohort;  -- inspect
-- ... and so on for all 10 steps
```

---

## SQL Generation Steps (all 10)

| Step | Name | Purpose |
|------|------|---------|
| 1 | Resolve exposure concept | Find standard OMOP concept ID for the exposure condition |
| 2 | Expand exposure descendants | Get all child concepts via `concept_ancestor` |
| 3 | Resolve outcome concept | Find standard OMOP concept ID for the outcome condition |
| 4 | Expand outcome descendants | Get all child concepts for the outcome |
| 5 | Cohort entry (t0) | First exposure date per patient |
| 6 | Compute exposure/index anchor | Build `exposure_index_date` and first predictive date |
| 7 | Generate spine | Yearly index rows per patient that keep outcome windows within study end |
| 8 | Outcome-based censoring | Remove rows after the outcome has occurred |
| 9 | Observation period + study-end censoring | Remove rows outside observation window or beyond study end |
| 10 | Outcome labeling | Label each row 1/0 based on outcome in the forward window |

---

## Censoring

Three types of censoring ensure the dataset is free of data leakage:

- **Outcome-based** — Once the outcome occurs, no further index rows are generated for that patient. The outcome event counts on the row where it happens, but subsequent rows are dropped.
- **Observation-based** — If a patient's `observation_period` ends, rows whose baseline or outcome windows extend beyond that boundary are removed.
- **Administrative** — Rows are kept only when `outcome_end` is on or before study end; windows that cross study end are not generated.

---

## Database-Specific Syntax

| Feature | PostgreSQL | SQL Server |
|---------|-----------|------------|
| Temp tables | `CREATE TEMP TABLE name AS ...` | `SELECT ... INTO #name` |
| Date arithmetic | `date + INTERVAL '365 days'` | `DATEADD(DAY, 365, date)` |
| Series generation | `generate_series(0, 20)` | `ROW_NUMBER() OVER (...)` from `sys.objects` |
| Temp table cleanup | `DROP TABLE IF EXISTS name` | `IF OBJECT_ID('tempdb..#name') IS NOT NULL DROP TABLE #name` |

---

## Example

The `examples/diabetes_nephropathy/` folder contains a complete generated output for:

- **Exposure:** Type 2 diabetes mellitus
- **Outcome:** Diabetic nephropathy
- **Study period:** 2016–2024
- **Baseline:** 1 year | **Outcome window:** 1 year
- **Mode:** Production (PostgreSQL)

The example folder README also includes a staged mini-dataset walkthrough that shows how sample patients move through `cohort`, `index_anchor`, `spine`, censoring, and final labeling.

---

## Requirements

- A modern web browser (Chrome, Firefox, Edge, Safari)
- An OMOP CDM database (v5.x) accessible via PostgreSQL or SQL Server
- Python 3.x with `pandas`, `sqlalchemy`, and `scikit-learn` (for the analysis script)
