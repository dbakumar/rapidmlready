/**
 * ============================================================================
 * DIALECTS.JS  -  Database Dialect Helpers (PostgreSQL vs SQL Server)
 * ============================================================================
 *
 * PURPOSE:
 *   Provides database-specific SQL syntax for date operations, series
 *   generation, and literal formatting.  Every other file that builds SQL
 *   calls these helpers so that a single dialect switch produces correct SQL
 *   for either PostgreSQL or SQL Server.
 *
 * DEPENDS ON:  nothing (standalone utility)
 * USED BY:     omop/compiler.js, methodologies/*.js
 *
 * PUBLIC API  (exposed on RapidML.Compiler.Dialects):
 *   dialectFor(db)                   - returns "postgres" or "sqlserver"
 *   quoteDateLiteral(db, y, m, d)    - database-safe date literal string
 *   addDaysExpr(db, dateExpr, days)  - SQL expression: date + N days
 *   addYearsExpr(db, dateExpr, yrs)  - SQL expression: date + N years
 *   seriesCTE(db, alias, maxN)       - CTE that generates integer series 0..N
 *
 * EXAMPLE:
 *   var d = RapidML.Compiler.Dialects;
 *   d.quoteDateLiteral("postgres", 2024, 1, 15);
 *   // => "DATE '2024-01-15'"
 *   d.addDaysExpr("sqlserver", "col", "30");
 *   // => "DATEADD(DAY, 30, col)"
 * ============================================================================
 */
(function() {
  window.RapidML = window.RapidML || {};
  RapidML.Compiler = RapidML.Compiler || {};

  /**
   * Normalise a database identifier to one of the two supported dialects.
   * Anything that is not "sqlserver" is treated as PostgreSQL.
   *
   * @param  {string} db  "postgres" or "sqlserver"
   * @return {string}     "postgres" or "sqlserver"
   */
  function dialectFor(db) {
    return db === "sqlserver" ? "sqlserver" : "postgres";
  }

  /**
   * Build a safe date literal string for the target database.
   *
   * PostgreSQL:  DATE '2024-01-15'
   * SQL Server:  CAST('2024-01-15' AS DATE)
   *
   * @param  {string} db    "postgres" or "sqlserver"
   * @param  {number|string} year
   * @param  {number|string} month
   * @param  {number|string} day
   * @return {string}        SQL date literal
   */
  function quoteDateLiteral(db, year, month, day) {
    var y = String(year);
    var m = String(month).padStart(2, "0");
    var d = String(day).padStart(2, "0");
    if (dialectFor(db) === "sqlserver") {
      return "CAST('" + y + "-" + m + "-" + d + "' AS DATE)";
    }
    return "DATE '" + y + "-" + m + "-" + d + "'";
  }

  /**
   * SQL expression that adds a number of days to a date expression.
   *
   * PostgreSQL:  (dateExpr + (days) * INTERVAL '1 day')
   * SQL Server:  DATEADD(DAY, days, dateExpr)
   *
   * @param  {string} db        "postgres" or "sqlserver"
   * @param  {string} dateExpr  SQL column or expression
   * @param  {string} daysExpr  integer or SQL expression for day count
   * @return {string}           SQL expression
   */
  function addDaysExpr(db, dateExpr, daysExpr) {
    if (dialectFor(db) === "sqlserver") {
      return "DATEADD(DAY, " + daysExpr + ", " + dateExpr + ")";
    }
    return "(" + dateExpr + " + (" + daysExpr + ") * INTERVAL '1 day')";
  }

  /**
   * SQL expression that adds a number of years to a date expression.
   *
   * @param  {string} db         "postgres" or "sqlserver"
   * @param  {string} dateExpr   SQL column or expression
   * @param  {string} yearsExpr  integer or SQL expression for year count
   * @return {string}            SQL expression
   */
  function addYearsExpr(db, dateExpr, yearsExpr) {
    if (dialectFor(db) === "sqlserver") {
      return "DATEADD(YEAR, " + yearsExpr + ", " + dateExpr + ")";
    }
    return "(" + dateExpr + " + (" + yearsExpr + ") * INTERVAL '1 year')";
  }

  /**
   * Build a CTE that generates an integer series from 0 to maxN.
   *
   * PostgreSQL:  uses generate_series(0, N)
   * SQL Server:  uses TOP(N+1) ROW_NUMBER() from sys.all_objects
   *
   * @param  {string} db     "postgres" or "sqlserver"
   * @param  {string} alias  CTE name (e.g. "nums")
   * @param  {number} maxN   upper bound (default 20)
   * @return {string}        complete CTE text
   */
  function seriesCTE(db, alias, maxN) {
    var upper = String(maxN || 20);
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
