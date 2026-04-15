/**
 * wizard-ui.js — Wizard UI Controller (3-panel EHR layout)
 *
 * This file contains ALL the browser-side UI logic for the Rapid ML-Ready
 * Wizard (index.html). It drives a 3-panel layout:
 *   LEFT   — vertical step tabs (sidebar navigation)
 *   CENTER — one wizard section visible at a time
 *   RIGHT  — OMOP concept ID reference (always-visible sidebar)
 *
 * It depends on the RapidML global namespace being set up by:
 *   core/generator.js   → RapidML.Methodologies, RapidML.AnalysisTemplates, getFormConfig(), generate()
 *   rules/cohort-rules.js  → RapidML.CohortRules
 *   rules/outcome-rules.js → RapidML.OutcomeRules
 *   omop/concepts.js       → RapidML.ConceptReference
 *   omop/compiler.js       → RapidML.Compiler.compileStudy
 *
 * Load this file AFTER all the above scripts in index.html.
 *
 * Sections in this file (search by heading):
 *   1. TAB NAVIGATION          — switch active section + sidebar highlight
 *   2. COVARIATE PRESETS       — preset definitions and apply logic
 *   3. RULE HELP PANELS        — update help text when rule selection changes
 *   4. VISIT FILTER            — show/hide custom visit concept fields
 *   5. EXAMPLE BUTTONS         — pre-fill form with example concept IDs
 *   6. CONCEPT REFERENCE PANEL — populate right sidebar + click-to-copy
 *   7. RIGHT PANEL TOGGLE      — show/hide the concept reference sidebar
 *   8. DROPDOWN POPULATION     — fill methodology/template dropdowns from registries
 *   9. SELF-CHECK PANEL        — live validation summary (step 6)
 *  10. COHORT & OUTCOME RULE ACTIONS — wire rule dropdowns to field visibility + help
 *  11. STEP NAVIGATION BUTTONS — next/prev buttons inside each section
 *  12. INITIALIZATION          — boot sequence that runs on page load
 */

// =====================================================================
//  1. TAB NAVIGATION
//  The left sidebar has vertical step tabs. Clicking a tab shows the
//  matching wizard section and highlights the tab. Only one section
//  is visible at a time (display toggle, not scroll).
// =====================================================================

/** Current active step number (1-based) */
var currentStep = 1;

/** List of section IDs in step order */
var SECTION_ORDER = [
  "section-study",
  "section-cohort",
  "section-outcome",
  "section-censoring",
  "section-covariates",
  "section-review"
];

/**
 * Switch to the wizard section with the given DOM id.
 * Hides all other sections, updates sidebar tab highlight,
 * and updates the header step indicator.
 */
function goToSection(sectionId) {
  // Hide all sections, show only the target
  document.querySelectorAll(".wizard-section").forEach(function (sec) {
    sec.classList.remove("active");
  });
  var target = document.getElementById(sectionId);
  if (target) target.classList.add("active");

  // Update sidebar tab active state
  document.querySelectorAll(".step-tab").forEach(function (tab) {
    tab.classList.remove("active");
    if (tab.getAttribute("data-target") === sectionId) {
      tab.classList.add("active");
      currentStep = parseInt(tab.getAttribute("data-step"), 10) || 1;
    }
  });

  // Mark earlier steps as completed (visual indicator)
  document.querySelectorAll(".step-tab").forEach(function (tab) {
    var stepNum = parseInt(tab.getAttribute("data-step"), 10) || 0;
    if (stepNum < currentStep) {
      tab.classList.add("completed");
    } else {
      tab.classList.remove("completed");
    }
  });

  // Update header status text
  var headerStatus = document.getElementById("headerStatus");
  if (headerStatus) {
    headerStatus.textContent = "Step " + currentStep + " of 6";
  }

  // Scroll center panel to top
  var center = document.getElementById("centerPanel");
  if (center) center.scrollTop = 0;
}

/**
 * Attach click handlers to sidebar step tabs.
 */
function setupWizardNavigation() {
  document.querySelectorAll(".step-tab").forEach(function (tab) {
    tab.addEventListener("click", function () {
      goToSection(tab.getAttribute("data-target"));
    });
  });
}

/**
 * Wire next/prev buttons inside each section to navigate between steps.
 */
