/**
 * ============================================================================
 * GENERATOR.JS  -  Core Plugin Coordinator, Registries & Configuration Handler
 * ============================================================================
 *
 * PURPOSE:
 *   This is the central orchestration file for the Rapid ML-Ready Wizard.
 *   It ties together all plugins (methodologies, analysis templates, data
 *   model adapters), collects user input from the HTML form, validates it,
 *   and packages the generated output files into a downloadable zip.
 *
 * WHAT THIS FILE MANAGES:
 *   1. ADAPTER REGISTRY         - register / retrieve data model adapters
 *   2. METHODOLOGY REGISTRY     - register / retrieve study methodology plugins
 *   3. ANALYSIS TEMPLATE REG.   - register / retrieve analysis template plugins
 *   4. FORM CONFIG COLLECTION   - read all HTML form inputs into config object
 *   5. CONFIG NORMALISATION     - apply defaults and type-coerce values
 *   6. INPUT VALIDATION         - verify config before SQL generation
 *   7. DOWNLOAD & PACKAGING     - create timestamped zip of all outputs
 *   8. GENERATION ENTRY POINT   - generate() wires everything together
 *
 * DEPENDS ON:  nothing (loaded first among project scripts)
 * USED BY:     wizard-ui.js (calls generate()), methodologies/*.js, templates/*.js
 *
 * GLOBAL NAMESPACE:
 *   window.RapidML.Methodologies      - methodology plugin registry
 *   window.RapidML.AnalysisTemplates  - analysis template plugin registry
 *   window.RapidML.Adapters           - data model adapter registry
 *   window.RapidML.Compiler           - shared compiler namespace (populated
 *                                       by omop/compiler.js, core/dialects.js)
 *
 * DATA FLOW:
 *   User fills HTML form
 *        |  getFormConfig()
 *        v
 *   Raw form data -> normalizeConfig() -> validateConfig()
 *        |                                     |
 *        v                                     v
 *   Normalized config object            Array of error strings
 *        |
 *        v  generate()
 *   methodology.buildSQL(config)   -> study.sql
 *   methodology.describeRules(cfg) -> README.md
 *   template.buildScript(config)   -> run.py
 *        |
 *        v  downloadPackage()
 *   Timestamped zip file
 * ============================================================================
 */

// ============================================================================
// GLOBAL NAMESPACE SETUP
// ============================================================================
// The RapidML global object holds all plugins and utilities for the wizard.
// Every other script file attaches its public API to this object.
window.RapidML = window.RapidML || {};
RapidML.Methodologies = RapidML.Methodologies || {};
RapidML.AnalysisTemplates = RapidML.AnalysisTemplates || {};
RapidML.Compiler = RapidML.Compiler || {};

// ============================================================================
// DATA MODEL ADAPTER REGISTRY
// ============================================================================
// Adapters translate evidence blocks (diagnosis, lab, drug, procedure rows)
// into data-model-specific SQL.  Currently only OMOP CDM is implemented
// (see omop/evidence-sql.js).  Future adapters (FHIR, i2b2, PCORnet) would
// register here and become available in the Data Model dropdown.
//
// Adapter interface - each adapter object must provide:
//   id                              -> unique string, e.g. "omop"
//   buildConceptCTEs(config)        -> array of CTE strings
//   buildCohortCTE(config)          -> CTE string (person_id, t0)
//   buildFirstOutcomeCTE(config)    -> CTE string (person_id, outcome_date)
//   buildOutcomeLabelExpr(config)   -> CASE expression string
//   buildExclusionWhere(config)     -> WHERE clause string or null
//   buildConfounderColumns(config)  -> { columns: [], joins: [] }
//   buildDomainBridge(config)       -> { outcomes, cohortEntry } bridge

(function () {
  var adapters = {};

  /**
   * Registry for data model adapters.
   *
   * register(adapter) - store an adapter keyed by adapter.id
   * get(id)           - retrieve by id (returns null if not found)
   * list()            - return array of all registered adapter objects
   */
  RapidML.Adapters = {
    register: function (adapter) {
      if (adapter && adapter.id) {
        adapters[adapter.id] = adapter;
      }
    },
    get: function (id) {
      return adapters[id] || null;
    },
    list: function () {
      return Object.keys(adapters).map(function (k) { return adapters[k]; });
    }
  };
})();

