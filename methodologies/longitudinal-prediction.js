/**
 * ============================================================================
 * LONGITUDINAL-PREDICTION.JS  -  Methodology Plugin: Longitudinal Prediction
 * ============================================================================
 *
 * PURPOSE:
 *   Implements a repeated-index study design.  Each patient gets one row
 *   per (person_id, index_date) pair covering a baseline look-back window
 *   and an outcome look-forward window.  Index dates are generated yearly
 *   from the patient's cohort entry date.
 *
 * HOW IT WORKS:
 *   This file does NOT contain raw SQL queries.  Instead it uses the
 *   compiler toolkit (omop/compiler.js) as building blocks and adds its
 *   own spine strategy:
 *
 *   1. Calls compiler.buildConceptCTEs  -> concept resolution
 *   2. Calls compiler.buildCohortCTE    -> cohort (person_id, t0)
 *   3. Calls compiler.buildAnchorCTE    -> index_anchor (clamped t0)
 *   4. Builds its own spine CTE         -> repeated yearly windows via
 *                                          a generate_series / ROW_NUMBER
 *                                          integer series
 *   5. Calls compiler.buildFirstOutcomeCTE  -> first outcome date
 *   6. Calls compiler.buildCensoredSpineCTE -> censoring filters
 *   7. Calls compiler.buildFinalSelect      -> covariates + label
 *
 *   It also builds the generated README.md via describeRules().
 *
 * PLUGIN INTERFACE:
 *   id              -> "longitudinal-prediction"
 *   label           -> "Longitudinal prediction (default)"
 *   buildSQL(config) -> complete SQL string (production or debug)
 *   describeRules(config) -> Markdown README string
 *
 * SELF-REGISTERS on RapidML.Methodologies
 *
 * DEPENDS ON:
 *   core/generator.js    (RapidML.Methodologies.register)
 *   core/dialects.js     (RapidML.Compiler.Dialects)
 *   omop/compiler.js     (RapidML.Compiler.*)
 * ============================================================================
 */

