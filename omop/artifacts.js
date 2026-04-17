/**
 * ============================================================================
 * ARTIFACTS.JS  -  Best-Practice Artifact Generator
 * ============================================================================
 *
 * PURPOSE:
 *   When the user enables "Best-Practice Mode" in the wizard, this file
 *   generates a detailed manifest.json that documents every aspect of the
 *   study configuration, including full evidence logic descriptions.
 *
 * DEPENDS ON:  nothing (standalone)
 * USED BY:     core/generator.js  (generate() calls buildArtifacts)
 *
 * PUBLIC API:
 *   RapidML.Compiler.buildArtifacts(config, methodologyId)
 *     -> array of { filename, content, mimeType }
 * ============================================================================
 */
(function() {
  window.RapidML = window.RapidML || {};
  RapidML.Compiler = RapidML.Compiler || {};

  // ── OMOP table mapping for human-readable descriptions ──────────
  var TABLE_MAP = {
    diagnosis:   { table: "condition_occurrence",  conceptCol: "condition_concept_id",  dateCol: "condition_start_date" },
    lab:         { table: "measurement",           conceptCol: "measurement_concept_id", dateCol: "measurement_date" },
    drug:        { table: "drug_exposure",         conceptCol: "drug_concept_id",        dateCol: "drug_exposure_start_date" },
    procedure:   { table: "procedure_occurrence",  conceptCol: "procedure_concept_id",   dateCol: "procedure_date" },
    observation: { table: "observation",           conceptCol: "observation_concept_id",  dateCol: "observation_date" },
    visit:       { table: "visit_occurrence",      conceptCol: "visit_concept_id",        dateCol: "visit_start_date" }
  };

  var VISIT_CONTEXT_MAP = {
    all:        "Any visit type",
    inpatient:  "Inpatient only (concept 9201)",
    outpatient: "Outpatient only (concept 9202)",
    emergency:  "Emergency only (concept 9203)",
    custom:     "Custom visit concept IDs"
  };

  /**
   * Build a detailed human-readable description of a single evidence row.
   *
   * @param  {object} row     evidence row object
   * @param  {number} idx     0-based index within its block
   * @return {object}         detailed row descriptor
   */
  function describeRow(row, idx) {
    var mapping = TABLE_MAP[row.type] || {};
    var desc = {
      index: idx,
      type: row.type,
      conceptId: row.conceptId || "",
      label: row.label || "",
      omopTable: mapping.table || "unknown",
      conceptColumn: mapping.conceptCol || "unknown",
      dateColumn: mapping.dateCol || "unknown",
      includesDescendants: !!row.descendants,
      descendantLogic: row.descendants
        ? "Resolves via concept_ancestor (ancestor_concept_id = " + (row.conceptId || "?") + ")"
        : "Exact concept ID match only"
    };

    // Lab / observation threshold
    if ((row.type === "lab" || row.type === "observation") && row.operator && row.value) {
      desc.threshold = {
        operator: row.operator,
        value: row.value,
        sqlFragment: "value_as_number " + row.operator + " " + row.value
      };
    }

    // MinCount
    var minCount = parseInt(row.minCount, 10) || 1;
    desc.minCount = minCount;
    if (minCount > 1) {
      desc.minCountLogic = "HAVING COUNT(*) >= " + minCount;
    }

    // Distinct visits
    desc.distinctVisits = !!row.distinctVisits;
    if (row.distinctVisits) {
      desc.distinctVisitsLogic = "HAVING COUNT(DISTINCT visit_occurrence_id) >= " + minCount;
    }

    // Visit context
    desc.visitContext = row.visitContext || "all";
    desc.visitContextDescription = VISIT_CONTEXT_MAP[desc.visitContext] || desc.visitContext;
    if (desc.visitContext === "custom" && row.visitContextIds && row.visitContextIds.length) {
      desc.visitContextIds = row.visitContextIds;
    }

    // Build a human-readable summary sentence
    var summary = "Find patients with ";
    if (row.label) {
      summary += row.label + " (";
    }
    summary += row.type + " concept " + (row.conceptId || "?");
    if (row.label) summary += ")";
    if (row.descendants) summary += " including descendants";
    if (desc.threshold) {
      summary += " where value " + desc.threshold.operator + " " + desc.threshold.value;
    }
    if (minCount > 1) {
      summary += ", requiring at least " + minCount;
      summary += row.distinctVisits ? " distinct visits" : " records";
    }
    summary += " in " + mapping.table;
    if (desc.visitContext !== "all") {
      summary += " (" + desc.visitContextDescription + ")";
    }
    desc.summary = summary;

    return desc;
  }

  /**
   * Build a detailed description of an evidence block (entry or outcome).
   *
   * @param  {object} block   { match, rows }
   * @param  {string} name    "entry" or "outcome"
   * @return {object}         detailed block descriptor
   */
  function describeBlock(block, name) {
    if (!block || !block.rows || !block.rows.length) {
      return { name: name, rowCount: 0, rows: [] };
    }

    var matchMode = block.match || "all";
    var rows = block.rows.map(function(r, i) { return describeRow(r, i); });

    var result = {
      name: name,
      matchMode: matchMode,
      matchDescription: matchMode === "all"
        ? "Patient must match ALL of the following criteria (intersection)"
        : "Patient must match ANY of the following criteria (union)",
      combinationSqlLogic: matchMode === "all"
        ? "INNER JOIN across all row subqueries, then HAVING COUNT(DISTINCT row_idx) = " + rows.length
        : "UNION ALL of all row subqueries, then GROUP BY person_id using MIN(event_date)",
      rowCount: rows.length,
      rows: rows
    };

    return result;
  }

  /**
   * Build a detailed description of a flat evidence list (exclusions or confounders).
   *
   * @param  {Array}  list    array of evidence row objects
   * @param  {string} name    "exclusions" or "confounders"
   * @param  {string} logic   how rows are used in SQL
   * @return {object}         detailed list descriptor
   */
  function describeList(list, name, logic) {
    if (!list || !list.length) {
      return { name: name, rowCount: 0, rows: [] };
    }

    return {
      name: name,
      logic: logic,
      rowCount: list.length,
      rows: list.map(function(r, i) { return describeRow(r, i); })
    };
  }

  /**
   * Build the detailed manifest.
   *
   * @param  {object} config         normalised study configuration
   * @param  {string} methodologyId  e.g. "longitudinal-prediction"
   * @return {Array}  array of { filename, content, mimeType }
   */
  function buildArtifacts(config, methodologyId) {
    var study = config.study || {};

    // Build detailed evidence descriptions
    var evidenceLogic = {
      entry: describeBlock(study.entry, "Cohort Entry"),
      outcome: describeBlock(study.outcome, "Outcome"),
      exclusions: describeList(
        study.exclusions,
        "Exclusions",
        "Each exclusion row generates a NOT EXISTS subquery. Patients matching any exclusion row are removed from the cohort."
      ),
      confounders: describeList(
        study.confounders,
        "Confounders",
        "Each confounder row generates a binary flag column (0 or 1) in the final SELECT. These are additional features for the analysis model."
      )
    };

    // Build covariate details
    var covariateDetails = (config.covariates || []).map(function(id) {
      return { id: id, encoding: config.covariateEncoding || "count" };
    });

    var manifest = {
      schemaVersion: "2.0.0",
      generatedAt: new Date().toISOString(),

      // ── Plugin selections ──────────────────────────
      methodology: methodologyId,
      analysisTemplate: config.analysisTemplate,

      // ── Database configuration ─────────────────────
      database: {
        engine: config.db,
        schema: config.schema,
        dataModel: config.dataModel || "omop"
      },

      // ── Study period ───────────────────────────────
      studyPeriod: {
        startYear: config.startYear,
        endYear: config.endYear,
        startDate: config.startYear + "-01-01",
        endDate: config.endYear + "-12-31"
      },

      // ── Time windows ───────────────────────────────
      timeWindows: {
        baselineDays: Number(config.baselineDays) || 365,
        outcomeDays: Number(config.outcomeDays) || 365,
        description: "Baseline window looks back " + (Number(config.baselineDays) || 365) +
          " days from index date. Outcome window looks forward " +
          (Number(config.outcomeDays) || 365) + " days from index date."
      },

      // ── Modes ──────────────────────────────────────
      modes: {
        debug: !!config.debug,
        bestPracticeMode: !!config.bestPracticeMode,
        debugDescription: config.debug
          ? "Debug mode enabled: SQL uses step-by-step temp tables with row counts"
          : "Production mode: SQL is a single CTE chain"
      },

      // ── Full evidence logic ────────────────────────
      evidenceLogic: evidenceLogic,

      // ── Covariates ─────────────────────────────────
      covariates: {
        encoding: config.covariateEncoding || "count",
        encodingDescription: (config.covariateEncoding === "binary")
          ? "Binary encoding: 1 if present, 0 if absent"
          : (config.covariateEncoding === "count_and_binary")
            ? "Both count and binary columns for each covariate"
            : "Count encoding: raw count of matching records",
        selected: covariateDetails
      },

      // ── Raw config (for machine consumption) ───────
      rawConfig: {
        db: config.db,
        schema: config.schema,
        dataModel: config.dataModel,
        startYear: config.startYear,
        endYear: config.endYear,
        baselineDays: config.baselineDays,
        outcomeDays: config.outcomeDays,
        debug: !!config.debug,
        bestPracticeMode: !!config.bestPracticeMode,
        methodology: config.methodology,
        analysisTemplate: config.analysisTemplate,
        covariateEncoding: config.covariateEncoding,
        covariates: config.covariates,
        study: config.study
      }
    };

    return [
      {
        filename: "manifest.json",
        content: JSON.stringify(manifest, null, 2),
        mimeType: "application/json"
      }
    ];
  }

  RapidML.Compiler.buildArtifacts = buildArtifacts;
})();
