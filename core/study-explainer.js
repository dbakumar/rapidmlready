/**
 * ============================================================================
 * STUDY-EXPLAINER.JS  -  Plain-Language HTML Study Explainer Generator
 * ============================================================================
 *
 * PURPOSE:
 *   Generates a self-contained HTML file ("study_explainer.html") that
 *   explains the generated study to anyone — researchers, clinicians, and
 *   the general public — using simple language (5th-grade level) and
 *   interactive visualisations.
 *
 * WHAT IT PRODUCES:
 *   - What the research question is (plain English)
 *   - Who gets included in the study (cohort)
 *   - A visual spine diagram showing time windows built from actual config values
 *   - What the tool is looking for as an "outcome"
 *   - What extra medical facts are collected (covariates / confounders)
 *   - Who is excluded and why
 *   - A worked example patient timeline
 *
 * VISUALISATION:
 *   Uses Chart.js (loaded from CDN) for a horizontal bar / Gantt-style
 *   spine diagram.  No server or build step needed — fully self-contained.
 *
 * PUBLIC API:
 *   RapidML.StudyExplainer.buildHTML(config)  -> HTML string
 *
 * DEPENDS ON:  core/generator.js (RapidML namespace)
 * USED BY:     core/generator.js  generate() — added to downloaded zip
 * ============================================================================
 */

