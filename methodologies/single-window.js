/**
 * ============================================================================
 * SINGLE-WINDOW.JS  -  Methodology Plugin: Single Window
 * ============================================================================
 *
 * PURPOSE:
 *   Implements a single-window study design.  Each patient gets exactly
 *   one row with one baseline + outcome window anchored at their cohort
 *   entry date (t0), clamped to the study start boundary.
 *
 *   No yearly repetition - no integer series.  Simpler and faster when
 *   a repeated-index design is not needed (e.g. cross-sectional prediction,
 *   case-control matching).
 *
 * HOW IT DIFFERS FROM LONGITUDINAL:
 *   - Longitudinal: multiple rows per patient (yearly index dates)
 *   - Single window: exactly one row per patient
 *   - No nums / generate_series CTE needed
 *
 * PLUGIN INTERFACE:
 *   id              -> "single-window"
 *   label           -> "Single window (one row per patient)"
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
  //  Window expressions — single window, no nums.n
  // ---------------------------------------------------------------

  function buildWindowExpressions(config) {
    var d = RapidML.Compiler.Dialects;
    var db = config.db;
    var baselineDays = String(Number(config.baselineDays) || 365);
    var outcomeDays  = String(Number(config.outcomeDays) || 365);

    return {
      baselineDays: baselineDays,
      outcomeDays: outcomeDays,
      // first_index_date = t0 + baseline offset
      firstIndexDateExpr: d.addDaysExpr(db, "c.exposure_index_date", baselineDays),
      // Single window: index_date = first_index_date (no yearly offset)
      indexDateExpr:      "a.first_index_date",
      baselineStartExpr:  "a.exposure_index_date",
      baselineEndExpr:    d.addDaysExpr(db, "a.first_index_date", "-1"),
      outcomeStartExpr:   "a.first_index_date",
      outcomeEndExpr:     d.addDaysExpr(db, "a.first_index_date", outcomeDays)
    };
  }

  /** Build the spine CTE — one row per patient, no series JOIN */
  function buildSpineCTE(config, ctx, windowExpr) {
    var C = RapidML.Compiler;
    return C.sqlLines([
      "-- Single window per person (no yearly repetition)",
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
      "  WHERE " + windowExpr.outcomeEndExpr + " <= " + ctx.studyEnd,
      ")"
    ]);
  }

  // ---------------------------------------------------------------
  //  PRODUCTION SQL
  // ---------------------------------------------------------------

  function buildProductionSQL(config) {
    var C = RapidML.Compiler;
    var ctx = C.prepareContext(config);
    var windowExpr = buildWindowExpressions(config);

    var ctes = C.buildConceptCTEs(config, ctx).concat([
      C.buildCohortCTE(config, ctx),
      C.buildAnchorCTE(config, ctx, windowExpr.baselineDays),
      buildSpineCTE(config, ctx, windowExpr),
      C.buildFirstOutcomeCTE(config, ctx),
      C.buildCensoredSpineCTE(config, ctx)
    ]);

    var sel = C.buildFinalSelect(config, ctx);

    return C.sqlLines([
      C.buildHeader(config, "Single Window (one row per patient)"),
      C.buildPerformanceHints(config),
      "WITH " + ctes.join(",\n"),
      "SELECT",
      "  " + sel.columns.join(",\n  "),
      "FROM final_spine s",
      sel.joins.join("\n"),
      "ORDER BY s.person_id;"
    ]);
  }

  // ---------------------------------------------------------------
  //  DEBUG SQL
  // ---------------------------------------------------------------

  function buildDebugSQL(config) {
    var C = RapidML.Compiler;
    var ctx = C.prepareContext(config);
    var dbg = C.buildDebugHelpers(config, ctx);
    var windowExpr = buildWindowExpressions(config);

    // Steps 1-5: concepts, cohort (shared)
    var conceptSteps = C.buildDebugConceptSteps(config, ctx, dbg);
    var cohortStep = C.buildDebugCohortStep(config, ctx, dbg);

    // Step 6: index anchor
    // Must inline the CASE expression for exposure_index_date because
    // PostgreSQL cannot reference a column alias within the same SELECT.
    var d = RapidML.Compiler.Dialects;
    var exposureExpr = "(CASE WHEN c.t0 < " + ctx.studyStart + " THEN " + ctx.studyStart + " ELSE c.t0 END)";
    var anchorFirstIndexExpr = d.addDaysExpr(config.db, exposureExpr, windowExpr.baselineDays);
    var anchorStep = C.sqlLines([
      "",
      "-- STEP 6: Build index anchor",
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

    // Step 7: single-window spine (methodology-specific, no nums)
    var spineStep = C.sqlLines([
      "",
      "-- STEP 7: Build single-window spine (one row per patient)",
      dbg.dropTemp("spine"),
      dbg.createTempFromSelect(
        "spine",
        [
          "  a.person_id,",
          "  a.t0,",
          "  a.exposure_index_date,",
          "  " + windowExpr.indexDateExpr + " AS index_date,",
          "  " + windowExpr.baselineStartExpr + " AS baseline_start,",
          "  " + windowExpr.baselineEndExpr + " AS baseline_end,",
          "  " + windowExpr.outcomeStartExpr + " AS outcome_start,",
          "  " + windowExpr.outcomeEndExpr + " AS outcome_end"
        ].join("\n"),
        "FROM " + dbg.tmpName("index_anchor") + " a\nWHERE " + windowExpr.outcomeEndExpr + " <= " + ctx.studyEnd
      ),
      "SELECT COUNT(*) AS spine_rows FROM " + dbg.tmpName("spine") + ";"
    ]);

    // Steps 8-10: outcome, censoring, final (shared)
    var outcomeStep = C.buildDebugOutcomeStep(config, ctx, dbg, 8);
    var censorStep  = C.buildDebugCensoringStep(config, ctx, dbg, 9, dbg.tmpName("spine"));
    var finalStep   = C.buildDebugFinalStep(config, ctx, dbg, 10);

    return C.sqlLines([
      C.buildHeader(config, "Single Window DEBUG (one row per patient)"),
      conceptSteps,
      cohortStep,
      anchorStep,
      spineStep,
      outcomeStep,
      censorStep,
      finalStep
    ]);
  }

  // ---------------------------------------------------------------
  //  README builder
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

    if ((row.type === "lab" || row.type === "observation") && row.operator && row.value) {
      lines.push("| Value Threshold | `value_as_number " + row.operator + " " + row.value + "` |");
    }

    var minCount = parseInt(row.minCount, 10) || 1;
    if (minCount > 1) {
      lines.push("| Minimum Records | " + minCount + (row.distinctVisits ? " distinct visits" : " records") + " |");
    }

    if (row.distinctVisits) {
      lines.push("| Count Mode | Distinct `visit_occurrence_id` values |");
    }

    var vc = row.visitContext || "all";
    if (vc !== "all") {
      lines.push("| Visit Context | " + (VISIT_CONTEXT_LABELS[vc] || vc) + " |");
      if (vc === "custom" && row.visitContextIds && row.visitContextIds.length) {
        lines.push("| Custom Visit IDs | " + row.visitContextIds.join(", ") + " |");
      }
    }

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

  // ── Plain-language helpers ───────────────────────────────────────

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
   * 5th-grade plain-language summary for the single-window design.
   * Uses actual config values (years, window lengths, concept labels).
   */
  function buildSWPlainSummary(config) {
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
      "predict whether a patient will develop " + outcome + ".",
      "",
      "### How the Study Works",
      "",
      "Think of each patient's time in the study like a single ruler snapshot:",
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
      "  *before* the index date — how many doctor visits, what medicines, what diagnoses.",
      "",
      "- **Look-forward window (" + oc + " days / ~" + ocYrs + " year" + (ocYrs === 1 ? "" : "s") + "):**",
      "  The computer checks whether the patient was diagnosed with " + outcome,
      "  in the " + oc + " days *after* this date.",
      "  - If yes → **label = 1** (the outcome happened)",
      "  - If no  → **label = 0** (the outcome did not happen)",
      "",
      "### One Window Per Patient (Single-Window Design)",
      "",
      "This study uses a **single-window design**: each patient contributes",
      "**exactly one row of data**, anchored at their earliest qualifying event date.",
      "This is simpler and works well when you want one prediction per patient.",
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
      "During the look-back window the computer collects these features:",
      "  - " + covs,
      confCount > 0
        ? "  - " + confCount + " additional confounder flag(s) (yes/no medical facts that might skew results)"
        : "",
      "",
      "---",
      ""
    ].filter(function (l) { return l !== null && l !== undefined; });
  }

  /**
   * ASCII spine diagram using real config values (single-window variant).
   */
  function buildSWSpineExample(config) {
    var sy  = Number(config.startYear  || 2016);
    var ey  = Number(config.endYear    || 2024);
    var bl  = Number(config.baselineDays || 365);
    var oc  = Number(config.outcomeDays  || 365);
    var entry   = _entryLabel(config);
    var outcome = _outcomeLabel(config);
    var blYrs = bl / 365;
    var ocYrs = oc / 365;

    var pA_t0   = sy;
    var pA_idx  = Math.round((pA_t0 + blYrs) * 10) / 10;
    var pA_oEnd = Math.round((pA_t0 + blYrs + ocYrs) * 10) / 10;

    var pB_t0   = sy + 1;
    var pB_idx  = Math.round((pB_t0 + blYrs) * 10) / 10;
    var pB_oEnd = Math.round((pB_t0 + blYrs + ocYrs) * 10) / 10;

    return [
      "## 📅 Example: How Patient Windows Are Built",
      "",
      "Using your configuration — baseline " + bl + " days, outcome " + oc + " days,",
      "study period " + sy + "–" + ey + ":",
      "",
      "```",
      "TIMELINE (" + sy + " → " + ey + ")",
      "─────────────────────────────────────────────────────────────────",
      "Patient A  (enters " + pA_t0 + ", no outcome):",
      "  t0=" + pA_t0 + "  baseline=[" + pA_t0 + "…" + pA_idx + "]  outcome=[" + pA_idx + "…" + pA_oEnd + "]  → label=0",
      "",
      "Patient B  (enters " + pB_t0 + ", gets " + outcome + "):",
      "  t0=" + pB_t0 + "  baseline=[" + pB_t0 + "…" + pB_idx + "]  outcome=[" + pB_idx + "…" + pB_oEnd + "]  → label=1",
      "",
      "  (Each patient has EXACTLY ONE row in the dataset.)",
      "─────────────────────────────────────────────────────────────────",
      "  [  ] = baseline window (look-back " + bl + " days)",
      "  [  ] = outcome window  (look-forward " + oc + " days)",
      "  label=0 → no " + outcome + "  |  label=1 → " + outcome + " occurred",
      "```",
      ""
    ];
  }

  function describeRules(config) {
    var baselineDays = Number(config.baselineDays) || 365;
    var outcomeDays  = Number(config.outcomeDays) || 365;
    var covariates   = (config.covariates || []).join(", ") || "none";
    var entry = config.study && config.study.entry;
    var outcome = config.study && config.study.outcome;

    var lines = [
      "# Study: Single-Window Prediction",
      ""
    ];

    // ── Plain-language summary + spine example (top of README) ───
    lines = lines.concat(buildSWPlainSummary(config));
    lines = lines.concat(buildSWSpineExample(config));

    // ── Technical config table ────────────────────────────────────
    lines = lines.concat([
      "## Configuration Summary",
      "",
      "| Item | Value |",
      "|---|---|",
      "| Methodology | Single window (one row per patient) |",
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
      ""
    ]);

    // ── Detailed evidence logic ──────────────────────
    lines.push("## Study Definition — Detailed Evidence Logic");
    lines.push("");

    // Entry block
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
      lines.push("");
    }

    // Outcome block
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
      lines.push("");
    } else {
      lines.push("");
      lines.push("No outcome criteria defined.");
      lines.push("");
    }

    // Exclusions
    var excl = config.study && config.study.exclusions;
    if (excl && excl.length) {
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

    // Confounders
    var conf = config.study && config.study.confounders;
    if (conf && conf.length) {
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

    // ── SQL pipeline ─────────────────────────────────
    lines = lines.concat([
      "## SQL Pipeline",
      "",
      "1. **Concept Resolution:** Resolve concept descendants for each evidence row via `concept_ancestor` table.",
      "2. **Cohort Building:** Build cohort entry dates (t0) by combining entry evidence rows with match mode logic.",
      "3. **Index Anchoring:** Anchor each patient to a single index date (t0 + baseline offset, clamped to study start).",
      "4. **Single Window:** One baseline + outcome window per patient (no yearly repetition).",
      "5. **Censoring:** Apply first-outcome handling + observation period boundaries + study end boundary.",
      "6. **Exclusions:** Remove patients matching any exclusion criteria via NOT EXISTS.",
      "7. **Final Select:** Compute `outcome_label` and append covariates + confounder flags.",
      "",
      "## Output",
      "",
      "One row per `person_id` with:",
      "- Time-window columns (`baseline_start`, `baseline_end`, `outcome_start`, `outcome_end`)",
      "- `outcome_label` (0 = no event, 1 = event, NULL = censored)",
      "- Selected covariates: " + covariates,
      ""
    ]);

    // Debug notes
    if (config.debug) {
      lines = lines.concat([
        "## Debug Mode",
        "",
        "Debug mode is **enabled**: SQL uses step-by-step temp tables with row-count checkpoints.",
        "Run each step independently and inspect intermediate results to trace patient flow."
      ]);
    }

    return lines.join("\n");
  }

  // ---------------------------------------------------------------
  //  Plugin registration
  // ---------------------------------------------------------------

  var singleWindowMethodology = {
    id: "single-window",
    label: "Single window (one row per patient)",

    buildSQL: function (config) {
      if (config.debug) {
        return buildDebugSQL(config);
      }
      return buildProductionSQL(config);
    },

    describeRules: describeRules
  };

  if (typeof RapidML !== "undefined" && RapidML.Methodologies && RapidML.Methodologies.register) {
    RapidML.Methodologies.register(singleWindowMethodology);
  }

})();
