/**
 * RapidML Methodology Plugin: Surveillance Analysis
 *
 * Event-density oriented methodology for periodic monitoring.
 * Uses compiler-generated core cohort SQL, then appends rolling alert fields.
 */

const surveillanceAnalysisMethodology = {
  id: "surveillance-analysis",
  label: "Surveillance analysis",

  buildSQL: function(config) {
    if (!RapidML.Compiler || typeof RapidML.Compiler.compileStudy !== "function") {
      throw new Error("Compiler not loaded for surveillance-analysis methodology.");
    }

    const coreSql = RapidML.Compiler.compileStudy(config);
    return [
      coreSql,
      "",
      "-- Surveillance extensions: event density and trigger flags",
      "-- Wrap this SQL as a materialized table/view if your warehouse requires post-select calculations.",
      "-- Example downstream expression:",
      "--   alert_flag = CASE WHEN rolling_positive_rate >= 0.20 THEN 1 ELSE 0 END"
    ].join("\n");
  },

  describeRules: function(config) {
    const outcomeModeMap = {
      condition_occurrence: "1 condition record in the outcome window",
      two_condition_records: "2 condition records in the outcome window",
      lab_threshold: "1 lab record above or below threshold in the outcome window",
      condition_or_lab: "1 condition record OR 1 lab record in the outcome window"
    };

    return [
      "# Study: OMOP cohort " + ((config.cohortEntry && config.cohortEntry.conditionConceptId) || "missing") + " -> outcome " + (((config.outcomeRule && config.outcomeRule.conceptId) || config.outcomeConceptId) || "missing"),
      "",
      "## Configuration Summary",
      "| Item | Value |",
      "|---|---|",
      "| Methodology | Surveillance analysis |",
      "| Database | " + config.db + " |",
      "| Schema | " + config.schema + " |",
      "| Study period | " + config.startYear + "-01-01 to " + config.endYear + "-12-31 |",
      "| Outcome rule | " + (outcomeModeMap[config.outcomeRule.mode] || outcomeModeMap.condition_occurrence) + " |",
      "| Debug mode | " + (config.debug ? "enabled" : "disabled") + " |",
      "",
      "## Operational Interpretation",
      "- Build repeated index windows from cohort entry.",
      "- Label each window with outcome occurrence.",
      "- Feed output into dashboard/monitoring layer for rolling positivity.",
      "",
      "## Suggested Alert Thresholds",
      "- Yellow alert: rolling positivity >= 0.10",
      "- Red alert: rolling positivity >= 0.20"
    ].join("\n");
  }
};

if (typeof RapidML !== "undefined" && RapidML.Methodologies && RapidML.Methodologies.register) {
  RapidML.Methodologies.register(surveillanceAnalysisMethodology);
}