function setupStepNavButtons() {
  document.querySelectorAll(".nav-next-btn").forEach(function (btn) {
    btn.addEventListener("click", function () {
      goToSection(btn.getAttribute("data-next"));
    });
  });
  document.querySelectorAll(".nav-prev-btn").forEach(function (btn) {
    btn.addEventListener("click", function () {
      goToSection(btn.getAttribute("data-prev"));
    });
  });
}


// =====================================================================
//  2. COVARIATE PRESETS
//  Maps preset IDs to arrays of covariate checkbox values.
//  Used by the "Apply" button in wizard section 5.
// =====================================================================

/**
 * Returns a map of preset ID → array of covariate value strings.
 * These values must match the `value` attributes on the covariate
 * checkboxes in index.html section 5.
 */
function getCovariatePresetMap() {
  return {
    // Quick sanity-check set
    minimal: [
      "age_at_index",
      "sex_concept_id"
    ],
    // Recommended starter set — demographics + baseline utilization
    clinical_baseline: [
      "age_at_index",
      "sex_concept_id",
      "baseline_condition_count",
      "baseline_drug_count",
      "baseline_visit_count",
      "baseline_measurement_count"
    ],
    // Full feature set — all demographics, labs, and prior history
    extended: [
      "age_at_index",
      "sex_concept_id",
      "race_concept_id",
      "ethnicity_concept_id",
      "baseline_condition_count",
      "baseline_drug_count",
      "baseline_visit_count",
      "baseline_measurement_count",
      "baseline_egfr",
      "baseline_creatinine",
      "baseline_hba1c",
      "baseline_systolic_bp",
      "baseline_diastolic_bp",
      "baseline_bmi",
      "prior_outcome_history",
      "prior_hospitalization_flag",
      "prior_er_visit_flag",
      "prior_procedure_flag"
    ]
  };
}

/**
 * Read the selected preset from the dropdown, check/uncheck all
 * covariate boxes to match, then refresh the help text and self-check.
 */
function applyCovariatePreset() {
  var presetId = document.getElementById("covariatePreset").value;
  var presetMap = getCovariatePresetMap();
  var selected = presetMap[presetId] || [];

  document.querySelectorAll('input[name="covariates"]').forEach(function (box) {
    box.checked = selected.indexOf(box.value) >= 0;
  });

  updatePresetHelp(presetId);
  updateSelfCheck();
}

/**
 * Show a one-line description of the selected preset in #presetHelp.
 */
function updatePresetHelp(presetId) {
  var help = document.getElementById("presetHelp");
  if (!help) return;

  var info = {
    minimal:            "Minimal (quick baseline): age + sex only. Best for first-pass sanity checks.",
    clinical_baseline:  "Clinical Baseline (recommended): demographics + baseline utilization. Balanced starter set.",
    extended:           "Extended (rich features): race/ethnicity, all labs, prior history. Use when data is complete."
  };

  help.textContent = info[presetId] || info.clinical_baseline;
}

/**
 * Wire the preset dropdown and Apply button to applyCovariatePreset().
 */
function setupCovariatePresetActions() {
  var applyBtn = document.getElementById("applyPresetBtn");
  var presetSelect = document.getElementById("covariatePreset");

  if (applyBtn) applyBtn.addEventListener("click", applyCovariatePreset);
  if (presetSelect) presetSelect.addEventListener("change", applyCovariatePreset);
}


// =====================================================================
//  2. RULE HELP PANELS
//  When the user selects a cohort or outcome rule, update the help
//  text shown below the dropdown (the blue info box).
// =====================================================================

/**
 * Delegate to the cohort rule registry to update #cohortRuleHelp.
 */
function updateCohortRuleHelp(ruleId) {
  if (window.RapidML && window.RapidML.CohortRules) {
    window.RapidML.CohortRules.updateHelp(ruleId);
  }
}

/**
 * Delegate to the outcome rule registry to update #outcomeRuleHelp.
 */
function updateOutcomeRuleHelp(ruleId) {
  if (window.RapidML && window.RapidML.OutcomeRules) {
    window.RapidML.OutcomeRules.updateHelp(ruleId);
  }
}


// =====================================================================
//  3. VISIT FILTER
//  The visit filter dropdown controls whether custom concept ID
//  fields are visible. Only "custom" mode reveals the extra input.
// =====================================================================

