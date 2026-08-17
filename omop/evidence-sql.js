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

  function quoteSqlString(value) {
    return "'" + String(value || "").replace(/'/g, "''") + "'";
  }

  function unique(items) {
    var seen = {};
    var out = [];
    items.forEach(function (item) {
      if (!seen[item]) {
        seen[item] = true;
        out.push(item);
      }
    });
    return out;
  }

  function parseConceptTokens(row) {
    var values = [];

    if (Array.isArray(row && row.conceptIds)) {
      values = values.concat(row.conceptIds);
    }
    if (row && row.conceptId !== undefined && row.conceptId !== null && String(row.conceptId).trim() !== "") {
      values.push(row.conceptId);
    }

    var tokens = [];
    values.forEach(function (val) {
      String(val)
        .split(/[\s,;|]+/)
        .map(function (token) { return token.trim(); })
        .filter(Boolean)
        .forEach(function (token) { tokens.push(token); });
    });

    return unique(tokens);
  }

  function getConceptSpec(row) {
    var numeric = [];
    var sourceCodes = [];

    parseConceptTokens(row).forEach(function (token) {
      if (/^\d+$/.test(token)) {
        numeric.push(token);
      } else {
        sourceCodes.push(token);
      }
    });

    return {
      numericIds: unique(numeric),
      sourceCodes: unique(sourceCodes)
    };
  }

  function normalizeCodingMethod(row) {
    var method = String((row && row.codingMethod) || "concept_id").toLowerCase();
    var allowed = {
      concept_id: true,
      icd10: true,
      icd9: true,
      rxnorm: true,
      loinc: true,
      snomed: true,
      source_value: true
    };
    return allowed[method] ? method : "concept_id";
  }

  function vocabularyIdsForMethod(method) {
    if (method === "icd10") return ["ICD10CM", "ICD10PCS", "ICD10"]; 
    if (method === "icd9") return ["ICD9CM", "ICD9Proc", "ICD9"]; 
    if (method === "rxnorm") return ["RxNorm"]; 
    if (method === "loinc") return ["LOINC"]; 
    if (method === "snomed") return ["SNOMED"]; 
    return [];
  }

  function rowMinCount(row) {
    var minCount = parseInt(row && row.minCount, 10) || 1;
    return minCount > 1 ? minCount : 1;
  }

  function rowMinSpacingDays(row) {
    var spacing = parseInt(row && row.minSpacingDays, 10) || 0;
    return spacing > 0 ? spacing : 0;
  }

  function dateDiffDaysExpr(db, startExpr, endExpr) {
    if (db === "sqlserver") {
      return "DATEDIFF(DAY, " + startExpr + ", " + endExpr + ")";
    }
    return "(CAST(" + endExpr + " AS DATE) - CAST(" + startExpr + " AS DATE))";
  }

  function sqlLines(lines) {
    return lines
      .filter(function (l) { return l !== null && l !== undefined && l !== ""; })
      .join("\n");
  }

  function buildConceptFilter(config, row, prefix, conceptColumn, sourceConceptColumn, sourceValueColumn) {
    var spec = getConceptSpec(row);
    var method = normalizeCodingMethod(row);
    var clauses = [];

    // Source-value mode: literal match only.
    if (method === "source_value") {
      if (spec.sourceCodes.length > 0 && sourceValueColumn) {
        clauses.push("UPPER(" + sourceValueColumn + ") IN (" + spec.sourceCodes.map(function(code) {
          return quoteSqlString(String(code).toUpperCase());
        }).join(", ") + ")");
      }
      if (spec.numericIds.length > 0 && sourceValueColumn) {
        clauses.push("UPPER(" + sourceValueColumn + ") IN (" + spec.numericIds.map(function(code) {
          return quoteSqlString(String(code).toUpperCase());
        }).join(", ") + ")");
      }
      if (clauses.length === 0) {
        return conceptColumn + " = 0";
      }
      return clauses.length === 1 ? clauses[0] : "(" + clauses.join(" OR ") + ")";
    }

    // Code-system mode (ICD/LOINC/RxNorm/SNOMED): map via OMOP concept vocabulary + source columns.
    if (method !== "concept_id") {
      var vocabIds = vocabularyIdsForMethod(method);
      var allCodes = unique(spec.numericIds.concat(spec.sourceCodes));
      var vocabFilter = vocabIds.length
        ? " AND c.vocabulary_id IN (" + vocabIds.map(quoteSqlString).join(", ") + ")"
        : "";

      if (allCodes.length > 0 && sourceConceptColumn) {
        clauses.push(sourceConceptColumn + " IN (" +
          "SELECT c.concept_id FROM " + config.schema + ".concept c " +
          "WHERE UPPER(c.concept_code) IN (" + allCodes.map(function(code) {
            return quoteSqlString(String(code).toUpperCase());
          }).join(", ") + ")" + vocabFilter +
        ")");
      }
      if (allCodes.length > 0 && sourceValueColumn) {
        clauses.push("UPPER(" + sourceValueColumn + ") IN (" + allCodes.map(function(code) {
          return quoteSqlString(String(code).toUpperCase());
        }).join(", ") + ")");
      }

      if (clauses.length === 0) {
        return conceptColumn + " = 0";
      }
      return clauses.length === 1 ? clauses[0] : "(" + clauses.join(" OR ") + ")";
    }

    if (spec.numericIds.length > 0) {
      if (row.descendants && row.type !== "lab" && row.type !== "visit") {
        clauses.push(conceptColumn + " IN (SELECT concept_id FROM " + prefix + "_concepts)");
      } else if (spec.numericIds.length === 1) {
        clauses.push(conceptColumn + " = " + spec.numericIds[0]);
      } else {
        clauses.push(conceptColumn + " IN (" + spec.numericIds.join(", ") + ")");
      }
    }

    if (spec.sourceCodes.length > 0 && sourceValueColumn) {
      clauses.push(sourceValueColumn + " IN (" + spec.sourceCodes.map(quoteSqlString).join(", ") + ")");
    }

    if (clauses.length === 0) {
      return conceptColumn + " = 0";
    }
    if (clauses.length === 1) {
      return clauses[0];
    }
    return "(" + clauses.join(" OR ") + ")";
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
    if (normalizeCodingMethod(row) !== "concept_id") return null;
    if (!row.descendants) return null;
    if (row.type === "lab" || row.type === "visit") return null;
    var spec = getConceptSpec(row);
    if (!spec.numericIds.length) return null;
    var ancestorFilter = spec.numericIds.length === 1
      ? "ancestor_concept_id = " + spec.numericIds[0]
      : "ancestor_concept_id IN (" + spec.numericIds.join(", ") + ")";
    return sqlLines([
      "-- Descendants for " + prefix + " (" + row.type + ")",
      prefix + "_concepts AS (",
      "  SELECT DISTINCT descendant_concept_id AS concept_id",
      "  FROM " + config.schema + ".concept_ancestor",
      "  WHERE " + ancestorFilter,
      ")"
    ]);
  }

  // ── Per-row event subquery (finds person_id, MIN date) ─────────

  function buildRowEventBaseQuery(config, row, prefix, windowSpec) {
    function addWindowFilters(lines, personExpr, dateExpr) {
      if (!windowSpec) return lines;
      lines.push("  AND " + personExpr + " = " + windowSpec.pAlias + ".person_id");
      lines.push("  AND " + dateExpr + " BETWEEN " + windowSpec.pAlias + "." + windowSpec.startCol + " AND " + windowSpec.pAlias + "." + windowSpec.endCol);
      return lines;
    }

    if (row.type === "diagnosis") {
      var diagnosisLines = [
        "SELECT co.person_id AS person_id, co.condition_start_date AS event_date, co.visit_occurrence_id AS visit_occurrence_id",
        "FROM " + config.schema + ".condition_occurrence co",
        rowVisitJoinClause(row, config.schema, "co", "condition_start_date", "visit_occurrence_id", "v_" + prefix),
        "WHERE " + buildConceptFilter(config, row, prefix, "co.condition_concept_id", "co.condition_source_concept_id", "co.condition_source_value")
      ];
      return sqlLines(addWindowFilters(diagnosisLines, "co.person_id", "co.condition_start_date"));
    }

    if (row.type === "lab") {
      var labJoin = (row.visitContext && row.visitContext !== "all")
        ? rowVisitJoinClause(row, config.schema, "m", "measurement_date", "visit_occurrence_id", "v_" + prefix)
        : null;
      var labLines = [
        "SELECT m.person_id AS person_id, m.measurement_date AS event_date, m.visit_occurrence_id AS visit_occurrence_id",
        "FROM " + config.schema + ".measurement m",
        labJoin,
        "WHERE " + buildConceptFilter(config, row, prefix, "m.measurement_concept_id", "m.measurement_source_concept_id", "m.measurement_source_value"),
        "  AND CAST(m.value_as_number AS NUMERIC) " + safeOperator(row.operator) + " " + safeNumericValue(row.value)
      ];
      return sqlLines(addWindowFilters(labLines, "m.person_id", "m.measurement_date"));
    }

    if (row.type === "drug") {
      var drugJoin = (row.visitContext && row.visitContext !== "all")
        ? rowVisitJoinClause(row, config.schema, "de", "drug_exposure_start_date", "visit_occurrence_id", "v_" + prefix)
        : null;
      var drugLines = [
        "SELECT de.person_id AS person_id, de.drug_exposure_start_date AS event_date, de.visit_occurrence_id AS visit_occurrence_id",
        "FROM " + config.schema + ".drug_exposure de",
        drugJoin,
        "WHERE " + buildConceptFilter(config, row, prefix, "de.drug_concept_id", "de.drug_source_concept_id", "de.drug_source_value")
      ];
      return sqlLines(addWindowFilters(drugLines, "de.person_id", "de.drug_exposure_start_date"));
    }

    if (row.type === "procedure") {
      var procJoin = (row.visitContext && row.visitContext !== "all")
        ? rowVisitJoinClause(row, config.schema, "po", "procedure_date", "visit_occurrence_id", "v_" + prefix)
        : null;
      var procLines = [
        "SELECT po.person_id AS person_id, po.procedure_date AS event_date, po.visit_occurrence_id AS visit_occurrence_id",
        "FROM " + config.schema + ".procedure_occurrence po",
        procJoin,
        "WHERE " + buildConceptFilter(config, row, prefix, "po.procedure_concept_id", "po.procedure_source_concept_id", "po.procedure_source_value")
      ];
      return sqlLines(addWindowFilters(procLines, "po.person_id", "po.procedure_date"));
    }

    if (row.type === "observation") {
      var observationLines = [
        "SELECT o.person_id AS person_id, o.observation_date AS event_date, o.visit_occurrence_id AS visit_occurrence_id",
        "FROM " + config.schema + ".observation o",
        rowVisitJoinClause(row, config.schema, "o", "observation_date", "visit_occurrence_id", "v_" + prefix),
        "WHERE " + buildConceptFilter(config, row, prefix, "o.observation_concept_id", "o.observation_source_concept_id", "o.observation_source_value")
      ];
      if (row.operator && row.value) {
        observationLines.push("  AND CAST(o.value_as_number AS NUMERIC) " + safeOperator(row.operator) + " " + safeNumericValue(row.value));
      }
      return sqlLines(addWindowFilters(observationLines, "o.person_id", "o.observation_date"));
    }

    if (row.type === "visit") {
      var visitLines = [
        "SELECT vo.person_id AS person_id, vo.visit_start_date AS event_date, vo.visit_occurrence_id AS visit_occurrence_id",
        "FROM " + config.schema + ".visit_occurrence vo",
        "WHERE " + buildConceptFilter(config, row, prefix, "vo.visit_concept_id", "vo.visit_source_concept_id", "vo.visit_source_value")
      ];
      return sqlLines(addWindowFilters(visitLines, "vo.person_id", "vo.visit_start_date"));
    }

    return "SELECT NULL AS person_id, NULL AS event_date, NULL AS visit_occurrence_id WHERE 1=0";
  }

  function buildRowEventAggQuery(config, row, baseQuerySql) {
    var minCount = rowMinCount(row);
    var spacingDays = rowMinSpacingDays(row);
    var distinctVisits = !!row.distinctVisits;

    if (spacingDays > 0) {
      var diffExpr = dateDiffDaysExpr(config.db, "r.prev_event_date", "r.event_date");
      var spacingFlag = "CASE WHEN r.prev_event_date IS NOT NULL AND " + diffExpr + " >= " + spacingDays + " THEN 1 ELSE 0 END";

      return sqlLines([
        "SELECT z.person_id, MIN(z.event_date) AS event_date",
        "FROM (",
        "  SELECT r.person_id, r.event_date,",
        "         (1 + SUM(" + spacingFlag + ") OVER (PARTITION BY r.person_id ORDER BY r.event_date ROWS UNBOUNDED PRECEDING)) AS spaced_count",
        "  FROM (",
        "    SELECT b.person_id, b.event_date,",
        "           LAG(b.event_date) OVER (PARTITION BY b.person_id ORDER BY b.event_date) AS prev_event_date",
        "    FROM (",
        "      SELECT DISTINCT raw.person_id, raw.event_date" + (distinctVisits ? ", raw.visit_occurrence_id" : ""),
        "      FROM (",
        "        " + baseQuerySql,
        "      ) raw",
        "    ) b",
        "  ) r",
        ") z",
        "GROUP BY z.person_id",
        "HAVING MAX(z.spaced_count) >= " + minCount
      ]);
    }

    var countExpr;
    if (distinctVisits) {
      countExpr = "COUNT(DISTINCT x.visit_occurrence_id)";
    } else {
      countExpr = "COUNT(*)";
    }

    return sqlLines([
      "SELECT x.person_id, MIN(x.event_date) AS event_date",
      "FROM (",
      "  " + baseQuerySql,
      ") x",
      "GROUP BY x.person_id",
      "HAVING " + countExpr + " >= " + minCount
    ]);
  }

  function buildRowEventSubquery(config, row, prefix) {
    var baseQuery = buildRowEventBaseQuery(config, row, prefix, null);
    return buildRowEventAggQuery(config, row, baseQuery);
  }

  // ── Per-row windowed EXISTS (for outcome label / exclusions) ───

  function buildRowWindowedExists(config, row, prefix, pAlias, startCol, endCol) {
    var baseQuery = buildRowEventBaseQuery(config, row, prefix, {
      pAlias: pAlias,
      startCol: startCol,
      endCol: endCol
    });
    var aggQuery = buildRowEventAggQuery(config, row, baseQuery);
    return sqlLines([
      "EXISTS (",
      "  SELECT 1",
      "  FROM (",
      "    " + aggQuery,
      "  ) _win",
      ")"
    ]);
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
