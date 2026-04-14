# Example: Diabetes -> Nephropathy

This folder contains a generated PostgreSQL production query for:

- Exposure: Type 2 diabetes mellitus
- Outcome: Diabetic nephropathy
- Study period: 2016-01-01 to 2024-12-31
- Baseline window: 365 days
- Outcome window: 365 days

## Temporal Rules Used in This Example

1. `t0` is each patient's first exposure date.
2. `exposure_index_date` is anchored as follows:
	- if `t0 < 2016-01-01`, then `exposure_index_date = 2016-01-01`
	- else `exposure_index_date = t0`
3. `first_index_date = exposure_index_date + 365 days`
4. Spine rows are generated yearly from `first_index_date`.
5. A row is generated only if its `outcome_end` stays within study end (`<= 2024-12-31`).
6. After the first observed outcome, future rows are censored.

## Included Files

- `study.sql`: generated CTE query implementing the rules above.
- `run.py`: example PostgreSQL execution script that reads `study.sql`, writes `results.csv`, and optionally trains a simple logistic regression on numeric features.

## Running the Example Query

PowerShell example:

```powershell
$env:PGHOST = 'localhost'
$env:PGPORT = '5432'
$env:PGDATABASE = 'omop_db'
$env:PGUSER = 'username'
$env:PGPASSWORD = 'password'
python run.py
```

You can also provide a full connection string through `DATABASE_URL`. The script looks for `study.sql` in the same folder, exports query results to `results.csv`, and trains a toy model only when the query returns `outcome_label` plus usable numeric feature columns.

## Mini Walkthrough: How the Spine Table Is Built

The tables below use a small illustrative dataset to show how rows move through each stage.

Study settings for this walkthrough:

- Study period: 2016-01-01 to 2024-12-31
- Baseline window: 365 days
- Outcome window: 365 days

### Stage 0: Example Input Facts

| person_id | first_diabetes_date | first_nephropathy_date | observation_start | observation_end | note |
|---|---|---|---|---|---|
| 100 | 2014-06-10 | 2018-03-15 | 2010-01-01 | 2024-12-31 | prevalent diabetes before study start |
| 200 | 2016-08-20 | null | 2015-01-01 | 2024-12-31 | incident diabetes during study |
| 300 | 2023-07-01 | null | 2023-01-01 | 2024-12-31 | too late for full outcome window |
| 400 | 2017-02-01 | 2018-01-15 | 2016-01-01 | 2024-12-31 | outcome occurs before first predictive row |
| 500 | 2015-01-01 | null | 2015-01-01 | 2017-06-30 | observation period too short |

### Stage 1: `tmp_cohort`

This stage finds `t0`, the first diabetes date for each patient.

| person_id | t0 |
|---|---|
| 100 | 2014-06-10 |
| 200 | 2016-08-20 |
| 300 | 2023-07-01 |
| 400 | 2017-02-01 |
| 500 | 2015-01-01 |

### Stage 2: `tmp_index_anchor`

Rules:

- if `t0 < 2016-01-01`, then `exposure_index_date = 2016-01-01`
- else `exposure_index_date = t0`
- `first_index_date = exposure_index_date + 365 days`

| person_id | t0 | exposure_index_date | first_index_date |
|---|---|---|---|
| 100 | 2014-06-10 | 2016-01-01 | 2016-12-31 |
| 200 | 2016-08-20 | 2016-08-20 | 2017-08-20 |
| 300 | 2023-07-01 | 2023-07-01 | 2024-06-30 |
| 400 | 2017-02-01 | 2017-02-01 | 2018-02-01 |
| 500 | 2015-01-01 | 2016-01-01 | 2016-12-31 |

### Stage 3: `tmp_spine`

This stage generates yearly candidate rows.

