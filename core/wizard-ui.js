/**
 * ============================================================================
 * WIZARD-UI.JS  -  Wizard UI Controller (3-Panel EHR Layout)
 * ============================================================================
 *
 * PURPOSE:
 *   Contains ALL browser-side UI logic for the Rapid ML-Ready Wizard
 *   (index.html).  Drives a 3-panel layout:
 *     LEFT   - vertical step tabs (sidebar navigation, 5 steps)
 *     CENTER - one wizard section visible at a time (form panels)
 *     RIGHT  - OMOP concept ID reference (always-visible, click-to-copy)
 *
 * SECTIONS IN THIS FILE:
 *   1.  TAB NAVIGATION        - switch active section + sidebar highlight
 *   2.  COVARIATE PRESETS      - preset definitions and apply logic
 *   3.  VISIT FILTER           - show/hide custom visit concept fields
 *   4.  EVIDENCE BLOCK SETUP   - initialise evidence row forms
 *   5.  EXAMPLE BUTTONS        - pre-fill with diabetes study examples
 *   6.  CONCEPT REFERENCE      - populate right sidebar + click-to-copy
 *   7.  RIGHT PANEL TOGGLE     - show/hide the concept sidebar
 *   8.  DROPDOWN POPULATION    - fill methodology / template dropdowns
 *   9.  SELF-CHECK PANEL       - live validation summary (step 5)
 *  10.  INITIALISATION         - boot sequence that runs on page load
 *
 * DATA FLOW:
 *   Page loads -> setTimeout(10ms) -> init functions run in sequence
 *   User navigates steps -> goToSection() shows/hides panels
 *   User changes inputs -> updateSelfCheck() refreshes validation
 *   User clicks Generate -> generate() in generator.js is called
 *
 * DEPENDS ON (must be loaded before this file):
 *   core/generator.js      -> RapidML.Methodologies, AnalysisTemplates,
 *                              Adapters, getFormConfig(), generate()
 *   core/evidence-ui.js    -> RapidML.EvidenceUI
 *   omop/concepts.js       -> RapidML.ConceptReference
 *
 * GLOBAL FUNCTIONS EXPOSED:
 *   goToSection(id)        - switch wizard step
 *   updateSelfCheck()      - refresh validation panel
 *   applyCovariatePreset() - apply covariate preset from dropdown
 * ============================================================================
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
  "section-definition",
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
    headerStatus.textContent = "Step " + currentStep + " of 5";
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
//  3. VISIT FILTER
//  The visit filter dropdown controls whether custom concept ID
// =====================================================================
//  4. EVIDENCE BLOCK SETUP
//  Initialize the dynamic evidence row forms in the Study Definition
//  section.  Uses RapidML.EvidenceUI to render blocks.
// =====================================================================

/** Handles returned from renderBlock — used by example buttons */
var _entryBlockHandle = null;
var _outcomeBlockHandle = null;

/**
 * Initialize all four evidence block containers.
 * Adds one default row to entry and outcome blocks.
 */
function setupEvidenceBlocks() {
  if (!RapidML.EvidenceUI) return;

  _entryBlockHandle = RapidML.EvidenceUI.renderBlock("entryBlock", {
    label: "Entry",
    showMatch: true,
    showLabel: false
  });

  _outcomeBlockHandle = RapidML.EvidenceUI.renderBlock("outcomeBlock", {
    label: "Outcome",
    showMatch: true,
    showLabel: false
  });

  RapidML.EvidenceUI.renderBlock("exclusionsBlock", {
    label: "Exclusion",
    showMatch: false,
    showLabel: true
  });

  RapidML.EvidenceUI.renderBlock("confoundersBlock", {
    label: "Confounder",
    showMatch: false,
    showLabel: true
  });

  // Add one default row each for entry and outcome
  if (_entryBlockHandle) _entryBlockHandle.addRow({ type: "diagnosis" });
  if (_outcomeBlockHandle) _outcomeBlockHandle.addRow({ type: "diagnosis" });
}


// =====================================================================
//  5. EXAMPLE BUTTONS
//  Pre-fill evidence blocks with realistic examples so new users
//  can see a working configuration immediately.
// =====================================================================

/**
 * Attach click handlers to example buttons.
 */
