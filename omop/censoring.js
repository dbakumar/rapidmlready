(function() {
  window.RapidML = window.RapidML || {};
  RapidML.Compiler = RapidML.Compiler || {};

  function buildCensoringWhere(config) {
    const db = config.db;
    const d = RapidML.Compiler.Dialects;
    const studyEnd = d.quoteDateLiteral(db, config.endYear, 12, 31);

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
