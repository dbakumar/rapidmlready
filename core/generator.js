/**
 * ============================================================================
 * GENERATOR.JS – Core Plugin Coordinator and Configuration Handler
 * ============================================================================
 * 
 * This file manages:
 * 1. PLUGIN REGISTRIES – Store methodology and analysis template plugins
 * 2. FORM CONFIG COLLECTION – Gather user inputs from HTML forms
 * 3. CONFIG NORMALIZATION – Convert raw form data into study configuration
 * 4. GENERATION & DOWNLOAD – Create finalized SQL and scripts
 * 
 * For developers:
 * - Each function has a single, clear purpose
 * - Plugin registries use simple key-value objects
 * - Config flows: raw form data → normalized config → compiler input
 * - All download logic is centralized in the generate() function
 * ============================================================================
 */

// ============================================================================
// PLUGIN REGISTRY SETUP
// ============================================================================
// The RapidML global object holds all plugins and utilities for the wizard
window.RapidML = window.RapidML || {};
RapidML.Methodologies = RapidML.Methodologies || {};
RapidML.AnalysisTemplates = RapidML.AnalysisTemplates || {};
RapidML.Compiler = RapidML.Compiler || {};

// ============================================================================
// METHODOLOGY PLUGIN MANAGEMENT
// ============================================================================
// Methodologies define HOW to build the cohort (e.g., longitudinal prediction)
// Each plugin provides SQL generation and rule documentation

/** Register a new methodology plugin */
RapidML.Methodologies.register = function(plugin) {
  RapidML.Methodologies[plugin.id] = plugin;
};

/** Retrieve a single methodology by ID */
RapidML.Methodologies.get = function(id) {
  return RapidML.Methodologies[id];
};

/** Get all registered methodologies as an array */
RapidML.Methodologies.list = function() {
  return Object.values(RapidML.Methodologies).filter(function(p) { return p && p.id; });
};

// ============================================================================
// ANALYSIS TEMPLATE PLUGIN MANAGEMENT
// ============================================================================
// Analysis templates define analysis code generation (e.g., logistic regression)
// Each template produces analysis scripts based on the selected methodology

/** Register a new analysis template plugin */
RapidML.AnalysisTemplates.register = function(plugin) {
  RapidML.AnalysisTemplates[plugin.id] = plugin;
};

/** Retrieve a single analysis template by ID */
RapidML.AnalysisTemplates.get = function(id) {
  return RapidML.AnalysisTemplates[id];
};

/** Get all registered analysis templates as an array */
RapidML.AnalysisTemplates.list = function() {
  return Object.values(RapidML.AnalysisTemplates).filter(function(p) { return p && p.id; });
};

// ============================================================================
// UTILITY FUNCTIONS
// ============================================================================

/**
 * Download a file to the user's computer
 * @param {string} filename - Name for the downloaded file
 * @param {string} text - File content
 * @param {string} mimeType - Optional: MIME type (default "text/plain")
 */
function download(filename, text, mimeType) {
  mimeType = mimeType || "text/plain";
  const blob = new Blob([text], { type: mimeType });
  const url = window.URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  window.URL.revokeObjectURL(url);
}

/**
 * Download a Blob (used for zip packages).
 */
function downloadBlob(filename, blob) {
  const url = window.URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  window.URL.revokeObjectURL(url);
}

/**
 * Build a filesystem-safe timestamp like 20260414_091530.
 */
function buildTimestamp() {
  const now = new Date();
  const yyyy = String(now.getFullYear());
  const mm = String(now.getMonth() + 1).padStart(2, "0");
  const dd = String(now.getDate()).padStart(2, "0");
  const hh = String(now.getHours()).padStart(2, "0");
  const mi = String(now.getMinutes()).padStart(2, "0");
  const ss = String(now.getSeconds()).padStart(2, "0");
  return yyyy + mm + dd + "_" + hh + mi + ss;
}

/**
 * Add timestamp before extension so each generated file is uniquely identifiable.
 */
