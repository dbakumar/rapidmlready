# Contributing to Rapid ML-Ready Wizard

This guide shows how to add new cohort rules, outcome rules, methodologies, analysis templates, and covariates.

## Project Structure

```text
index.html              ← Wizard UI (entry point, open in browser)
CONTRIBUTING.md         ← This file
README.md               ← Project overview

core/                   ← Generic engine (data-model independent)
  generator.js          ← Config collection + zip packaging
  wizard-ui.js          ← Wizard form logic, presets, validation, self-check
  dialects.js           ← PostgreSQL vs SQL Server helpers
  windows.js            ← Baseline/outcome window expressions

omop/                   ← OMOP CDM data model
  compiler.js           ← OMOP SQL pipeline (debug + production)
  censoring.js          ← OMOP censoring (observation_period table)
  concepts.js           ← Concept ID reference library
  covariates.js         ← Feature engineering SQL (baseline labs, counts)
  artifacts.js          ← Manifest, attrition, data quality SQL

rules/                  ← Cohort + outcome rule definitions and SQL
  cohort-rules.js       ← Cohort entry rule registry + UI behavior
  cohort-sql.js         ← Cohort entry SQL builders (one per rule)
  outcome-rules.js      ← Outcome rule registry + UI behavior
  outcome-sql.js        ← Outcome SQL builders (one per rule)

methodologies/          ← Study design plugins
  longitudinal-prediction.js  ← Repeated-index spine (active)
  surveillance-analysis.js    ← Event monitoring (placeholder)

templates/              ← Analysis script generators
  logistic-regression.js      ← Python logistic regression
  decision-tree.js            ← Python decision tree

docs/                   ← Reference specifications (not loaded at runtime)
examples/               ← Example generated studies
```

## How It Works

```
User fills wizard form (index.html)
        │
        ▼
generator.js collects config → normalizeConfig()
        │
        ▼
Methodology plugin builds SQL → calls omop/compiler.js
        │
        ├── omop/compiler.js orchestrates:
        │   ├── core/dialects.js  (DB syntax — generic)
        │   ├── core/windows.js   (date windows — generic)
        │   ├── omop/censoring.js  (censoring — OMOP)
        │   ├── rules/cohort-sql.js  (cohort CTE — OMOP)
        │   ├── rules/outcome-sql.js (outcome CTEs — OMOP)
        │   └── omop/covariates.js   (features — OMOP)
        │
        ▼
Analysis template builds run.py
        │
        ▼
Methodology builds README.md
        │
        ▼
generator.js packages files into timestamped zip
```

All modules communicate through the global `RapidML` namespace (no bundler needed).

---

## Add a New Cohort Entry Rule

**Files to edit:** `rules/cohort-rules.js` and `rules/cohort-sql.js`

### Step 1: Register the rule definition

In `rules/cohort-rules.js`, add an entry to the `rules` array:

```javascript
{
  id: "my_new_rule",
  label: "My new rule (description for dropdown)",
  help: "Detailed explanation shown to users when selected.",
  inputRequirements: {
    condition: true,     // requires condition concept ID
    measurement: false   // does not require lab input
  },
  inputRequirementMode: "all"  // "all" = every true field required, "any" = at least one
}
```

### Step 2: Add the SQL builder

In `rules/cohort-sql.js`, add a case to `buildSimpleCohortCTE()`:

```javascript
case "my_new_rule":
  return buildMyNewRuleCohort(config);
```

Then write the builder function:

```javascript
function buildMyNewRuleCohort(config) {
  var schema = config.schema;
  var visitPred = visitFilterPredicate(config);
  var sqlLines = [
    "cohort AS (",
    "  SELECT co.person_id, MIN(co.condition_start_date) AS t0",
    "  FROM " + schema + ".condition_occurrence co",
    "  JOIN " + schema + ".visit_occurrence vo",
    "    ON co.visit_occurrence_id = vo.visit_occurrence_id",
    visitPred ? "  WHERE " + visitPred : "",
    "    AND co.condition_concept_id IN (SELECT concept_id FROM entry_condition_descendants)",
    "  -- your custom logic here",
    "  GROUP BY co.person_id",
    ")"
  ];
  return sqlLines.filter(Boolean).join("\n");
}
```

### Step 3: Add the dropdown option in index.html

In the `<select id="cohortEntryMode">` dropdown:

```html
<option value="my_new_rule">My new rule (description)</option>
```

### Step 4: Test

1. Open index.html in a browser.
2. Select your new rule from the dropdown.
3. Fill required fields (check the self-check panel).
4. Generate a package and inspect the SQL output.

---

