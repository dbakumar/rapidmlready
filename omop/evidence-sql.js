/**
 * ============================================================================
 * EVIDENCE-SQL.JS  -  OMOP CDM Evidence Adapter
 * ============================================================================
 *
 * PURPOSE:
 *   Converts evidence blocks (rows of type diagnosis / lab / drug /
 *   procedure / observation / visit) into OMOP-specific SQL CTEs.
 *   This is the OMOP CDM implementation of the adapter interface
 *   defined by core/adapter-registry (now in core/generator.js).
 *
 * HOW IT WORKS:
 *   Each evidence row specifies a type, concept ID, and optional
 *   operator/value.  This adapter maps each type to the corresponding
 *   OMOP CDM table and column:
 *
 *   | Row Type     | OMOP Table               | Concept Column            |
 *   |------------- |--------------------------|---------------------------|
 *   | diagnosis    | condition_occurrence      | condition_concept_id      |
 *   | lab          | measurement               | measurement_concept_id    |
 *   | drug         | drug_exposure              | drug_concept_id           |
 *   | procedure    | procedure_occurrence       | procedure_concept_id      |
 *   | observation  | observation                | observation_concept_id    |
 *   | visit        | visit_occurrence           | visit_concept_id          |
 *
 *   For each row it generates:
 *   1. A concept CTE  - resolves descendants via concept_ancestor
 *   2. An event query  - finds matching events (person_id, MIN date)
 *   3. HAVING clause   - enforces minCount / distinctVisits thresholds
 *   4. Visit JOINs     - filters by inpatient/outpatient/ER context
 *
 *   Blocks combine rows with match modes:
 *     "all" -> every row must match (HAVING COUNT DISTINCT row_idx = N)
 *     "any" -> at least one row matches (UNION ALL + MIN date)
 *
 * ADAPTER CONTRACT (registered as id="omop"):
 *   buildConceptCTEs(config)      -> array of CTE strings
 *   buildCohortCTE(config)        -> "cohort AS (...)" CTE
 *   buildFirstOutcomeCTE(config)   -> "first_outcome AS (...)" CTE
 *   buildOutcomeLabelExpr(config)  -> "CASE ... END AS outcome_label"
 *   buildExclusionWhere(config)    -> "AND NOT EXISTS (...)" fragment
 *   buildConfounderColumns(config) -> { columns[], joins[] }
 *   buildDomainBridge(config)      -> { outcomes, cohortEntry }
 *
 * DEPENDS ON:  core/generator.js  (RapidML.Adapters.register)
 * USED BY:     omop/compiler.js   (routes all SQL building through adapter)
 * ============================================================================
 */