/**
 * Show the custom visit concept ID input only when mode === "custom".
 */
function updateVisitFilterVisibility() {
  var modeSelect = document.getElementById("visitFilterMode");
  var customFields = document.getElementById("visitFilterCustomFields");
  if (!modeSelect || !customFields) return;
  customFields.style.display = modeSelect.value === "custom" ? "block" : "none";
}

/**
 * Attach change listener and run initial visibility check.
 */
function setupVisitFilterActions() {
  var modeSelect = document.getElementById("visitFilterMode");
  if (!modeSelect) return;

  function refreshVisitFilterState() {
    updateVisitFilterVisibility();
    updateSelfCheck();
  }

  modeSelect.addEventListener("change", refreshVisitFilterState);
  refreshVisitFilterState();
}


// =====================================================================
//  4. EXAMPLE BUTTONS
//  Pre-fill the form with realistic example concept IDs so new users
//  can see a working configuration immediately.
// =====================================================================

/**
 * Fill cohort entry fields with example values.
 * @param {string} type - "condition" (diabetes only) or "condition_lab" (diabetes + eGFR)
 */
function applyCohortExample(type) {
  var modeSelect = document.getElementById("cohortEntryMode");
  var conditionInput = document.getElementById("cohortConditionConceptId");
  var measurementInput = document.getElementById("cohortMeasurementConceptId");
  var opInput = document.getElementById("cohortMeasurementOp");
  var valueInput = document.getElementById("cohortMeasurementValue");

  if (type === "condition") {
    // Example: Type 2 Diabetes (OMOP concept 201826), condition-only entry
    modeSelect.value = "first_event";
    conditionInput.value = "201826";
    measurementInput.value = "";
    opInput.value = "<";
    valueInput.value = "";
  }

  if (type === "condition_lab") {
    // Example: Type 2 Diabetes + eGFR < 60 on different visits
    modeSelect.value = "condition_lab_diff_visits";
    conditionInput.value = "201826";
    measurementInput.value = "3020460";
    opInput.value = "<";
    valueInput.value = "60";
  }

  // Trigger change so rule help and field visibility refresh
  modeSelect.dispatchEvent(new Event("change"));
  updateSelfCheck();
}

/**
 * Fill outcome fields with example values.
 * @param {string} type - "condition" (nephropathy) or "lab" (eGFR < 30)
 */
function applyOutcomeExample(type) {
  var modeSelect = document.getElementById("outcomeRuleMode");
  var conceptInput = document.getElementById("outcomeConceptId");
  var measurementInput = document.getElementById("outcomeMeasurementConceptId");
  var opInput = document.getElementById("outcomeMeasurementOp");
  var valueInput = document.getElementById("outcomeMeasurementValue");

  if (type === "condition") {
    // Example: Diabetic nephropathy (OMOP concept 443767)
    modeSelect.value = "condition_occurrence";
    conceptInput.value = "443767";
    measurementInput.value = "";
    opInput.value = "<";
    valueInput.value = "";
  }

  if (type === "lab") {
    // Example: eGFR < 30 (severe kidney disease threshold)
    modeSelect.value = "lab_threshold";
    conceptInput.value = "";
    measurementInput.value = "3020460";
    opInput.value = "<";
    valueInput.value = "30";
  }

  modeSelect.dispatchEvent(new Event("change"));
  updateSelfCheck();
}

/**
 * Attach click handlers to all four example buttons.
 */
function setupRuleExampleActions() {
  var cohortConditionBtn = document.getElementById("applyCohortExampleConditionBtn");
  var cohortLabBtn = document.getElementById("applyCohortExampleLabBtn");
  var outcomeConditionBtn = document.getElementById("applyOutcomeExampleConditionBtn");
  var outcomeLabBtn = document.getElementById("applyOutcomeExampleLabBtn");

  if (cohortConditionBtn) cohortConditionBtn.addEventListener("click", function () { applyCohortExample("condition"); });
  if (cohortLabBtn) cohortLabBtn.addEventListener("click", function () { applyCohortExample("condition_lab"); });
  if (outcomeConditionBtn) outcomeConditionBtn.addEventListener("click", function () { applyOutcomeExample("condition"); });
  if (outcomeLabBtn) outcomeLabBtn.addEventListener("click", function () { applyOutcomeExample("lab"); });
}