// ============================================================================
// METHODOLOGY PLUGIN MANAGEMENT
// ============================================================================
// Methodologies define HOW to build the cohort (e.g., longitudinal prediction).
// Each plugin provides SQL generation and rule documentation.
//
// Methodology interface:
//   id                       -> unique string, e.g. "longitudinal-prediction"
//   label                    -> human-readable name for dropdown
//   buildSQL(config, db)     -> complete SQL string
//   describeRules(config)    -> Markdown string for README

/** Register a new methodology plugin. */
RapidML.Methodologies.register = function(plugin) {
  RapidML.Methodologies[plugin.id] = plugin;
};

/** Retrieve a single methodology by ID. */
RapidML.Methodologies.get = function(id) {
  return RapidML.Methodologies[id];
};

/** Get all registered methodologies as an array. */
RapidML.Methodologies.list = function() {
  return Object.keys(RapidML.Methodologies).filter(function(k) {
    return RapidML.Methodologies[k] && RapidML.Methodologies[k].id;
  }).map(function(k) { return RapidML.Methodologies[k]; });
};

// ============================================================================
// ANALYSIS TEMPLATE PLUGIN MANAGEMENT
// ============================================================================
// Analysis templates define analysis code generation (e.g., logistic regression).
// Each template produces analysis scripts based on the selected methodology.
//
// Template interface:
//   id                       -> unique string, e.g. "logistic-regression"
//   label                    -> human-readable name for dropdown
//   filename                 -> output filename, e.g. "run.py"
//   buildScript(config)      -> complete script string

/** Register a new analysis template plugin. */
RapidML.AnalysisTemplates.register = function(plugin) {
  RapidML.AnalysisTemplates[plugin.id] = plugin;
};

/** Retrieve a single analysis template by ID. */
RapidML.AnalysisTemplates.get = function(id) {
  return RapidML.AnalysisTemplates[id];
};

/** Get all registered analysis templates as an array. */
RapidML.AnalysisTemplates.list = function() {
  return Object.keys(RapidML.AnalysisTemplates).filter(function(k) {
    return RapidML.AnalysisTemplates[k] && RapidML.AnalysisTemplates[k].id;
  }).map(function(k) { return RapidML.AnalysisTemplates[k]; });
};

// ============================================================================
// UTILITY FUNCTIONS
// ============================================================================

/**
 * Download a file to the user's computer.
 *
 * Creates a temporary Blob URL, triggers a click on a hidden anchor,
 * then cleans up.  Used for individual file fallback when JSZip is
 * unavailable.
 *
 * @param {string} filename - Name for the downloaded file
 * @param {string} text     - File content
 * @param {string} mimeType - MIME type (default "text/plain")
 */
function download(filename, text, mimeType) {
  mimeType = mimeType || "text/plain";
  var blob = new Blob([text], { type: mimeType });
  var url = window.URL.createObjectURL(blob);
  var link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  window.URL.revokeObjectURL(url);
}

/**
 * Download a pre-built Blob (used for zip packages).
 *
 * @param {string} filename - Name for the downloaded file
 * @param {Blob}   blob     - Binary content
 */
function downloadBlob(filename, blob) {
  var url = window.URL.createObjectURL(blob);
  var link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  window.URL.revokeObjectURL(url);
}

/**
 * Build a filesystem-safe timestamp like 20260414_091530.
 * Used to make every generated file uniquely identifiable.
 *
 * @return {string} timestamp in YYYYMMdd_HHmmss format
 */
function buildTimestamp() {
  var now = new Date();
  var yyyy = String(now.getFullYear());
  var mm = String(now.getMonth() + 1).padStart(2, "0");
  var dd = String(now.getDate()).padStart(2, "0");
  var hh = String(now.getHours()).padStart(2, "0");
  var mi = String(now.getMinutes()).padStart(2, "0");
  var ss = String(now.getSeconds()).padStart(2, "0");
  return yyyy + mm + dd + "_" + hh + mi + ss;
}