(function () {

  // ---------------------------------------------------------------
  //  Config readers — safely extract values from the config object
  // ---------------------------------------------------------------

  /** OMOP table mapping for human-readable evidence descriptions */
  var TABLE_MAP = {
    diagnosis:   { table: "condition_occurrence",  conceptCol: "condition_concept_id",  dateCol: "condition_start_date" },
    lab:         { table: "measurement",           conceptCol: "measurement_concept_id", dateCol: "measurement_date" },
    drug:        { table: "drug_exposure",         conceptCol: "drug_concept_id",        dateCol: "drug_exposure_start_date" },
    procedure:   { table: "procedure_occurrence",  conceptCol: "procedure_concept_id",   dateCol: "procedure_date" },
    observation: { table: "observation",           conceptCol: "observation_concept_id",  dateCol: "observation_date" },
    visit:       { table: "visit_occurrence",      conceptCol: "visit_concept_id",        dateCol: "visit_start_date" }
  };

  var VISIT_CONTEXT_LABELS = {
    all: "Any visit type",
    inpatient: "Inpatient only (concept 9201)",
    outpatient: "Outpatient only (concept 9202)",
    emergency: "Emergency only (concept 9203)",
    custom: "Custom visit concept IDs"
  };

  /** Build a detailed Markdown description for a single evidence row */
  function describeRowDetailed(row, idx) {
    var mapping = TABLE_MAP[row.type] || {};
    var lines = [];
    var label = row.label ? row.label : (row.type + " concept " + (row.conceptId || "?"));

    lines.push("#### Row " + (idx + 1) + ": " + label);
    lines.push("");
    lines.push("| Property | Value |");
    lines.push("|----------|-------|");
    lines.push("| Type | " + (row.type || "unknown") + " |");
    lines.push("| Concept ID | " + (row.conceptId || "not set") + " |");
    lines.push("| OMOP Table | `" + (mapping.table || "unknown") + "` |");
    lines.push("| Concept Column | `" + (mapping.conceptCol || "unknown") + "` |");
    lines.push("| Date Column | `" + (mapping.dateCol || "unknown") + "` |");
    lines.push("| Include Descendants | " + (row.descendants ? "Yes — resolves via `concept_ancestor` table" : "No — exact concept ID match only") + " |");

    // Lab / observation threshold
    if ((row.type === "lab" || row.type === "observation") && row.operator && row.value) {
      lines.push("| Value Threshold | `value_as_number " + row.operator + " " + row.value + "` |");
    }

    // MinCount
    var minCount = parseInt(row.minCount, 10) || 1;
    if (minCount > 1) {
      lines.push("| Minimum Records | " + minCount + (row.distinctVisits ? " distinct visits" : " records") + " |");
    }

    // Distinct visits
    if (row.distinctVisits) {
      lines.push("| Count Mode | Distinct `visit_occurrence_id` values |");
    }

    // Visit context
    var vc = row.visitContext || "all";
    if (vc !== "all") {
      lines.push("| Visit Context | " + (VISIT_CONTEXT_LABELS[vc] || vc) + " |");
      if (vc === "custom" && row.visitContextIds && row.visitContextIds.length) {
        lines.push("| Custom Visit IDs | " + row.visitContextIds.join(", ") + " |");
      }
    }

    // SQL logic summary
    lines.push("");
    lines.push("**SQL Logic:** Query `" + (mapping.table || "?") + "` WHERE `" +
      (mapping.conceptCol || "?") + "` ");
    if (row.descendants) {
      lines.push("IN (SELECT `descendant_concept_id` FROM `concept_ancestor` WHERE `ancestor_concept_id` = " +
        (row.conceptId || "?") + ")");
    } else {
      lines.push("= " + (row.conceptId || "?"));
    }
    if ((row.type === "lab" || row.type === "observation") && row.operator && row.value) {
      lines.push("AND `value_as_number` " + row.operator + " " + row.value);
    }
    if (vc !== "all") {
      lines.push("filtered to " + (VISIT_CONTEXT_LABELS[vc] || vc) + " visits via JOIN to `visit_occurrence`");
    }
    if (minCount > 1) {
      if (row.distinctVisits) {
        lines.push(", requiring HAVING COUNT(DISTINCT `visit_occurrence_id`) >= " + minCount);
      } else {
        lines.push(", requiring HAVING COUNT(*) >= " + minCount);
      }
    }

    return lines;
  }

  /** Summarize evidence rows as a brief one-line string (for config table) */
  function describeEvidenceRows(rows) {
    if (!rows || !rows.length) return "none";
    return rows.map(function(r) {
      var desc = r.type + " concept " + (r.conceptId || "?");
      if (r.label) desc = r.label + " (" + desc + ")";
      if (r.type === "lab" && r.operator && r.value) {
        desc += " " + r.operator + " " + r.value;
      }
      if (r.descendants) desc += " +descendants";
      var minCount = parseInt(r.minCount, 10) || 1;
      if (minCount > 1) {
        desc += " ≥" + minCount + (r.distinctVisits ? " distinct visits" : " records");
      } else if (r.distinctVisits) {
        desc += " (distinct visits)";
      }
      return desc;
    }).join("; ");
  }

  // ---------------------------------------------------------------
  //  README section builders — each returns an array of Markdown lines
  // ---------------------------------------------------------------

  // ── Helpers shared by plain-language sections ──────────────────

  /**
   * Build a short readable description of one evidence row.
   * When label is null/empty, derives text from type + conceptId + threshold.
   */
  function _shortRowDesc(row) {
    if (!row) return "?";
    var type = (row.type || "diagnosis").toLowerCase();
    var cid  = row.conceptId || "?";
    if (row.label && String(row.label).trim()) {
      var lbl = String(row.label).trim();
      if ((type === "lab" || type === "observation") && row.operator && row.value)
        lbl += " " + row.operator + " " + row.value;
      return lbl;
    }
    var desc;
    if (type === "diagnosis")       desc = "diagnosis " + cid + (row.descendants ? " (and related)" : "");
    else if (type === "lab")        { desc = "lab " + cid; if (row.operator && row.value) desc += " " + row.operator + " " + row.value; }
    else if (type === "drug")       desc = "drug " + cid + (row.descendants ? " (and related)" : "");
    else if (type === "procedure")  desc = "procedure " + cid;
    else if (type === "observation") { desc = "observation " + cid; if (row.operator && row.value) desc += " " + row.operator + " " + row.value; }
    else if (type === "visit")      desc = "visit type " + cid;
    else                            desc = type + " " + cid;
    var minCount = parseInt(row.minCount, 10) || 1;
    if (minCount > 1) desc += " (\u2265" + minCount + (row.distinctVisits ? " visits" : "x") + ")";
    return desc;
  }

  /** Summarise all rows of a block as a joined plain-text string (AND / OR). */
  function _entryLabel(config) {
    var block = config.study && config.study.entry;
    if (!block || !block.rows || !block.rows.length) return "the entry condition";
    var connector = block.match === "any" ? " OR " : " AND ";
    return block.rows.map(_shortRowDesc).join(connector);
  }

  function _outcomeLabel(config) {
    var block = config.study && config.study.outcome;
    if (!block || !block.rows || !block.rows.length) return "the outcome condition";
    var connector = block.match === "any" ? " OR " : " AND ";
    return block.rows.map(_shortRowDesc).join(connector);
  }

  /**
   * 5th-grade plain-language summary — goes at the very top of the README.
   * Uses actual config values (years, window lengths, concept labels) so a
   * non-technical reader immediately sees what this particular study does.
   */
  function buildPlainSummary(config) {
    var entry        = _entryLabel(config);
    var outcome      = _outcomeLabel(config);
    var sy           = String(config.startYear   || "2016");
    var ey           = String(config.endYear     || "2024");
    var bl           = Number(config.baselineDays || 365);
    var oc           = Number(config.outcomeDays  || 365);
    var blYrs        = Math.round(bl / 365 * 10) / 10;
    var ocYrs        = Math.round(oc / 365 * 10) / 10;
    var span         = Number(ey) - Number(sy);
    var covs         = (config.covariates || []).join(", ") || "none selected";
    var exclCount    = (config.study && config.study.exclusions && config.study.exclusions.length) || 0;
    var confCount    = (config.study && config.study.confounders && config.study.confounders.length) || 0;

    return [
      "---",
      "",
      "## 🔬 What This Study Is About (Plain Language)",
      "",
      "> **For anyone to read — no medical training needed.**",
      "",
      "### The Research Question",
      "",
      "**\"Among people who have been diagnosed with " + entry + ",",
      "who goes on to develop " + outcome + "?\"**",
      "",
      "This study looks at patient records from " + sy + " to " + ey + " (" + span + " years).",
      "It uses a computer program to learn patterns from past medical history that might",
      "predict whether a patient will develop " + outcome + " in the future.",
      "",
      "### How the Study Works",
      "",
      "Think of each patient's time in the study like a sliding ruler:",
      "",
      "```",
      "Patient enters study",
      "        |",
      "        t0    <── first diagnosis of " + entry,
      "        |",
      "        |←── Look-BACK " + bl + " days ──→|←── Look-FORWARD " + oc + " days ──→|",
      "        |        (baseline window)          |       (outcome window)          |",
      "        |   [collect past medical facts]    | [did " + outcome + " happen?]   |",
      "```",
      "",
      "- **Look-back window (" + bl + " days / ~" + blYrs + " year" + (blYrs === 1 ? "" : "s") + "):**",
      "  The computer looks at what happened to the patient in the " + bl + " days",
      "  *before* this date — how many doctor visits, what medicines, what diagnoses.",
      "",
      "- **Look-forward window (" + oc + " days / ~" + ocYrs + " year" + (ocYrs === 1 ? "" : "s") + "):**",
      "  The computer checks whether the patient was diagnosed with " + outcome,
      "  in the " + oc + " days *after* this date.",
      "  - If yes → **label = 1** (the outcome happened)",
      "  - If no  → **label = 0** (the outcome did not happen)",
      "",
      "### Why Multiple Windows Per Patient? (Longitudinal Design)",
      "",
      "This study uses a **longitudinal (repeated-index) design**:",
      "each eligible patient contributes **one row of data per year** they remain",
      "in the study.  This makes better use of available data because the same person",
      "can be 'at risk' for the outcome across multiple years.",
      "",
      "```",
      "Patient A — enters " + sy,
      "Year 1: |--baseline--|--outcome?--|  → label = 0",
      "Year 2: |--baseline--|--outcome?--|  → label = 0",
      "Year 3: |--baseline--|--outcome?--|  → label = 1  ← outcome detected here",
      "(Year 4 onward: removed because outcome already occurred)",
      "```",
      "",
      "### Who Is in the Study?",
      "",
      "- **Included:** Patients in the database with a recorded diagnosis of **" + entry + "**",
      "  between " + sy + " and " + ey + ".",
      exclCount > 0
        ? "- **Excluded:** " + exclCount + " group(s) of patients are removed before analysis to keep the results fair."
        : "- **Excluded:** No additional exclusions configured.",
      "",
      "### What the Computer Learns From",
      "",
      "During each look-back window the computer collects these features:",
      "  - " + covs,
      confCount > 0
        ? "  - " + confCount + " additional confounder flag(s) (yes/no medical facts that might skew results)"
        : "",
      "",
      "### What Happens Next",
      "",
      "1. The collected features (look-back) and label (look-forward) form a dataset.",
      "2. A machine-learning model is trained to predict **label = 1** from the features.",
      "3. Researchers can then identify which features best predict " + outcome + ".",
      "",
      "---",
      ""
    ].filter(function (l) { return l !== null && l !== undefined; });
  }

  /**
   * ASCII spine diagram section using real config values.
   * Shows three fictional patients to illustrate how windows are generated.
   */
  function buildSpineExample(config) {
    var sy  = Number(config.startYear  || 2016);
    var ey  = Number(config.endYear    || 2024);
    var bl  = Number(config.baselineDays || 365);
    var oc  = Number(config.outcomeDays  || 365);
    var entry   = _entryLabel(config);
    var outcome = _outcomeLabel(config);

    // Build two example patients using real dates
    var lines = [
      "## 📅 Example: How Patient Windows Are Built",
      "",
      "Using your configuration — baseline " + bl + " days, outcome " + oc + " days,",
      "study period " + sy + "–" + ey + ":",
      "",
      "```",
      "TIMELINE (" + sy + " → " + ey + ")",
      "─────────────────────────────────────────────────────────────────"
    ];

    var span = ey - sy;
    var blYrs = bl / 365;
    var ocYrs = oc / 365;

    // Patient A: enters at study start, no outcome
    var pA_t0 = sy;
    var windowCount = 0;
    for (var n = 0; n < 6; n++) {
      var idxDate = pA_t0 + blYrs * (n + 1);
      var wEnd    = idxDate + ocYrs;
      if (wEnd > ey) break;
      windowCount++;
    }
    lines.push("Patient A  (enters " + pA_t0 + ", no outcome — " + windowCount + " window" + (windowCount !== 1 ? "s" : "") + "):");
    for (var n2 = 0; n2 < Math.min(windowCount, 3); n2++) {
      var idx2  = pA_t0 + blYrs * (n2 + 1);
      var bsYr  = Math.round((pA_t0 + blYrs * n2) * 10) / 10;
      var beYr  = Math.round(idx2 * 10) / 10;
      var oeYr  = Math.round((idx2 + ocYrs) * 10) / 10;
      lines.push("  Window " + (n2 + 1) + ": [" + bsYr + "…" + beYr + "] baseline | [" +
                 beYr + "…" + oeYr + "] outcome → label=0");
    }
    if (windowCount > 3) lines.push("  … " + (windowCount - 3) + " more window(s) …");

    // Patient B: enters 1 year later, gets outcome in window 2
    var pB_t0 = sy + 1;
    lines.push("");
    lines.push("Patient B  (enters " + pB_t0 + ", outcome in window 2):");
    for (var n3 = 0; n3 < 3; n3++) {
      var idx3  = pB_t0 + blYrs * (n3 + 1);
      var bsYr2 = Math.round((pB_t0 + blYrs * n3) * 10) / 10;
      var beYr2 = Math.round(idx3 * 10) / 10;
      var oeYr2 = Math.round((idx3 + ocYrs) * 10) / 10;
      if (oeYr2 > ey) break;
      var lbl = n3 === 1 ? "label=1  ← " + outcome + " detected" : (n3 > 1 ? "(removed — outcome already occurred)" : "label=0");
      lines.push("  Window " + (n3 + 1) + ": [" + bsYr2 + "…" + beYr2 + "] baseline | [" +
                 beYr2 + "…" + oeYr2 + "] outcome → " + lbl);
      if (n3 === 1) break;  // stop after the outcome window
    }

    lines = lines.concat([
      "─────────────────────────────────────────────────────────────────",
      "  [  ] = baseline window (look-back " + bl + " days)",
      "  [  ] = outcome window  (look-forward " + oc + " days)",
      "  label=0 → no " + outcome + "  |  label=1 → " + outcome + " occurred",
      "```",
      ""
    ]);

    return lines;
  }

  /** Title line */
  function buildTitle(config) {
    var entry = config.study && config.study.entry && config.study.entry.rows;
    var outcome = config.study && config.study.outcome && config.study.outcome.rows;
    var entryLabel = entry && entry.length ? (entry[0].label || entry[0].conceptId || "?") : "?";
    var outcomeLabel = outcome && outcome.length ? (outcome[0].label || outcome[0].conceptId || "?") : "?";
    return [
      "# Study: " + entryLabel + " → " + outcomeLabel
    ];
  }

  /** Configuration summary table */
  function buildConfigTable(config) {
    var baselineDays = Number(config.baselineDays) || 365;
    var outcomeDays  = Number(config.outcomeDays) || 365;
    var covariates   = (config.covariates || []).join(", ") || "none";
    var entry = config.study && config.study.entry;
    var outcome = config.study && config.study.outcome;

    return [
      "## Configuration Summary",
      "",
      "| Item | Value |",
      "|---|---|",
      "| Methodology | Longitudinal prediction (repeated-index spine) |",
      "| Database | " + config.db + " |",
      "| Schema | " + config.schema + " |",
      "| Data model | " + (config.dataModel || "omop") + " |",
      "| Study period | " + config.startYear + "-01-01 to " + config.endYear + "-12-31 |",
      "| Entry criteria | " + (entry ? entry.rows.length + " row(s), match=" + entry.match : "none") + " |",
      "| Outcome criteria | " + (outcome ? outcome.rows.length + " row(s), match=" + outcome.match : "none") + " |",
      "| Exclusions | " + ((config.study && config.study.exclusions && config.study.exclusions.length) || 0) + " row(s) |",
      "| Confounders | " + ((config.study && config.study.confounders && config.study.confounders.length) || 0) + " row(s) |",
      "| Baseline window | " + baselineDays + " days |",
      "| Outcome window | " + outcomeDays + " days |",
      "| Covariate encoding | " + (config.covariateEncoding || "count") + " |",
      "| Selected covariates | " + covariates + " |",
      "| Debug mode | " + (config.debug ? "enabled" : "disabled") + " |",
      "| Best-practice mode | " + (config.bestPracticeMode ? "enabled" : "disabled") + " |"
    ];
  }

  /** Lists evidence blocks with detailed row-by-row logic descriptions */
  function buildStudyDefinition(config) {
    var lines = ["## Study Definition — Detailed Evidence Logic"];

    var entry = config.study && config.study.entry;
    lines.push("");
    lines.push("### Cohort Entry Criteria");
    if (entry && entry.rows && entry.rows.length) {
      lines.push("");
      lines.push("**Match mode:** `" + (entry.match || "all") + "` — " +
        (entry.match === "any"
          ? "patient must match ANY of the following criteria (union)"
          : "patient must match ALL of the following criteria (intersection)"));
      lines.push("");
      if (entry.match === "all" && entry.rows.length > 1) {
        lines.push("**SQL combination logic:** All row subqueries are combined, then filtered with " +
          "`HAVING COUNT(DISTINCT row_idx) = " + entry.rows.length + "`. " +
          "The cohort entry date (t0) is the `MAX(event_date)` across matching rows.");
      } else if (entry.match === "any" && entry.rows.length > 1) {
        lines.push("**SQL combination logic:** Row subqueries are combined with `UNION ALL`, " +
          "then grouped by `person_id` using `MIN(event_date)` as the cohort entry date (t0).");
      }
      lines.push("");
      for (var i = 0; i < entry.rows.length; i++) {
        lines = lines.concat(describeRowDetailed(entry.rows[i], i));
        lines.push("");
      }
    } else {
      lines.push("");
      lines.push("No entry criteria defined.");
    }

    var outcome = config.study && config.study.outcome;
    lines.push("### Outcome Criteria");
    if (outcome && outcome.rows && outcome.rows.length) {
      lines.push("");
      lines.push("**Match mode:** `" + (outcome.match || "all") + "` — " +
        (outcome.match === "any"
          ? "any of the following qualifies as an outcome event"
          : "all of the following must be present for an outcome event"));
      lines.push("");
      for (var j = 0; j < outcome.rows.length; j++) {
        lines = lines.concat(describeRowDetailed(outcome.rows[j], j));
        lines.push("");
      }
      lines.push("**Outcome labelling:** If a matching outcome event occurs within the outcome window " +
        "(`outcome_start` to `outcome_end`), `outcome_label = 1`; otherwise `outcome_label = 0`.");
    } else {
      lines.push("");
      lines.push("No outcome criteria defined.");
    }

    var excl = config.study && config.study.exclusions;
    if (excl && excl.length) {
      lines.push("");
      lines.push("### Exclusion Criteria");
      lines.push("");
      lines.push("Each exclusion row generates a `NOT EXISTS` subquery. " +
        "Patients matching **any** exclusion row are removed from the final dataset.");
      lines.push("");
      for (var k = 0; k < excl.length; k++) {
        lines = lines.concat(describeRowDetailed(excl[k], k));
        lines.push("");
      }
    }

    var conf = config.study && config.study.confounders;
    if (conf && conf.length) {
      lines.push("");
      lines.push("### Confounder Flags");
      lines.push("");
      lines.push("Each confounder row generates a binary flag column (0 or 1) in the final output. " +
        "These are additional features that indicate presence of a condition/treatment during baseline.");
      lines.push("");
      for (var m = 0; m < conf.length; m++) {
        lines = lines.concat(describeRowDetailed(conf[m], m));
        lines.push("");
      }
    }

    return lines;
  }

  /** Explains the SQL pipeline stages at a high level */
  function buildPipelineDescription() {
    return [
      "## SQL Pipeline",
      "",
      "1. Resolve concept descendants for each evidence row from OMOP vocabulary tables.",
      "2. Build cohort entry dates (t0) by combining entry evidence rows.",
      "3. Build repeated yearly index windows with baseline/outcome periods.",
      "4. Apply censoring: first-outcome handling + observation period checks + study end boundary.",
      "5. Apply exclusion criteria (if any).",
      "6. Compute `outcome_label` and append covariates + confounder flags.",
      "",
      "## Output",
      "",
      "One row per `(person_id, index_date)` with:",
      "- Time-window columns (baseline_start, baseline_end, outcome_start, outcome_end)",
      "- `outcome_label` (0 = no event, 1 = event, NULL = censored)",
      "- Selected covariates",
      "- Confounder flags (if defined)"
    ];
  }

  /** DB-specific performance tips */
  function buildPerformanceGuidance(config) {
    var lines = ["## Performance Guidance"];
    if (config.db === "postgres") {
      lines.push("- Run `ANALYZE` on large OMOP tables (condition_occurrence, measurement, visit_occurrence, observation_period) after major data loads.");
    } else {
      lines.push("- Refresh table statistics (`UPDATE STATISTICS`) after major data loads.");
    }
    return lines;
  }

  /** Debug explanation (only if debug mode enabled) */
  function buildDebugNotes(config) {
    if (!config.debug) {
      return ["## Debug", "", "Debug mode is disabled. SQL is a single production CTE pipeline."];
    }
    return [
      "## Debug",
      "",
      "Debug mode is enabled: SQL includes step-by-step temp tables with row-count checkpoints.",
      "",
      "### Conceptual Example",
      "- Person A: enters cohort in 2020, remains outcome-free until 2023 → early rows label 0, later row may label 1.",
      "- Person B: has early outcome in 2021 → subsequent rows removed by outcome-based censoring.",
      "- Use temp-table row counts in `study.sql` to trace exactly where each patient is filtered."
    ];
  }

  // ---------------------------------------------------------------
  //  Plugin definition
  // ---------------------------------------------------------------

  /**
   * Build the repeated-index window expressions.
   * These use `nums.n` to create yearly offsets from the anchor.
   */
  function buildWindowExpressions(config) {
    var d = RapidML.Compiler.Dialects;
    var db = config.db;
    var baselineDays = String(Number(config.baselineDays) || 365);
    var outcomeDays  = String(Number(config.outcomeDays) || 365);
    var stepDays     = baselineDays;  // each index step = baselineDays wide

    return {
      baselineDays: baselineDays,
      outcomeDays: outcomeDays,
      firstIndexDateExpr: d.addDaysExpr(db, "a.exposure_index_date", baselineDays),
      indexDateExpr:      d.addDaysExpr(db, "a.first_index_date", "nums.n * " + stepDays),
      baselineStartExpr:  d.addDaysExpr(db, "a.first_index_date", "(nums.n * " + stepDays + ") - " + baselineDays),
      baselineEndExpr:    d.addDaysExpr(db, "a.first_index_date", "(nums.n * " + stepDays + ") - 1"),
      outcomeStartExpr:   d.addDaysExpr(db, "a.first_index_date", "nums.n * " + stepDays),
      outcomeEndExpr:     d.addDaysExpr(db, d.addDaysExpr(db, "a.first_index_date", "nums.n * " + stepDays), outcomeDays)
    };
  }

  /** Build the spine CTE — repeated index windows via nums series */
  function buildSpineCTE(config, ctx, windowExpr) {
    var C = RapidML.Compiler;
    return C.sqlLines([
      "-- Build repeated index windows per person",
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
      "  JOIN nums ON " + windowExpr.outcomeEndExpr + " <= " + ctx.studyEnd,
      ")"
    ]);
  }

  // ---------------------------------------------------------------
  //  PRODUCTION SQL — single CTE pipeline
  // ---------------------------------------------------------------

  function buildProductionSQL(config) {
    var C = RapidML.Compiler;
    var d = C.Dialects;
    var ctx = C.prepareContext(config);
    var windowExpr = buildWindowExpressions(config);
    var numsCTE = d.seriesCTE(config.db, "nums", 20);

    var ctes = C.buildConceptCTEs(config, ctx).concat([
      C.buildCohortCTE(config, ctx),
      C.buildAnchorCTE(config, ctx, windowExpr.baselineDays),
      numsCTE,
      buildSpineCTE(config, ctx, windowExpr),
      C.buildFirstOutcomeCTE(config, ctx),
      C.buildCensoredSpineCTE(config, ctx)
    ]);

    var sel = C.buildFinalSelect(config, ctx);

    return C.sqlLines([
      C.buildHeader(config, "Longitudinal Prediction (repeated-index spine)"),
      C.buildPerformanceHints(config),
      "WITH " + ctes.join(",\n"),
      "SELECT",
      "  " + sel.columns.join(",\n  "),
      "FROM final_spine s",
      sel.joins.join("\n"),
      "ORDER BY s.person_id, s.index_date;"
    ]);
  }

  // ---------------------------------------------------------------
  //  DEBUG SQL — step-by-step temp tables
  // ---------------------------------------------------------------

  function buildDebugSQL(config) {
    var C = RapidML.Compiler;
    var d = C.Dialects;
    var ctx = C.prepareContext(config);
    var dbg = C.buildDebugHelpers(config, ctx);
    var windowExpr = buildWindowExpressions(config);
    var numsCTE = d.seriesCTE(config.db, "nums", 20);
    var isPostgres = ctx.isPostgres;

    // Steps 1-5: concepts, cohort (shared with compiler)
    var conceptSteps = C.buildDebugConceptSteps(config, ctx, dbg);
    var cohortStep = C.buildDebugCohortStep(config, ctx, dbg);

    // Step 6: index anchor
    // Must inline the CASE expression for exposure_index_date because
    // PostgreSQL cannot reference a column alias within the same SELECT.
    var exposureExpr = "(CASE WHEN c.t0 < " + ctx.studyStart + " THEN " + ctx.studyStart + " ELSE c.t0 END)";
    var anchorFirstIndexExpr = d.addDaysExpr(config.db, exposureExpr, windowExpr.baselineDays);
    var anchorStep = C.sqlLines([
      "",
      "-- STEP 6: Build index anchor (respect study start and baseline offset)",
      dbg.dropTemp("index_anchor"),
      dbg.createTempFromSelect(
        "index_anchor",
        [
          "  c.person_id,",
          "  c.t0,",
          "  " + exposureExpr + " AS exposure_index_date,",
          "  " + anchorFirstIndexExpr + " AS first_index_date"
        ].join("\n"),
        "FROM " + dbg.tmpName("cohort") + " c"
      ),
      dbg.selectTop(dbg.tmpName("index_anchor"), "person_id")
    ]);

    // Step 7: repeated yearly spine (methodology-specific)
    var spineStep = C.sqlLines([
      "",
      "-- STEP 7: Build repeated yearly spine rows",
      dbg.dropTemp("spine"),
      (isPostgres
        ? C.sqlLines([
            "CREATE TEMP TABLE " + dbg.tmpName("spine") + " AS",
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
            "FROM " + dbg.tmpName("index_anchor") + " a",
            "JOIN nums ON " + windowExpr.outcomeEndExpr + " <= " + ctx.studyEnd + ";"
          ])
        : C.sqlLines([
            "WITH " + numsCTE + ",",
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
            "  FROM " + dbg.tmpName("index_anchor") + " a",
            "  JOIN nums ON " + windowExpr.outcomeEndExpr + " <= " + ctx.studyEnd,
            ")",
            "SELECT * INTO " + dbg.tmpName("spine") + " FROM spine_src;"
          ])),
      "SELECT COUNT(*) AS spine_rows FROM " + dbg.tmpName("spine") + ";"
    ]);

    // Steps 8-10: outcome, censoring, final (shared)
    var outcomeStep = C.buildDebugOutcomeStep(config, ctx, dbg, 8);
    var censorStep  = C.buildDebugCensoringStep(config, ctx, dbg, 9, dbg.tmpName("spine"));
    var finalStep   = C.buildDebugFinalStep(config, ctx, dbg, 10);

    return C.sqlLines([
      C.buildHeader(config, "Longitudinal Prediction DEBUG (repeated-index spine)"),
      conceptSteps,
      cohortStep,
      anchorStep,
      spineStep,
      outcomeStep,
      censorStep,
      finalStep
    ]);
  }

  var longitudinalPredictionMethodology = {
    id: "longitudinal-prediction",
    label: "Longitudinal prediction (default)",

    /**
     * Generate SQL — this methodology owns the repeated-index spine.
     * Uses compiler building blocks for concepts, cohort, censoring, covariates.
     */
    buildSQL: function (config) {
      if (config.debug) {
        return buildDebugSQL(config);
      }
      return buildProductionSQL(config);
    },

    /**
     * Build the generated README (Markdown) that accompanies the SQL.
     * Each section is produced by a dedicated helper above.
     */
    describeRules: function (config) {
      return [].concat(
        buildTitle(config),
        [""],
        buildPlainSummary(config),
        buildSpineExample(config),
        buildConfigTable(config),
        [""],
        buildStudyDefinition(config),
        [""],
        buildPipelineDescription(),
        [""],
        buildPerformanceGuidance(config),
        [""],
        buildDebugNotes(config)
      ).join("\n");
    }
  };

  // ---------------------------------------------------------------
  //  Self-registration
  // ---------------------------------------------------------------

  if (typeof RapidML !== "undefined" && RapidML.Methodologies && RapidML.Methodologies.register) {
    RapidML.Methodologies.register(longitudinalPredictionMethodology);
  }

})();
