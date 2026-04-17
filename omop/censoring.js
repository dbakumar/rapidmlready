/**
 * ============================================================================
 * CENSORING.JS  -  OMOP Observation Period Censoring
 * ============================================================================
 *
 * PURPOSE:
 *   Builds the WHERE clause that censors (removes) spine rows that fall
 *   outside the patient's observation period, past the study end date,
 *   or after a first outcome event.
 *
 * CENSORING RULES APPLIED:
 *   1. Outcome date must be on or after the outcome window start
 *   2. Baseline start must be within the observation period
 *   3. Outcome end must be within the observation period
 *   4. Outcome end must not exceed the study end date
 *
 * DEPENDS ON:  core/dialects.js (RapidML.Compiler.Dialects)
 * USED BY:     omop/compiler.js  (buildCensoredSpineCTE)
 *
 * PUBLIC API:
 *   RapidML.Compiler.Censoring.buildCensoringWhere(config)
 * ============================================================================
 */
(function() {
  window.RapidML = window.RapidML || {};
  RapidML.Compiler = RapidML.Compiler || {};

  /**
   * Build the censoring WHERE clause for the final_spine CTE.
   *
   * @param  {object} config  normalised study configuration
   * @return {string}         multi-line AND-joined WHERE conditions
   */
  function buildCensoringWhere(config) {
    var db = config.db;
    var d = RapidML.Compiler.Dialects;
    var studyEnd = d.quoteDateLiteral(db, config.endYear, 12, 31);

    return [
      "(o.outcome_date IS NULL OR s.outcome_start <= o.outcome_date)",
      "s.baseline_start >= op.observation_period_start_date",
      "s.outcome_end <= op.observation_period_end_date",
      "s.outcome_end <= " + studyEnd
    ].join("\n    AND ");
  }

  RapidML.Compiler.Censoring = {
    buildCensoringWhere: buildCensoringWhere
  };
})();
