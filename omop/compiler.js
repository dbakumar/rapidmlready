/**
 * ============================================================================
 * COMPILER.JS  -  OMOP Compiler Toolkit (Building Blocks for Methodologies)
 * ============================================================================
 *
 * PURPOSE:
 *   The compiler does NOT build the complete study SQL on its own.
 *   Instead it exposes a set of reusable building blocks that each
 *   methodology plugin (e.g. longitudinal-prediction.js) assembles
 *   with its own spine / window strategy.
 *
 * BUILDING BLOCKS:
 *   prepareContext(config)               -> shared context (dialects, dates,
 *                                           covariates, adapter)
 *   buildConceptCTEs(config, ctx)        -> concept-resolution CTEs
 *   buildCohortCTE(config, ctx)          -> cohort (person_id, t0)
 *   buildAnchorCTE(config, ctx, days)    -> index_anchor (clamped t0)
 *   buildFirstOutcomeCTE(config, ctx)    -> first_outcome (person_id, date)
 *   buildCensoredSpineCTE(config, ctx)   -> final_spine from spine
 *   outcomeLabelExpr(config, ctx)        -> CASE expression
 *   buildFinalSelect(config, ctx)        -> SELECT columns + JOIN clauses
 *   buildHeader(config, label)           -> SQL file header comment
 *   buildPerformanceHints(config)        -> DB-specific ANALYZE hints
 *   buildDebugHelpers(config, ctx)       -> temp-table helper functions
 *   buildDebugConceptSteps / CohortStep / OutcomeStep / CensoringStep / FinalStep
 *   sqlLines(lines)                      -> join non-empty lines
 *
 * ADAPTER ROUTING:
 *   The compiler delegates data-model-specific SQL generation to the
 *   registered adapter (e.g. OMOP via omop/evidence-sql.js).  The\n *   adapter is selected based on config.dataModel (default: \"omop\").
 *
 * DEPENDS ON:\n *   core/generator.js       (RapidML.Adapters)\n *   core/dialects.js        (RapidML.Compiler.Dialects)\n *   omop/censoring.js       (RapidML.Compiler.Censoring)\n *   omop/covariates.js      (RapidML.Compiler.Covariates)\n *   omop/evidence-sql.js    (OMOP adapter registration)\n *
 * USED BY:\n *   methodologies/*.js      (call building blocks to assemble SQL)\n *   core/generator.js       (generate -> methodology -> compiler)\n *
 * PUBLIC API (exposed on RapidML.Compiler):\n *   All building block functions listed above.\n * ============================================================================\n */
