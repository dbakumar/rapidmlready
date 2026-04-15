/**
 * RapidML Methodology Plugin: Longitudinal Prediction
 *
 * Study design: Repeated-index spine with yearly follow-up windows.
 * Each patient gets one row per (person_id, index_date) pair, covering
 * a baseline look-back window and an outcome look-forward window.
 *
 * This file does NOT contain SQL — it delegates to the OMOP compiler
 * via RapidML.Compiler.compileStudy(config). It provides:
 *   1. buildSQL()       → call the compiler
 *   2. describeRules()  → build the generated README (Markdown)
 *
 * Self-registers on RapidML.Methodologies.
 */

(function () {

  // ---------------------------------------------------------------
  //  Label maps — human-readable descriptions for rule IDs
  // ---------------------------------------------------------------

  var COHORT_MODE_LABELS = {
    first_event:                "1 condition record",
    visit_count:                "2 condition records on 2 distinct visits",
    condition_lab_diff_visits:  "1 condition record and 1 lab record on different visits",
    condition_or_lab:           "1 condition record OR 1 lab record"
  };

  var OUTCOME_MODE_LABELS = {
    condition_occurrence:  "1 condition record in the outcome window",
    two_condition_records: "2 condition records in the outcome window",
    lab_threshold:         "1 lab record above or below threshold in the outcome window",
    condition_or_lab:      "1 condition record OR 1 lab record in the outcome window"
  };

  var VISIT_FILTER_LABELS = {
    all:        "All visit types",
    inpatient:  "Inpatient visits only",
    outpatient: "Outpatient visits only",
    emergency:  "Emergency visits only",
    custom:     "Custom visit concept IDs"
  };

  // ---------------------------------------------------------------
  //  Config readers — safely extract values from the config object
  // ---------------------------------------------------------------

  function cohortConditionId(config) {
    return (config.cohortEntry && config.cohortEntry.conditionConceptId) || "missing";
  }

  function cohortMeasurementId(config) {
    return (config.cohortEntry && config.cohortEntry.measurementConceptId) || "missing";
  }

  function outcomeConditionId(config) {
    return (config.outcomeRule && config.outcomeRule.conceptId) || config.outcomeConceptId || "missing";
  }

  function outcomeMeasurementId(config) {
    return (config.outcomeRule && config.outcomeRule.measurementConceptId) || "missing";
  }

  function visitFilterMode(config) {
    return (config.visitFilter && config.visitFilter.mode) || "all";
  }

  function visitFilterConceptText(config) {
    var mode = visitFilterMode(config);
    if (mode !== "custom") return "n/a";
    var ids = config.visitFilter && config.visitFilter.conceptIds;
    return (ids && ids.length) ? ids.join(", ") : "missing";
  }

  function cohortNeedsLab(config) {
    return config.cohortEntryMode === "condition_lab_diff_visits"
        || config.cohortEntryMode === "condition_or_lab";
  }

  function outcomeNeedsCondition(config) {
    var m = config.outcomeRule && config.outcomeRule.mode;
    return m === "condition_occurrence"
        || m === "two_condition_records"
        || m === "condition_or_lab";
  }

  function outcomeNeedsLab(config) {
    var m = config.outcomeRule && config.outcomeRule.mode;
    return m === "lab_threshold" || m === "condition_or_lab";
  }

  // ---------------------------------------------------------------
  //  README section builders — each returns an array of Markdown lines
  // ---------------------------------------------------------------

  /** Title line */
  function buildTitle(config) {
    return [
      "# Study: OMOP cohort " + cohortConditionId(config) + " → outcome " + outcomeConditionId(config)
    ];
  }

  /** Configuration summary table */
  function buildConfigTable(config) {
    var baselineDays = Number(config.baselineYears) * 365;
    var outcomeDays  = Number(config.outcomeYears) * 365;
    var covariates   = (config.covariates || []).join(", ") || "none";

    return [
      "## Configuration Summary",
      "",
      "| Item | Value |",
      "|---|---|",
      "| Methodology | Longitudinal prediction (repeated-index spine) |",
      "| Database | " + config.db + " |",
      "| Schema | " + config.schema + " |",
      "| Study period | " + config.startYear + "-01-01 to " + config.endYear + "-12-31 |",
      "| Cohort entry rule | " + (COHORT_MODE_LABELS[config.cohortEntryMode] || COHORT_MODE_LABELS.first_event) + " |",
      "| Outcome rule | " + (OUTCOME_MODE_LABELS[config.outcomeRule.mode] || OUTCOME_MODE_LABELS.condition_occurrence) + " |",
      "| Visit filter | " + (VISIT_FILTER_LABELS[visitFilterMode(config)] || VISIT_FILTER_LABELS.all) + " |",
      "| Visit concept IDs (custom) | " + visitFilterConceptText(config) + " |",
      "| Baseline window | " + config.baselineYears + " year(s) (" + baselineDays + " days) |",
      "| Outcome window | " + config.outcomeYears + " year(s) (" + outcomeDays + " days) |",
      "| Covariate encoding | " + (config.covariateEncoding || "count") + " |",
      "| Selected covariates | " + covariates + " |",
      "| Debug mode | " + (config.debug ? "enabled" : "disabled") + " |",
      "| Best-practice mode | " + (config.bestPracticeMode ? "enabled" : "disabled") + " |"
    ];
  }

  /** Lists which concept IDs the selected rules actually need */
  function buildRequiredInputs(config) {
    var lines = ["## Required Inputs"];

    lines.push("- **Cohort condition concept**: " + cohortConditionId(config));

    if (cohortNeedsLab(config)) {
      lines.push("- **Cohort measurement**: concept " + cohortMeasurementId(config)
        + " " + ((config.cohortEntry && config.cohortEntry.measurementOperator) || ">")
        + " " + ((config.cohortEntry && config.cohortEntry.measurementValue) || "missing"));
    } else {
      lines.push("- **Cohort measurement**: not required by selected rule");
    }

    if (outcomeNeedsCondition(config)) {
      lines.push("- **Outcome condition concept**: " + outcomeConditionId(config));
    } else {
      lines.push("- **Outcome condition concept**: not required by selected rule");
    }

    if (outcomeNeedsLab(config)) {
      lines.push("- **Outcome measurement**: concept " + outcomeMeasurementId(config)
        + " " + ((config.outcomeRule && config.outcomeRule.measurementOperator) || ">")
        + " " + ((config.outcomeRule && config.outcomeRule.measurementValue) || "missing"));
    } else {
      lines.push("- **Outcome measurement**: not required by selected rule");
    }

    return lines;
  }

  /** Explains the SQL pipeline stages at a high level */
  function buildPipelineDescription() {
    return [
      "## SQL Pipeline",
      "",
      "1. Resolve entry and outcome concept descendants from OMOP vocabulary tables.",
      "2. Build cohort entry dates (t0) based on selected cohort rule.",
      "3. Join entry events through `visit_occurrence` for consistent visit-context filtering.",
      "4. Build repeated yearly index windows with baseline/outcome periods.",
      "5. Apply censoring: first-outcome handling + observation period checks + study end boundary.",
      "6. Compute `outcome_label` and append selected covariates.",
      "",
      "## Output",
      "",
      "One row per `(person_id, index_date)` with:",
      "- Time-window columns (baseline_start, baseline_end, outcome_start, outcome_end)",
      "- `outcome_label` (0 = no event, 1 = event, NULL = censored)",
      "- Selected covariates"
    ];
  }

  /** DB-specific performance tips */
  function buildPerformanceGuidance(config) {
    var lines = ["## Performance Guidance"];
    if (config.db === "postgres") {
      lines.push("- Run `ANALYZE` on large OMOP tables (condition_occurrence, measurement, visit_occurrence, observation_period) after major data loads.");
    } else {
      lines.push("- Refresh table statistics (`UPDATE STATISTICS`) after major data loads.");
    }
    return lines;
  }

  /** Debug explanation (only if debug mode enabled) */
  function buildDebugNotes(config) {
    if (!config.debug) {
      return ["## Debug", "", "Debug mode is disabled. SQL is a single production CTE pipeline."];
    }
    return [
      "## Debug",
      "",
      "Debug mode is enabled: SQL includes step-by-step temp tables with row-count checkpoints.",
      "",
      "### Conceptual Example",
      "- Person A: enters cohort in 2020, remains outcome-free until 2023 → early rows label 0, later row may label 1.",
      "- Person B: has early outcome in 2021 → subsequent rows removed by outcome-based censoring.",
      "- Use temp-table row counts in `study.sql` to trace exactly where each patient is filtered."
    ];
  }

  // ---------------------------------------------------------------
  //  Plugin definition
  // ---------------------------------------------------------------

  var longitudinalPredictionMethodology = {
    id: "longitudinal-prediction",
    label: "Longitudinal prediction (default)",

    /**
     * Generate SQL by delegating to the OMOP compiler.
     * The compiler builds the full CTE pipeline (or debug temp-table script).
     */
    buildSQL: function (config) {
      if (RapidML.Compiler && typeof RapidML.Compiler.compileStudy === "function") {
        return RapidML.Compiler.compileStudy(config);
      }
      throw new Error("Compiler not loaded for longitudinal-prediction methodology.");
    },

    /**
     * Build the generated README (Markdown) that accompanies the SQL.
     * Each section is produced by a dedicated helper above.
     */
    describeRules: function (config) {
      return [].concat(
        buildTitle(config),
        [""],
        buildConfigTable(config),
        [""],
        buildRequiredInputs(config),
        [""],
        buildPipelineDescription(),
        [""],
        buildPerformanceGuidance(config),
        [""],
        buildDebugNotes(config)
      ).join("\n");
    }
  };

  // ---------------------------------------------------------------
  //  Self-registration
  // ---------------------------------------------------------------

  if (typeof RapidML !== "undefined" && RapidML.Methodologies && RapidML.Methodologies.register) {
    RapidML.Methodologies.register(longitudinalPredictionMethodology);
  }

})();