(function () {
  window.RapidML = window.RapidML || {};

  // -------------------------------------------------------------------------
  //  Helpers
  // -------------------------------------------------------------------------

  /**
   * Build a short, readable phrase for a single evidence row.
   * Uses the row label when present; otherwise derives a description from
   * type + conceptId + operator/value so "Condition #201826" is never shown
   * when the config actually captures richer information.
   *
   * Examples:
   *   diagnosis 201826 +descendants  → "diagnosis 201826 (and related)"
   *   lab 3020460 < 30               → "lab 3020460 < 30"
   *   drug 1503297                   → "drug 1503297"
   */
  function shortRowDesc(row) {
    if (!row) return "?";
    var type = (row.type || "diagnosis").toLowerCase();
    var cid  = row.conceptId || "?";

    // Prefer explicit label if provided and non-empty
    if (row.label && String(row.label).trim()) {
      var lbl = String(row.label).trim();
      if ((type === "lab" || type === "observation") && row.operator && row.value) {
        lbl += " " + row.operator + " " + row.value;
      }
      return lbl;
    }

    // Build description from type + concept + threshold
    var desc;
    if (type === "diagnosis") {
      desc = "diagnosis " + cid + (row.descendants ? " (and related)" : "");
    } else if (type === "lab") {
      desc = "lab " + cid;
      if (row.operator && row.value) desc += " " + row.operator + " " + row.value;
    } else if (type === "drug") {
      desc = "drug " + cid + (row.descendants ? " (and related)" : "");
    } else if (type === "procedure") {
      desc = "procedure " + cid;
    } else if (type === "observation") {
      desc = "observation " + cid;
      if (row.operator && row.value) desc += " " + row.operator + " " + row.value;
    } else if (type === "visit") {
      desc = "visit type " + cid;
    } else {
      desc = type + " " + cid;
    }

    var minCount = parseInt(row.minCount, 10) || 1;
    if (minCount > 1) {
      desc += " (≥" + minCount + (row.distinctVisits ? " visits" : "x") + ")";
    }
    return desc;
  }

  /**
   * Summarise an entire block (entry / outcome) as a short inline phrase,
   * joining all its rows with the correct connector word (AND / OR).
   * Used in the research question hero card and cohort flow section.
   *
   * Examples (entry block, match=all, 2 rows):
   *   "diagnosis 201826 (and related)  AND  lab 3020460 < 30"
   * Example (outcome block, match=all, 1 row):
   *   "lab 3020460 >= 30"
   */
  function blockSummary(block) {
    if (!block || !block.rows || !block.rows.length) return "no criteria defined";
    var connector = block.match === "any" ? " <em>OR</em> " : " <em>AND</em> ";
    return block.rows.map(shortRowDesc).join(connector);
  }

  /**
   * Plain-text (no HTML) version for use inside code blocks / markdown.
   */
  function blockSummaryText(block) {
    if (!block || !block.rows || !block.rows.length) return "no criteria defined";
    var connector = block.match === "any" ? " OR " : " AND ";
    return block.rows.map(shortRowDesc).join(connector);
  }

  /** Convenience wrappers kept for internal callers */
  function entryLabel(config) {
    return blockSummary(config.study && config.study.entry) || "the entry condition";
  }

  function outcomeLabel(config) {
    return blockSummary(config.study && config.study.outcome) || "the outcome condition";
  }

  /** Plain-text versions for use in ASCII diagrams / markdown */
  function entryLabelText(config) {
    return blockSummaryText(config.study && config.study.entry) || "the entry condition";
  }

  function outcomeLabelText(config) {
    return blockSummaryText(config.study && config.study.outcome) || "the outcome condition";
  }

  function pluralDays(n) {
    return n === 1 ? "1 day" : n + " days";
  }

  function pluralYears(n) {
    return n === 1 ? "1 year" : n + " years";
  }

  function studySpanYears(config) {
    return (Number(config.endYear) || 2024) - (Number(config.startYear) || 2016);
  }

  /**
   * Build a full plain-English sentence for a single evidence row.
   * Used in bullet-point evidence sections.
   */
  function plainRow(row) {
    var type = (row.type || "diagnosis").toLowerCase();
    var concept = (row.label && String(row.label).trim())
      ? String(row.label).trim()
      : "concept ID " + (row.conceptId || "?");
    var base = "";

    if (type === "diagnosis") base = "was diagnosed with " + concept;
    else if (type === "drug")  base = "was prescribed " + concept;
    else if (type === "lab") {
      base = "had a lab test for " + concept;
      if (row.operator && row.value)
        base += " with a result " + row.operator + " " + row.value;
    }
    else if (type === "procedure")   base = "had the procedure: " + concept;
    else if (type === "observation") {
      base = "had an observation recorded: " + concept;
      if (row.operator && row.value)
        base += " (value " + row.operator + " " + row.value + ")";
    }
    else if (type === "visit") base = "had a visit: " + concept;
    else base = type + ": " + concept;

    var minCount = parseInt(row.minCount, 10) || 1;
    if (minCount > 1) {
      base += " (at least " + minCount + (row.distinctVisits ? " separate visits" : " times") + ")";
    }
    if (row.descendants) base += " (or any related sub-type)";
    return base;
  }

  /** Describe all rows of a block in plain English (used in evidence cards) */
  function plainBlock(block) {
    if (!block || !block.rows || !block.rows.length) return "No criteria defined.";
    var mode = block.match === "any" ? "any of the following" : "all of the following";
    var strs = block.rows.map(function (r) { return "• The patient " + plainRow(r); });
    return "The patient must meet <strong>" + mode + "</strong>:<br>" + strs.join("<br>");
  }

  // -------------------------------------------------------------------------
  //  Spine diagram data builder
  //
  //  Builds 3 example patients to show how the time windows look, using the
  //  actual startYear / baselineDays / outcomeDays from config.
  // -------------------------------------------------------------------------

  function buildSpineData(config) {
    var startYear  = Number(config.startYear)  || 2016;
    var endYear    = Number(config.endYear)    || 2024;
    var baselineDays = Number(config.baselineDays) || 365;
    var outcomeDays  = Number(config.outcomeDays)  || 365;
    var isLong     = config.methodology !== "single-window";

    // Convert days to fractional years for display
    var baselineYrs = baselineDays / 365;
    var outcomeYrs  = outcomeDays  / 365;

    // Example patients — t0 relative to startYear in years
    var patients = [
      { name: "Patient A", t0Offset: 0.0, outcomeAt: null },   // no outcome
      { name: "Patient B", t0Offset: 0.5, outcomeAt: 2.8 },    // outcome in Window 2
      { name: "Patient C", t0Offset: 1.0, outcomeAt: null }    // no outcome
    ];

    var bars = [];   // { patient, label, start, end, color, type }
    var studySpan = endYear - startYear;

    patients.forEach(function (p) {
      var t0 = startYear + p.t0Offset;
      var firstIndex = t0 + baselineYrs;
      var windows = [];

      if (isLong) {
        // Longitudinal: add up to 3 windows per patient for clarity
        for (var n = 0; n < 3; n++) {
          var indexDate     = firstIndex + n * baselineYrs;
          var baselineStart = indexDate  - baselineYrs;
          var baselineEnd   = indexDate;
          var outcomeStart  = indexDate;
          var outcomeEnd    = indexDate + outcomeYrs;
          if (outcomeEnd > endYear) break;

          // Outcome censoring: skip windows starting after outcome
          var outcomeYr = p.outcomeAt ? (startYear + p.outcomeAt) : null;
          if (outcomeYr && outcomeStart >= outcomeYr) break;

          windows.push({ baselineStart: baselineStart, baselineEnd: baselineEnd,
                         outcomeStart: outcomeStart, outcomeEnd: outcomeEnd,
                         hasOutcome: !!(outcomeYr && outcomeYr >= outcomeStart && outcomeYr < outcomeEnd) });
        }
      } else {
        // Single window: exactly one window
        var baselineEnd   = firstIndex;
        var outcomeEnd    = firstIndex + outcomeYrs;
        windows.push({ baselineStart: t0, baselineEnd: baselineEnd,
                       outcomeStart: firstIndex, outcomeEnd: Math.min(outcomeEnd, endYear),
                       hasOutcome: !!(p.outcomeAt) });
      }

      windows.forEach(function (w, idx) {
        bars.push({ patient: p.name, window: idx + 1,
                    baselineStart: w.baselineStart, baselineEnd: w.baselineEnd,
                    outcomeStart: w.outcomeStart, outcomeEnd: w.outcomeEnd,
                    hasOutcome: w.hasOutcome,
                    outcomeAtYr: p.outcomeAt ? (startYear + p.outcomeAt) : null });
      });
    });

    return { patients: patients, bars: bars, startYear: startYear, endYear: endYear,
             baselineDays: baselineDays, outcomeDays: outcomeDays, isLong: isLong };
  }

  /** Serialize the spine data to a JSON string safe to embed in <script> */
  function safeJSON(obj) {
    return JSON.stringify(obj).replace(/</g, "\\u003c").replace(/>/g, "\\u003e");
  }

  // -------------------------------------------------------------------------
  //  Evidence section HTML
  // -------------------------------------------------------------------------

  function htmlEvidenceSection(title, icon, block, emptyMsg) {
    if (!block || !block.rows || !block.rows.length) {
      return '<div class="card">' +
        '<h3>' + title + '</h3>' +
        '<p class="muted">' + emptyMsg + '</p></div>';
    }
    var mode = block.match === "any"
      ? '<span class="badge badge-any">ANY one of these</span>'
      : '<span class="badge badge-all">ALL of these</span>';
    var items = block.rows.map(function (r) {
      return '<li>' + plainRow(r) + '</li>';
    }).join("");
    return '<div class="card">' +
      '<h3>' + title + '</h3>' +
      '<p>Match mode: ' + mode + '</p>' +
      '<ul>' + items + '</ul></div>';
  }

  function htmlExclusionSection(excl) {
    if (!excl || !excl.length) return "";
    var items = excl.map(function (r) {
      return '<li>' + plainRow(r) + '</li>';
    }).join("");
    return '<div class="card card-warn">' +
      '<h3>Who Is Left Out?</h3>' +
      '<p>Some patients are <strong>excluded</strong> before the study starts. ' +
      'These patients are left out so the results stay fair:</p>' +
      '<ul>' + items + '</ul></div>';
  }

  function htmlConfounderSection(conf) {
    if (!conf || !conf.length) return "";
    var items = conf.map(function (r) {
      return '<li><strong>' + (r.label || r.type + " " + (r.conceptId || "")) + '</strong> — ' +
        'recorded as a yes/no flag in the dataset</li>';
    }).join("");
    return '<div class="card">' +
      '<h3>Extra Medical Facts Collected (Confounders)</h3>' +
      '<p>These are extra facts that might influence the result. ' +
      'The computer tracks them so the math can account for them:</p>' +
      '<ul>' + items + '</ul></div>';
  }

  function htmlCovariateSection(config) {
    var covs = (config.covariates || []);
    var custom = (config.customCovariates || []);
    if (!covs.length && !custom.length) return "";
    var LABELS = {
      age_at_index: "Age at the study date",
      sex_concept_id: "Sex (male / female / other)",
      baseline_condition_count: "How many different diagnoses in the look-back period",
      baseline_drug_count: "How many different medicines in the look-back period",
      baseline_visit_count: "How many doctor visits in the look-back period",
      baseline_measurement_count: "How many lab tests in the look-back period"
    };
    var items = covs.map(function (c) {
      return '<li>' + (LABELS[c] || c) + '</li>';
    }).join("");
    custom.forEach(function (c) {
      items += '<li>Custom: ' + (c.label || c.conceptId || c) + '</li>';
    });
    return '<div class="card">' +
      '<h3>Features Used to Predict (Covariates)</h3>' +
      '<p>These are the medical facts the computer uses to learn patterns and make predictions:</p>' +
      '<ul>' + items + '</ul>' +
      '<p class="muted">Encoding method: <strong>' + (config.covariateEncoding || "count") + '</strong></p></div>';
  }

  // -------------------------------------------------------------------------
  //  Plain-English research question block
  // -------------------------------------------------------------------------

  function htmlResearchQuestion(config) {
    var entryBlock   = config.study && config.study.entry;
    var outcomeBlock = config.study && config.study.outcome;
    var entryRows    = entryBlock   && entryBlock.rows   || [];
    var outcomeRows  = outcomeBlock && outcomeBlock.rows || [];
    var span    = studySpanYears(config);
    var bl      = pluralDays(Number(config.baselineDays) || 365);
    var oc      = pluralDays(Number(config.outcomeDays)  || 365);
    var isLong  = config.methodology !== "single-window";

    // Build a precise, multi-row aware research question
    var entryConnector  = entryBlock  && entryBlock.match  === "any" ? " <em>or</em> " : " <em>and</em> ";
    var outcomeConnector = outcomeBlock && outcomeBlock.match === "any" ? " <em>or</em> " : " <em>and</em> ";
    var entryDesc   = entryRows.length
      ? entryRows.map(function (r) { return "<strong>" + shortRowDesc(r) + "</strong>"; }).join(entryConnector)
      : "<strong>the entry condition</strong>";
    var outcomeDesc = outcomeRows.length
      ? outcomeRows.map(function (r) { return "<strong>" + shortRowDesc(r) + "</strong>"; }).join(outcomeConnector)
      : "<strong>the outcome condition</strong>";

    // Summarise what the entry criteria mean in one sentence
    var entrySentence = entryRows.length > 1
      ? 'patients who meet <strong>all ' + entryRows.length + ' entry criteria</strong> ('
        + entryRows.map(shortRowDesc).join(" AND ") + ')'
      : 'patients with ' + entryDesc;

    var q = '"Among ' + entrySentence + ', who went on to have ' + outcomeDesc + '?"';

    var how = isLong
      ? 'For each qualifying patient, the computer checks every year they were in the study ' +
        '(from ' + config.startYear + ' to ' + config.endYear + '). ' +
        'Each year counts as a separate check window.'
      : 'Each qualifying patient is checked once — using their first qualifying event date.';

    return '<div class="card card-hero">' +
      '<h2>What Is This Study Asking?</h2>' +
      '<p class="question">' + q + '</p>' +
      '<p>The study covers <strong>' + span + ' years</strong> ' +
      '(' + config.startYear + '\u2013' + config.endYear + '). ' + how + '</p>' +
      '<p>For each time window the computer uses <strong>' + bl +
      '</strong> of past medical history to predict whether <strong>' +
      outcomeDesc + '</strong> happens in the next <strong>' + oc + '</strong>.</p>' +
      (entryRows.length > 1
        ? '<div class="entry-pills"><span class="pill-label">Entry requires ALL of:</span>' +
          entryRows.map(function (r) {
            return '<span class="pill pill-entry">' + shortRowDesc(r) + '</span>';
          }).join('<span class="pill-connector">AND</span>') +
          '</div>'
        : '') +
      (outcomeRows.length > 0
        ? '<div class="entry-pills"><span class="pill-label">Outcome ' +
          (outcomeBlock.match === "any" ? '(any of):' : '(all of):') + '</span>' +
          outcomeRows.map(function (r) {
            return '<span class="pill pill-outcome">' + shortRowDesc(r) + '</span>';
          }).join('<span class="pill-connector">' + (outcomeBlock.match === "any" ? 'OR' : 'AND') + '</span>') +
          '</div>'
        : '') +
      '</div>';
  }

  // -------------------------------------------------------------------------
  //  Cohort flow plain-English summary
  // -------------------------------------------------------------------------

  function htmlCohortFlow(config) {
    var entryBlock   = config.study && config.study.entry;
    var outcomeBlock = config.study && config.study.outcome;
    var excl         = config.study && config.study.exclusions;
    var confounders  = config.study && config.study.confounders;

    // Build entry summary as a short multi-row list if needed
    var entryRows   = entryBlock   && entryBlock.rows   || [];
    var outcomeRows = outcomeBlock && outcomeBlock.rows || [];
    var entryHtml   = entryRows.length > 1
      ? 'patients who meet <em>all</em> of: ' +
        entryRows.map(function (r) { return '<strong>' + shortRowDesc(r) + '</strong>'; }).join(' AND ')
      : entryRows.length === 1
        ? 'patients with <strong>' + shortRowDesc(entryRows[0]) + '</strong>'
        : '<strong>the entry condition</strong>';
    var outcomeHtml = outcomeRows.length
      ? outcomeRows.map(function (r) { return '<em>' + shortRowDesc(r) + '</em>'; })
          .join(outcomeBlock && outcomeBlock.match === 'any' ? ' OR ' : ' AND ')
      : '<em>the outcome condition</em>';

    var steps = [
      '<li><strong>Step 1 — Find the group (cohort):</strong> ' +
        'We start with all ' + entryHtml + ' in the database ' +
        'at some point during the study period (' + config.startYear + '–' + config.endYear + ').</li>',
      excl && excl.length
        ? '<li><strong>Step 2 — Remove some patients:</strong> ' +
          excl.length + ' group(s) of patients are excluded from the start ' +
          'to keep the study fair (for example, patients already diagnosed with the outcome).</li>'
        : '<li><strong>Step 2 — No exclusions:</strong> All entry-qualifying patients are kept.</li>',
      '<li><strong>Step 3 — Set up look-back and look-forward windows:</strong> ' +
        'For each patient we define a <em>look-back window</em> (past ' +
        pluralDays(Number(config.baselineDays) || 365) + ') and a ' +
        '<em>look-forward window</em> (next ' +
        pluralDays(Number(config.outcomeDays) || 365) + ').</li>',
      '<li><strong>Step 4 — Measure the outcome:</strong> ' +
        'Did the patient have ' + outcomeHtml + ' during the look-forward window? ' +
        'If yes → <strong>label = 1</strong>. If no → <strong>label = 0</strong>.</li>',
      '<li><strong>Step 5 — Collect features:</strong> ' +
        'From the look-back window, the computer collects medical facts (age, visit counts, lab results, etc.) ' +
        'that may help predict the outcome.</li>',
      confounders && confounders.length
        ? '<li><strong>Step 6 — Record confounders:</strong> ' +
          confounders.length + ' extra yes/no medical flags are added to make sure ' +
          'the model does not confuse them with the true predictors.</li>'
        : ''
    ].filter(Boolean);

    return '<div class="card">' +
      '<h2>How the Study Works — Step by Step</h2>' +
      '<ol>' + steps.join("") + '</ol></div>';
  }

  // -------------------------------------------------------------------------
  //  Worked example patient timeline (text-based)
  // -------------------------------------------------------------------------

  function htmlWorkedExample(config) {
    var isLong  = config.methodology !== "single-window";
    var entry   = entryLabel(config);
    var outcome = outcomeLabel(config);
    var bl      = Number(config.baselineDays) || 365;
    var oc      = Number(config.outcomeDays)  || 365;
    var sy      = Number(config.startYear)    || 2016;

    var t0     = "Jan 1, " + sy;
    var idx    = "Jan 1, " + (sy + Math.round(bl / 365));
    var oEnd   = "Jan 1, " + (sy + Math.round((bl + oc) / 365));

    var example = isLong
      ? '<p><strong>Example (Longitudinal):</strong></p>' +
        '<p>Alice is first diagnosed with <em>' + entry + '</em> on ' + t0 + '.<br>' +
        'Window 1: Look-back runs from ' + t0 + ' to ' + idx + '. ' +
        'Look-forward runs from ' + idx + ' to ' + oEnd + '. ' +
        'If Alice develops <em>' + outcome + '</em> before ' + oEnd + ', she gets label = 1.<br>' +
        'Window 2 starts one step later and checks the next year, and so on until ' + config.endYear + '.</p>'
      : '<p><strong>Example (Single Window):</strong></p>' +
        '<p>Alice is first diagnosed with <em>' + entry + '</em> on ' + t0 + '.<br>' +
        'Alice gets exactly one row. Look-back: ' + t0 + ' to ' + idx + '. ' +
        'Look-forward: ' + idx + ' to ' + oEnd + '. ' +
        'If Alice develops <em>' + outcome + '</em> before ' + oEnd + ', she gets label = 1.</p>';

    return '<div class="card">' +
      '<h2>A Worked Example</h2>' + example + '</div>';
  }

  // -------------------------------------------------------------------------
  //  Full HTML page builder
  // -------------------------------------------------------------------------

  function buildHTML(config) {
    var spineData   = buildSpineData(config);
    var isLong      = config.methodology !== "single-window";
    // Plain-text versions for title / h1 / <title> tag (no embedded HTML)
    var entryTxt    = entryLabelText(config);
    var outcomeTxt  = outcomeLabelText(config);
    var methodLabel = isLong
      ? "Longitudinal (yearly windows)"
      : "Single window (one row per patient)";
    var excl   = config.study && config.study.exclusions;
    var conf   = config.study && config.study.confounders;

    /* ------------------------------------------------------------------
       Chart.js dataset — horizontal Gantt bars for the spine diagram
    ------------------------------------------------------------------ */
    // Per-patient color scheme for clear visual distinction
    var PATIENT_COLORS = {
      "Patient A": { baseline: "rgba(59,130,246,0.8)",  baselineBorder: "rgba(37,99,235,1)",
                     outcome:  "rgba(147,197,253,0.8)", outcomeBorder:  "rgba(59,130,246,1)" },
      "Patient B": { baseline: "rgba(139,92,246,0.8)",  baselineBorder: "rgba(109,40,217,1)",
                     outcome:  "rgba(196,181,253,0.8)", outcomeBorder:  "rgba(139,92,246,1)" },
      "Patient C": { baseline: "rgba(245,158,11,0.8)",  baselineBorder: "rgba(217,119,6,1)",
                     outcome:  "rgba(253,230,138,0.8)", outcomeBorder:  "rgba(245,158,11,1)" }
    };

    // Build Y labels (patient × window rows)
    var yLabels = [];
    var baselineData = [];
    var outcomeData  = [];
    var gapData      = [];    // invisible spacer from study start to baseline_start
    var outcomeMarkers = [];  // individual point markers for actual outcomes
    var baselineColors = [];
    var baselineBorderColors = [];
    var outcomeColors = [];
    var outcomeBorderColors = [];

    spineData.bars.forEach(function (b) {
      var lbl = isLong
        ? b.patient + " — Window " + b.window
        : b.patient;
      yLabels.push(lbl);

      // Offset from startYear in fractional years
      var gapLen      = b.baselineStart  - spineData.startYear;
      var baselineLen = b.baselineEnd    - b.baselineStart;
      var outcomeLen  = b.outcomeEnd     - b.outcomeStart;

      gapData.push(gapLen);
      baselineData.push(baselineLen);
      outcomeData.push(outcomeLen);

      // Per-patient colors
      var pc = PATIENT_COLORS[b.patient] || PATIENT_COLORS["Patient A"];
      baselineColors.push(pc.baseline);
      baselineBorderColors.push(pc.baselineBorder);
      outcomeColors.push(pc.outcome);
      outcomeBorderColors.push(pc.outcomeBorder);

      if (b.hasOutcome && b.outcomeAtYr) {
        outcomeMarkers.push({
          x: b.outcomeAtYr - spineData.startYear,
          y: yLabels.length - 1
        });
      }
    });

    // Compute the actual data extent so x-axis scales to the bars,
    // not the full study span (important when windows are short, e.g. 90 days).
    var chartMax = 0;
    for (var ci = 0; ci < gapData.length; ci++) {
      chartMax = Math.max(chartMax, gapData[ci] + baselineData[ci] + outcomeData[ci]);
    }
    chartMax = Math.max(Math.ceil(chartMax * 1.08 * 10) / 10, 1);

    var chartConfig = {
      yLabels: yLabels,
      gapData: gapData,
      baselineData: baselineData,
      outcomeData: outcomeData,
      baselineColors: baselineColors,
      baselineBorderColors: baselineBorderColors,
      outcomeColors: outcomeColors,
      outcomeBorderColors: outcomeBorderColors,
      outcomeMarkers: outcomeMarkers,
      startYear: spineData.startYear,
      endYear: spineData.endYear,
      studySpan: spineData.endYear - spineData.startYear,
      chartMax: chartMax
    };

    /* ------------------------------------------------------------------
       HTML template
    ------------------------------------------------------------------ */
    return '<!DOCTYPE html>\n<html lang="en">\n<head>\n' +
      '<meta charset="UTF-8">\n' +
      '<meta name="viewport" content="width=device-width, initial-scale=1.0">\n' +
      '<title>Study Explainer — ' + entryTxt + ' → ' + outcomeTxt + '</title>\n' +
      '<script src="https://cdn.jsdelivr.net/npm/chart.js@4.4.2/dist/chart.umd.min.js"></script>\n' +
      '<style>\n' + buildCSS() + '\n</style>\n' +
      '</head>\n<body>\n' +

      // ── Hero banner ──
      '<header>\n' +
      '<div class="banner">\n' +
      '<div class="banner-inner">\n' +
      '<div class="banner-logo">RapidML Ready</div>\n' +
      '<h1>' + entryTxt + ' <span class="arrow">→</span> ' + outcomeTxt + '</h1>\n' +
      '<p class="banner-sub">A plain-language guide to this research study</p>\n' +
      '<div class="badges">' +
      '<span class="chip">' + config.startYear + '–' + config.endYear + '</span>' +
      '<span class="chip">' + methodLabel + '</span>' +
      '<span class="chip">' + (config.db || "postgres") + ' · ' + (config.schema || "cdm") + '</span>' +
      '</div>\n' +
      '</div>\n</div>\n</header>\n\n' +

      '<main class="container">\n' +

      // ── Research question ──
      htmlResearchQuestion(config) + '\n' +

      // ── Step by step ──
      htmlCohortFlow(config) + '\n' +

      // ── Spine visualizer ──
      '<div class="card">' +
      '<h2>📅 Patient Time Windows — Visual Spine Diagram</h2>' +
      '<div class="spine-legend">' +
        '<div class="legend-item">' +
          '<span class="legend-swatch swatch-patient-a"></span>' +
          '<div><strong>Patient A</strong> (blue) — No outcome. All windows get <span class="label-no">label = 0</span>.</div>' +
        '</div>' +
        '<div class="legend-item">' +
          '<span class="legend-swatch swatch-patient-b"></span>' +
          '<div><strong>Patient B</strong> (purple) — Outcome occurs in Window 2. That row gets <span class="label-yes">label = 1</span>. ' +
          'Later windows are removed (censored).</div>' +
        '</div>' +
        '<div class="legend-item">' +
          '<span class="legend-swatch swatch-patient-c"></span>' +
          '<div><strong>Patient C</strong> (amber) — No outcome. All windows get <span class="label-no">label = 0</span>.</div>' +
        '</div>' +
        '<div class="legend-item">' +
          '<span class="legend-swatch swatch-dot"></span>' +
          '<div><strong>Red dot — Outcome event detected</strong><br>' +
          'The approximate date the outcome was first recorded. That row gets <span class="label-yes">label = 1</span>. ' +
          'All later windows for that patient are removed.</div>' +
        '</div>' +
      '</div>' +
      '<p class="muted" style="margin-bottom:0.5rem">' +
        'Darker bars = <strong>look-back (baseline)</strong> window (' + pluralDays(Number(config.baselineDays) || 365) + '). ' +
        'Lighter bars = <strong>look-forward (outcome)</strong> window (' + pluralDays(Number(config.outcomeDays) || 365) + ').</p>' +
      '<div class="chart-wrap"><canvas id="spineChart"></canvas></div>' +
      '<div class="outcome-callout">' +
        '<span class="callout-icon"></span>' +
        '<div>' +
          '<strong>How to read this chart:</strong><br>' +
          'Each row is one time window for a patient. ' +
          'The darker bar shows the look-back period (medical history collected). ' +
          'The lighter bar shows the look-forward period (where we check for the outcome).<br><br>' +
          '<strong>Patient B — Window 2</strong> has a <span class="label-yes">red dot</span> in its lighter bar. This means:<br>' +
          '① The outcome event was recorded during Window 2\'s look-forward period.<br>' +
          '② That row is saved with <span class="label-yes">label = 1</span>.<br>' +
          '③ No Window 3 appears for Patient B — the patient is censored after the outcome.<br>' +
          'Patient A and Patient C have no red dots — all their rows are <span class="label-no">label = 0</span>.' +
        '</div>' +
      '</div>' +
      '</div>\n\n' +

      // ── Evidence blocks ──
      htmlEvidenceSection("Who Gets Into the Study? (Entry Criteria)", "",
        config.study && config.study.entry,
        "No entry criteria were configured.") + '\n' +

      htmlEvidenceSection("What Are We Trying to Predict? (Outcome)", "",
        config.study && config.study.outcome,
        "No outcome criteria were configured.") + '\n' +

      htmlExclusionSection(excl) + '\n' +
      htmlConfounderSection(conf) + '\n' +
      htmlCovariateSection(config) + '\n' +

      // ── Worked example ──
      htmlWorkedExample(config) + '\n' +

      // ── Data flow diagram ──
      '<div class="card">\n' +
      '<h2>How the Data Flows</h2>\n' +
      '<div class="flow">' + buildFlowDiagram(config) + '</div>\n' +
      '</div>\n\n' +

      // ── Footer ──
      '<div class="card card-footer">\n' +
      '<h3>Generated by RapidML Ready</h3>\n' +
      '<p>This explainer was automatically generated from your study configuration. ' +
      'Methodology: <strong>' + methodLabel + '</strong>. ' +
      'Analysis template: <strong>' + (config.analysisTemplate || "logistic-regression") + '</strong>.</p>\n' +
      '<p class="muted">For technical details see <code>study.sql</code> and <code>README.md</code> ' +
      'in this package.</p>\n' +
      '</div>\n\n' +

      '</main>\n\n' +

      // ── Chart.js inline script ──
      '<script>\n' +
      '(function() {\n' +
      '  var C = ' + safeJSON(chartConfig) + ';\n' +
      buildChartScript() +
      '})();\n' +
      '</script>\n' +
      '</body>\n</html>';
  }

  // -------------------------------------------------------------------------
  //  Flow diagram (pure HTML/CSS, no JS needed)
  // -------------------------------------------------------------------------

  function buildFlowDiagram(config) {
    var isLong = config.methodology !== "single-window";
    var steps = [
      { label: "All Patients<br>in Database" },
      { label: "Entry Criteria<br>Filter" },
      { label: "Exclusions<br>Removed",
        skip: !config.study || !config.study.exclusions || !config.study.exclusions.length },
      { label: isLong ? "Yearly Windows<br>Generated" : "Single Window<br>Per Patient" },
      { label: "Censoring<br>Applied" },
      { label: "Outcome<br>Measured" },
      { label: "Features<br>Collected" },
      { label: "ML Model<br>Trained" }
    ];
    return steps.filter(function (s) { return !s.skip; }).map(function (s, i, arr) {
      var arrow = i < arr.length - 1 ? '<span class="flow-arrow">&#8594;</span>' : '';
      return '<div class="flow-step"><div class="flow-icon">' + (i + 1) + '</div>' +
             '<div class="flow-label">' + s.label + '</div></div>' + arrow;
    }).join("");
  }

  // -------------------------------------------------------------------------
  //  Chart.js rendering script (embedded in the HTML output)
  // -------------------------------------------------------------------------

  function buildChartScript() {
    return [
      '  var ctx = document.getElementById("spineChart").getContext("2d");',
      '  var barCount = C.yLabels.length;',
      '  var height   = Math.max(320, barCount * 48 + 100);',
      '  ctx.canvas.parentNode.style.height = height + "px";',
      '',
      '  // ── Inline Chart.js plugin: draw red circles for outcome events ──────',
      '  // afterDraw fires after every chart render. We convert each marker\'s',
      '  // data-space (x = fractional years, y = row index) to canvas pixels',
      '  // using the chart\'s built-in scale helpers, then draw a red circle.',
      '  var outcomeMarkerPlugin = {',
      '    id: "outcomeMarkerPlugin",',
      '    afterDraw: function(chart) {',
      '      if (!C.outcomeMarkers || !C.outcomeMarkers.length) return;',
      '      var c   = chart.ctx;',
      '      var xSc = chart.scales.x;',
      '      var ySc = chart.scales.y;',
      '      C.outcomeMarkers.forEach(function(m) {',
      '        // m.x = years from study start  (maps to the stacked x-axis)',
      '        // m.y = 0-based row index        (maps to the categorical y-axis)',
      '        var xPx = xSc.getPixelForValue(m.x);',
      '        var yPx = ySc.getPixelForValue(m.y);',
      '        c.save();',
      '        // 1. White halo so the dot stands out on blue/green bars',
      '        c.beginPath();',
      '        c.arc(xPx, yPx, 9, 0, 2 * Math.PI);',
      '        c.fillStyle = "rgba(255,255,255,0.9)";',
      '        c.fill();',
      '        // 2. Red filled circle',
      '        c.beginPath();',
      '        c.arc(xPx, yPx, 7, 0, 2 * Math.PI);',
      '        c.fillStyle = "rgba(220,38,38,0.92)";',
      '        c.fill();',
      '        // 3. Thin white border',
      '        c.strokeStyle = "#fff";',
      '        c.lineWidth = 1.5;',
      '        c.stroke();',
      '        // 4. Small white crosshair to distinguish from a plain dot',
      '        c.beginPath();',
      '        c.moveTo(xPx, yPx - 3.5);',
      '        c.lineTo(xPx, yPx + 3.5);',
      '        c.moveTo(xPx - 3.5, yPx);',
      '        c.lineTo(xPx + 3.5, yPx);',
      '        c.strokeStyle = "rgba(255,255,255,0.8)";',
      '        c.lineWidth = 1.2;',
      '        c.stroke();',
      '        c.restore();',
      '      });',
      '    }',
      '  };',
      '',
      '  // ── Stacked horizontal bar chart ─────────────────────────────────────',
      '  // Stack order: gap (invisible spacer) → baseline (colored) → outcome (lighter)',
      '  // Each patient has a unique color. A scatter dataset adds a red-dot legend entry.',
      '  new Chart(ctx, {',
      '    type: "bar",',
      '    data: {',
      '      labels: C.yLabels,',
      '      datasets: [',
      '        {',
      '          label: "Gap (hidden)",',
      '          data: C.gapData,',
      '          backgroundColor: "rgba(0,0,0,0)",',
      '          borderWidth: 0,',
      '          stack: "spine"',
      '        },',
      '        {',
      '          label: "Baseline (look-back)",',
      '          data: C.baselineData,',
      '          backgroundColor: C.baselineColors,',
      '          borderColor: C.baselineBorderColors,',
      '          borderWidth: 1.5,',
      '          stack: "spine",',
      '          borderRadius: 4',
      '        },',
      '        {',
      '          label: "Outcome window (look-forward)",',
      '          data: C.outcomeData,',
      '          backgroundColor: C.outcomeColors,',
      '          borderColor: C.outcomeBorderColors,',
      '          borderWidth: 1.5,',
      '          stack: "spine",',
      '          borderRadius: 4',
      '        },',
      '        {',
      '          label: "Outcome event (red dot = label 1)",',
      '          data: [],',
      '          backgroundColor: "rgba(220,38,38,0.92)",',
      '          type: "scatter",',
      '          pointStyle: "circle",',
      '          pointRadius: 7',
      '        }',
      '      ]',
      '    },',
      '    options: {',
      '      indexAxis: "y",',
      '      responsive: true,',
      '      maintainAspectRatio: false,',
      '      plugins: {',
      '        legend: {',
      '          display: true,',
      '          labels: {',
      '            filter: function(item) { return item.text !== "Gap (hidden)"; },',
      '            generateLabels: function(chart) {',
      '              // Custom legend: show per-patient color boxes + red dot',
      '              return [',
      '                { text: "Patient A (baseline / outcome)", fillStyle: "rgba(59,130,246,0.8)", strokeStyle: "rgba(37,99,235,1)", lineWidth: 1.5 },',
      '                { text: "Patient B (baseline / outcome)", fillStyle: "rgba(139,92,246,0.8)", strokeStyle: "rgba(109,40,217,1)", lineWidth: 1.5 },',
      '                { text: "Patient C (baseline / outcome)", fillStyle: "rgba(245,158,11,0.8)", strokeStyle: "rgba(217,119,6,1)", lineWidth: 1.5 },',
      '                { text: "Outcome event (red dot)", fillStyle: "rgba(220,38,38,0.92)", strokeStyle: "rgba(220,38,38,1)", lineWidth: 0, pointStyle: "circle" }',
      '              ];',
      '            }',
      '          }',
      '        },',
      '        tooltip: {',
      '          callbacks: {',
      '            label: function(ctx) {',
      '              if (ctx.dataset.label === "Gap (hidden)") return null;',
      '              if (ctx.dataset.label.indexOf("Outcome event") === 0) return null;',
      '              var val = ctx.parsed.x;',
      '              var yr  = Math.round(val * 10) / 10;',
      '              return ctx.dataset.label + ": " + yr + " years";',
      '            }',
      '          }',
      '        }',
      '      },',
      '      scales: {',
      '        x: {',
      '          stacked: true,',
      '          min: 0,',
      '          max: C.chartMax,',
      '          title: {',
      '            display: true,',
      '            text: "Years from Study Start (" + C.startYear + ")"',
      '          },',
      '          ticks: {',
      '            callback: function(value) {',
      '              return C.startYear + (value > 0 ? "+" + value : "");',
      '            }',
      '          }',
      '        },',
      '        y: {',
      '          stacked: true,',
      '          ticks: { font: { weight: "bold" } }',
      '        }',
      '      }',
      '    },',
      '    plugins: [outcomeMarkerPlugin]',
      '  });',
    ].join("\n");
  }

  // -------------------------------------------------------------------------
  //  CSS
  // -------------------------------------------------------------------------

  function buildCSS() {
    return [
      '  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }',
      '  body { font-family: "Segoe UI", system-ui, sans-serif; background: #f8fafc; color: #1e293b; line-height: 1.6; }',
      '  a { color: #2563eb; }',
      '',
      '  /* Banner */',
      '  .banner { background: linear-gradient(135deg, #1e3a5f 0%, #2563eb 100%); color: #fff; padding: 2.5rem 1.5rem; }',
      '  .banner-inner { max-width: 960px; margin: 0 auto; }',
      '  .banner-logo { font-size: 0.8rem; letter-spacing: 0.15em; text-transform: uppercase; opacity: 0.75; margin-bottom: 0.5rem; }',
      '  .banner h1 { font-size: clamp(1.4rem, 4vw, 2.2rem); font-weight: 700; margin-bottom: 0.4rem; }',
      '  .banner-sub { opacity: 0.85; margin-bottom: 0.8rem; }',
      '  .arrow { color: #93c5fd; }',
      '  .badges { display: flex; flex-wrap: wrap; gap: 0.4rem; }',
      '  .chip { background: rgba(255,255,255,0.18); border: 1px solid rgba(255,255,255,0.3); border-radius: 999px; padding: 0.2rem 0.7rem; font-size: 0.78rem; }',
      '',
      '  /* Layout */',
      '  .container { max-width: 960px; margin: 0 auto; padding: 1.5rem 1rem 3rem; display: flex; flex-direction: column; gap: 1.25rem; }',
      '',
      '  /* Cards */',
      '  .card { background: #fff; border: 1px solid #e2e8f0; border-radius: 10px; padding: 1.5rem; box-shadow: 0 1px 3px rgba(0,0,0,0.06); }',
      '  .card-hero { border-left: 5px solid #2563eb; background: #eff6ff; }',
      '  .card-warn { border-left: 5px solid #f59e0b; background: #fffbeb; }',
      '  .card-footer { background: #f1f5f9; }',
      '',
      '  /* Typography */',
      '  .card h2 { font-size: 1.15rem; font-weight: 700; margin-bottom: 0.75rem; color: #0f172a; }',
      '  .card h3 { font-size: 1rem; font-weight: 600; margin-bottom: 0.6rem; color: #0f172a; }',
      '  .card p, .card li { font-size: 0.97rem; margin-bottom: 0.4rem; }',
      '  .card ul, .card ol { padding-left: 1.4rem; margin-top: 0.4rem; }',
      '  .card li { margin-bottom: 0.3rem; }',
      '  .muted { color: #64748b; font-size: 0.88rem; }',
      '  .question { font-size: 1.1rem; font-weight: 600; color: #1e40af; margin: 0.5rem 0 1rem; }',
      '  code { background: #f1f5f9; border-radius: 4px; padding: 0 4px; font-family: monospace; font-size: 0.88em; }',
      '',
      '  /* Badges */',
      '  .badge { display: inline-block; border-radius: 999px; padding: 0.15rem 0.6rem; font-size: 0.8rem; font-weight: 600; }',
      '  .badge-any { background: #fef3c7; color: #92400e; }',
      '  .badge-all { background: #dbeafe; color: #1e40af; }',
      '',
      '  /* Legend */',
      '  .legend-baseline { color: #2563eb; font-weight: 600; }',
      '  .legend-outcome  { color: #16a34a; font-weight: 600; }',
      '',
      '  /* Chart */',
      '  .chart-wrap { position: relative; width: 100%; min-height: 200px; }',
      '',
      '  /* Flow diagram */',
      '  .flow { display: flex; flex-wrap: wrap; align-items: center; gap: 0; margin-top: 0.5rem; }',
      '  .flow-step { display: flex; flex-direction: column; align-items: center; width: 90px; text-align: center; }',
      '  .flow-icon { width: 32px; height: 32px; border-radius: 50%; background: #2563eb; color: #fff; font-size: 0.85rem; font-weight: 700; display: flex; align-items: center; justify-content: center; margin: 0 auto 0.3rem; flex-shrink: 0; }',
      '  .flow-label { font-size: 0.72rem; color: #374151; line-height: 1.3; }',
      '  .flow-arrow { font-size: 1.4rem; color: #94a3b8; padding: 0 2px; margin-bottom: 1.2rem; }',
      '  /* Spine diagram legend */',
      '  .spine-legend { display: flex; flex-direction: column; gap: 0.7rem; margin-bottom: 1rem; }',
      '  .legend-item { display: flex; align-items: flex-start; gap: 0.75rem; font-size: 0.9rem; line-height: 1.4; }',
      '  .legend-swatch { flex-shrink: 0; width: 28px; height: 18px; border-radius: 4px; margin-top: 2px; display: flex; align-items: center; justify-content: center; font-size: 1rem; font-weight: 700; }',
      '  .swatch-patient-a { background: rgba(59,130,246,0.8); border: 1px solid rgba(37,99,235,1); }',
      '  .swatch-patient-b { background: rgba(139,92,246,0.8); border: 1px solid rgba(109,40,217,1); }',
      '  .swatch-patient-c { background: rgba(245,158,11,0.8); border: 1px solid rgba(217,119,6,1); }',
      '  .swatch-dot      { background: rgba(220,38,38,0.92); width: 14px; height: 14px; border-radius: 50%; margin-top: 4px; flex-shrink: 0; }',
      '  .label-yes { color: #166534; font-weight: 700; }',
      '  .label-no  { color: #6b7280; font-weight: 700; }',
      '  /* Outcome callout below chart */',
      '  .outcome-callout { display: flex; align-items: flex-start; gap: 0.75rem; background: #fef2f2; border: 1px solid #fecaca; border-radius: 8px; padding: 0.85rem 1rem; margin-top: 1rem; font-size: 0.9rem; line-height: 1.5; }',
      '  .callout-icon { flex-shrink: 0; width: 20px; height: 20px; border-radius: 50%; background: #f59e0b; color: #fff; font-size: 0.75rem; font-weight: 700; display: flex; align-items: center; justify-content: center; margin-top: 2px; }',
      '  .callout-icon::before { content: "i"; font-style: italic; }',
      '',
      '  /* Entry / outcome pills in hero card */',
      '  .entry-pills { display: flex; flex-wrap: wrap; align-items: center; gap: 0.35rem; margin-top: 0.9rem; }',
      '  .pill-label { font-size: 0.78rem; font-weight: 600; color: #475569; margin-right: 0.2rem; white-space: nowrap; }',
      '  .pill { border-radius: 999px; padding: 0.25rem 0.75rem; font-size: 0.82rem; font-weight: 600; white-space: nowrap; }',
      '  .pill-entry   { background: #dbeafe; color: #1e40af; border: 1px solid #bfdbfe; }',
      '  .pill-outcome { background: #dcfce7; color: #166534; border: 1px solid #bbf7d0; }',
      '  .pill-connector { font-size: 0.72rem; font-weight: 700; color: #64748b; padding: 0 0.1rem; }',
      '',
      '  @media (max-width: 600px) {',
      '    .flow-step { width: 70px; }',
      '    .flow-icon { width: 26px; height: 26px; font-size: 0.75rem; }',
      '    .flow-label { font-size: 0.65rem; }',
      '  }'
    ].join("\n");
  }

  // -------------------------------------------------------------------------
  //  Public API
  // -------------------------------------------------------------------------

  RapidML.StudyExplainer = {
    buildHTML: buildHTML
  };

})();
