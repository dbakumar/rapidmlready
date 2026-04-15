(function() {
  window.RapidML = window.RapidML || {};
  RapidML.Compiler = RapidML.Compiler || {};
  RapidML.Compiler.Domains = RapidML.Compiler.Domains || {};

  /**
   * OMOP Outcomes Domain — Concept ID Resolution and Outcome Labeling
   */

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

  function entryConditionRootCTE(config) {
    return sqlLines([
      "-- Entry condition root concept for cohort rule",
      "entry_condition_root AS (",
      "  SELECT concept_id",
      "  FROM " + config.schema + ".concept",
      "  WHERE concept_id = " + conceptId(config.cohortEntry && config.cohortEntry.conditionConceptId),
      "    AND standard_concept = 'S'",
      ")"
    ]);
  }

  function entryConditionDescendantsCTE(config) {
    return sqlLines([
      "-- All descendants used for cohort entry matching",
      "entry_condition_descendants AS (",
      "  SELECT descendant_concept_id AS concept_id",
      "  FROM " + config.schema + ".concept_ancestor",
      "  WHERE ancestor_concept_id IN (SELECT concept_id FROM entry_condition_root)",
      ")"
    ]);
  }

  function outcomeRootCTE(config) {
    const outcomeConcept = conceptId(config.outcomeRule && config.outcomeRule.conceptId ? config.outcomeRule.conceptId : config.outcomeConceptId);
    return sqlLines([
      "-- Outcome root concept for label creation",
      "outcome_root AS (",
      "  SELECT concept_id",
      "  FROM " + config.schema + ".concept",
      "  WHERE concept_id = " + outcomeConcept,
      "    AND standard_concept = 'S'",
      ")"
    ]);
  }

  function outcomeDescendantsCTE(config) {
    return sqlLines([
      "-- All descendants used for outcome matching",
      "outcome_descendants AS (",
      "  SELECT descendant_concept_id AS concept_id",
      "  FROM " + config.schema + ".concept_ancestor",
      "  WHERE ancestor_concept_id IN (SELECT concept_id FROM outcome_root)",
      ")"
    ]);
  }

  function firstOutcomeCTE(config) {
    const mode = config.outcomeRule && config.outcomeRule.mode ? config.outcomeRule.mode : "condition_occurrence";
    if (mode === "condition_occurrence") {
      return buildFirstConditionOutcomeCTE(config);
    }
    if (mode === "two_condition_records") {
      return buildFirstTwoConditionOutcomeCTE(config);
    }
    if (mode === "lab_threshold") {
      return buildFirstLabOutcomeCTE(config);
    }
    if (mode === "condition_or_lab") {
      return buildFirstConditionOrLabOutcomeCTE(config);
    }
    return buildFirstConditionOutcomeCTE(config);
  }

  function buildFirstConditionOutcomeCTE(config) {
    return sqlLines([
      "-- Earliest condition-based outcome date per person",
      "first_outcome AS (",
      "  SELECT person_id, MIN(condition_start_date) AS outcome_date",
      "  FROM " + config.schema + ".condition_occurrence",
      "  WHERE condition_concept_id IN (SELECT concept_id FROM outcome_descendants)",
      "  GROUP BY person_id",
      ")"
    ]);
  }

  function buildFirstTwoConditionOutcomeCTE(config) {
    return sqlLines([
      "-- Earliest outcome date among people with >= 2 outcome condition records",
      "first_outcome AS (",
      "  SELECT person_id, MIN(outcome_date) AS outcome_date",
      "  FROM (",
      "    SELECT person_id, condition_start_date AS outcome_date",
      "    FROM " + config.schema + ".condition_occurrence",
      "    WHERE condition_concept_id IN (SELECT concept_id FROM outcome_descendants)",
      "  ) x",
      "  GROUP BY person_id",
      "  HAVING COUNT(*) >= 2",
      ")"
    ]);
  }

  function buildFirstLabOutcomeCTE(config) {
    const measurementConcept = conceptId(config.outcomeRule && config.outcomeRule.measurementConceptId);
    const measurementOperator = safeOperator(config.outcomeRule && config.outcomeRule.measurementOperator);
    const measurementValue = safeNumericValue(config.outcomeRule && config.outcomeRule.measurementValue);

    return sqlLines([
      "-- Earliest lab-threshold outcome date per person",
      "first_outcome AS (",
      "  SELECT person_id, MIN(measurement_date) AS outcome_date",
      "  FROM " + config.schema + ".measurement",
      "  WHERE measurement_concept_id = " + measurementConcept,
      "    AND CAST(value_as_number AS NUMERIC) " + measurementOperator + " " + measurementValue,
      "  GROUP BY person_id",
      ")"
    ]);
  }

  function buildFirstConditionOrLabOutcomeCTE(config) {
    const measurementConcept = conceptId(config.outcomeRule && config.outcomeRule.measurementConceptId);
    const measurementOperator = safeOperator(config.outcomeRule && config.outcomeRule.measurementOperator);
    const measurementValue = safeNumericValue(config.outcomeRule && config.outcomeRule.measurementValue);

    return sqlLines([
      "-- Earliest outcome date from condition OR lab-threshold evidence",
      "first_outcome AS (",
      "  SELECT person_id, MIN(outcome_date) AS outcome_date",
      "  FROM (",
      "    SELECT person_id, condition_start_date AS outcome_date",
      "    FROM " + config.schema + ".condition_occurrence",
      "    WHERE condition_concept_id IN (SELECT concept_id FROM outcome_descendants)",
      "    UNION ALL",
      "    SELECT person_id, measurement_date AS outcome_date",
      "    FROM " + config.schema + ".measurement",
      "    WHERE measurement_concept_id = " + measurementConcept,
      "      AND CAST(value_as_number AS NUMERIC) " + measurementOperator + " " + measurementValue,
      "  ) x",
      "  GROUP BY person_id",
      ")"
    ]);
  }

  function outcomeLabelExpr(config) {
    const mode = config.outcomeRule && config.outcomeRule.mode ? config.outcomeRule.mode : "condition_occurrence";
    if (mode === "condition_occurrence") {
      return buildConditionOutcomeLabelExpr(config);
    }
    if (mode === "two_condition_records") {
      return buildTwoConditionOutcomeLabelExpr(config);
    }
    if (mode === "lab_threshold") {
      return buildLabOutcomeLabelExpr(config);
    }
    if (mode === "condition_or_lab") {
      return buildConditionOrLabOutcomeLabelExpr(config);
    }
    return buildConditionOutcomeLabelExpr(config);
  }

  function buildConditionOutcomeLabelExpr(config) {
    return sqlLines([
      "CASE",
      "    WHEN EXISTS (",
      "      SELECT 1",
      "      FROM " + config.schema + ".condition_occurrence co",
      "      WHERE co.person_id = s.person_id",
      "        AND co.condition_concept_id IN (SELECT concept_id FROM outcome_descendants)",
      "        AND co.condition_start_date BETWEEN s.outcome_start AND s.outcome_end",
      "    )",
      "    THEN 1 ELSE 0",
      "  END AS outcome_label"
    ]);
  }

  function buildTwoConditionOutcomeLabelExpr(config) {
    return sqlLines([
      "CASE",
      "    WHEN (",
      "      SELECT COUNT(*)",
      "      FROM " + config.schema + ".condition_occurrence co",
      "      WHERE co.person_id = s.person_id",
      "        AND co.condition_concept_id IN (SELECT concept_id FROM outcome_descendants)",
      "        AND co.condition_start_date BETWEEN s.outcome_start AND s.outcome_end",
      "    ) >= 2",
      "    THEN 1 ELSE 0",
      "  END AS outcome_label"
    ]);
  }

  function buildLabOutcomeLabelExpr(config) {
    const measurementConcept = conceptId(config.outcomeRule && config.outcomeRule.measurementConceptId);
    const measurementOperator = safeOperator(config.outcomeRule && config.outcomeRule.measurementOperator);
    const measurementValue = safeNumericValue(config.outcomeRule && config.outcomeRule.measurementValue);

    return sqlLines([
      "CASE",
      "    WHEN EXISTS (",
      "      SELECT 1",
      "      FROM " + config.schema + ".measurement m",
      "      WHERE m.person_id = s.person_id",
      "        AND m.measurement_concept_id = " + measurementConcept,
      "        AND CAST(m.value_as_number AS NUMERIC) " + measurementOperator + " " + measurementValue,
      "        AND m.measurement_date BETWEEN s.outcome_start AND s.outcome_end",
      "    )",
      "    THEN 1 ELSE 0",
      "  END AS outcome_label"
    ]);
  }

  function buildConditionOrLabOutcomeLabelExpr(config) {
    const measurementConcept = conceptId(config.outcomeRule && config.outcomeRule.measurementConceptId);
    const measurementOperator = safeOperator(config.outcomeRule && config.outcomeRule.measurementOperator);
    const measurementValue = safeNumericValue(config.outcomeRule && config.outcomeRule.measurementValue);

    return sqlLines([
      "CASE",
      "    WHEN EXISTS (",
      "      SELECT 1",
      "      FROM " + config.schema + ".condition_occurrence co",
      "      WHERE co.person_id = s.person_id",
      "        AND co.condition_concept_id IN (SELECT concept_id FROM outcome_descendants)",
      "        AND co.condition_start_date BETWEEN s.outcome_start AND s.outcome_end",
      "    ) OR EXISTS (",
      "      SELECT 1",
      "      FROM " + config.schema + ".measurement m",
      "      WHERE m.person_id = s.person_id",
      "        AND m.measurement_concept_id = " + measurementConcept,
      "        AND CAST(m.value_as_number AS NUMERIC) " + measurementOperator + " " + measurementValue,
      "        AND m.measurement_date BETWEEN s.outcome_start AND s.outcome_end",
      "    )",
      "    THEN 1 ELSE 0",
      "  END AS outcome_label"
    ]);
  }

  RapidML.Compiler.Domains.Outcomes = {
    entryConditionRootCTE: entryConditionRootCTE,
    entryConditionDescendantsCTE: entryConditionDescendantsCTE,
    outcomeRootCTE: outcomeRootCTE,
    outcomeDescendantsCTE: outcomeDescendantsCTE,
    firstOutcomeCTE: firstOutcomeCTE,
    outcomeLabelExpr: outcomeLabelExpr
  };
})();
