(function() {
  window.RapidML = window.RapidML || {};
  RapidML.Compiler = RapidML.Compiler || {};

  /**
   * OMOP Standard Concept IDs for Common Labs and Visit Types
   */
  const STANDARD_CONCEPTS = {
    // Lab measurements (LOINC in OMOP)
    egfr: 3051823,                    // Estimated glomerular filtration rate
    hba1c: 3004410,                   // Hemoglobin A1c
    creatinine: 3020564,              // Creatinine
    systolic_bp: 3004249,             // Systolic blood pressure
    diastolic_bp: 3012888,            // Diastolic blood pressure
    bmi: 3038553,                     // Body Mass Index

    // Visit types
    hospitalization: 9201,            // Inpatient visit
    emergency: 9203                   // Emergency department visit
  };

  function sqlLines(lines) {
    return lines.filter(function(line) { return line !== null && line !== undefined; }).join("\n");
  }

  function countToFeature(expr, aliasBase, encodingMode) {
    if (encodingMode === "binary") {
      return "CASE WHEN (" + expr + ") > 0 THEN 1 ELSE 0 END AS " + aliasBase + "_flag";
    }
    if (encodingMode === "count_and_binary") {
      return [
        "(" + expr + ") AS " + aliasBase,
        "CASE WHEN (" + expr + ") > 0 THEN 1 ELSE 0 END AS " + aliasBase + "_flag"
      ];
    }
    return "(" + expr + ") AS " + aliasBase;
  }

  function baselineCountExpr(config, tableName, dateColumn) {
    return "SELECT COUNT(*) FROM " + config.schema + "." + tableName + " x " +
      "WHERE x.person_id = s.person_id " +
      "AND x." + dateColumn + " BETWEEN s.baseline_start AND s.baseline_end";
  }

  function personJoinRequired(covariates) {
    return covariates.some(function(id) {
      return ["age_at_index", "sex_concept_id", "race_concept_id", "ethnicity_concept_id"].indexOf(id) >= 0;
    });
  }

  function ageExpr(db) {
    if (db === "sqlserver") {
      return "DATEDIFF(YEAR, DATEFROMPARTS(p.year_of_birth, 1, 1), s.index_date) AS age_at_index";
    }
    return "(EXTRACT(YEAR FROM s.index_date)::INT - p.year_of_birth) AS age_at_index";
  }

  function priorOutcomeExpr(config) {
    return "CASE WHEN EXISTS (" +
      "SELECT 1 FROM " + config.schema + ".condition_occurrence co " +
      "WHERE co.person_id = s.person_id " +
      "AND co.condition_concept_id IN (SELECT concept_id FROM outcome_descendants) " +
      "AND co.condition_start_date < s.outcome_start" +
      ") THEN 1 ELSE 0 END AS prior_outcome_history";
  }

  function lastLabValueExpr(config, labConceptId, labName) {
    return sqlLines([
      "(",
      "  -- Most recent baseline lab value for " + labName,
      "  SELECT m.value_as_number",
      "  FROM " + config.schema + ".measurement m",
      "  WHERE m.person_id = s.person_id",
      "    AND m.measurement_concept_id = " + labConceptId,
      "    AND m.measurement_date BETWEEN s.baseline_start AND s.baseline_end",
      "  ORDER BY m.measurement_date DESC",
      "  LIMIT 1",
      ") AS baseline_" + labName
    ]);
  }

  function priorVisitTypeExpr(config, visitTypeConceptId, visitTypeName) {
    return "CASE WHEN EXISTS (" +
      "SELECT 1 FROM " + config.schema + ".visit_occurrence vo " +
      "WHERE vo.person_id = s.person_id " +
      "AND vo.visit_concept_id = " + visitTypeConceptId + " " +
      "AND vo.visit_start_date < s.baseline_start" +
      ") THEN 1 ELSE 0 END AS prior_" + visitTypeName + "_flag";
  }

  function normalizeCovariates(covariates) {
    if (!Array.isArray(covariates) || covariates.length === 0) {
      return [
        "age_at_index",
        "sex_concept_id",
        "baseline_condition_count",
        "baseline_drug_count",
        "baseline_visit_count",
        "baseline_measurement_count"
      ];
    }
    return covariates;
  }

  function flatten(items) {
    const out = [];
    items.forEach(function(item) {
      if (Array.isArray(item)) {
        item.forEach(function(inner) { out.push(inner); });
      } else if (item) {
        out.push(item);
      }
    });
    return out;
  }

  function buildSelect(config) {
    const selected = normalizeCovariates(config.covariates);
    const encoding = config.covariateEncoding || "count";
    const cols = [];
    const joins = [];

    if (personJoinRequired(selected)) {
      joins.push("LEFT JOIN " + config.schema + ".person p ON p.person_id = s.person_id");
    }

    selected.forEach(function(id) {
      // ===== DEMOGRAPHICS =====
      if (id === "age_at_index") {
        cols.push(ageExpr(config.db));
        return;
      }
      if (id === "sex_concept_id") {
        cols.push("p.gender_concept_id AS sex_concept_id");
        return;
      }
      if (id === "race_concept_id") {
        cols.push("p.race_concept_id AS race_concept_id");
        return;
      }
      if (id === "ethnicity_concept_id") {
        cols.push("p.ethnicity_concept_id AS ethnicity_concept_id");
        return;
      }

      // ===== BASELINE EVENT COUNTS =====
      if (id === "baseline_condition_count") {
        cols.push(countToFeature(
          baselineCountExpr(config, "condition_occurrence", "condition_start_date"),
          "baseline_condition_count",
          encoding
        ));
        return;
      }
      if (id === "baseline_drug_count") {
        cols.push(countToFeature(
          baselineCountExpr(config, "drug_exposure", "drug_exposure_start_date"),
          "baseline_drug_count",
          encoding
        ));
        return;
      }
      if (id === "baseline_visit_count") {
        cols.push(countToFeature(
          baselineCountExpr(config, "visit_occurrence", "visit_start_date"),
          "baseline_visit_count",
          encoding
        ));
        return;
      }
      if (id === "baseline_measurement_count") {
        cols.push(countToFeature(
          baselineCountExpr(config, "measurement", "measurement_date"),
          "baseline_measurement_count",
          encoding
        ));
        return;
      }

      // ===== BASELINE LAB VALUES =====
      if (id === "baseline_egfr") {
        cols.push(lastLabValueExpr(config, STANDARD_CONCEPTS.egfr, "egfr"));
        return;
      }
      if (id === "baseline_hba1c") {
        cols.push(lastLabValueExpr(config, STANDARD_CONCEPTS.hba1c, "hba1c"));
        return;
      }
      if (id === "baseline_creatinine") {
        cols.push(lastLabValueExpr(config, STANDARD_CONCEPTS.creatinine, "creatinine"));
        return;
      }
      if (id === "baseline_systolic_bp") {
        cols.push(lastLabValueExpr(config, STANDARD_CONCEPTS.systolic_bp, "systolic_bp"));
        return;
      }
      if (id === "baseline_diastolic_bp") {
        cols.push(lastLabValueExpr(config, STANDARD_CONCEPTS.diastolic_bp, "diastolic_bp"));
        return;
      }
      if (id === "baseline_bmi") {
        cols.push(lastLabValueExpr(config, STANDARD_CONCEPTS.bmi, "bmi"));
        return;
      }

      // ===== PRIOR EVENT HISTORY =====
      if (id === "prior_outcome_history") {
        cols.push(priorOutcomeExpr(config));
        return;
      }
      if (id === "prior_hospitalization_flag") {
        cols.push(priorVisitTypeExpr(config, STANDARD_CONCEPTS.hospitalization, "hospitalization"));
        return;
      }
      if (id === "prior_er_visit_flag") {
        cols.push(priorVisitTypeExpr(config, STANDARD_CONCEPTS.emergency, "er_visit"));
        return;
      }
      if (id === "prior_procedure_flag") {
        cols.push("CASE WHEN EXISTS (" +
          "SELECT 1 FROM " + config.schema + ".procedure_occurrence po " +
          "WHERE po.person_id = s.person_id " +
          "AND po.procedure_date < s.baseline_start" +
          ") THEN 1 ELSE 0 END AS prior_procedure_flag");
        return;
      }
    });

    return {
      joins: joins,
      columns: flatten(cols)
    };
  }

  RapidML.Compiler.Covariates = {
    buildSelect: buildSelect,
    STANDARD_CONCEPTS: STANDARD_CONCEPTS
  };
})();