(function() {
  window.RapidML = window.RapidML || {};
  RapidML.Compiler = RapidML.Compiler || {};

  /** Join an array of strings, filtering out null/undefined/empty values. */
  function sqlLines(lines) {
    return lines.filter(function(line) { return line !== null && line !== undefined && line !== ""; }).join("\n");
  }

  function requiredModulesPresent() {
    return !!(
      RapidML.Compiler.Dialects &&
      RapidML.Compiler.Censoring &&
      RapidML.Compiler.Covariates &&
      RapidML.Adapters
    );
  }

  /** Get the adapter for evidence-based configs */
  function getAdapter(config) {
    if (config.study && RapidML.Adapters) {
      return RapidML.Adapters.get(config.dataModel || "omop");
    }
    return null;
  }

  /**
   * Prepare shared context that every methodology will need.
   * Returns an object with dialects, date boundaries, covariate info.
   */
  function prepareContext(config) {
    if (!requiredModulesPresent()) {
      throw new Error(
        "Compiler modules not loaded. Ensure scripts are included: " +
        "core/dialects, core/adapter-registry, omop/censoring, omop/covariates."
      );
    }

    var d = RapidML.Compiler.Dialects;
    var covariates = RapidML.Compiler.Covariates.buildSelect(config);
    var studyStart = d.quoteDateLiteral(config.db, config.startYear, 1, 1);
    var studyEnd = d.quoteDateLiteral(config.db, config.endYear, 12, 31);

    var adapter = getAdapter(config);
    var bridge = adapter.buildDomainBridge(config);

    return {
      d: d,
      covariates: covariates,
      studyStart: studyStart,
      studyEnd: studyEnd,
      outcomes: bridge.outcomes,
      cohortEntry: bridge.cohortEntry,
      isPostgres: config.db === "postgres",
      adapter: adapter
    };
  }

  /** 4 CTEs: entry condition root/descendants, outcome root/descendants */
  function buildConceptCTEs(config, ctx) {
    return ctx.adapter.buildConceptCTEs(config);
  }

  /** Cohort CTE — produces person_id, t0 */
  function buildCohortCTE(config, ctx) {
    return ctx.adapter.buildCohortCTE(config);
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
    return ctx.adapter.buildFirstOutcomeCTE(config);
  }

  /**
   * Censored spine CTE — takes the spine (built by methodology) and
   * applies censoring filters + exclusions.  Assumes an existing CTE named "spine".
   */
  function buildCensoredSpineCTE(config, ctx) {
    var censorWhere = RapidML.Compiler.Censoring.buildCensoringWhere(config);

    var exclusionWhere = ctx.adapter.buildExclusionWhere(config);
    if (exclusionWhere) {
      censorWhere = censorWhere + "\n    AND " + exclusionWhere;
    }

    return sqlLines([
      "-- Apply outcome and observation-period censoring" + (config.study && config.study.exclusions && config.study.exclusions.length ? " + exclusions" : ""),
      "final_spine AS (",
      "  SELECT s.*",
      "  FROM spine s",
      "  LEFT JOIN first_outcome o ON s.person_id = o.person_id",
      "  JOIN " + config.schema + ".observation_period op ON s.person_id = op.person_id",
      "  WHERE " + censorWhere,
      ")"
    ]);
  }

  /** CASE expression for outcome_label */
  function outcomeLabelExpr(config, ctx) {
    return ctx.adapter.buildOutcomeLabelExpr(config);
  }

  /** Build the final SELECT columns array and covariate JOIN clauses */
  function buildFinalSelect(config, ctx) {
    var selectColumns = [
      "s.*",
      outcomeLabelExpr(config, ctx)
    ].concat(ctx.covariates.columns || []);

    var confResult = ctx.adapter.buildConfounderColumns(config);
    selectColumns = selectColumns.concat(confResult.columns || []);

    return {
      columns: selectColumns,
      joins: ctx.covariates.joins || []
    };
  }

  /** SQL comment header for the top of the generated file */
  function buildHeader(config, label) {
    var mode = config.debug ? "DEBUG" : "PRODUCTION";
    var entryDesc, outcomeDesc;

    var entryRows = config.study && config.study.entry ? config.study.entry.rows.length : 0;
    var outcomeRows = config.study && config.study.outcome ? config.study.outcome.rows.length : 0;
    entryDesc = entryRows + " evidence row(s), match=" + ((config.study && config.study.entry && config.study.entry.match) || "all");
    outcomeDesc = outcomeRows + " evidence row(s), match=" + ((config.study && config.study.outcome && config.study.outcome.match) || "any");

    return sqlLines([
      "/***********************************************************************",
      " " + mode + " SQL — " + label,
      " Database: " + (config.db === "postgres" ? "PostgreSQL" : "SQL Server"),
      " Entry: " + entryDesc,
      " Outcome: " + outcomeDesc,
      " Data model: " + (config.dataModel || "omop"),
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
    return "-- Evidence-based concept resolution (combined into cohort and outcome steps below)";
  }

  /** Cohort entry debug step */
  function buildDebugCohortStep(config, ctx, dbg) {
    var isPostgres = ctx.isPostgres;
    var conceptCTEs = ctx.adapter.buildConceptCTEs(config).filter(Boolean);
    var cohortCTE = ctx.adapter.buildCohortCTE(config);
    var allCTEs = conceptCTEs.concat([cohortCTE]).join(",\n");
    return sqlLines([
      "",
      "-- STEP 5: Build evidence-based cohort (concept resolution + entry criteria)",
      dbg.dropTemp("cohort"),
      (isPostgres ? "CREATE TEMP TABLE " + dbg.tmpName("cohort") + " AS" : null),
      "WITH " + allCTEs,
      (isPostgres
        ? "SELECT * FROM cohort;"
        : "SELECT * INTO " + dbg.tmpName("cohort") + " FROM cohort;"),
      "SELECT COUNT(*) AS cohort_size FROM " + dbg.tmpName("cohort") + ";"
    ]);
  }

  /** First outcome debug step */
  function buildDebugOutcomeStep(config, ctx, dbg, stepNum) {
    var isPostgres = ctx.isPostgres;
    var outComCTEs = [];
    if (config.study && config.study.outcome && config.study.outcome.rows) {
      config.study.outcome.rows.forEach(function(row, i) {
        if (row.descendants && row.type !== "lab") {
          var cid = String(row.conceptId || "0").replace(/[^0-9]/g, "") || "0";
          outComCTEs.push(
            "outcome_r" + i + "_concepts AS (\n" +
            "  SELECT descendant_concept_id AS concept_id\n" +
            "  FROM " + config.schema + ".concept_ancestor\n" +
            "  WHERE ancestor_concept_id = " + cid + "\n" +
            ")"
          );
        }
      });
    }
    var firstOutcomeCTE = ctx.adapter.buildFirstOutcomeCTE(config);
    var allCTEs = outComCTEs.concat([firstOutcomeCTE]).join(",\n");
    return sqlLines([
      "",
      "-- STEP " + stepNum + ": Compute first outcome (evidence-based)",
      dbg.dropTemp("first_outcome"),
      (isPostgres ? "CREATE TEMP TABLE " + dbg.tmpName("first_outcome") + " AS" : null),
      "WITH " + allCTEs,
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

    var outComCTEs = [];
    if (config.study && config.study.outcome && config.study.outcome.rows) {
      config.study.outcome.rows.forEach(function(row, i) {
        if (row.descendants && row.type !== "lab") {
          var cid = String(row.conceptId || "0").replace(/[^0-9]/g, "") || "0";
          outComCTEs.push(
            "outcome_r" + i + "_concepts AS (\n" +
            "  SELECT descendant_concept_id AS concept_id\n" +
            "  FROM " + config.schema + ".concept_ancestor\n" +
            "  WHERE ancestor_concept_id = " + cid + "\n" +
            ")"
          );
        }
      });
    }

    // Add exclusion concept CTEs if needed
    if (config.study && config.study.exclusions) {
      config.study.exclusions.forEach(function(exc, i) {
        if (exc.descendants && exc.type !== "lab") {
          var cid = String(exc.conceptId || "0").replace(/[^0-9]/g, "") || "0";
          outComCTEs.push(
            "excl_" + i + "_concepts AS (\n" +
            "  SELECT descendant_concept_id AS concept_id\n" +
            "  FROM " + config.schema + ".concept_ancestor\n" +
            "  WHERE ancestor_concept_id = " + cid + "\n" +
            ")"
          );
        }
      });
    }

    // Add confounder concept CTEs if needed
    if (config.study && config.study.confounders) {
      config.study.confounders.forEach(function(conf, i) {
        if (conf.descendants && conf.type !== "lab") {
          var cid = String(conf.conceptId || "0").replace(/[^0-9]/g, "") || "0";
          outComCTEs.push(
            "conf_" + i + "_concepts AS (\n" +
            "  SELECT descendant_concept_id AS concept_id\n" +
            "  FROM " + config.schema + ".concept_ancestor\n" +
            "  WHERE ancestor_concept_id = " + cid + "\n" +
            ")"
          );
        }
      });
    }

    var withClause = outComCTEs.length > 0
      ? "WITH " + outComCTEs.join(",\n") + "\n"
      : "";

    return sqlLines([
      "",
      "-- STEP " + stepNum + ": Build final labeled dataset with covariates",
      withClause + "SELECT",
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