function setupExampleActions() {
  var diabetesBtn = document.getElementById("applyExampleDiabetesBtn");
  var diabetesLabBtn = document.getElementById("applyExampleDiabetesLabBtn");

  if (diabetesBtn) {
    diabetesBtn.addEventListener("click", function () {
      RapidML.EvidenceUI.applyDiabetesExample(_entryBlockHandle, _outcomeBlockHandle);
    });
  }
  if (diabetesLabBtn) {
    diabetesLabBtn.addEventListener("click", function () {
      RapidML.EvidenceUI.applyDiabetesLabExample(_entryBlockHandle, _outcomeBlockHandle);
    });
  }
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
//  The review section (step 5) shows a live summary of form state.
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
 * Re-read all form fields, validate against evidence block state,
 * and render a summary into #selfCheckPanel.
 */
function updateSelfCheck() {
  var panel = document.getElementById("selfCheckPanel");

  // getFormConfig() is defined in core/generator.js
  var cfg = getFormConfig();

  // --- Plugin readiness ---
  var compilerReady = !!(RapidML.Compiler && RapidML.Compiler.prepareContext);
  var methods = RapidML.Methodologies.list().length;
  var templates = RapidML.AnalysisTemplates.list().length;

  // --- Evidence block summary ---
  var study = cfg.study || {};
  var entryRows = study.entry ? study.entry.rows.length : 0;
  var outcomeRows = study.outcome ? study.outcome.rows.length : 0;
  var exclusionCount = study.exclusions ? study.exclusions.length : 0;
  var confounderCount = study.confounders ? study.confounders.length : 0;

  // --- Visit filter display text ---
  // --- Overall readiness ---
  var requiredFieldsReady = !!(
    cfg.schema &&
    cfg.startYear &&
    cfg.endYear &&
    entryRows > 0 &&
    outcomeRows > 0
  );
  var covariateCount = (cfg.covariates || []).length;
  var generationReady = requiredFieldsReady && covariateCount > 0 && compilerReady;

  // --- Render HTML ---
  panel.innerHTML = [
    "<div><strong>Database:</strong> " + cfg.db + " | <strong>Schema:</strong> " + (cfg.schema || "<em>not set</em>") + "</div>",
    "<div><strong>Data model:</strong> " + (cfg.dataModel || "omop") + " | <strong>Study years:</strong> " + cfg.startYear + "–" + cfg.endYear + "</div>",
    "<div><strong>Entry rows:</strong> " + entryRows + " " + yesNo(entryRows > 0) + " | <strong>Match:</strong> " + ((study.entry && study.entry.match) || "all") + "</div>",
    "<div><strong>Outcome rows:</strong> " + outcomeRows + " " + yesNo(outcomeRows > 0) + " | <strong>Match:</strong> " + ((study.outcome && study.outcome.match) || "any") + "</div>",
    "<div><strong>Exclusions:</strong> " + exclusionCount + " | <strong>Confounders:</strong> " + confounderCount + "</div>",
    "<div><strong>Baseline:</strong> " + cfg.baselineDays + " days | <strong>Outcome window:</strong> " + cfg.outcomeDays + " days</div>",
    "<div><strong>Compiler:</strong> " + yesNo(compilerReady) + " | <strong>Methodologies:</strong> " + methods + " | <strong>Templates:</strong> " + templates + "</div>",
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
//  10. INITIALIZATION
//  Boot sequence — runs after a short delay to let all plugin scripts
//  finish self-registration (methodologies, templates, adapters).
// =====================================================================

setTimeout(function () {
  setupWizardNavigation();       // 1. Sidebar tabs → switch section
  setupStepNavButtons();         // 2. Next/prev buttons inside sections
  populateDropdowns();           // 3. Methodology + template <select>
  setupCovariatePresetActions(); // 4. Preset apply button
  setupEvidenceBlocks();         // 5. Evidence block forms (entry, outcome, exclusions, confounders)
  setupExampleActions();         // 6. Example buttons
  setupConceptRefPanel();        // 7. Concept ID reference (right sidebar)
  setupRightPanelToggle();       // 8. Header toggle for right panel
  applyCovariatePreset();        // 9. Apply default preset (clinical_baseline)
  attachAutoSelfCheck();         // 10. Live validation on all inputs
  updateSelfCheck();             // 11. Initial self-check render
}, 10);
