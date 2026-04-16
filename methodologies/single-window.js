/**
 * RapidML Methodology Plugin: Single Window
 *
 * Study design: One row per patient.  Each person gets a single
 * baseline + outcome window anchored at their cohort entry date (t0),
 * clamped to the study start boundary.
 *
 * No yearly repetition — no nums series.  Simpler and faster when
 * a repeated-index design is not needed (e.g., cross-sectional
 * prediction, case–control matching).
 *
 * Self-registers on RapidML.Methodologies.
 */

(function () {

  // ---------------------------------------------------------------
  //  Window expressions — single window, no nums.n
  // ---------------------------------------------------------------

  function buildWindowExpressions(config) {
    var d = RapidML.Compiler.Dialects;
    var db = config.db;
    var baselineDays = String(Number(config.baselineYears) * 365);
    var outcomeDays  = String(Number(config.outcomeYears) * 365);

    return {
      baselineDays: baselineDays,
      outcomeDays: outcomeDays,
      // first_index_date = t0 + baseline offset
      firstIndexDateExpr: d.addDaysExpr(db, "c.exposure_index_date", baselineDays),
      // Single window: index_date = first_index_date (no yearly offset)
      indexDateExpr:      "a.first_index_date",
      baselineStartExpr:  "a.exposure_index_date",
      baselineEndExpr:    d.addDaysExpr(db, "a.first_index_date", "-1"),
      outcomeStartExpr:   "a.first_index_date",
      outcomeEndExpr:     d.addDaysExpr(db, "a.first_index_date", outcomeDays)
    };
  }

  /** Build the spine CTE — one row per patient, no series JOIN */
  function buildSpineCTE(config, ctx, windowExpr) {
    var C = RapidML.Compiler;
    return C.sqlLines([
      "-- Single window per person (no yearly repetition)",
      "spine AS (",
      "  SELECT",
      "    a.person_id,",
      "    a.t0,",
      "    a.exposure_index_date,",
      "    " + windowExpr.indexDateExpr + " AS index_date,",
      "    " + windowExpr.baselineStartExpr + " AS baseline_start,",
      "    " + windowExpr.baselineEndExpr + " AS baseline_end,",
      "    " + windowExpr.outcomeStartExpr + " AS outcome_start,",
      "    " + windowExpr.outcomeEndExpr + " AS outcome_end",
      "  FROM index_anchor a",
      "  WHERE " + windowExpr.outcomeEndExpr + " <= " + ctx.studyEnd,
      ")"
    ]);
  }

  // ---------------------------------------------------------------
  //  PRODUCTION SQL
  // ---------------------------------------------------------------

  function buildProductionSQL(config) {
    var C = RapidML.Compiler;
    var ctx = C.prepareContext(config);
    var windowExpr = buildWindowExpressions(config);

    var ctes = C.buildConceptCTEs(config, ctx).concat([
      C.buildCohortCTE(config, ctx),
      C.buildAnchorCTE(config, ctx, windowExpr.baselineDays),
      buildSpineCTE(config, ctx, windowExpr),
      C.buildFirstOutcomeCTE(config, ctx),
      C.buildCensoredSpineCTE(config, ctx)
    ]);

    var sel = C.buildFinalSelect(config, ctx);

    return C.sqlLines([
      C.buildHeader(config, "Single Window (one row per patient)"),
      C.buildPerformanceHints(config),
      "WITH " + ctes.join(",\n"),
      "SELECT",
      "  " + sel.columns.join(",\n  "),
      "FROM final_spine s",
      sel.joins.join("\n"),
      "ORDER BY s.person_id;"
    ]);
  }

  // ---------------------------------------------------------------
  //  DEBUG SQL
  // ---------------------------------------------------------------

  function buildDebugSQL(config) {
    var C = RapidML.Compiler;
    var ctx = C.prepareContext(config);
    var dbg = C.buildDebugHelpers(config, ctx);
    var windowExpr = buildWindowExpressions(config);

    // Steps 1-5: concepts, cohort (shared)
    var conceptSteps = C.buildDebugConceptSteps(config, ctx, dbg);
    var cohortStep = C.buildDebugCohortStep(config, ctx, dbg);

    // Step 6: index anchor
    var anchorStep = C.sqlLines([
      "",
      "-- STEP 6: Build index anchor",
      dbg.dropTemp("index_anchor"),
      dbg.createTempFromSelect(
        "index_anchor",
        [
          "  c.person_id,",
          "  c.t0,",
          "  CASE",
          "    WHEN c.t0 < " + ctx.studyStart + " THEN " + ctx.studyStart,
          "    ELSE c.t0",
          "  END AS exposure_index_date,",
          "  " + windowExpr.firstIndexDateExpr + " AS first_index_date"
        ].join("\n"),
        "FROM " + dbg.tmpName("cohort") + " c"
      ),
      dbg.selectTop(dbg.tmpName("index_anchor"), "person_id")
    ]);

    // Step 7: single-window spine (methodology-specific, no nums)
    var spineStep = C.sqlLines([
      "",
      "-- STEP 7: Build single-window spine (one row per patient)",
      dbg.dropTemp("spine"),
      dbg.createTempFromSelect(
        "spine",
        [
          "  a.person_id,",
          "  a.t0,",
          "  a.exposure_index_date,",
          "  " + windowExpr.indexDateExpr + " AS index_date,",
          "  " + windowExpr.baselineStartExpr + " AS baseline_start,",
          "  " + windowExpr.baselineEndExpr + " AS baseline_end,",
          "  " + windowExpr.outcomeStartExpr + " AS outcome_start,",
          "  " + windowExpr.outcomeEndExpr + " AS outcome_end"
        ].join("\n"),
        "FROM " + dbg.tmpName("index_anchor") + " a\nWHERE " + windowExpr.outcomeEndExpr + " <= " + ctx.studyEnd
      ),
      "SELECT COUNT(*) AS spine_rows FROM " + dbg.tmpName("spine") + ";"
    ]);

    // Steps 8-10: outcome, censoring, final (shared)
    var outcomeStep = C.buildDebugOutcomeStep(config, ctx, dbg, 8);
    var censorStep  = C.buildDebugCensoringStep(config, ctx, dbg, 9, dbg.tmpName("spine"));
    var finalStep   = C.buildDebugFinalStep(config, ctx, dbg, 10);

    return C.sqlLines([
      C.buildHeader(config, "Single Window DEBUG (one row per patient)"),
      conceptSteps,
      cohortStep,
      anchorStep,
      spineStep,
      outcomeStep,
      censorStep,
      finalStep
    ]);
  }

  // ---------------------------------------------------------------
  //  README builder
  // ---------------------------------------------------------------

  function describeRules(config) {
    var baselineDays = Number(config.baselineYears) * 365;
    var outcomeDays  = Number(config.outcomeYears) * 365;
    var covariates   = (config.covariates || []).join(", ") || "none";

    return [
      "# Study: Single-Window Prediction",
      "",
      "## Configuration Summary",
      "",
      "| Item | Value |",
      "|---|---|",
      "| Methodology | Single window (one row per patient) |",
      "| Database | " + config.db + " |",
      "| Schema | " + config.schema + " |",
      "| Study period | " + config.startYear + "-01-01 to " + config.endYear + "-12-31 |",
      "| Baseline window | " + config.baselineYears + " year(s) (" + baselineDays + " days) |",
      "| Outcome window | " + config.outcomeYears + " year(s) (" + outcomeDays + " days) |",
      "| Selected covariates | " + covariates + " |",
      "| Debug mode | " + (config.debug ? "enabled" : "disabled") + " |",
      "",
      "## SQL Pipeline",
      "",
      "1. Resolve entry and outcome concept descendants.",
      "2. Build cohort entry dates (t0) based on selected cohort rule.",
      "3. Anchor each patient to a single index date (t0 + baseline offset).",
      "4. One baseline + outcome window per patient (no yearly repetition).",
      "5. Apply censoring: first-outcome + observation period + study end.",
      "6. Compute outcome_label and append covariates.",
      "",
      "## Output",
      "",
      "One row per person_id with baseline_start, baseline_end, outcome_start, outcome_end, outcome_label, and selected covariates."
    ].join("\n");
  }

  // ---------------------------------------------------------------
  //  Plugin registration
  // ---------------------------------------------------------------

  var singleWindowMethodology = {
    id: "single-window",
    label: "Single window (one row per patient)",

    buildSQL: function (config) {
      if (config.debug) {
        return buildDebugSQL(config);
      }
      return buildProductionSQL(config);
    },

    describeRules: describeRules
  };

  if (typeof RapidML !== "undefined" && RapidML.Methodologies && RapidML.Methodologies.register) {
    RapidML.Methodologies.register(singleWindowMethodology);
  }

})();
