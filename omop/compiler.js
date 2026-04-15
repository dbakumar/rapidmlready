(function() {
  window.RapidML = window.RapidML || {};
  RapidML.Compiler = RapidML.Compiler || {};

  function sqlLines(lines) {
    return lines.filter(function(line) { return line !== null && line !== undefined && line !== ""; }).join("\n");
  }

  function requiredModulesPresent() {
    return !!(
      RapidML.Compiler.Dialects &&
      RapidML.Compiler.WindowEngine &&
      RapidML.Compiler.Censoring &&
      RapidML.Compiler.Covariates &&
      RapidML.Compiler.Domains &&
      RapidML.Compiler.Domains.Outcomes &&
      RapidML.Compiler.Domains.CohortEntry
    );
  }

  function buildExampleNotes() {
    return [
      "-- ---------------------------------------------------------------------",
      "-- DEBUG WALKTHROUGH EXAMPLE (conceptual, not executed)",
      "-- Person A: t0=2020-01-15; no outcome until 2023-03-10",
      "-- Person B: t0=2018-06-01; outcome on 2021-02-05",
      "-- Steps below let you inspect where each person is kept or censored.",
      "-- ---------------------------------------------------------------------"
    ];
  }

  function buildDebugStudy(config, deps) {
    const d = deps.d;
    const outcomes = deps.outcomes;
    const cohortEntry = deps.cohortEntry;
    const covariates = deps.covariates;
    const windowExpr = deps.windowExpr;
    const studyStart = deps.studyStart;
    const studyEnd = deps.studyEnd;
    const numsCTE = deps.numsCTE;

    const entryConditionConcept = (config.cohortEntry && config.cohortEntry.conditionConceptId) || "missing";
    const outcomeConcept = (config.outcomeRule && config.outcomeRule.conceptId) || config.outcomeConceptId || "missing";

    const isPostgres = config.db === "postgres";
    const tmpPrefix = isPostgres ? "tmp_" : "#tmp_";

    function tmpName(base) {
      return tmpPrefix + base;
    }

    function dropTemp(base) {
      const name = tmpName(base);
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

    function createTempAs(base, selectSqlBody) {
      const name = tmpName(base);
      if (isPostgres) {
        return [
          "CREATE TEMP TABLE " + name + " AS",
          selectSqlBody + ";"
        ].join("\n");
      }

      // SQL Server equivalent: SELECT ... INTO #temp_table
      return [
        selectSqlBody.replace(/^\s*SELECT/i, "SELECT"),
        "INTO " + name + selectSqlBody.replace(/^\s*SELECT[\s\S]*?\bFROM\b/i, " FROM") + ";"
      ].join("\n");
    }

    function createTempFromSelect(base, columnsSql, fromAndWhereSql) {
      const name = tmpName(base);
      if (isPostgres) {
        return [
          "CREATE TEMP TABLE " + name + " AS",
          "SELECT",
          columnsSql,
          fromAndWhereSql + ";"
        ].join("\n");
      }
      return [
        "SELECT",
        columnsSql,
        "INTO " + name,
        fromAndWhereSql + ";"
      ].join("\n");
    }

    const outcomeLabelExpr = outcomes.outcomeLabelExpr(config);
    const selectColumns = [
      "s.*",
      outcomeLabelExpr
    ].concat(covariates.columns || []);

    return sqlLines([
      "/***********************************************************************",
      " DEBUG SQL (step-by-step temp tables) - " + (isPostgres ? "PostgreSQL" : "SQL Server"),
      " Entry condition concept: " + entryConditionConcept,
      " Outcome concept: " + outcomeConcept,
      " Cohort entry mode: " + (config.cohortEntryMode || "first_event"),
      "***********************************************************************/",
      "-- DEBUG HINTS:",
      (isPostgres ? "--   PostgreSQL: run EXPLAIN (ANALYZE, BUFFERS) on heavy steps for query-plan diagnostics." : "--   SQL Server: consider SET STATISTICS IO ON; SET STATISTICS TIME ON; while tuning."),
      (isPostgres ? "--   PostgreSQL: inspect temp tables with SELECT COUNT(*) and LIMIT samples at each step." : "--   SQL Server: inspect temp tables with SELECT COUNT(*) and TOP samples at each step."),
      (isPostgres ? "--   PostgreSQL: disable expensive debug diagnostics when done to keep output clean." : "--   SQL Server: disable diagnostics after debugging: SET STATISTICS IO OFF; SET STATISTICS TIME OFF;"),
      "",
      buildExampleNotes().join("\n"),
      "",
      "-- STEP 1: Resolve entry condition root concept",
      dropTemp("entry_condition_root"),
      createTempFromSelect(
        "entry_condition_root",
        "  concept_id",
        "FROM " + config.schema + ".concept\nWHERE concept_id = " + String(entryConditionConcept).replace(/[^0-9]/g, "") + "\n  AND standard_concept = 'S'"
      ),
      "SELECT * FROM " + tmpName("entry_condition_root") + ";",
      "",
      "-- STEP 2: Expand entry condition descendants",
      dropTemp("entry_condition_descendants"),
      createTempFromSelect(
        "entry_condition_descendants",
        "  descendant_concept_id AS concept_id",
        "FROM " + config.schema + ".concept_ancestor\nWHERE ancestor_concept_id IN (SELECT concept_id FROM " + tmpName("entry_condition_root") + ")"
      ),
      "SELECT COUNT(*) AS entry_descendant_count FROM " + tmpName("entry_condition_descendants") + ";",
      "",
      "-- STEP 3: Resolve outcome root concept",
      dropTemp("outcome_root"),
      createTempFromSelect(
        "outcome_root",
        "  concept_id",
        "FROM " + config.schema + ".concept\nWHERE concept_id = " + String(outcomeConcept).replace(/[^0-9]/g, "") + "\n  AND standard_concept = 'S'"
      ),
      "SELECT * FROM " + tmpName("outcome_root") + ";",
      "",
      "-- STEP 4: Expand outcome descendants",
      dropTemp("outcome_descendants"),
      createTempFromSelect(
        "outcome_descendants",
        "  descendant_concept_id AS concept_id",
        "FROM " + config.schema + ".concept_ancestor\nWHERE ancestor_concept_id IN (SELECT concept_id FROM " + tmpName("outcome_root") + ")"
      ),
      "SELECT COUNT(*) AS outcome_descendant_count FROM " + tmpName("outcome_descendants") + ";",
      "",
      "-- STEP 5: Build cohort entry table (t0 per person)",
      dropTemp("cohort"),
      (isPostgres ? "CREATE TEMP TABLE " + tmpName("cohort") + " AS" : null),
      "WITH entry_condition_descendants AS (",
      "  SELECT concept_id FROM " + tmpName("entry_condition_descendants"),
      "),",
      cohortEntry.buildCohortCTE(config),
      (isPostgres ? "SELECT * FROM cohort;" : "SELECT * INTO " + tmpName("cohort") + " FROM cohort;"),
      "SELECT COUNT(*) AS cohort_size FROM " + tmpName("cohort") + ";",
      "",
      "-- STEP 6: Build index anchor (respect study start and baseline offset)",
      dropTemp("index_anchor"),
      createTempFromSelect(
        "index_anchor",
        [
          "  c.person_id,",
          "  c.t0,",
          "  CASE",
          "    WHEN c.t0 < " + studyStart + " THEN " + studyStart,
          "    ELSE c.t0",
          "  END AS exposure_index_date,",
          "  " + windowExpr.firstIndexDateExpr + " AS first_index_date"
        ].join("\n"),
        "FROM " + tmpName("cohort") + " c"
      ),
      selectTop(tmpName("index_anchor"), "person_id"),
      "",
      "-- STEP 7: Build repeated yearly spine rows",
      dropTemp("spine"),
      (isPostgres
        ? [
            "CREATE TEMP TABLE " + tmpName("spine") + " AS",
            "WITH " + numsCTE,
            "SELECT",
            "  a.person_id,",
            "  a.t0,",
            "  a.exposure_index_date,",
            "  " + windowExpr.indexDateExpr + " AS index_date,",
            "  " + windowExpr.baselineStartExpr + " AS baseline_start,",
            "  " + windowExpr.baselineEndExpr + " AS baseline_end,",
            "  " + windowExpr.outcomeStartExpr + " AS outcome_start,",
            "  " + windowExpr.outcomeEndExpr + " AS outcome_end",
            "FROM " + tmpName("index_anchor") + " a",
            "JOIN nums ON " + windowExpr.outcomeEndExpr + " <= " + studyEnd + ";"
          ].join("\n")
        : [
            "WITH " + numsCTE,
            "spine_src AS (",
            "  SELECT",
            "    a.person_id,",
            "    a.t0,",
            "    a.exposure_index_date,",
            "    " + windowExpr.indexDateExpr + " AS index_date,",
            "    " + windowExpr.baselineStartExpr + " AS baseline_start,",
            "    " + windowExpr.baselineEndExpr + " AS baseline_end,",
            "    " + windowExpr.outcomeStartExpr + " AS outcome_start,",
            "    " + windowExpr.outcomeEndExpr + " AS outcome_end",
            "  FROM " + tmpName("index_anchor") + " a",
            "  JOIN nums ON " + windowExpr.outcomeEndExpr + " <= " + studyEnd,
            ")",
            "SELECT * INTO " + tmpName("spine") + " FROM spine_src;"
          ].join("\n")),
      "SELECT COUNT(*) AS spine_rows FROM " + tmpName("spine") + ";",
      "",
      "-- STEP 8: Compute first outcome date per person",
      dropTemp("first_outcome"),
      (isPostgres ? "CREATE TEMP TABLE " + tmpName("first_outcome") + " AS" : null),
      "WITH outcome_descendants AS (",
      "  SELECT concept_id FROM " + tmpName("outcome_descendants"),
      "),",
      outcomes.firstOutcomeCTE(config),
      (isPostgres ? "SELECT * FROM first_outcome;" : "SELECT * INTO " + tmpName("first_outcome") + " FROM first_outcome;"),
      "SELECT COUNT(*) AS first_outcome_rows FROM " + tmpName("first_outcome") + ";",
      "",
      "-- STEP 9: Apply censoring rules (outcome, observation period, study end)",
      dropTemp("final_spine"),
      createTempFromSelect(
        "final_spine",
        "  s.*, o.outcome_date AS first_outcome_date",
        "FROM " + tmpName("spine") + " s\nLEFT JOIN " + tmpName("first_outcome") + " o ON s.person_id = o.person_id\nJOIN " + config.schema + ".observation_period op ON s.person_id = op.person_id\nWHERE " + RapidML.Compiler.Censoring.buildCensoringWhere(config)
      ),
      "SELECT COUNT(*) AS final_spine_rows FROM " + tmpName("final_spine") + ";",
      "",
      "-- STEP 10: Build final labeled dataset with selected covariates",
      "WITH outcome_descendants AS (",
      "  SELECT concept_id FROM " + tmpName("outcome_descendants"),
      ")",
      "SELECT",
      "  " + selectColumns.join(",\n  "),
      "FROM " + tmpName("final_spine") + " s",
      (covariates.joins || []).join("\n"),
      "ORDER BY s.person_id, s.index_date;"
    ]);
  }

  function buildProductionStudy(config, deps) {
    const outcomes = deps.outcomes;
    const cohortEntry = deps.cohortEntry;
    const covariates = deps.covariates;
    const windowExpr = deps.windowExpr;
    const studyStart = deps.studyStart;
    const studyEnd = deps.studyEnd;
    const numsCTE = deps.numsCTE;

    const ctes = [
      outcomes.entryConditionRootCTE(config),
      outcomes.entryConditionDescendantsCTE(config),
      outcomes.outcomeRootCTE(config),
      outcomes.outcomeDescendantsCTE(config),
      cohortEntry.buildCohortCTE(config),
      sqlLines([
        "-- Anchor each person to study start boundary and first prediction date",
        "index_anchor AS (",
        "  SELECT",
        "    c.person_id,",
        "    c.t0,",
        "    CASE",
        "      WHEN c.t0 < " + studyStart + " THEN " + studyStart,
        "      ELSE c.t0",
        "    END AS exposure_index_date,",
        "    " + windowExpr.firstIndexDateExpr + " AS first_index_date",
        "  FROM cohort c",
        ")"
      ]),
      numsCTE,
      sqlLines([
        "-- Build repeated yearly index windows per person",
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
        "  JOIN nums ON " + windowExpr.outcomeEndExpr + " <= " + studyEnd,
        ")"
      ]),
      outcomes.firstOutcomeCTE(config),
      sqlLines([
        "-- Apply outcome and observation-period censoring",
        "final_spine AS (",
        "  SELECT s.*",
        "  FROM spine s",
        "  LEFT JOIN first_outcome o ON s.person_id = o.person_id",
        "  JOIN " + config.schema + ".observation_period op ON s.person_id = op.person_id",
        "  WHERE " + RapidML.Compiler.Censoring.buildCensoringWhere(config),
        ")"
      ])
    ];

    const selectColumns = [
      "s.*",
      outcomes.outcomeLabelExpr(config)
    ].concat(covariates.columns || []);

    const performanceGuidance = config.db === "postgres"
      ? [
          "-- PERFORMANCE (PostgreSQL): run once after bulk loads or before this query on stale stats",
          "-- ANALYZE " + config.schema + ".condition_occurrence;",
          "-- ANALYZE " + config.schema + ".measurement;",
          "-- ANALYZE " + config.schema + ".visit_occurrence;",
          "-- ANALYZE " + config.schema + ".observation_period;"
        ]
      : [
          "-- PERFORMANCE (SQL Server): refresh optimizer stats when data changes significantly",
          "-- UPDATE STATISTICS " + config.schema + ".condition_occurrence WITH FULLSCAN;",
          "-- UPDATE STATISTICS " + config.schema + ".measurement WITH FULLSCAN;",
          "-- UPDATE STATISTICS " + config.schema + ".visit_occurrence WITH FULLSCAN;",
          "-- UPDATE STATISTICS " + config.schema + ".observation_period WITH FULLSCAN;"
        ];

    return sqlLines([
      "/***********************************************************************",
      " PRODUCTION SQL (Compiler v2 — Predefined Cohort Rules)",
      " Debug mode: disabled",
      " Entry condition concept: " + (config.cohortEntry && config.cohortEntry.conditionConceptId ? config.cohortEntry.conditionConceptId : "missing"),
      " Outcome concept: " + ((config.outcomeRule && config.outcomeRule.conceptId) || config.outcomeConceptId || "missing"),
      " Cohort entry mode: " + (config.cohortEntryMode || "first_event"),
      "***********************************************************************/",
      "-- Cohort entry is standardized through visit_occurrence joins for consistent event context.",
      "-- This lets users restrict cohort entry to inpatient/outpatient/ER/custom visit types.",
      performanceGuidance.join("\n"),
      "-- CTE pipeline below is ordered from concept resolution to final labeled windows.",
      "WITH " + ctes.join(",\n"),
      "-- Final dataset with outcome label and selected covariates",
      "SELECT",
      "  " + selectColumns.join(",\n  "),
      "FROM final_spine s",
      (covariates.joins || []).join("\n"),
      "ORDER BY s.person_id, s.index_date;"
    ]);
  }

  function compileStudy(config) {
    if (!requiredModulesPresent()) {
      throw new Error("Compiler modules not loaded. Ensure scripts are included: core/dialects, core/windows, omop/censoring, omop/covariates, rules/outcome-sql, rules/cohort-sql.");
    }

    const d = RapidML.Compiler.Dialects;
    const outcomes = RapidML.Compiler.Domains.Outcomes;
    const cohortEntry = RapidML.Compiler.Domains.CohortEntry;
    const covariates = RapidML.Compiler.Covariates.buildSelect(config);
    const windowExpr = RapidML.Compiler.WindowEngine.buildWindowExpressions(config);
    const studyStart = d.quoteDateLiteral(config.db, config.startYear, 1, 1);
    const studyEnd = d.quoteDateLiteral(config.db, config.endYear, 12, 31);
    const numsCTE = d.seriesCTE(config.db, "nums", 20);
    const isDebug = !!config.debug;

    const deps = {
      d: d,
      outcomes: outcomes,
      cohortEntry: cohortEntry,
      covariates: covariates,
      windowExpr: windowExpr,
      studyStart: studyStart,
      studyEnd: studyEnd,
      numsCTE: numsCTE
    };

    if (isDebug) {
      return buildDebugStudy(config, deps);
    }

    return buildProductionStudy(config, deps);
  }

  RapidML.Compiler.compileStudy = compileStudy;
})();
