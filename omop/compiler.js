(function() {
  window.RapidML = window.RapidML || {};
  RapidML.Compiler = RapidML.Compiler || {};

  // ===================================================================
  //  COMPILER TOOLKIT
  //
  //  The compiler does NOT build the complete study SQL.  It exposes
  //  building blocks that each methodology assembles with its own
  //  spine / window strategy.
  //
  //  Building blocks:
  //    prepareContext(config)        → shared objects (dialects, dates, covariates)
  //    buildConceptCTEs(config)      → 4 CTEs: entry root, entry descendants,
  //                                    outcome root, outcome descendants
  //    buildCohortCTE(config)        → 1 CTE: cohort (person_id, t0)
  //    buildAnchorCTE(config, ctx)   → 1 CTE: index_anchor
  //    buildFirstOutcomeCTE(config)  → 1 CTE: first_outcome
  //    buildCensoredSpineCTE(config, ctx) → 1 CTE: final_spine from spine
  //    outcomeLabelExpr(config)      → CASE expression for outcome_label
  //    buildFinalSelect(config, ctx) → final SELECT columns + covariate joins
  //    buildDebugHelpers(config, ctx)→ temp-table helper functions
  //    sqlLines(lines)               → join non-empty lines
  //    buildHeader(config, label)    → SQL comment header
  // ===================================================================

  function sqlLines(lines) {
    return lines.filter(function(line) { return line !== null && line !== undefined && line !== ""; }).join("\n");
  }

  function requiredModulesPresent() {
    return !!(
      RapidML.Compiler.Dialects &&
      RapidML.Compiler.Censoring &&
      RapidML.Compiler.Covariates &&
      RapidML.Compiler.Domains &&
      RapidML.Compiler.Domains.Outcomes &&
      RapidML.Compiler.Domains.CohortEntry
    );
  }

  /**
   * Prepare shared context that every methodology will need.
   * Returns an object with dialects, date boundaries, covariate info.
   */
  function prepareContext(config) {
    if (!requiredModulesPresent()) {
      throw new Error(
        "Compiler modules not loaded. Ensure scripts are included: " +
        "core/dialects, omop/censoring, omop/covariates, rules/outcome-sql, rules/cohort-sql."
      );
    }

    var d = RapidML.Compiler.Dialects;
    var covariates = RapidML.Compiler.Covariates.buildSelect(config);
    var studyStart = d.quoteDateLiteral(config.db, config.startYear, 1, 1);
    var studyEnd = d.quoteDateLiteral(config.db, config.endYear, 12, 31);

    return {
      d: d,
      covariates: covariates,
      studyStart: studyStart,
      studyEnd: studyEnd,
      outcomes: RapidML.Compiler.Domains.Outcomes,
      cohortEntry: RapidML.Compiler.Domains.CohortEntry,
      isPostgres: config.db === "postgres"
    };
  }

  /** 4 CTEs: entry condition root/descendants, outcome root/descendants */
  function buildConceptCTEs(config, ctx) {
    return [
      ctx.outcomes.entryConditionRootCTE(config),
      ctx.outcomes.entryConditionDescendantsCTE(config),
      ctx.outcomes.outcomeRootCTE(config),
      ctx.outcomes.outcomeDescendantsCTE(config)
    ];
  }

  /** Cohort CTE — produces person_id, t0 */
  function buildCohortCTE(config, ctx) {
    return ctx.cohortEntry.buildCohortCTE(config);
  }

  /**
   * Index anchor CTE — clamps t0 to study start and computes the
   * first valid index date (t0 + baseline offset).
   * Takes a baselineDays string for the offset.
   */
  function buildAnchorCTE(config, ctx, baselineDays) {
    var d = ctx.d;
    var firstIndexDateExpr = d.addDaysExpr(config.db, "c.exposure_index_date", baselineDays);
    return sqlLines([
      "-- Anchor each person to study start boundary and first prediction date",
      "index_anchor AS (",
      "  SELECT",
      "    c.person_id,",
      "    c.t0,",
      "    CASE",
      "      WHEN c.t0 < " + ctx.studyStart + " THEN " + ctx.studyStart,
      "      ELSE c.t0",
      "    END AS exposure_index_date,",
      "    " + firstIndexDateExpr + " AS first_index_date",
      "  FROM cohort c",
      ")"
    ]);
  }

  /** First outcome CTE — produces person_id, outcome_date */
  function buildFirstOutcomeCTE(config, ctx) {
    return ctx.outcomes.firstOutcomeCTE(config);
  }

  /**
   * Censored spine CTE — takes the spine (built by methodology) and
   * applies censoring filters.  Assumes an existing CTE named "spine".
   */
  function buildCensoredSpineCTE(config, ctx) {
    return sqlLines([
      "-- Apply outcome and observation-period censoring",
      "final_spine AS (",
      "  SELECT s.*",
      "  FROM spine s",
      "  LEFT JOIN first_outcome o ON s.person_id = o.person_id",
      "  JOIN " + config.schema + ".observation_period op ON s.person_id = op.person_id",
      "  WHERE " + RapidML.Compiler.Censoring.buildCensoringWhere(config),
      ")"
    ]);
  }

  /** CASE expression for outcome_label */
  function outcomeLabelExpr(config, ctx) {
    return ctx.outcomes.outcomeLabelExpr(config);
  }

  /** Build the final SELECT columns array and covariate JOIN clauses */
  function buildFinalSelect(config, ctx) {
    var selectColumns = [
      "s.*",
      outcomeLabelExpr(config, ctx)
    ].concat(ctx.covariates.columns || []);

    return {
      columns: selectColumns,
      joins: ctx.covariates.joins || []
    };
  }

  /** SQL comment header for the top of the generated file */
  function buildHeader(config, label) {
    var mode = config.debug ? "DEBUG" : "PRODUCTION";
    var entryConceptId = (config.cohortEntry && config.cohortEntry.conditionConceptId) || "missing";
    var outcomeConceptId = (config.outcomeRule && config.outcomeRule.conceptId) || config.outcomeConceptId || "missing";
    return sqlLines([
      "/***********************************************************************",
      " " + mode + " SQL — " + label,
      " Database: " + (config.db === "postgres" ? "PostgreSQL" : "SQL Server"),
      " Entry condition concept: " + entryConceptId,
      " Outcome concept: " + outcomeConceptId,
      " Cohort entry mode: " + (config.cohortEntryMode || "first_event"),
      "***********************************************************************/"
    ]);
  }

  /** Performance guidance comments */
  function buildPerformanceHints(config) {
    if (config.db === "postgres") {
      return sqlLines([
        "-- PERFORMANCE (PostgreSQL): run once after bulk loads",
        "-- ANALYZE " + config.schema + ".condition_occurrence;",
        "-- ANALYZE " + config.schema + ".measurement;",
        "-- ANALYZE " + config.schema + ".visit_occurrence;",
        "-- ANALYZE " + config.schema + ".observation_period;"
      ]);
    }
    return sqlLines([
      "-- PERFORMANCE (SQL Server): refresh optimizer stats",
      "-- UPDATE STATISTICS " + config.schema + ".condition_occurrence WITH FULLSCAN;",
      "-- UPDATE STATISTICS " + config.schema + ".measurement WITH FULLSCAN;",
      "-- UPDATE STATISTICS " + config.schema + ".visit_occurrence WITH FULLSCAN;",
      "-- UPDATE STATISTICS " + config.schema + ".observation_period WITH FULLSCAN;"
    ]);
  }

  // =================================================================
  //  DEBUG HELPERS — temp-table utilities for methodology debug paths
  // =================================================================

  function buildDebugHelpers(config, ctx) {
    var isPostgres = ctx.isPostgres;
    var tmpPrefix = isPostgres ? "tmp_" : "#tmp_";

    function tmpName(base) {
      return tmpPrefix + base;
    }

    function dropTemp(base) {
      var name = tmpName(base);
      if (isPostgres) {
        return "DROP TABLE IF EXISTS " + name + ";";
      }
      return "IF OBJECT_ID('tempdb.." + name + "') IS NOT NULL DROP TABLE " + name + ";";
    }

    function selectTop(tableName, orderByExpr) {
      if (isPostgres) {
        return "SELECT * FROM " + tableName + (orderByExpr ? " ORDER BY " + orderByExpr : "") + " LIMIT 20;";
      }
      return "SELECT TOP 20 * FROM " + tableName + (orderByExpr ? " ORDER BY " + orderByExpr : "") + ";";
    }

    function createTempFromSelect(base, columnsSql, fromAndWhereSql) {
      var name = tmpName(base);
      if (isPostgres) {
        return sqlLines([
          "CREATE TEMP TABLE " + name + " AS",
          "SELECT",
          columnsSql,
          fromAndWhereSql + ";"
        ]);
      }
      return sqlLines([
        "SELECT",
        columnsSql,
        "INTO " + name,
        fromAndWhereSql + ";"
      ]);
    }

    function createTempFromCTE(base, withClause, cteBody, finalSelect) {
      var name = tmpName(base);
      if (isPostgres) {
        return sqlLines([
          "CREATE TEMP TABLE " + name + " AS",
          withClause,
          cteBody,
          finalSelect + ";"
        ]);
      }
      return sqlLines([
        withClause,
        cteBody,
        finalSelect.replace(/^\s*SELECT/i, "SELECT") + " INTO " + name + ";"
      ]);
    }

    return {
      tmpName: tmpName,
      dropTemp: dropTemp,
      selectTop: selectTop,
      createTempFromSelect: createTempFromSelect,
      createTempFromCTE: createTempFromCTE
    };
  }

  // =================================================================
  //  Concept debug steps — shared by all debug methodologies
  // =================================================================

  function buildDebugConceptSteps(config, ctx, dbg) {
    var entryConceptId = String((config.cohortEntry && config.cohortEntry.conditionConceptId) || "0").replace(/[^0-9]/g, "");
    var outcomeConceptId = String((config.outcomeRule && config.outcomeRule.conceptId) || config.outcomeConceptId || "0").replace(/[^0-9]/g, "");

    return sqlLines([
      "-- STEP 1: Resolve entry condition root concept",
      dbg.dropTemp("entry_condition_root"),
      dbg.createTempFromSelect(
        "entry_condition_root",
        "  concept_id",
        "FROM " + config.schema + ".concept\nWHERE concept_id = " + entryConceptId + "\n  AND standard_concept = 'S'"
      ),
      "SELECT * FROM " + dbg.tmpName("entry_condition_root") + ";",
      "",
      "-- STEP 2: Expand entry condition descendants",
      dbg.dropTemp("entry_condition_descendants"),
      dbg.createTempFromSelect(
        "entry_condition_descendants",
        "  descendant_concept_id AS concept_id",
        "FROM " + config.schema + ".concept_ancestor\nWHERE ancestor_concept_id IN (SELECT concept_id FROM " + dbg.tmpName("entry_condition_root") + ")"
      ),
      "SELECT COUNT(*) AS entry_descendant_count FROM " + dbg.tmpName("entry_condition_descendants") + ";",
      "",
      "-- STEP 3: Resolve outcome root concept",
      dbg.dropTemp("outcome_root"),
      dbg.createTempFromSelect(
        "outcome_root",
        "  concept_id",
        "FROM " + config.schema + ".concept\nWHERE concept_id = " + outcomeConceptId + "\n  AND standard_concept = 'S'"
      ),
      "SELECT * FROM " + dbg.tmpName("outcome_root") + ";",
      "",
      "-- STEP 4: Expand outcome descendants",
      dbg.dropTemp("outcome_descendants"),
      dbg.createTempFromSelect(
        "outcome_descendants",
        "  descendant_concept_id AS concept_id",
        "FROM " + config.schema + ".concept_ancestor\nWHERE ancestor_concept_id IN (SELECT concept_id FROM " + dbg.tmpName("outcome_root") + ")"
      ),
      "SELECT COUNT(*) AS outcome_descendant_count FROM " + dbg.tmpName("outcome_descendants") + ";"
    ]);
  }

  /** Cohort entry debug step */
  function buildDebugCohortStep(config, ctx, dbg) {
    var isPostgres = ctx.isPostgres;
    return sqlLines([
      "",
      "-- STEP 5: Build cohort entry table (t0 per person)",
      dbg.dropTemp("cohort"),
      (isPostgres ? "CREATE TEMP TABLE " + dbg.tmpName("cohort") + " AS" : null),
      "WITH entry_condition_descendants AS (",
      "  SELECT concept_id FROM " + dbg.tmpName("entry_condition_descendants"),
      "),",
      ctx.cohortEntry.buildCohortCTE(config),
      (isPostgres
        ? "SELECT * FROM cohort;"
        : "SELECT * INTO " + dbg.tmpName("cohort") + " FROM cohort;"),
      "SELECT COUNT(*) AS cohort_size FROM " + dbg.tmpName("cohort") + ";"
    ]);
  }

  /** First outcome debug step */
  function buildDebugOutcomeStep(config, ctx, dbg, stepNum) {
    var isPostgres = ctx.isPostgres;
    return sqlLines([
      "",
      "-- STEP " + stepNum + ": Compute first outcome date per person",
      dbg.dropTemp("first_outcome"),
      (isPostgres ? "CREATE TEMP TABLE " + dbg.tmpName("first_outcome") + " AS" : null),
      "WITH outcome_descendants AS (",
      "  SELECT concept_id FROM " + dbg.tmpName("outcome_descendants"),
      "),",
      ctx.outcomes.firstOutcomeCTE(config),
      (isPostgres
        ? "SELECT * FROM first_outcome;"
        : "SELECT * INTO " + dbg.tmpName("first_outcome") + " FROM first_outcome;"),
      "SELECT COUNT(*) AS first_outcome_rows FROM " + dbg.tmpName("first_outcome") + ";"
    ]);
  }

  /** Censoring debug step */
  function buildDebugCensoringStep(config, ctx, dbg, stepNum, spineTableName) {
    return sqlLines([
      "",
      "-- STEP " + stepNum + ": Apply censoring rules (outcome, observation period, study end)",
      dbg.dropTemp("final_spine"),
      dbg.createTempFromSelect(
        "final_spine",
        "  s.*, o.outcome_date AS first_outcome_date",
        "FROM " + spineTableName + " s\nLEFT JOIN " + dbg.tmpName("first_outcome") + " o ON s.person_id = o.person_id\nJOIN " + config.schema + ".observation_period op ON s.person_id = op.person_id\nWHERE " + RapidML.Compiler.Censoring.buildCensoringWhere(config)
      ),
      "SELECT COUNT(*) AS final_spine_rows FROM " + dbg.tmpName("final_spine") + ";"
    ]);
  }

  /** Final labeled dataset debug step */
  function buildDebugFinalStep(config, ctx, dbg, stepNum) {
    var sel = buildFinalSelect(config, ctx);
    return sqlLines([
      "",
      "-- STEP " + stepNum + ": Build final labeled dataset with selected covariates",
      "WITH outcome_descendants AS (",
      "  SELECT concept_id FROM " + dbg.tmpName("outcome_descendants"),
      ")",
      "SELECT",
      "  " + sel.columns.join(",\n  "),
      "FROM " + dbg.tmpName("final_spine") + " s",
      sel.joins.join("\n"),
      "ORDER BY s.person_id, s.index_date;"
    ]);
  }

  // =================================================================
  //  Public API — exposed on RapidML.Compiler
  // =================================================================

  RapidML.Compiler.prepareContext       = prepareContext;
  RapidML.Compiler.buildConceptCTEs     = buildConceptCTEs;
  RapidML.Compiler.buildCohortCTE       = buildCohortCTE;
  RapidML.Compiler.buildAnchorCTE       = buildAnchorCTE;
  RapidML.Compiler.buildFirstOutcomeCTE = buildFirstOutcomeCTE;
  RapidML.Compiler.buildCensoredSpineCTE = buildCensoredSpineCTE;
  RapidML.Compiler.outcomeLabelExpr     = outcomeLabelExpr;
  RapidML.Compiler.buildFinalSelect     = buildFinalSelect;
  RapidML.Compiler.buildHeader          = buildHeader;
  RapidML.Compiler.buildPerformanceHints = buildPerformanceHints;
  RapidML.Compiler.buildDebugHelpers    = buildDebugHelpers;
  RapidML.Compiler.buildDebugConceptSteps = buildDebugConceptSteps;
  RapidML.Compiler.buildDebugCohortStep  = buildDebugCohortStep;
  RapidML.Compiler.buildDebugOutcomeStep = buildDebugOutcomeStep;
  RapidML.Compiler.buildDebugCensoringStep = buildDebugCensoringStep;
  RapidML.Compiler.buildDebugFinalStep   = buildDebugFinalStep;
  RapidML.Compiler.sqlLines              = sqlLines;
})();