function withTimestamp(filename, timestamp) {
  const lastDot = filename.lastIndexOf(".");
  if (lastDot <= 0) {
    return filename + "_" + timestamp;
  }
  const base = filename.slice(0, lastDot);
  const ext = filename.slice(lastDot);
  return base + "_" + timestamp + ext;
}

/**
 * Package all generated files into one zip (preferred) and fallback to direct downloads.
 */
async function downloadPackage(files, timestamp) {
  if (window.JSZip) {
    const zip = new window.JSZip();
    files.forEach(function(file) {
      zip.file(withTimestamp(file.filename, timestamp), file.content);
    });

    const zipBlob = await zip.generateAsync({ type: "blob" });
    downloadBlob("rapidmlready_package_" + timestamp + ".zip", zipBlob);
    return;
  }

  // Fallback path when JSZip is unavailable.
  files.forEach(function(file, idx) {
    setTimeout(function() {
      download(withTimestamp(file.filename, timestamp), file.content, file.mimeType || "text/plain");
    }, idx * 120);
  });
  alert("JSZip library not loaded. Downloaded timestamped files individually instead of zip.");
}

// ============================================================================
// CONFIGURATION NORMALIZATION
// ============================================================================

/**
 * Normalizes raw form data into a clean, consistent study configuration.
 * This ensures all required fields have defaults and proper types.
 * 
 * Why normalize?
 * - User might skip fields → provide sensible defaults
 * - Form returns strings → convert to proper types (numbers, booleans)
 * - Multiple rules stored in single object → simplify access
 * 
 * @param {object} raw - Raw form data from getFormConfig()
 * @returns {object} - Normalized config ready for SQL compiler
 */
function normalizeConfig(raw) {
  // Default covariates if user doesn't select any
  const defaults = [
    "age_at_index",
    "sex_concept_id",
    "baseline_condition_count",
    "baseline_drug_count",
    "baseline_visit_count",
    "baseline_measurement_count"
  ];

  return {
    // DATABASE SETTINGS
    db: raw.db || "postgres",
    schema: raw.schema || "",
    startYear: String(raw.startYear || "2016"),
    endYear: String(raw.endYear || "2024"),

    // OUTCOME RULE (how to label follow-up window)
    outcomeConceptId: raw.outcomeConceptId || "",
    outcomeRule: raw.outcomeRule || {
      mode: "condition_occurrence",
      conceptId: raw.outcomeConceptId || "",
      measurementConceptId: "",
      measurementOperator: ">",
      measurementValue: ""
    },

    // TIMEFRAMES
    baselineYears: String(raw.baselineYears || "1"),
    outcomeYears: String(raw.outcomeYears || "1"),

    // OPTIONS
    debug: !!raw.debug,
    bestPracticeMode: !!raw.bestPracticeMode,

    // VISIT FILTER FOR ENTRY EVENTS
    visitFilter: {
      mode: raw.visitFilter && raw.visitFilter.mode ? raw.visitFilter.mode : "all",
      conceptIds: raw.visitFilter && Array.isArray(raw.visitFilter.conceptIds) ? raw.visitFilter.conceptIds : []
    },

    // PLUGIN SELECTIONS
    methodology: raw.methodology || "longitudinal-prediction",
    analysisTemplate: raw.analysisTemplate || "logistic-regression",

    // COHORT RULE (when patients enter)
    cohortEntryMode: raw.cohortEntryMode || "first_event",
    cohortEntry: raw.cohortEntry || {
      mode: "first_event",
      conditionConceptId: "",
      measurementConceptId: "",
      measurementOperator: ">",
      measurementValue: ""
    },

    // COVARIATES (features to include)
    covariateEncoding: raw.covariateEncoding || "count",
    covariates: Array.isArray(raw.covariates) && raw.covariates.length ? raw.covariates : defaults
  };
}

// ============================================================================
// FORM DATA COLLECTION
// ============================================================================

/**
 * Read all form inputs from the HTML and collect into raw config object.
 * This is called when "Generate Package" is clicked.
 * 
 * @returns {object} - Raw config data (before normalization)
 */