// =====================================================================
//  6. CONCEPT REFERENCE PANEL
//  Renders OMOP concept IDs from RapidML.ConceptReference into the
//  always-visible right sidebar panel. Adds click-to-copy on each
//  <code> element.
// =====================================================================

/**
 * Populate the right sidebar concept reference content with HTML from
 * the ConceptReference registry and add click-to-copy handlers on each
 * <code> element inside the panel.
 */
function setupConceptRefPanel() {
  var contentDiv = document.getElementById("conceptRefContent");

  // Render all concept categories as HTML
  if (contentDiv && window.RapidML && window.RapidML.ConceptReference) {
    contentDiv.innerHTML = window.RapidML.ConceptReference.renderAll();
  }

  // Click-to-copy: clicking a concept <code> element copies the ID
  var panel = document.getElementById("conceptRefPanel");
  var codeElements = panel ? panel.querySelectorAll("code") : [];
  codeElements.forEach(function (el) {
    el.style.cursor = "pointer";
    el.addEventListener("click", function (e) {
      e.preventDefault();
      var text = el.getAttribute("data-concept-id") || el.textContent.split("–")[0].trim().replace("✓ ", "");
      navigator.clipboard.writeText(text).then(function () {
        var original = el.textContent;
        el.textContent = "✓ Copied!";
        el.style.backgroundColor = "#d1fae5";
        setTimeout(function () {
          el.textContent = original;
          el.style.backgroundColor = "";
        }, 1200);
      });
    });
  });
}


// =====================================================================
//  7. RIGHT PANEL TOGGLE
//  The header bar has a button to show/hide the right concept panel.
// =====================================================================

/**
 * Wire the header toggle button to show/hide the right sidebar.
 */
function setupRightPanelToggle() {
  var toggleBtn = document.getElementById("toggleRightPanel");
  var rightPanel = document.getElementById("rightPanel");
  if (!toggleBtn || !rightPanel) return;

  toggleBtn.addEventListener("click", function () {
    var isHidden = rightPanel.style.display === "none";
    rightPanel.style.display = isHidden ? "" : "none";
    toggleBtn.textContent = isHidden ? "Hide Concepts" : "Concept Reference";
  });
}


// =====================================================================
//  8. DROPDOWN POPULATION
//  After all plugins have self-registered, fill the methodology and
//  analysis template <select> elements from the registries.
// =====================================================================

/**
 * Populate the #methodology and #analysisTemplate dropdowns from
 * RapidML.Methodologies.list() and RapidML.AnalysisTemplates.list().
 * Adds a disabled placeholder at the end of the methodology list.
 */
function populateDropdowns() {
  // Methodology dropdown
  var methodologySelect = document.getElementById("methodology");
  var methodologies = RapidML.Methodologies.list();
  if (methodologies.length > 0) {
    methodologySelect.innerHTML = methodologies
      .map(function (m) { return '<option value="' + m.id + '">' + m.label + '</option>'; })
      .join("") +
      '<option value="" disabled>--- Add new methodology plugin (placeholder) ---</option>';
    methodologySelect.value = methodologies[0].id;
  }

  // Analysis template dropdown
  var templateSelect = document.getElementById("analysisTemplate");
  var templates = RapidML.AnalysisTemplates.list();
  if (templates.length > 0) {
    templateSelect.innerHTML = templates
      .map(function (t) { return '<option value="' + t.id + '">' + t.label + '</option>'; })
      .join("");
    templateSelect.value = templates[0].id;
  }
}


// =====================================================================
//  9. SELF-CHECK PANEL
//  The review section (step 6) shows a live summary of form state.
//  Red/green indicators tell the user what's filled vs missing.
//  This function re-renders on every input/change event.
// =====================================================================

/**
 * Human-friendly check/cross indicator.
 */
function yesNo(value) {
  return value ? "✓ OK" : "✗ Missing";
}

/**
 * Re-read all form fields, validate against rule requirements,
 * and render a summary into #selfCheckPanel.
 *
 * Called automatically on every input/change event via attachAutoSelfCheck().
 */
