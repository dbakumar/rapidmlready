(function() {
  window.RapidML = window.RapidML || {};
  RapidML.Compiler = RapidML.Compiler || {};

  function buildWindowExpressions(config) {
    const db = config.db;
    const d = RapidML.Compiler.Dialects;
    const baselineDays = String(Number(config.baselineYears) * 365);
    const outcomeDays = String(Number(config.outcomeYears) * 365);

    const firstIndexDateExpr = d.addDaysExpr(db, "a.exposure_index_date", baselineDays);
    const indexDateExpr = d.addYearsExpr(db, "a.first_index_date", "nums.n");
    const baselineStartExpr = d.addDaysExpr(db, "a.first_index_date", "(nums.n * 365) - " + baselineDays);
    const baselineEndExpr = d.addDaysExpr(db, "a.first_index_date", "(nums.n * 365) - 1");
    const outcomeStartExpr = d.addYearsExpr(db, "a.first_index_date", "nums.n");
    const outcomeEndExpr = d.addDaysExpr(db, d.addYearsExpr(db, "a.first_index_date", "nums.n"), outcomeDays);

    return {
      baselineDays: baselineDays,
      outcomeDays: outcomeDays,
      firstIndexDateExpr: firstIndexDateExpr,
      indexDateExpr: indexDateExpr,
      baselineStartExpr: baselineStartExpr,
      baselineEndExpr: baselineEndExpr,
      outcomeStartExpr: outcomeStartExpr,
      outcomeEndExpr: outcomeEndExpr
    };
  }

  RapidML.Compiler.WindowEngine = {
    buildWindowExpressions: buildWindowExpressions
  };
})();
