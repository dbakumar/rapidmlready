/**
 * ============================================================================
 * COVARIATES.JS  -  OMOP Feature Engineering SQL Builder
 * ============================================================================
 *
 * PURPOSE:
 *   Builds the SQL columns and JOINs needed to add patient-level features
 *   (covariates) to the final study output.  These include demographics,
 *   baseline event counts, baseline lab values, and prior event history.
 *
 * HOW IT WORKS:
 *   The user selects covariates in the wizard (step 4).  This file reads
 *   that selection and emits the SQL fragments the compiler needs:
 *     - columns[]  : SELECT expressions (subqueries, CASE, simple columns)
 *     - joins[]    : LEFT JOIN clauses (e.g. person table)
 *
 *   The compiler's buildFinalSelect() merges these into the final SQL.
 *
 * SUPPORTED COVARIATE GROUPS:
 *   Demographics:      age_at_index, sex, race, ethnicity
 *   Baseline counts:   condition, drug, visit, measurement counts
 *   Baseline labs:     eGFR, creatinine, HbA1c, BP, BMI
 *   Prior history:     prior outcome, hospitalisation, ER visit, procedure
 *   Custom:            any OMOP concept ID from any domain with flexible
 *                      aggregation (count, binary, last/first/min/max value)
 *
 * ENCODING MODES:
 *   "count"            - raw counts
 *   "binary"           - 0/1 flags
 *   "count_and_binary" - both
 *
 * DEPENDS ON:  nothing (standalone, attached to RapidML.Compiler.Covariates)
 * USED BY:     omop/compiler.js  (prepareContext calls buildSelect)
 *
 * PUBLIC API:
 *   RapidML.Compiler.Covariates.buildSelect(config)  ->  { columns, joins }
 *   RapidML.Compiler.Covariates.STANDARD_CONCEPTS    ->  lab/visit concept IDs
 * ============================================================================
 */
(function() {
  window.RapidML = window.RapidML || {};
  RapidML.Compiler = RapidML.Compiler || {};

  /**
   * OMOP Standard Concept IDs for Common Labs and Visit Types.
   * These are used as defaults when the user selects lab-based covariates.
   */
  var STANDARD_CONCEPTS = {
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

  /**
   * Check whether any demographic covariates are selected, which requires
   * a JOIN to the person table.
   */
  function personJoinRequired(covariates) {
    var demoIds = ["age_at_index", "sex_concept_id", "race_concept_id", "ethnicity_concept_id"];
    for (var i = 0; i < covariates.length; i++) {
      if (demoIds.indexOf(covariates[i]) >= 0) return true;
    }
    return false;
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

  /**
   * Flatten a mixed array of strings and arrays-of-strings into a flat array.
   */
  function flatten(items) {
    var out = [];
    items.forEach(function(item) {
      if (Array.isArray(item)) {
        item.forEach(function(inner) { out.push(inner); });
      } else if (item) {
        out.push(item);
      }
    });
    return out;
  }

  /**
   * Build the covariate SQL fragments for the given config.
   *
   * @param  {object} config  normalised study configuration
   * @return {object}         { columns: string[], joins: string[] }
   */
  function buildSelect(config) {
    var selected = normalizeCovariates(config.covariates);
    var encoding = config.covariateEncoding || "count";
    var cols = [];
    var joins = [];

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

    // ===== CUSTOM COVARIATES (user-defined concept IDs) =====
    var customCovs = config.customCovariates || [];
    var DOMAIN_MAP = {
      condition:   { table: "condition_occurrence",  conceptCol: "condition_concept_id",   dateCol: "condition_start_date" },
      drug:        { table: "drug_exposure",         conceptCol: "drug_concept_id",        dateCol: "drug_exposure_start_date" },
      lab:         { table: "measurement",           conceptCol: "measurement_concept_id", dateCol: "measurement_date" },
      procedure:   { table: "procedure_occurrence",  conceptCol: "procedure_concept_id",   dateCol: "procedure_date" },
      observation: { table: "observation",           conceptCol: "observation_concept_id",  dateCol: "observation_date" },
      visit:       { table: "visit_occurrence",      conceptCol: "visit_concept_id",        dateCol: "visit_start_date" }
    };

    customCovs.forEach(function(cov) {
      var info = DOMAIN_MAP[cov.domain];
      if (!info) return;

      var cid = parseInt(cov.conceptId, 10);
      if (isNaN(cid)) return;

      var alias = cov.label;
      var agg = cov.aggregation;
      var fqTable = config.schema + "." + info.table;
      var where = "x.person_id = s.person_id AND x." + info.conceptCol + " = " + cid +
                  " AND x." + info.dateCol + " BETWEEN s.baseline_start AND s.baseline_end";

      if (agg === "count") {
        cols.push("(SELECT COUNT(*) FROM " + fqTable + " x WHERE " + where + ") AS " + alias);
      } else if (agg === "binary") {
        cols.push("CASE WHEN (SELECT COUNT(*) FROM " + fqTable + " x WHERE " + where + ") > 0 " +
                  "THEN 1 ELSE 0 END AS " + alias);
      } else if (agg === "last_value") {
        cols.push(sqlLines([
          "(SELECT x.value_as_number FROM " + fqTable + " x",
          "  WHERE " + where,
          "  ORDER BY x." + info.dateCol + " DESC",
          "  LIMIT 1) AS " + alias
        ]));
      } else if (agg === "first_value") {
        cols.push(sqlLines([
          "(SELECT x.value_as_number FROM " + fqTable + " x",
          "  WHERE " + where,
          "  ORDER BY x." + info.dateCol + " ASC",
          "  LIMIT 1) AS " + alias
        ]));
      } else if (agg === "min_value") {
        cols.push("(SELECT MIN(x.value_as_number) FROM " + fqTable + " x WHERE " + where + ") AS " + alias);
      } else if (agg === "max_value") {
        cols.push("(SELECT MAX(x.value_as_number) FROM " + fqTable + " x WHERE " + where + ") AS " + alias);
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