function getFormConfig() {
  // Collect all checked covariate checkboxes into an array
  const selectedCovariates = Array.from(document.querySelectorAll('input[name="covariates"]:checked'))
    .map(function(el) { return el.value; });

  // Extract outcome rule settings from form fields
  function getOutcomeRuleConfig() {
    const modeElem = document.getElementById("outcomeRuleMode");
    const conceptElem = document.getElementById("outcomeConceptId");
    const measurementElem = document.getElementById("outcomeMeasurementConceptId");
    const opElem = document.getElementById("outcomeMeasurementOp");
    const valueElem = document.getElementById("outcomeMeasurementValue");

    return {
      mode: modeElem ? modeElem.value || "condition_occurrence" : "condition_occurrence",
      conceptId: conceptElem ? conceptElem.value || "" : "",
      measurementConceptId: measurementElem ? measurementElem.value || "" : "",
      measurementOperator: opElem ? opElem.value || ">" : ">",
      measurementValue: valueElem ? valueElem.value || "" : ""
    };
  }

  // Extract cohort rule settings from form fields
  function getCohortEntryConfig() {
    const modeElem = document.getElementById("cohortEntryMode");
    const conditionElem = document.getElementById("cohortConditionConceptId");
    const measurementElem = document.getElementById("cohortMeasurementConceptId");
    const opElem = document.getElementById("cohortMeasurementOp");
    const valueElem = document.getElementById("cohortMeasurementValue");

    return {
      mode: modeElem ? modeElem.value : "first_event",
      conditionConceptId: conditionElem ? conditionElem.value || "" : "",
      measurementConceptId: measurementElem ? measurementElem.value || "" : "",
      measurementOperator: opElem ? opElem.value || ">" : ">",
      measurementValue: valueElem ? valueElem.value || "" : ""
    };
  }

  function getVisitFilterConfig() {
    const modeElem = document.getElementById("visitFilterMode");
    const conceptsElem = document.getElementById("visitConceptIds");
    const mode = modeElem ? modeElem.value || "all" : "all";
    const conceptIds = conceptsElem && conceptsElem.value
      ? conceptsElem.value.split(",").map(function(id) {
          return String(id || "").trim().replace(/[^0-9]/g, "");
        }).filter(function(id) { return id.length > 0; })
      : [];

    return {
      mode: mode,
      conceptIds: conceptIds
    };
  }

  // Collect all form fields and normalize
  return normalizeConfig({
    db: document.getElementById("db").value,
    schema: document.getElementById("schema").value,
    startYear: document.getElementById("startYear").value,
    endYear: document.getElementById("endYear").value,
    outcomeConceptId: document.getElementById("outcomeConceptId").value,
    outcomeRule: getOutcomeRuleConfig(),
    baselineYears: document.getElementById("baselineYears").value,
    outcomeYears: document.getElementById("outcomeYears").value,
    debug: document.getElementById("debugMode").checked,
    methodology: document.getElementById("methodology") ? document.getElementById("methodology").value : "longitudinal-prediction",
    analysisTemplate: document.getElementById("analysisTemplate") ? document.getElementById("analysisTemplate").value : "logistic-regression",
    cohortEntryMode: document.getElementById("cohortEntryMode") ? document.getElementById("cohortEntryMode").value : "first_event",
    cohortEntry: getCohortEntryConfig(),
    visitFilter: getVisitFilterConfig(),
    bestPracticeMode: document.getElementById("bestPracticeMode") ? document.getElementById("bestPracticeMode").checked : false,
    covariateEncoding: document.getElementById("covariateEncoding") ? document.getElementById("covariateEncoding").value : "count",
    covariates: selectedCovariates
  });
}

// ============================================================================
// INPUT VALIDATION
// ============================================================================

/** Allowed SQL comparison operators — prevents injection via operator field */
var ALLOWED_OPERATORS = ['>', '<', '>=', '<=', '='];

/**
 * Sanitize a SQL identifier (schema name, etc.).
 * Only allow alphanumeric, underscore, and a single dot for schema.table.
 * Returns empty string if invalid.
 */
function sanitizeIdentifier(value) {
  var str = String(value || "").trim();
  if (/^[a-zA-Z_][a-zA-Z0-9_.]*$/.test(str) && str.length <= 128) {
    return str;
  }
  return "";
}