| person_id | index_date | baseline_start | baseline_end | outcome_start | outcome_end | kept in `tmp_spine`? |
|---|---|---|---|---|---|---|
| 100 | 2016-12-31 | 2016-01-01 | 2016-12-30 | 2016-12-31 | 2017-12-31 | yes |
| 100 | 2017-12-31 | 2016-12-31 | 2017-12-30 | 2017-12-31 | 2018-12-31 | yes |
| 100 | 2018-12-31 | 2017-12-31 | 2018-12-30 | 2018-12-31 | 2019-12-31 | yes |
| 200 | 2017-08-20 | 2016-08-20 | 2017-08-19 | 2017-08-20 | 2018-08-20 | yes |
| 200 | 2018-08-20 | 2017-08-20 | 2018-08-19 | 2018-08-20 | 2019-08-20 | yes |
| 300 | 2024-06-30 | 2023-07-01 | 2024-06-29 | 2024-06-30 | 2025-06-30 | no |
| 400 | 2018-02-01 | 2017-02-01 | 2018-01-31 | 2018-02-01 | 2019-02-01 | yes |
| 500 | 2016-12-31 | 2016-01-01 | 2016-12-30 | 2016-12-31 | 2017-12-31 | yes |

Person `300` never gets a spine row because the full outcome window would cross study end.

### Stage 4: `tmp_first_outcome`

This stage finds the first nephropathy date for each patient.

| person_id | outcome_date |
|---|---|
| 100 | 2018-03-15 |
| 400 | 2018-01-15 |

### Stage 5: `tmp_spine_outcome_censored`

Rows are kept only if there is no outcome yet, or if `outcome_start <= outcome_date`.

| person_id | index_date | outcome_start | outcome_end | kept after outcome censor? | reason |
|---|---|---|---|---|---|
| 100 | 2016-12-31 | 2016-12-31 | 2017-12-31 | yes | row starts before first outcome |
| 100 | 2017-12-31 | 2017-12-31 | 2018-12-31 | yes | first outcome falls inside this row's outcome window |
| 100 | 2018-12-31 | 2018-12-31 | 2019-12-31 | no | row starts after first outcome |
| 400 | 2018-02-01 | 2018-02-01 | 2019-02-01 | no | first outcome happened before this row started |

Patient `400` contributes no predictive rows because nephropathy occurred before the first predictive index date.

### Stage 6: `tmp_final_spine`

This stage applies observation-period checks and keeps only rows whose outcome window stays inside study end.

| person_id | index_date | outcome_end | observation_end | kept in final spine? | reason |
|---|---|---|---|---|---|
| 100 | 2016-12-31 | 2017-12-31 | 2024-12-31 | yes | inside observation period and study period |
| 100 | 2017-12-31 | 2018-12-31 | 2024-12-31 | yes | inside observation period and study period |
| 200 | 2017-08-20 | 2018-08-20 | 2024-12-31 | yes | inside observation period and study period |
| 500 | 2016-12-31 | 2017-12-31 | 2017-06-30 | no | outcome window exceeds observation period |

### Stage 7: Final Labeled Output

The last step adds `outcome_label = 1` when nephropathy occurs between `outcome_start` and `outcome_end`.

| person_id | exposure_index_date | index_date | baseline_start | baseline_end | outcome_start | outcome_end | outcome_label |
|---|---|---|---|---|---|---|---|
| 100 | 2016-01-01 | 2016-12-31 | 2016-01-01 | 2016-12-30 | 2016-12-31 | 2017-12-31 | 0 |
| 100 | 2016-01-01 | 2017-12-31 | 2016-12-31 | 2017-12-30 | 2017-12-31 | 2018-12-31 | 1 |
| 200 | 2016-08-20 | 2017-08-20 | 2016-08-20 | 2017-08-19 | 2017-08-20 | 2018-08-20 | 0 |
| 200 | 2016-08-20 | 2018-08-20 | 2017-08-20 | 2018-08-19 | 2018-08-20 | 2019-08-20 | 0 |

This walkthrough shows the main patterns:

- prevalent diabetes before study start is anchored to study start
- incident diabetes during study keeps the actual diagnosis date as exposure index
- rows are dropped when `outcome_end` crosses study end
- rows are dropped after the first observed outcome
- rows are dropped when observation time is too short
