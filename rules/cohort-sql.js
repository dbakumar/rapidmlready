(function() {
  window.RapidML = window.RapidML || {};
  RapidML.Compiler = RapidML.Compiler || {};
  RapidML.Compiler.Domains = RapidML.Compiler.Domains || {};

  function conceptId(value) {
    return String(value || "").replace(/[^0-9]/g, "") || "0";
  }

  function safeOperator(op) {
    var allowed = ['>', '<', '>=', '<=', '='];
    var trimmed = String(op || "").trim();
    return allowed.indexOf(trimmed) >= 0 ? trimmed : ">";
  }

  function safeNumericValue(val) {
    var num = parseFloat(val);
    return isNaN(num) ? "0" : String(num);
  }

  function sqlLines(lines) {
    return lines.filter(function(line) { return line !== null && line !== undefined; }).join("\n");
  }

  function visitFilterConceptIds(config) {
    const filter = config && config.visitFilter ? config.visitFilter : {};
    const mode = filter.mode || "all";

    if (mode === "inpatient") {
      return ["9201"];
    }
    if (mode === "outpatient") {
      return ["9202"];
    }
    if (mode === "emergency") {
      return ["9203"];
    }
    if (mode === "custom" && Array.isArray(filter.conceptIds)) {
      return filter.conceptIds
        .map(function(id) { return conceptId(id); })
        .filter(function(id) { return id !== "0"; });
    }

    return [];
  }

  function visitFilterPredicate(config, visitAlias) {
    const ids = visitFilterConceptIds(config);
    if (!ids.length) {
      return "1=1";
    }
    return visitAlias + ".visit_concept_id IN (" + ids.join(", ") + ")";
  }

  function visitJoinClause(config, eventAlias, eventDateColumn, eventVisitIdColumn, visitAlias) {
    return sqlLines([
      "JOIN " + config.schema + ".visit_occurrence " + visitAlias,
      "      ON " + visitAlias + ".person_id = " + eventAlias + ".person_id",
      "      AND (",
      "        (" + eventAlias + "." + eventVisitIdColumn + " IS NOT NULL AND " + visitAlias + ".visit_occurrence_id = " + eventAlias + "." + eventVisitIdColumn + ")",
      "        OR",
      "        (" + eventAlias + "." + eventVisitIdColumn + " IS NULL AND " + eventAlias + "." + eventDateColumn + " BETWEEN " + visitAlias + ".visit_start_date AND COALESCE(" + visitAlias + ".visit_end_date, " + visitAlias + ".visit_start_date))",
      "      )",
      "      AND " + visitFilterPredicate(config, visitAlias)
    ]);
  }

  function buildCohortCTE(config) {
    const simpleMode = config.cohortEntryMode || "first_event";
    return buildSimpleCohortCTE(config, simpleMode);
  }

  function buildSimpleCohortCTE(config, mode) {
    if (mode === "visit_count") {
      return sqlLines([
        "-- Cohort mode: two qualifying condition records on distinct visits",
        "cohort AS (",
        "  SELECT person_id, MIN(first_dx_date) AS t0",
        "  FROM (",
        "    SELECT",
        "      co.person_id,",
        "      co.visit_occurrence_id,",
        "      MIN(co.condition_start_date) AS first_dx_date",
        "    FROM " + config.schema + ".condition_occurrence co",
        "    " + visitJoinClause(config, "co", "condition_start_date", "visit_occurrence_id", "vco"),
        "    WHERE co.condition_concept_id IN (SELECT concept_id FROM entry_condition_descendants)",
        "    GROUP BY co.person_id, co.visit_occurrence_id",
        "  ) v",
        "  GROUP BY person_id",
        "  HAVING COUNT(DISTINCT visit_occurrence_id) >= 2",
        ")"
      ]);
    }

    if (mode === "condition_lab_diff_visits") {
      return buildConditionPlusMeasurementDifferentVisits(config);
    }

    if (mode === "condition_or_lab") {
      return buildConditionOrMeasurementCohort(config);
    }

    return sqlLines([
      "-- Cohort mode: first qualifying condition event",
      "cohort AS (",
      "  SELECT co.person_id, MIN(co.condition_start_date) AS t0",
      "  FROM " + config.schema + ".condition_occurrence co",
      "  " + visitJoinClause(config, "co", "condition_start_date", "visit_occurrence_id", "vco"),
      "  WHERE co.condition_concept_id IN (SELECT concept_id FROM entry_condition_descendants)",
      "  GROUP BY co.person_id",
      ")"
    ]);
  }

  function buildConditionPlusMeasurementDifferentVisits(config) {
    const measurementConcept = conceptId(config.cohortEntry && config.cohortEntry.measurementConceptId);
    const measurementOperator = safeOperator(config.cohortEntry && config.cohortEntry.measurementOperator);
    const measurementValue = safeNumericValue(config.cohortEntry && config.cohortEntry.measurementValue);

    return sqlLines([
      "-- Cohort mode: condition + lab threshold on different visits",
      "cohort AS (",
      "  SELECT person_id, MIN(entry_date) AS t0",
      "  FROM (",
      "    SELECT DISTINCT",
      "      co.person_id,",
      "      co.condition_start_date AS entry_date",
      "    FROM " + config.schema + ".condition_occurrence co",
      "    " + visitJoinClause(config, "co", "condition_start_date", "visit_occurrence_id", "vco"),
      "    JOIN " + config.schema + ".measurement m",
      "      ON co.person_id = m.person_id",
      "    " + visitJoinClause(config, "m", "measurement_date", "visit_occurrence_id", "vm"),
      "      AND COALESCE(vco.visit_occurrence_id, -1) != COALESCE(vm.visit_occurrence_id, -1)",
      "    WHERE co.condition_concept_id IN (SELECT concept_id FROM entry_condition_descendants)",
      "      AND m.measurement_concept_id = " + measurementConcept,
      "      AND CAST(m.value_as_number AS NUMERIC) " + measurementOperator + " " + measurementValue,
      "  ) combined",
      "  GROUP BY person_id",
      ")"
    ]);
  }

  function buildConditionOrMeasurementCohort(config) {
    const measurementConcept = conceptId(config.cohortEntry && config.cohortEntry.measurementConceptId);
    const measurementOperator = safeOperator(config.cohortEntry && config.cohortEntry.measurementOperator);
    const measurementValue = safeNumericValue(config.cohortEntry && config.cohortEntry.measurementValue);

    return sqlLines([
      "-- Cohort mode: condition OR lab threshold (earliest qualifying event)",
      "cohort AS (",
      "  SELECT person_id, MIN(entry_date) AS t0",
      "  FROM (",
      "    SELECT",
      "      co.person_id,",
      "      co.condition_start_date AS entry_date",
      "    FROM " + config.schema + ".condition_occurrence co",
      "    " + visitJoinClause(config, "co", "condition_start_date", "visit_occurrence_id", "vco"),
      "    WHERE co.condition_concept_id IN (SELECT concept_id FROM entry_condition_descendants)",
      "",
      "    UNION ALL",
      "",
      "    SELECT",
      "      m.person_id,",
      "      m.measurement_date AS entry_date",
      "    FROM " + config.schema + ".measurement m",
      "    " + visitJoinClause(config, "m", "measurement_date", "visit_occurrence_id", "vm"),
      "    WHERE m.measurement_concept_id = " + measurementConcept,
      "      AND CAST(m.value_as_number AS NUMERIC) " + measurementOperator + " " + measurementValue,
      "  ) qualifying_events",
      "  GROUP BY person_id",
      ")"
    ]);
  }

  RapidML.Compiler.Domains.CohortEntry = {
    buildCohortCTE: buildCohortCTE,
    buildSimpleCohortCTE: buildSimpleCohortCTE,
    buildConditionPlusMeasurementDifferentVisits: buildConditionPlusMeasurementDifferentVisits,
    buildConditionOrMeasurementCohort: buildConditionOrMeasurementCohort
  };
})();