/**
 * Validate a SQL operator is in the allowed list.
 * Returns the valid operator or ">" as safe default.
 */
function validateOperator(op) {
  var trimmed = String(op || "").trim();
  return ALLOWED_OPERATORS.indexOf(trimmed) >= 0 ? trimmed : ">";
}

/**
 * Validate study configuration before SQL generation.
 * Returns an array of error messages (empty = valid).
 */
function validateConfig(config) {
  var errors = [];

  // Schema name must be a valid SQL identifier
  if (!sanitizeIdentifier(config.schema)) {
    errors.push("Schema name contains invalid characters. Use only letters, numbers, underscores, and dots.");
  }

  // Year range
  var startY = parseInt(config.startYear, 10);
  var endY = parseInt(config.endYear, 10);
  if (isNaN(startY) || isNaN(endY)) {
    errors.push("Study years must be valid numbers.");
  } else if (startY >= endY) {
    errors.push("Start year must be before end year.");
  }

  // Baseline/outcome window
  if (parseInt(config.baselineYears, 10) <= 0) {
    errors.push("Baseline period must be positive.");
  }
  if (parseInt(config.outcomeYears, 10) <= 0) {
    errors.push("Outcome window must be positive.");
  }

  // Validate operators in cohort/outcome rules
  if (config.cohortEntry) {
    config.cohortEntry.measurementOperator = validateOperator(config.cohortEntry.measurementOperator);
  }
  if (config.outcomeRule) {
    config.outcomeRule.measurementOperator = validateOperator(config.outcomeRule.measurementOperator);
  }

  // Sanitize schema name in-place
  config.schema = sanitizeIdentifier(config.schema);

  return errors;
}

// ============================================================================
// GENERATION AND DOWNLOAD
// ============================================================================

/**
 * Main generate function: orchestrates SQL generation and package download.
 * 
 * Flow:
 * 1. Collect form config
 * 2. Get selected methodology plugin (e.g., "longitudinal-prediction")
 * 3. Get selected analysis template plugin (e.g., "logistic-regression")
 * 4. Call methodology.buildSQL() to generate study.sql
 * 5. Call methodology.describeRules() to generate README.md
 * 6. Call template.buildScript() to generate analysis script
 * 7. Build one timestamped zip package for all generated files
 * 8. If best-practice mode enabled, generate additional artifacts
 */
async function generate() {
  // Collect and normalize all form inputs
  const config = getFormConfig();

  // Validate inputs before SQL generation
  const validationErrors = validateConfig(config);
  if (validationErrors.length > 0) {
    alert("Configuration errors:\n\n• " + validationErrors.join("\n• "));
    return;
  }

  // Load selected plugins
  const methodology = RapidML.Methodologies.get(config.methodology);
  const template = RapidML.AnalysisTemplates.get(config.analysisTemplate);

  // Validate plugins are available
  if (!methodology) {
    alert("Methodology not found: " + config.methodology);
    return;
  }
  if (!template) {
    alert("Analysis template not found: " + config.analysisTemplate);
    return;
  }

  try {
    // Generate content using plugins
    const sql = methodology.buildSQL(config, config.db);
    const readme = methodology.describeRules(config);
    const runScript = template.buildScript(config);
    const timestamp = buildTimestamp();

    const files = [
      { filename: "study.sql", content: sql, mimeType: "text/plain" },
      { filename: "README.md", content: readme, mimeType: "text/markdown" },
      { filename: template.filename, content: runScript, mimeType: "text/plain" }
    ];

    // Add optional best-practice artifacts if enabled.
    if (config.bestPracticeMode && RapidML.Compiler && typeof RapidML.Compiler.buildArtifacts === "function") {
      const artifacts = RapidML.Compiler.buildArtifacts(config, methodology.id);
      if (artifacts && artifacts.length) {
        artifacts.forEach(function(item) {
          files.push({
            filename: item.filename,
            content: item.content,
            mimeType: item.mimeType || "text/plain"
          });
        });
      }
    }

    await downloadPackage(files, timestamp);
  } catch (err) {
    alert("Package generation failed: " + (err && err.message ? err.message : err));
  }
}