function updateSelfCheck() {
  var panel = document.getElementById("selfCheckPanel");

  // getFormConfig() is defined in core/generator.js
  var cfg = getFormConfig();

  // --- Plugin readiness ---
  var compilerReady = !!(RapidML.Compiler && RapidML.Compiler.compileStudy);
  var methods = RapidML.Methodologies.list().length;
  var templates = RapidML.AnalysisTemplates.list().length;

  // --- Human-readable rule labels ---
  var cohortLabel = cfg.cohortEntryMode;
  var outcomeLabel = cfg.outcomeRule.mode;
  if (RapidML.CohortRules) {
    var cohortRule = RapidML.CohortRules.getRule(cfg.cohortEntryMode);
    cohortLabel = cohortRule.label;
  }
  if (RapidML.OutcomeRules) {
    var outcomeRule = RapidML.OutcomeRules.getRule(cfg.outcomeRule.mode);
    outcomeLabel = outcomeRule.label;
  }

  // --- Rule input validation ---
  // Build boolean maps of which input types are filled, then ask the
  // rule registries whether the selected rule's requirements are met.
  var cohortInputState = {
    condition:   !!(cfg.cohortEntry && cfg.cohortEntry.conditionConceptId),
    measurement: !!(cfg.cohortEntry && cfg.cohortEntry.measurementConceptId && cfg.cohortEntry.measurementValue),
    procedure:   !!(cfg.cohortEntry && cfg.cohortEntry.procedureConceptId),
    observation: !!(cfg.cohortEntry && cfg.cohortEntry.observationConceptId)
  };
  var outcomeInputState = {
    condition:   !!(cfg.outcomeRule && cfg.outcomeRule.conceptId),
    measurement: !!(cfg.outcomeRule && cfg.outcomeRule.measurementConceptId && cfg.outcomeRule.measurementValue),
    procedure:   !!(cfg.outcomeRule && cfg.outcomeRule.procedureConceptId),
    observation: !!(cfg.outcomeRule && cfg.outcomeRule.observationConceptId)
  };

  var cohortInputsReady = !RapidML.CohortRules || !RapidML.CohortRules.isInputSatisfied
    ? true
    : RapidML.CohortRules.isInputSatisfied(cfg.cohortEntryMode, cohortInputState);
  var outcomeInputsReady = !RapidML.OutcomeRules || !RapidML.OutcomeRules.isInputSatisfied
    ? true
    : RapidML.OutcomeRules.isInputSatisfied(cfg.outcomeRule.mode, outcomeInputState);

  // --- Overall readiness ---
  var requiredFieldsReady = !!(
    cfg.schema &&
    cfg.startYear &&
    cfg.endYear &&
    cfg.outcomeRule &&
    cfg.cohortEntry &&
    (!cfg.visitFilter || cfg.visitFilter.mode !== "custom" || (cfg.visitFilter.conceptIds && cfg.visitFilter.conceptIds.length > 0)) &&
    cohortInputsReady &&
    outcomeInputsReady
  );
  var covariateCount = (cfg.covariates || []).length;
  var generationReady = requiredFieldsReady && covariateCount > 0 && compilerReady;

  // --- Visit filter display text ---
  var visitFilterSummary = cfg.visitFilter && cfg.visitFilter.mode === "custom"
    ? (cfg.visitFilter.conceptIds && cfg.visitFilter.conceptIds.length ? cfg.visitFilter.conceptIds.join(",") : "custom (missing IDs)")
    : ((cfg.visitFilter && cfg.visitFilter.mode) || "all");

  // --- Render HTML ---
  panel.innerHTML = [
    "<div><strong>Database:</strong> " + cfg.db + " | <strong>Schema:</strong> " + cfg.schema + "</div>",
    "<div><strong>Study years:</strong> " + cfg.startYear + "–" + cfg.endYear + "</div>",
    "<div><strong>Cohort rule:</strong> " + cohortLabel + "</div>",
    "<div><strong>Outcome rule:</strong> " + outcomeLabel + "</div>",
    "<div><strong>Visit filter:</strong> " + visitFilterSummary + "</div>",
    "<div><strong>Baseline:</strong> " + cfg.baselineYears + " years | <strong>Outcome window:</strong> " + cfg.outcomeYears + " years</div>",
    "<div><strong>Compiler:</strong> " + yesNo(compilerReady) + " | <strong>Methodologies:</strong> " + methods + " | <strong>Templates:</strong> " + templates + "</div>",
    "<div><strong>Required fields:</strong> " + yesNo(requiredFieldsReady) + "</div>",
    "<div><strong>Selected covariates:</strong> " + covariateCount + " | <strong>Encoding:</strong> " + cfg.covariateEncoding + "</div>",
    "<div><strong>Debug mode:</strong> " + (cfg.debug ? "enabled" : "disabled") + " | <strong>Best-practice:</strong> " + (cfg.bestPracticeMode ? "enabled" : "disabled") + "</div>",
    "<div class='pt-2 font-bold text-lg' style='" + (generationReady ? "color: #16a34a;" : "color: #71717a;") + "'>" + (generationReady ? "✓ Ready to generate!" : "⚠ Fill all required fields") + "</div>"
  ].join("");
}