(function () {
  window.RapidML = window.RapidML || {};

  // ── Helpers ─────────────────────────────────────────────────────

  function conceptId(value) {
    return String(value || "").replace(/[^0-9]/g, "") || "0";
  }

  function safeOperator(op) {
    var allowed = [">", "<", ">=", "<=", "="];
    var trimmed = String(op || "").trim();
    return allowed.indexOf(trimmed) >= 0 ? trimmed : ">";
  }

  function safeNumericValue(val) {
    var num = parseFloat(val);
    return isNaN(num) ? "0" : String(num);
  }

  function sqlLines(lines) {
    return lines
      .filter(function (l) { return l !== null && l !== undefined && l !== ""; })
      .join("\n");
  }

  // ── Per-row visit context ──────────────────────────────────────

  /** Resolve visit concept IDs from a row's visitContext setting */
  function rowVisitConceptIds(row) {
    var mode = (row && row.visitContext) || "all";
    if (mode === "inpatient")  return ["9201"];
    if (mode === "outpatient") return ["9202"];
    if (mode === "emergency")  return ["9203"];
    if (mode === "custom" && Array.isArray(row.visitContextIds)) {
      return row.visitContextIds
        .map(function (id) { return conceptId(id); })
        .filter(function (id) { return id !== "0"; });
    }
    return []; // "all" → no concept filter
  }

  function rowVisitJoinClause(row, schema, eventAlias, dateCol, visitIdCol, visitAlias) {
    var ids = rowVisitConceptIds(row);
    var pred = ids.length
      ? visitAlias + ".visit_concept_id IN (" + ids.join(", ") + ")"
      : "1=1";
    return sqlLines([
      "JOIN " + schema + ".visit_occurrence " + visitAlias,
      "      ON " + visitAlias + ".person_id = " + eventAlias + ".person_id",
      "      AND (",
      "        (" + eventAlias + "." + visitIdCol + " IS NOT NULL AND " + visitAlias + ".visit_occurrence_id = " + eventAlias + "." + visitIdCol + ")",
      "        OR",
      "        (" + eventAlias + "." + visitIdCol + " IS NULL AND " + eventAlias + "." + dateCol + " BETWEEN " + visitAlias + ".visit_start_date AND COALESCE(" + visitAlias + ".visit_end_date, " + visitAlias + ".visit_start_date))",
      "      )",
      "      AND " + pred
    ]);
  }

  // ── Per-row concept CTE (ancestor expansion) ──────────────────

  function buildRowConceptCTE(config, row, prefix) {
    if (!row.descendants) return null;
    if (row.type === "lab" || row.type === "visit") return null;
    var cid = conceptId(row.conceptId);
    return sqlLines([
      "-- Descendants for " + prefix + " (" + row.type + " " + cid + ")",
      prefix + "_concepts AS (",
      "  SELECT descendant_concept_id AS concept_id",
      "  FROM " + config.schema + ".concept_ancestor",
      "  WHERE ancestor_concept_id = " + cid,
      ")"
    ]);
  }

  // ── Per-row event subquery (finds person_id, MIN date) ─────────

  /** Build a HAVING clause for minCount / distinctVisits thresholds */
  function buildHavingClause(row, visitAlias) {
    var minCount = parseInt(row.minCount, 10) || 1;
    if (minCount <= 1 && !row.distinctVisits) return null;
    if (row.distinctVisits && visitAlias) {
      return "HAVING COUNT(DISTINCT " + visitAlias + ".visit_occurrence_id) >= " + minCount;
    }
    if (minCount > 1) {
      return "HAVING COUNT(*) >= " + minCount;
    }
    return null;
  }

  function buildRowEventSubquery(config, row, prefix) {
    var cid = conceptId(row.conceptId);
    var conceptFilter;
    var having;

    if (row.type === "diagnosis") {
      conceptFilter = row.descendants
        ? "co.condition_concept_id IN (SELECT concept_id FROM " + prefix + "_concepts)"
        : "co.condition_concept_id = " + cid;
      having = buildHavingClause(row, "v_" + prefix);
      return sqlLines([
        "SELECT co.person_id, MIN(co.condition_start_date) AS event_date",
        "FROM " + config.schema + ".condition_occurrence co",
        rowVisitJoinClause(row, config.schema, "co", "condition_start_date", "visit_occurrence_id", "v_" + prefix),
        "WHERE " + conceptFilter,
        "GROUP BY co.person_id",
        having
      ]);
    }

    if (row.type === "lab") {
      having = buildHavingClause(row, "v_" + prefix);
      var labJoin = (row.visitContext && row.visitContext !== "all")
        ? rowVisitJoinClause(row, config.schema, "m", "measurement_date", "visit_occurrence_id", "v_" + prefix)
        : null;
      return sqlLines([
        "SELECT m.person_id, MIN(m.measurement_date) AS event_date",
        "FROM " + config.schema + ".measurement m",
        labJoin,
        "WHERE m.measurement_concept_id = " + cid,
        "  AND CAST(m.value_as_number AS NUMERIC) " + safeOperator(row.operator) + " " + safeNumericValue(row.value),
        "GROUP BY m.person_id",
        having
      ]);
    }

    if (row.type === "drug") {
      conceptFilter = row.descendants
        ? "de.drug_concept_id IN (SELECT concept_id FROM " + prefix + "_concepts)"
        : "de.drug_concept_id = " + cid;
      having = buildHavingClause(row, "v_" + prefix);
      var drugJoin = (row.visitContext && row.visitContext !== "all")
        ? rowVisitJoinClause(row, config.schema, "de", "drug_exposure_start_date", "visit_occurrence_id", "v_" + prefix)
        : null;
      return sqlLines([
        "SELECT de.person_id, MIN(de.drug_exposure_start_date) AS event_date",
        "FROM " + config.schema + ".drug_exposure de",
        drugJoin,
        "WHERE " + conceptFilter,
        "GROUP BY de.person_id",
        having
      ]);
    }

    if (row.type === "procedure") {
      conceptFilter = row.descendants
        ? "po.procedure_concept_id IN (SELECT concept_id FROM " + prefix + "_concepts)"
        : "po.procedure_concept_id = " + cid;
      having = buildHavingClause(row, "v_" + prefix);
      var procJoin = (row.visitContext && row.visitContext !== "all")
        ? rowVisitJoinClause(row, config.schema, "po", "procedure_date", "visit_occurrence_id", "v_" + prefix)
        : null;
      return sqlLines([
        "SELECT po.person_id, MIN(po.procedure_date) AS event_date",
        "FROM " + config.schema + ".procedure_occurrence po",
        procJoin,
        "WHERE " + conceptFilter,
        "GROUP BY po.person_id",
        having
      ]);
    }

    if (row.type === "observation") {
      conceptFilter = row.descendants
        ? "o.observation_concept_id IN (SELECT concept_id FROM " + prefix + "_concepts)"
        : "o.observation_concept_id = " + cid;
      var obsValueFilter = (row.operator && row.value)
        ? "\n  AND CAST(o.value_as_number AS NUMERIC) " + safeOperator(row.operator) + " " + safeNumericValue(row.value)
        : "";
      having = buildHavingClause(row, "v_" + prefix);
      return sqlLines([
        "SELECT o.person_id, MIN(o.observation_date) AS event_date",
        "FROM " + config.schema + ".observation o",
        rowVisitJoinClause(row, config.schema, "o", "observation_date", "visit_occurrence_id", "v_" + prefix),
        "WHERE " + conceptFilter + obsValueFilter,
        "GROUP BY o.person_id",
        having
      ]);
    }

    if (row.type === "visit") {
      having = buildHavingClause(row, null);
      return sqlLines([
        "SELECT vo.person_id, MIN(vo.visit_start_date) AS event_date",
        "FROM " + config.schema + ".visit_occurrence vo",
        "WHERE vo.visit_concept_id = " + cid,
        "GROUP BY vo.person_id",
        having
      ]);
    }

    return "SELECT NULL AS person_id, NULL AS event_date WHERE 1=0";
  }

  // ── Per-row windowed EXISTS (for outcome label / exclusions) ───

  function buildRowWindowedExists(config, row, prefix, pAlias, startCol, endCol) {
    var cid = conceptId(row.conceptId);
    var minCount = parseInt(row.minCount, 10) || 1;
    var needsCount = minCount > 1 || row.distinctVisits;

    // When minCount > 1, use a counting subquery instead of simple EXISTS
    function wrapCountCheck(selectFrom, whereLines, countExpr) {
      if (!needsCount) {
        return sqlLines([
          "EXISTS (",
          "  SELECT 1",
          "  " + selectFrom,
          whereLines,
          ")"
        ]);
      }
      return sqlLines([
        "(SELECT COUNT(" + countExpr + ")",
        " " + selectFrom,
        whereLines,
        ") >= " + minCount
      ]);
    }

    if (row.type === "diagnosis") {
      var f = row.descendants
        ? "co.condition_concept_id IN (SELECT concept_id FROM " + prefix + "_concepts)"
        : "co.condition_concept_id = " + cid;
      var visitJoin = (needsCount && row.distinctVisits) || (row.visitContext && row.visitContext !== "all")
        ? "\n  " + rowVisitJoinClause(row, config.schema, "co", "condition_start_date", "visit_occurrence_id", "v_" + prefix)
        : "";
      var countExpr = row.distinctVisits ? "DISTINCT v_" + prefix + ".visit_occurrence_id" : "*";
      return wrapCountCheck(
        "FROM " + config.schema + ".condition_occurrence co" + visitJoin,
        "  WHERE co.person_id = " + pAlias + ".person_id\n    AND " + f + "\n    AND co.condition_start_date BETWEEN " + pAlias + "." + startCol + " AND " + pAlias + "." + endCol,
        countExpr
      );
    }

    if (row.type === "lab") {
      var labVisit = (row.visitContext && row.visitContext !== "all")
        ? "\n  " + rowVisitJoinClause(row, config.schema, "m", "measurement_date", "visit_occurrence_id", "v_" + prefix)
        : "";
      var countExpr = "*";
      return wrapCountCheck(
        "FROM " + config.schema + ".measurement m" + labVisit,
        "  WHERE m.person_id = " + pAlias + ".person_id\n    AND m.measurement_concept_id = " + cid + "\n    AND CAST(m.value_as_number AS NUMERIC) " + safeOperator(row.operator) + " " + safeNumericValue(row.value) + "\n    AND m.measurement_date BETWEEN " + pAlias + "." + startCol + " AND " + pAlias + "." + endCol,
        countExpr
      );
    }

    if (row.type === "drug") {
      var f = row.descendants
        ? "de.drug_concept_id IN (SELECT concept_id FROM " + prefix + "_concepts)"
        : "de.drug_concept_id = " + cid;
      var drugVisit = (row.visitContext && row.visitContext !== "all")
        ? "\n" + rowVisitJoinClause(row, config.schema, "de", "drug_exposure_start_date", "visit_occurrence_id", "v_" + prefix)
        : "";
      return wrapCountCheck(
        "FROM " + config.schema + ".drug_exposure de" + drugVisit,
        "  WHERE de.person_id = " + pAlias + ".person_id\n    AND " + f + "\n    AND de.drug_exposure_start_date BETWEEN " + pAlias + "." + startCol + " AND " + pAlias + "." + endCol,
        "*"
      );
    }

    if (row.type === "procedure") {
      var f = row.descendants
        ? "po.procedure_concept_id IN (SELECT concept_id FROM " + prefix + "_concepts)"
        : "po.procedure_concept_id = " + cid;
      var procVisit = (row.visitContext && row.visitContext !== "all")
        ? "\n  " + rowVisitJoinClause(row, config.schema, "po", "procedure_date", "visit_occurrence_id", "v_" + prefix)
        : "";
      return wrapCountCheck(
        "FROM " + config.schema + ".procedure_occurrence po" + procVisit,
        "  WHERE po.person_id = " + pAlias + ".person_id\n    AND " + f + "\n    AND po.procedure_date BETWEEN " + pAlias + "." + startCol + " AND " + pAlias + "." + endCol,
        "*"
      );
    }

    if (row.type === "observation") {
      var f = row.descendants
        ? "o.observation_concept_id IN (SELECT concept_id FROM " + prefix + "_concepts)"
        : "o.observation_concept_id = " + cid;
      var obsValFilter = (row.operator && row.value)
        ? "\n    AND CAST(o.value_as_number AS NUMERIC) " + safeOperator(row.operator) + " " + safeNumericValue(row.value)
        : "";
      var visitJoin = (needsCount && row.distinctVisits) || (row.visitContext && row.visitContext !== "all")
        ? "\n  " + rowVisitJoinClause(row, config.schema, "o", "observation_date", "visit_occurrence_id", "v_" + prefix)
        : "";
      var countExpr = row.distinctVisits ? "DISTINCT v_" + prefix + ".visit_occurrence_id" : "*";
      return wrapCountCheck(
        "FROM " + config.schema + ".observation o" + visitJoin,
        "  WHERE o.person_id = " + pAlias + ".person_id\n    AND " + f + obsValFilter + "\n    AND o.observation_date BETWEEN " + pAlias + "." + startCol + " AND " + pAlias + "." + endCol,
        countExpr
      );
    }

    if (row.type === "visit") {
      return wrapCountCheck(
        "FROM " + config.schema + ".visit_occurrence vo",
        "  WHERE vo.person_id = " + pAlias + ".person_id\n    AND vo.visit_concept_id = " + cid + "\n    AND vo.visit_start_date BETWEEN " + pAlias + "." + startCol + " AND " + pAlias + "." + endCol,
        "*"
      );
    }

    return "1=0";
  }

  // ── Block-level builders ───────────────────────────────────────

  /** Collect all concept-ancestor CTEs for a block */
  function buildBlockConceptCTEs(config, block, blockPrefix) {
    if (!block || !block.rows) return [];
    var ctes = [];
    block.rows.forEach(function (row, i) {
      var cte = buildRowConceptCTE(config, row, blockPrefix + "_r" + i);
      if (cte) ctes.push(cte);
    });
    return ctes;
  }

  /** Build per-row event CTEs for multi-row blocks */
  function buildBlockEventCTEs(config, block, blockPrefix) {
    if (!block || !block.rows || block.rows.length <= 1) return null;
    var parts = [];
    block.rows.forEach(function (row, i) {
      var prefix = blockPrefix + "_r" + i;
      parts.push(sqlLines([
        "-- " + blockPrefix + " row " + i + " (" + row.type + ")",
        prefix + "_events AS (",
        "  " + buildRowEventSubquery(config, row, prefix),
        ")"
      ]));
    });
    return parts.join(",\n");
  }

  /** Build the combiner CTE (cohort or first_outcome) */
  function buildBlockCombinerCTE(config, block, blockPrefix, cteName, dateCol) {
    if (!block || !block.rows || block.rows.length === 0) return "";
    var rows = block.rows;
    var match = block.match || "all";

    // Single row — inline directly, renaming event_date to expected alias
    if (rows.length === 1) {
      return sqlLines([
        "-- " + cteName + ": single evidence row (" + rows[0].type + ")",
        cteName + " AS (",
        "  SELECT person_id, event_date AS " + dateCol + " FROM (",
        "  " + buildRowEventSubquery(config, rows[0], blockPrefix + "_r0"),
        "  ) _single",
        ")"
      ]);
    }

    // Multiple rows, match="any"
    if (match === "any") {
      var unions = rows.map(function (_, i) {
        return "    SELECT person_id, event_date FROM " + blockPrefix + "_r" + i + "_events";
      });
      return sqlLines([
        "-- " + cteName + ": ANY of " + rows.length + " evidence rows",
        cteName + " AS (",
        "  SELECT person_id, MIN(event_date) AS " + dateCol,
        "  FROM (",
        unions.join("\n    UNION ALL\n"),
        "  ) _any",
        "  GROUP BY person_id",
        ")"
      ]);
    }

    // Multiple rows, match="all"
    var unions = rows.map(function (_, i) {
      return "    SELECT person_id, event_date, " + i + " AS row_idx FROM " + blockPrefix + "_r" + i + "_events";
    });
    return sqlLines([
      "-- " + cteName + ": ALL of " + rows.length + " evidence rows must match",
      cteName + " AS (",
      "  SELECT person_id, MAX(event_date) AS " + dateCol,
      "  FROM (",
      unions.join("\n    UNION ALL\n"),
      "  ) _all",
      "  GROUP BY person_id",
      "  HAVING COUNT(DISTINCT row_idx) = " + rows.length,
      ")"
    ]);
  }

  // ── Adapter public functions ───────────────────────────────────

  /** All concept-ancestor CTEs for every block */
  function buildConceptCTEs(config) {
    if (!config.study) return [];
    var ctes = [];
    ctes = ctes.concat(buildBlockConceptCTEs(config, config.study.entry, "entry"));
    ctes = ctes.concat(buildBlockConceptCTEs(config, config.study.outcome, "outcome"));
    if (config.study.exclusions) {
      config.study.exclusions.forEach(function (exc, i) {
        var cte = buildRowConceptCTE(config, exc, "excl_" + i);
        if (cte) ctes.push(cte);
      });
    }
    if (config.study.confounders) {
      config.study.confounders.forEach(function (conf, i) {
        var cte = buildRowConceptCTE(config, conf, "conf_" + i);
        if (cte) ctes.push(cte);
      });
    }
    return ctes;
  }

  /** Cohort CTE from entry block → person_id, t0 */
  function buildCohortCTE(config) {
    var block = config.study.entry;
    var eventCTEs = buildBlockEventCTEs(config, block, "entry");
    var combiner = buildBlockCombinerCTE(config, block, "entry", "cohort", "t0");
    if (eventCTEs) {
      return eventCTEs + ",\n" + combiner;
    }
    return combiner;
  }

  /** First outcome CTE from outcome block → person_id, outcome_date */
  function buildFirstOutcomeCTE(config) {
    var block = config.study.outcome;
    var eventCTEs = buildBlockEventCTEs(config, block, "outcome");
    var combiner = buildBlockCombinerCTE(config, block, "outcome", "first_outcome", "outcome_date");
    if (eventCTEs) {
      return eventCTEs + ",\n" + combiner;
    }
    return combiner;
  }

  /** Outcome label CASE expression (EXISTS-based) */
  function buildOutcomeLabelExpr(config) {
    var block = config.study.outcome;
    if (!block || !block.rows || block.rows.length === 0) {
      return "0 AS outcome_label";
    }
    var match = block.match || "any";
    var existsClauses = block.rows.map(function (row, i) {
      return buildRowWindowedExists(config, row, "outcome_r" + i, "s", "outcome_start", "outcome_end");
    });
    var connector = match === "all" ? "\n    AND " : "\n    OR ";
    return sqlLines([
      "CASE",
      "    WHEN " + existsClauses.join(connector),
      "    THEN 1 ELSE 0",
      "  END AS outcome_label"
    ]);
  }

  /** Exclusion WHERE clauses (NOT EXISTS per exclusion row) */
  function buildExclusionWhere(config) {
    if (!config.study || !config.study.exclusions || config.study.exclusions.length === 0) {
      return null;
    }
    var clauses = config.study.exclusions.map(function (exc, i) {
      return "NOT " + buildRowWindowedExists(
        config, exc, "excl_" + i, "s", "baseline_start", "outcome_end"
      );
    });
    return clauses.join("\n    AND ");
  }

  /** Confounder columns (binary flags) and joins */
  function buildConfounderColumns(config) {
    if (!config.study || !config.study.confounders || config.study.confounders.length === 0) {
      return { columns: [], joins: [] };
    }
    var columns = [];
    config.study.confounders.forEach(function (conf, i) {
      var safeLabel = String(conf.label || "confounder_" + i)
        .toLowerCase()
        .replace(/[^a-z0-9_]/g, "_")
        .substring(0, 50);
      var existsExpr = buildRowWindowedExists(
        config, conf, "conf_" + i, "s", "baseline_start", "baseline_end"
      );
      columns.push("CASE WHEN " + existsExpr + " THEN 1 ELSE 0 END AS " + safeLabel);
    });
    return { columns: columns, joins: [] };
  }

  // ── Backward-compat bridge ─────────────────────────────────────
  // When config.study exists, the compiler calls the adapter instead
  // of the old domain modules.  These domain-compatible objects let
  // the compiler's existing functions work without changes.

  function buildDomainBridge(config) {
    return {
      outcomes: {
        entryConditionRootCTE: function () { return null; },
        entryConditionDescendantsCTE: function () { return null; },
        outcomeRootCTE: function () { return null; },
        outcomeDescendantsCTE: function () { return null; },
        firstOutcomeCTE: function (cfg) { return buildFirstOutcomeCTE(cfg); },
        outcomeLabelExpr: function (cfg) { return buildOutcomeLabelExpr(cfg); }
      },
      cohortEntry: {
        buildCohortCTE: function (cfg) { return buildCohortCTE(cfg); }
      }
    };
  }

  // ── Register ───────────────────────────────────────────────────

  RapidML.Adapters.register({
    id: "omop",
    label: "OMOP CDM",
    buildConceptCTEs: buildConceptCTEs,
    buildCohortCTE: buildCohortCTE,
    buildFirstOutcomeCTE: buildFirstOutcomeCTE,
    buildOutcomeLabelExpr: buildOutcomeLabelExpr,
    buildExclusionWhere: buildExclusionWhere,
    buildConfounderColumns: buildConfounderColumns,
    buildDomainBridge: buildDomainBridge
  });

})();
