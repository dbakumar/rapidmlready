(function() {
  window.RapidML = window.RapidML || {};
  RapidML.Compiler = RapidML.Compiler || {};

  function dialectFor(db) {
    return db === "sqlserver" ? "sqlserver" : "postgres";
  }

  function quoteDateLiteral(db, year, month, day) {
    const y = String(year);
    const m = String(month).padStart(2, "0");
    const d = String(day).padStart(2, "0");
    if (dialectFor(db) === "sqlserver") {
      return "CAST('" + y + "-" + m + "-" + d + "' AS DATE)";
    }
    return "DATE '" + y + "-" + m + "-" + d + "'";
  }

  function addDaysExpr(db, dateExpr, daysExpr) {
    if (dialectFor(db) === "sqlserver") {
      return "DATEADD(DAY, " + daysExpr + ", " + dateExpr + ")";
    }
    return "(" + dateExpr + " + (" + daysExpr + ") * INTERVAL '1 day')";
  }

  function addYearsExpr(db, dateExpr, yearsExpr) {
    if (dialectFor(db) === "sqlserver") {
      return "DATEADD(YEAR, " + yearsExpr + ", " + dateExpr + ")";
    }
    return "(" + dateExpr + " + (" + yearsExpr + ") * INTERVAL '1 year')";
  }

  function seriesCTE(db, alias, maxN) {
    const upper = String(maxN || 20);
    if (dialectFor(db) === "sqlserver") {
      return alias + " AS (\n" +
        "  SELECT TOP (" + upper + " + 1) ROW_NUMBER() OVER (ORDER BY (SELECT NULL)) - 1 AS n\n" +
        "  FROM sys.all_objects\n" +
        ")";
    }

    return alias + " AS (\n" +
      "  SELECT generate_series(0, " + upper + ") AS n\n" +
      ")";
  }

  RapidML.Compiler.Dialects = {
    dialectFor: dialectFor,
    quoteDateLiteral: quoteDateLiteral,
    addDaysExpr: addDaysExpr,
    addYearsExpr: addYearsExpr,
    seriesCTE: seriesCTE
  };
})();