/**
 * Attach change + input listeners to every form element so the
 * self-check panel updates automatically as the user types.
 */
function attachAutoSelfCheck() {
  document.querySelectorAll("input, select").forEach(function (el) {
    el.addEventListener("change", updateSelfCheck);
    el.addEventListener("input", updateSelfCheck);
  });
}


// =====================================================================
//  10. COHORT & OUTCOME RULE ACTIONS
//  When the user changes the cohort or outcome rule dropdown:
//    - Show/hide input groups for the selected rule (via rule registry)
//    - Update the help text panel
//    - Refresh the self-check summary
// =====================================================================

/**
 * Wire the #cohortEntryMode dropdown to field visibility and help.
 */
function setupCohortRuleActions() {
  var modeSelect = document.getElementById("cohortEntryMode");
  if (!modeSelect) return;

  function refreshRuleState() {
    // Tell the cohort rule registry to show/hide condition vs lab fields
    if (window.RapidML && window.RapidML.CohortRules) {
      window.RapidML.CohortRules.updateFieldVisibility(modeSelect.value);
    }
    updateCohortRuleHelp(modeSelect.value);
    updateSelfCheck();
  }

  modeSelect.addEventListener("change", refreshRuleState);
  // Run once on load to set initial state
  refreshRuleState();
}

/**
 * Wire the #outcomeRuleMode dropdown to field visibility and help.
 */
function setupOutcomeRuleActions() {
  var modeSelect = document.getElementById("outcomeRuleMode");
  if (!modeSelect) return;

  function refreshOutcomeState() {
    if (window.RapidML && window.RapidML.OutcomeRules) {
      window.RapidML.OutcomeRules.updateFieldVisibility(modeSelect.value);
    }
    updateOutcomeRuleHelp(modeSelect.value);
    updateSelfCheck();
  }

  modeSelect.addEventListener("change", refreshOutcomeState);
  refreshOutcomeState();
}


// =====================================================================
//  11. INITIALIZATION
//  Boot sequence — runs after a short delay to let all plugin scripts
//  finish self-registration (methodologies, templates, rules).
//
//  Order matters:
//    1. Wire sidebar tab navigation
//    2. Wire next/prev step buttons
//    3. Fill dropdowns from registries
//    4. Wire preset, rule, visit filter, and example buttons
//    5. Render concept reference in right sidebar
//    6. Wire right panel toggle button
//    7. Apply default covariate preset
//    8. Start live self-check listeners
//    9. Run initial self-check render
// =====================================================================

setTimeout(function () {
  setupWizardNavigation();       // 1. Sidebar tabs → switch section
  setupStepNavButtons();         // 2. Next/prev buttons inside sections
  populateDropdowns();           // 3. Methodology + template <select>
  setupCovariatePresetActions(); // 4a. Preset apply button
  setupCohortRuleActions();      // 4b. Cohort rule → field visibility
  setupOutcomeRuleActions();     // 4c. Outcome rule → field visibility
  setupVisitFilterActions();     // 4d. Visit filter → custom fields
  setupRuleExampleActions();     // 4e. Example buttons
  setupConceptRefPanel();        // 5. Concept ID reference (right sidebar)
  setupRightPanelToggle();       // 6. Header toggle for right panel
  applyCovariatePreset();        // 7. Apply default preset (clinical_baseline)
  attachAutoSelfCheck();         // 8. Live validation on all inputs
  updateSelfCheck();             // 9. Initial self-check render
}, 10);