## Add a New Outcome Rule

**Files to edit:** `rules/outcome-rules.js` and `rules/outcome-sql.js`

Same pattern as cohort rules:

### Step 1: Register in `rules/outcome-rules.js`

```javascript
{
  id: "my_outcome",
  label: "My outcome rule",
  help: "When this outcome counts as positive.",
  inputRequirements: {
    condition: true,
    measurement: false
  },
  inputRequirementMode: "all"
}
```

### Step 2: Add SQL builders in `rules/outcome-sql.js`

Two functions needed:

1. **`firstOutcomeCTE(config)`** — add a case returning the CTE that finds the first qualifying outcome event per patient.
2. **`outcomeLabelExpr(config)`** — add a case returning the CASE expression that labels each spine row as 0 or 1.

### Step 3: Add dropdown option in index.html

In the `<select id="outcomeRuleMode">` dropdown.

---

## Add a New Methodology

**Folder:** `methodologies/`

Create a new file, e.g. `methodologies/my-methodology.js`:

```javascript
var myMethodology = {
  id: "my-methodology",
  label: "My Methodology",

  buildSQL: function(config) {
    // Use the shared compiler to generate SQL
    return RapidML.Compiler.compileStudy(config);
  },

  describeRules: function(config) {
    // Return Markdown string for the generated README
    return [
      "# Study Summary",
      "",
      "- Methodology: My Methodology",
      "- Database: " + config.db,
      "- Schema: " + config.schema,
      "- Cohort rule: " + config.cohortEntryMode
    ].join("\n");
  }
};

// Self-register
RapidML.Methodologies.register(myMethodology);
```

Then add the script tag in `index.html` after existing methodologies:

```html
<script src="methodologies/my-methodology.js"></script>
```

The methodology automatically appears in the dropdown.

---

## Add a New Analysis Template

**Folder:** `templates/`

Create a new file, e.g. `templates/random-forest.js`:

```javascript
var randomForestTemplate = {
  id: "random-forest",
  label: "Random Forest (Python)",

  buildScript: function(config) {
    // Return Python code as a string
    return [
      "import pandas as pd",
      "from sklearn.ensemble import RandomForestClassifier",
      "# ... your template code"
    ].join("\n");
  }
};

RapidML.AnalysisTemplates.register(randomForestTemplate);
```

Then add the script tag in `index.html`:

```html
<script src="templates/random-forest.js"></script>
```

---

## Add a New Covariate

**File:** `omop/covariates.js`

In the `buildSelect()` function, add a new case to the feature switch:

```javascript
case "my_new_feature":
  columns.push("(SELECT COUNT(*) FROM " + schema + ".some_table st "
    + "WHERE st.person_id = s.person_id "
    + "AND st.some_date BETWEEN s.baseline_start AND s.baseline_end) AS my_new_feature");
  break;
```

Then add the checkbox in `index.html` section 5 (Covariates):

```html
<label class="flex items-center gap-2 cursor-pointer">
  <input type="checkbox" name="covariates" value="my_new_feature" class="w-4 h-4 border-2 border-slate-300 rounded"/>
  <span>My new feature</span>
</label>
```

If the covariate should appear in a preset, add it to `getCovariatePresetMap()` in the index.html script section.

---

## Add New OMOP Concepts

**File:** `omop/concepts.js`

```javascript
RapidML.ConceptReference.addConcept("conditions", 12345, "My New Condition");
RapidML.ConceptReference.addConcepts("measurements", [
  { id: 67890, name: "My Lab Test" }
]);
```

---

## Naming Conventions

| Item | ID format | Example |
|------|-----------|---------|
| Cohort rule | `snake_case` | `first_event`, `visit_count` |
| Outcome rule | `snake_case` | `condition_occurrence`, `lab_threshold` |
| Methodology | `kebab-case` | `longitudinal-prediction` |
| Template | `kebab-case` | `logistic-regression` |
| Covariate | `snake_case` | `baseline_egfr`, `prior_hospitalization_flag` |

---

## Testing Checklist

Before submitting a pull request:

- [ ] Open `index.html` in browser — no console errors
- [ ] New dropdown options appear and select correctly
- [ ] Self-check panel shows "Ready to generate" with valid inputs
- [ ] Generated SQL runs on target database (PostgreSQL or SQL Server)
- [ ] Generated README describes the new rule/methodology accurately
- [ ] Debug mode produces step-by-step SQL with temp tables
- [ ] Example buttons still work (if applicable)

## Questions?

Open an issue describing what you want to add. Include:
- Which extension point (rule, methodology, template, covariate)
- The clinical use case
- Sample concept IDs if applicable