/**
 * Add timestamp before extension so each generated file is uniquely
 * identifiable.  E.g. "study.sql" -> "study_20260414_091530.sql"
 *
 * @param  {string} filename  original file name
 * @param  {string} timestamp from buildTimestamp()
 * @return {string}           timestamped file name
 */
function withTimestamp(filename, timestamp) {
  var lastDot = filename.lastIndexOf(".");
  if (lastDot <= 0) {
    return filename + "_" + timestamp;
  }
  var base = filename.slice(0, lastDot);
  var ext = filename.slice(lastDot);
  return base + "_" + timestamp + ext;
}

/**
 * Package all generated files into one zip (preferred) or fall back to
 * individual file downloads when JSZip is not available.
 *
 * @param {Array}  files     array of {filename, content, mimeType}
 * @param {string} timestamp from buildTimestamp()
 */
function downloadPackage(files, timestamp) {
  if (window.JSZip) {
    var zip = new window.JSZip();
    files.forEach(function(file) {
      zip.file(withTimestamp(file.filename, timestamp), file.content);
    });

    zip.generateAsync({ type: "blob" }).then(function(zipBlob) {
      downloadBlob("rapidmlready_package_" + timestamp + ".zip", zipBlob);
    });
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
 * Normalises raw form data into a clean, consistent study configuration.
 * Ensures all required fields have defaults and proper types.
 *
 * @param  {object} raw  raw form data from getFormConfig()
 * @return {object}      normalised config ready for SQL compiler
 */
function normalizeConfig(raw) {
  // Default covariates if user does not select any
  var defaults = [
    "age_at_index",
    "sex_concept_id",
    "baseline_condition_count",
    "baseline_drug_count",
    "baseline_visit_count",
    "baseline_measurement_count"
  ];

  var config = {
    // DATABASE SETTINGS
    db: raw.db || "postgres",
    schema: raw.schema || "",
    dataModel: raw.dataModel || "omop",
    startYear: String(raw.startYear || "2016"),
    endYear: String(raw.endYear || "2024"),

    // TIMEFRAMES (in days)
    baselineDays: String(raw.baselineDays || "365"),
    outcomeDays: String(raw.outcomeDays || "365"),

    // OPTIONS
    debug: !!raw.debug,
    bestPracticeMode: !!raw.bestPracticeMode,

    // PLUGIN SELECTIONS
    methodology: raw.methodology || "longitudinal-prediction",
    analysisTemplate: raw.analysisTemplate || "logistic-regression",

    // COVARIATES (features to include)
    covariateEncoding: raw.covariateEncoding || "count",
    covariates: Array.isArray(raw.covariates) && raw.covariates.length ? raw.covariates : defaults,
    customCovariates: Array.isArray(raw.customCovariates) ? raw.customCovariates : []
  };

  // STUDY DEFINITION (evidence blocks)
  if (raw.study) {
    config.study = raw.study;
  }

  return config;
}

// ============================================================================
// FORM DATA COLLECTION
// ============================================================================

/**
 * Read all form inputs from the HTML and collect into a raw config object.
 * Uses EvidenceUI to collect the study definition evidence blocks.
 *
 * @return {object} normalised config data
 */
function getFormConfig() {
  // Collect all checked covariate checkboxes into an array
  var covariateEls = document.querySelectorAll('input[name="covariates"]:checked');
  var selectedCovariates = [];
  for (var i = 0; i < covariateEls.length; i++) {
    selectedCovariates.push(covariateEls[i].value);
  }

  // Collect custom covariates (user-defined concept ID rows)
  var customCovariates = [];
  if (typeof collectCustomCovariates === "function") {
    customCovariates = collectCustomCovariates();
  }

  // Collect evidence-based study definition from the UI
  var study = null;
  if (RapidML.EvidenceUI && typeof RapidML.EvidenceUI.collectStudyDefinition === "function") {
    study = RapidML.EvidenceUI.collectStudyDefinition();
  }

  // Collect all form fields and normalize
  return normalizeConfig({
    db: document.getElementById("db").value,
    schema: document.getElementById("schema").value,
    dataModel: document.getElementById("dataModel") ? document.getElementById("dataModel").value : "omop",
    startYear: document.getElementById("startYear").value,
    endYear: document.getElementById("endYear").value,
    baselineDays: document.getElementById("baselineDays").value,
    outcomeDays: document.getElementById("outcomeDays").value,
    debug: document.getElementById("debugMode").checked,
    methodology: document.getElementById("methodology") ? document.getElementById("methodology").value : "longitudinal-prediction",
    analysisTemplate: document.getElementById("analysisTemplate") ? document.getElementById("analysisTemplate").value : "logistic-regression",
    bestPracticeMode: document.getElementById("bestPracticeMode") ? document.getElementById("bestPracticeMode").checked : false,
    covariateEncoding: document.getElementById("covariateEncoding") ? document.getElementById("covariateEncoding").value : "count",
    covariates: selectedCovariates,
    customCovariates: customCovariates,
    study: study
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

  // Baseline/outcome window (days)
  if (parseInt(config.baselineDays, 10) <= 0) {
    errors.push("Baseline period (days) must be positive.");
  }
  if (parseInt(config.outcomeDays, 10) <= 0) {
    errors.push("Outcome window (days) must be positive.");
  }

  // Evidence block validation
  if (config.study) {
    if (!config.study.entry || !config.study.entry.rows || config.study.entry.rows.length === 0) {
      errors.push("At least one cohort entry evidence row is required.");
    }
    if (!config.study.outcome || !config.study.outcome.rows || config.study.outcome.rows.length === 0) {
      errors.push("At least one outcome evidence row is required.");
    }

    // Validate operators in evidence rows
    var allRows = [].concat(
      (config.study.entry && config.study.entry.rows) || [],
      (config.study.outcome && config.study.outcome.rows) || [],
      config.study.exclusions || [],
      config.study.confounders || []
    );
    allRows.forEach(function(row) {
      if (row.type === "lab" && row.operator) {
        row.operator = validateOperator(row.operator);
      }
    });
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
 *   1. Collect form config              (getFormConfig)
 *   2. Validate inputs                  (validateConfig)
 *   3. Get selected methodology plugin  (e.g. "longitudinal-prediction")
 *   4. Get selected analysis template   (e.g. "logistic-regression")
 *   5. methodology.buildSQL(config)     -> study.sql content
 *   6. methodology.describeRules(cfg)   -> README.md content
 *   7. template.buildScript(config)     -> analysis script content
 *   8. If best-practice mode, add extra artifacts
 *   9. Package everything into a timestamped zip
 */
function generate() {
  // Collect and normalise all form inputs
  var config = getFormConfig();

  // Validate inputs before SQL generation
  var validationErrors = validateConfig(config);
  if (validationErrors.length > 0) {
    alert("Configuration errors:\n\n• " + validationErrors.join("\n• "));
    return;
  }

  // Load selected plugins
  var methodology = RapidML.Methodologies.get(config.methodology);
  var template = RapidML.AnalysisTemplates.get(config.analysisTemplate);

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
    var sql = methodology.buildSQL(config, config.db);
    var readme = methodology.describeRules(config);
    var runScript = template.buildScript(config);
    var timestamp = buildTimestamp();

    var files = [
      { filename: "study.sql", content: sql, mimeType: "text/plain" },
      { filename: "README.md", content: readme, mimeType: "text/markdown" },
      { filename: template.filename, content: runScript, mimeType: "text/plain" }
    ];

    // Add optional best-practice artifacts if enabled.
    if (config.bestPracticeMode && RapidML.Compiler && typeof RapidML.Compiler.buildArtifacts === "function") {
      var artifacts = RapidML.Compiler.buildArtifacts(config, methodology.id);
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

    downloadPackage(files, timestamp);
  } catch (err) {
    alert("Package generation failed: " + (err && err.message ? err.message : err));
  }
}
