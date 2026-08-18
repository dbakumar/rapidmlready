/**
 * ============================================================================
 * EVIDENCE-UI.JS  -  Dynamic Evidence Block UI Component
 * ============================================================================
 *
 * PURPOSE:
 *   Renders interactive row-based evidence forms for the Study Definition
 *   step (step 2) of the wizard.  Each "evidence block" is a container
 *   that holds one or more evidence rows.  The user can add, remove, and
 *   configure rows to describe clinical criteria.
 *
 * EVIDENCE BLOCKS (4 blocks in the wizard):
 *   1. Entry       - defines who enters the study cohort
 *   2. Outcome     - defines the clinical event to predict
 *   3. Exclusions  - patients matching any exclusion row are removed
 *   4. Confounders - tracked as binary flag columns in the output
 *
 * EVIDENCE ROW FORMAT (each row is a plain object):
 *   {
 *     type:            "diagnosis" | "lab" | "drug" | "procedure" |
 *                      "observation" | "visit"
 *     conceptId:       first concept/code token (legacy compatibility)
 *     conceptIds:      array of concept/code tokens (e.g. ["201826","E11.9"])
 *     codingMethod:    "concept_id" | "icd10" | "icd9" | "rxnorm" |
 *                      "loinc" | "snomed" | "source_value"
 *     descendants:     boolean - include concept_ancestor descendants?
 *     operator:        lab/observation only: ">" | "<" | ">=" | "<="
 *     value:           lab/observation only: numeric threshold
 *     label:           human-readable name (auto or manual)
 *     minCount:        minimum number of matching records (default 1)
 *     minSpacingDays:  require qualifying events to be this many days apart
 *     distinctVisits:  count distinct visit_occurrence IDs?
 *     visitContext:    "all" | "inpatient" | "outpatient" | "emergency" |
 *                      "custom"
 *     visitContextIds: array of custom visit concept IDs
 *   }
 *
 * HOW DATA FLOWS:
 *   renderBlock(containerId) -> renders DOM form elements
 *                     |
 *   user interacts    |  adds/removes rows, changes dropdowns
 *                     v
 *   collectStudyDefinition() -> returns study definition object
 *                     |
 *                     v
 *   generator.js / compiler picks up the object for SQL generation
 *
 * DEPENDS ON:  nothing (pure DOM manipulation)
 * USED BY:     core/wizard-ui.js (initialisation)
 *              core/generator.js (collectStudyDefinition via getFormConfig)
 *
 * PUBLIC API (exposed on RapidML.EvidenceUI):
 *   renderBlock(containerId, options)       -> block handle
 *   collectBlockData(containerId)           -> { match, rows[] }
 *   collectListData(containerId)            -> rows[]
 *   collectStudyDefinition()                -> full study definition
 *   applyFairviewExample(entry, outcome,    -> pre-fill the full
 *     exclusions, confounders)                 Fairview worked example
 * ============================================================================
 */
(function () {
  window.RapidML = window.RapidML || {};

  var ROW_TYPES = [
    { value: "diagnosis",    label: "Diagnosis" },
    { value: "lab",          label: "Lab / Measurement" },
    { value: "drug",         label: "Drug Exposure" },
    { value: "procedure",    label: "Procedure" },
    { value: "observation",  label: "Observation" },
    { value: "visit",        label: "Visit" }
  ];

  // Row types that can link to visit_occurrence for visit-context filtering
  var VISIT_LINKABLE = ["diagnosis", "lab", "drug", "procedure", "observation"];

  var VISIT_CONTEXT_OPTIONS = [
    { value: "all",        label: "Any visit" },
    { value: "inpatient",  label: "Inpatient" },
    { value: "outpatient", label: "Outpatient" },
    { value: "emergency",  label: "ER/Emergency" },
    { value: "custom",     label: "Custom IDs…" }
  ];

  var CODING_METHOD_OPTIONS = [
    { value: "concept_id", label: "OMOP Concept ID" },
    { value: "icd10", label: "ICD-10" },
    { value: "icd9", label: "ICD-9" },
    { value: "rxnorm", label: "RxNorm" },
    { value: "loinc", label: "LOINC" },
    { value: "snomed", label: "SNOMED" },
    { value: "source_value", label: "Raw Source Value" }
  ];

  var rowCounter = 0;

  function parseConceptTokens(value) {
    return String(value || "")
      .split(/[\s,;|]+/)
      .map(function (token) { return token.trim(); })
      .filter(Boolean);
  }

  function parseIdList(value) {
    return String(value || "")
      .split(/[\s,;|]+/)
      .map(function (token) { return token.trim(); })
      .filter(Boolean);
  }

  // ── Render a single evidence row ──────────────────────────────

  function createRowElement(blockId, defaults) {
    defaults = defaults || {};
    var rowId = "ev_row_" + (++rowCounter);
    var row = document.createElement("div");
    row.className = "evidence-row flex flex-wrap items-end gap-2 p-3 bg-slate-50 border border-slate-200 rounded-md mb-2";
    row.setAttribute("data-row-id", rowId);

    // Type dropdown
    var typeOptions = ROW_TYPES.map(function (t) {
      var sel = t.value === (defaults.type || "diagnosis") ? " selected" : "";
      return '<option value="' + t.value + '"' + sel + '>' + t.label + '</option>';
    }).join("");

    // Show/hide fields based on default type
    var type = defaults.type || "diagnosis";
    var showValue    = (type === "lab" || type === "observation");
    var showDesc     = (type !== "lab" && type !== "visit");
    var showDV       = (type !== "lab" && type !== "visit");
    var showVisitCtx = (VISIT_LINKABLE.indexOf(type) >= 0);
    var valueDisplay    = showValue    ? "" : "display:none;";
    var descDisplay     = showDesc     ? "" : "display:none;";
    var dvDisplay       = showDV       ? "" : "display:none;";
    var visitCtxDisplay = showVisitCtx ? "" : "display:none;";

    var conceptInputValue = Array.isArray(defaults.conceptIds) && defaults.conceptIds.length
      ? defaults.conceptIds.join(", ")
      : (defaults.conceptId || "");

    row.innerHTML = [
      '<div class="w-36">',
      '  <label class="block text-[10px] font-semibold text-slate-500 mb-0.5">Type</label>',
      '  <select class="ev-type form-input border border-slate-300 p-1.5 w-full rounded text-xs">' + typeOptions + '</select>',
      '</div>',

      '<div class="w-32">',
      '  <label class="block text-[10px] font-semibold text-slate-500 mb-0.5">Coding Method</label>',
      '  <select class="ev-coding-method form-input border border-slate-300 p-1.5 w-full rounded text-xs" title="How to interpret the values you type. OMOP Concept ID = numeric standard IDs (e.g. 201826). ICD-10 / RxNorm / LOINC / SNOMED = source codes mapped via the OMOP vocabulary. Raw Source Value = literal match on *_source_value.">',
      CODING_METHOD_OPTIONS.map(function(o) {
          var sel = o.value === (defaults.codingMethod || "concept_id") ? " selected" : "";
          return '      <option value="' + o.value + '"' + sel + '>' + o.label + '</option>';
        }).join(""),
      '  </select>',
      '</div>',

      '<div class="w-40">',
      '  <label class="block text-[10px] font-semibold text-slate-500 mb-0.5">Code Values <a href="https://athena.ohdsi.org/search-terms/start" target="_blank" rel="noopener noreferrer" class="text-blue-500 hover:underline" title="Look up concept IDs on Athena OHDSI">Athena \u2197</a></label>',
      '  <input type="text" class="ev-concept form-input border border-slate-300 p-1.5 w-full rounded text-xs" placeholder="e.g. 201826, E11.9" value="' + conceptInputValue + '" title="Enter one or more values, comma or space separated. Examples: Concept ID 201826 = Type 2 Diabetes; 443767 = Diabetic Nephropathy; 3004410 = HbA1c; 1545999 = Metformin. For code lists use ICD-10 (E11.9) or RxNorm and set the Coding Method. Use the Athena link to look up IDs."/>',
      '</div>',

      '<div class="ev-visit-ctx-field" style="' + visitCtxDisplay + '">',
      '  <label class="block text-[10px] font-semibold text-slate-500 mb-0.5">Visit Context</label>',
      '  <div class="flex gap-1 items-center">',
      '    <select class="ev-visit-ctx form-input border border-slate-300 p-1.5 w-28 rounded text-xs">',
      VISIT_CONTEXT_OPTIONS.map(function(o) {
          var sel = o.value === (defaults.visitContext || "all") ? " selected" : "";
          return '      <option value="' + o.value + '"' + sel + '>' + o.label + '</option>';
        }).join(""),
      '    </select>',
      '    <input type="text" class="ev-visit-ctx-ids form-input border border-slate-300 p-1.5 rounded text-xs w-24" placeholder="9201,9202"',
      '      style="' + ((defaults.visitContext === "custom") ? "" : "display:none;") + '"',
      '      value="' + (defaults.visitContextIds || "") + '" title="Comma-separated visit concept IDs"/>',
      '  </div>',
      '</div>',

      '<div class="ev-lab-fields flex gap-2" style="' + valueDisplay + '">',
      '  <div class="w-20">',
      '    <label class="block text-[10px] font-semibold text-slate-500 mb-0.5">Operator</label>',
      '    <select class="ev-operator form-input border border-slate-300 p-1.5 w-full rounded text-xs">',
      '      <option value=">"' + (defaults.operator === ">" ? " selected" : "") + '>&gt;</option>',
      '      <option value="<"' + (defaults.operator === "<" ? " selected" : "") + '>&lt;</option>',
      '      <option value=">="' + (defaults.operator === ">=" ? " selected" : "") + '>&gt;=</option>',
      '      <option value="<="' + (defaults.operator === "<=" ? " selected" : "") + '>&lt;=</option>',
      '    </select>',
      '  </div>',
      '  <div class="w-20">',
      '    <label class="block text-[10px] font-semibold text-slate-500 mb-0.5">Value</label>',
      '    <input type="number" class="ev-value form-input border border-slate-300 p-1.5 w-full rounded text-xs" placeholder="e.g. 60" value="' + (defaults.value || "") + '"/>',
      '  </div>',
      '</div>',

      '<div class="ev-desc-field flex items-center gap-1" style="' + descDisplay + '">',
      '  <label class="flex items-center gap-1 text-[10px] text-slate-500 cursor-pointer mt-4">',
      '    <input type="checkbox" class="ev-descendants w-3 h-3 rounded"' + (defaults.descendants !== false ? " checked" : "") + '/>',
      '    <span>+ descendants</span>',
      '  </label>',
      '</div>',

      '<div class="w-14">',
      '  <label class="block text-[10px] font-semibold text-slate-500 mb-0.5">Min #</label>',
      '  <input type="number" class="ev-min-count form-input border border-slate-300 p-1.5 w-full rounded text-xs" min="1" step="1" placeholder="1" value="' + (defaults.minCount > 1 ? defaults.minCount : "") + '" title="Minimum number of matching records (default: 1)"/>',
      '</div>',

      '<div class="w-16">',
      '  <label class="block text-[10px] font-semibold text-slate-500 mb-0.5">Gap Days</label>',
      '  <input type="number" class="ev-min-spacing form-input border border-slate-300 p-1.5 w-full rounded text-xs" min="0" step="1" placeholder="0" value="' + (defaults.minSpacingDays > 0 ? defaults.minSpacingDays : "") + '" title="Require events to be at least N days apart (e.g. 30)"/>',
      '</div>',

      '<div class="ev-dxtype-field w-28" style="' + (type === "diagnosis" ? "" : "display:none;") + '">',
      '  <label class="block text-[10px] font-semibold text-slate-500 mb-0.5">Dx Type IDs <a href="https://athena.ohdsi.org/search-terms/terms?query=condition%20type" target="_blank" rel="noopener noreferrer" class="text-blue-500 hover:underline" title="Look up condition_type_concept_id values on Athena">\u2197</a></label>',
      '  <input type="text" class="ev-dxtype-ids form-input border border-slate-300 p-1.5 w-full rounded text-xs" placeholder="e.g. 32020" value="' + (defaults.conditionTypeIds || "") + '" title="Comma-separated condition_type_concept_id values (diagnosis provenance). Example: 32020 = EHR encounter diagnosis. Leave blank for any type. Use the Athena link to find more."/>',
      '</div>',

      '<div class="ev-drug-attr-field flex gap-2" style="' + (type === "drug" ? "" : "display:none;") + '">',
      '  <div class="w-24">',
      '    <label class="block text-[10px] font-semibold text-slate-500 mb-0.5">Route IDs <a href="https://athena.ohdsi.org/search-terms/terms?query=route" target="_blank" rel="noopener noreferrer" class="text-blue-500 hover:underline" title="Look up route_concept_id values on Athena">\u2197</a></label>',
      '    <input type="text" class="ev-drug-route-ids form-input border border-slate-300 p-1.5 w-full rounded text-xs" placeholder="e.g. 4132161" value="' + (defaults.drugRouteIds || "") + '" title="Comma-separated route_concept_id values. Examples: 4132161 = Oral, 4263689 = Topical. Leave blank for any route. Use the Athena link to find more."/>',
      '  </div>',
      '  <div class="w-24">',
      '    <label class="block text-[10px] font-semibold text-slate-500 mb-0.5">Order/Type IDs <a href="https://athena.ohdsi.org/search-terms/terms?query=drug%20type" target="_blank" rel="noopener noreferrer" class="text-blue-500 hover:underline" title="Look up drug_type_concept_id values on Athena">\u2197</a></label>',
      '    <input type="text" class="ev-drug-type-ids form-input border border-slate-300 p-1.5 w-full rounded text-xs" placeholder="e.g. 38000177" value="' + (defaults.drugTypeIds || "") + '" title="Comma-separated drug_type_concept_id values (order/exposure provenance). Examples: 38000177 = Prescription written, 38000175 = Prescription dispensed in pharmacy. Leave blank for any. Use the Athena link to find more."/>',
      '  </div>',
      '</div>',

      '<div class="ev-dv-field flex items-center gap-1" style="' + dvDisplay + '">',
      '  <label class="flex items-center gap-1 text-[10px] text-slate-500 cursor-pointer mt-4">',
      '    <input type="checkbox" class="ev-distinct-visits w-3 h-3 rounded"' + (defaults.distinctVisits ? " checked" : "") + '/>',
      '    <span>distinct visits</span>',
      '  </label>',
      '</div>',

      '<div class="ev-label-field w-32" style="' + (defaults.showLabel ? "" : "display:none;") + '">',
      '  <label class="block text-[10px] font-semibold text-slate-500 mb-0.5">Label</label>',
      '  <input type="text" class="ev-label form-input border border-slate-300 p-1.5 w-full rounded text-xs" placeholder="e.g. hypertension" value="' + (defaults.label || "") + '"/>',
      '</div>',

      '<button type="button" class="ev-delete mt-4 text-red-400 hover:text-red-600 text-xs font-bold px-2 py-1 rounded transition-colors" title="Remove row">&times;</button>'
    ].join("\n");

    // Wire type change → show/hide lab fields, descendants, distinct visits, visit context
    var typeSelect = row.querySelector(".ev-type");
    var labFields = row.querySelector(".ev-lab-fields");
    var descField = row.querySelector(".ev-desc-field");
    var dvField = row.querySelector(".ev-dv-field");
    var dxTypeField = row.querySelector(".ev-dxtype-field");
    var drugAttrField = row.querySelector(".ev-drug-attr-field");
    var visitCtxField = row.querySelector(".ev-visit-ctx-field");
    var visitCtxSelect = row.querySelector(".ev-visit-ctx");
    var visitCtxIds = row.querySelector(".ev-visit-ctx-ids");

    typeSelect.addEventListener("change", function () {
      var t = typeSelect.value;
      var showValue = (t === "lab" || t === "observation");
      var showDesc  = (t !== "lab" && t !== "visit");
      var showDV    = (t !== "lab" && t !== "visit");
      var showVC    = (VISIT_LINKABLE.indexOf(t) >= 0);
      labFields.style.display    = showValue ? "" : "none";
      descField.style.display    = showDesc  ? "" : "none";
      dvField.style.display      = showDV    ? "" : "none";
      visitCtxField.style.display = showVC   ? "" : "none";
      if (dxTypeField)   dxTypeField.style.display   = (t === "diagnosis") ? "" : "none";
      if (drugAttrField) drugAttrField.style.display = (t === "drug") ? "" : "none";
    });

    // Wire visit context dropdown → show/hide custom IDs input
    if (visitCtxSelect && visitCtxIds) {
      visitCtxSelect.addEventListener("change", function () {
        visitCtxIds.style.display = visitCtxSelect.value === "custom" ? "" : "none";
      });
    }

    // Wire delete button
    row.querySelector(".ev-delete").addEventListener("click", function () {
      row.remove();
      if (typeof updateSelfCheck === "function") updateSelfCheck();
    });

    return row;
  }

  // ── Render an evidence block (entry, outcome, exclusion, confounder) ──

  function renderBlock(containerId, options) {
    options = options || {};
    var container = document.getElementById(containerId);
    if (!container) return;

    var showMatch = options.showMatch !== false;
    var showLabel = !!options.showLabel;
    var blockLabel = options.label || "Evidence";

    // Match mode selector (for blocks with multiple rows)
    if (showMatch) {
      var matchDiv = document.createElement("div");
      matchDiv.className = "flex items-center gap-2 mb-3";
      matchDiv.innerHTML = [
        '<label class="text-xs font-semibold text-slate-600">Match mode:</label>',
        '<select class="ev-match form-input border border-slate-300 p-1 rounded text-xs w-32">',
        '  <option value="all">ALL rows match</option>',
        '  <option value="any">ANY row matches</option>',
        '</select>',
        '<span class="text-[10px] text-slate-400">How to combine multiple rows</span>'
      ].join("");
      container.appendChild(matchDiv);
    }

    // Rows container
    var rowsDiv = document.createElement("div");
    rowsDiv.className = "ev-rows";
    container.appendChild(rowsDiv);

    // Add row button
    var addBtn = document.createElement("button");
    addBtn.type = "button";
    addBtn.className = "mt-2 bg-slate-200 hover:bg-slate-300 text-slate-600 px-3 py-1 rounded text-xs font-medium transition-colors";
    addBtn.textContent = "+ Add " + blockLabel + " Row";
    addBtn.addEventListener("click", function () {
      var row = createRowElement(containerId, { showLabel: showLabel });
      rowsDiv.appendChild(row);
      if (typeof updateSelfCheck === "function") updateSelfCheck();
    });
    container.appendChild(addBtn);

    return {
      addRow: function (defaults) {
        defaults = defaults || {};
        defaults.showLabel = showLabel;
        var row = createRowElement(containerId, defaults);
        rowsDiv.appendChild(row);
        return row;
      },
      getRows: function () {
        return rowsDiv.querySelectorAll(".evidence-row");
      }
    };
  }

  // ── Collect a block's data from the DOM ───────────────────────

  function collectBlockData(containerId) {
    var container = document.getElementById(containerId);
    if (!container) return { match: "all", rows: [] };

    var matchSelect = container.querySelector(".ev-match");
    var match = matchSelect ? matchSelect.value : "all";

    var rows = [];
    container.querySelectorAll(".evidence-row").forEach(function (el) {
      var type = el.querySelector(".ev-type").value;
      var conceptIdVal = el.querySelector(".ev-concept").value.trim();
      var conceptTokens = parseConceptTokens(conceptIdVal);
      var operator = el.querySelector(".ev-operator") ? el.querySelector(".ev-operator").value : ">";
      var value = el.querySelector(".ev-value") ? el.querySelector(".ev-value").value.trim() : "";
      var descendants = el.querySelector(".ev-descendants") ? el.querySelector(".ev-descendants").checked : true;
      var label = el.querySelector(".ev-label") ? el.querySelector(".ev-label").value.trim() : "";
      var codingMethod = el.querySelector(".ev-coding-method") ? el.querySelector(".ev-coding-method").value : "concept_id";

      var minCountRaw = el.querySelector(".ev-min-count") ? parseInt(el.querySelector(".ev-min-count").value, 10) : 1;
      var minCount = (minCountRaw > 1) ? minCountRaw : 1;
      var minSpacingRaw = el.querySelector(".ev-min-spacing") ? parseInt(el.querySelector(".ev-min-spacing").value, 10) : 0;
      var minSpacingDays = (minSpacingRaw > 0) ? minSpacingRaw : 0;
      var distinctVisits = el.querySelector(".ev-distinct-visits") ? el.querySelector(".ev-distinct-visits").checked : false;
      var visitCtxEl = el.querySelector(".ev-visit-ctx");
      var visitContextMode = visitCtxEl ? visitCtxEl.value : "all";
      var visitCtxIdsEl = el.querySelector(".ev-visit-ctx-ids");
      var visitContextIds = (visitContextMode === "custom" && visitCtxIdsEl)
        ? visitCtxIdsEl.value.split(",").map(function(s) { return s.trim(); }).filter(Boolean)
        : [];

      var conditionTypeIds = (type === "diagnosis" && el.querySelector(".ev-dxtype-ids"))
        ? parseIdList(el.querySelector(".ev-dxtype-ids").value) : [];
      var drugRouteIds = (type === "drug" && el.querySelector(".ev-drug-route-ids"))
        ? parseIdList(el.querySelector(".ev-drug-route-ids").value) : [];
      var drugTypeIds = (type === "drug" && el.querySelector(".ev-drug-type-ids"))
        ? parseIdList(el.querySelector(".ev-drug-type-ids").value) : [];

      if (conceptTokens.length > 0) {
        var hasValue = (type === "lab" || type === "observation");
        var hasDesc  = (type !== "lab" && type !== "visit");
        var hasDV    = (type !== "lab" && type !== "visit");
        var hasVC    = (VISIT_LINKABLE.indexOf(type) >= 0);
        rows.push({
          type: type,
          conceptId: conceptTokens[0],
          conceptIds: conceptTokens,
          codingMethod: codingMethod,
          descendants: hasDesc ? descendants : false,
          operator: hasValue ? operator : null,
          value: hasValue ? value : null,
          label: label || null,
          minCount: minCount,
          minSpacingDays: minSpacingDays,
          distinctVisits: hasDV ? distinctVisits : false,
          visitContext: hasVC ? visitContextMode : "all",
          visitContextIds: (hasVC && visitContextMode === "custom") ? visitContextIds : [],
          conditionTypeIds: conditionTypeIds,
          drugRouteIds: drugRouteIds,
          drugTypeIds: drugTypeIds
        });
      }
    });

    return { match: match, rows: rows };
  }

  // ── Collect flat list data (exclusions, confounders) ──────────

  function collectListData(containerId) {
    var container = document.getElementById(containerId);
    if (!container) return [];

    var items = [];
    container.querySelectorAll(".evidence-row").forEach(function (el) {
      var type = el.querySelector(".ev-type").value;
      var conceptIdVal = el.querySelector(".ev-concept").value.trim();
      var conceptTokens = parseConceptTokens(conceptIdVal);
      var operator = el.querySelector(".ev-operator") ? el.querySelector(".ev-operator").value : ">";
      var value = el.querySelector(".ev-value") ? el.querySelector(".ev-value").value.trim() : "";
      var descendants = el.querySelector(".ev-descendants") ? el.querySelector(".ev-descendants").checked : true;
      var label = el.querySelector(".ev-label") ? el.querySelector(".ev-label").value.trim() : "";
      var codingMethod = el.querySelector(".ev-coding-method") ? el.querySelector(".ev-coding-method").value : "concept_id";

      var minCountRaw = el.querySelector(".ev-min-count") ? parseInt(el.querySelector(".ev-min-count").value, 10) : 1;
      var minCount = (minCountRaw > 1) ? minCountRaw : 1;
      var minSpacingRaw = el.querySelector(".ev-min-spacing") ? parseInt(el.querySelector(".ev-min-spacing").value, 10) : 0;
      var minSpacingDays = (minSpacingRaw > 0) ? minSpacingRaw : 0;
      var distinctVisits = el.querySelector(".ev-distinct-visits") ? el.querySelector(".ev-distinct-visits").checked : false;
      var visitCtxEl2 = el.querySelector(".ev-visit-ctx");
      var visitContextMode2 = visitCtxEl2 ? visitCtxEl2.value : "all";
      var visitCtxIdsEl2 = el.querySelector(".ev-visit-ctx-ids");
      var visitContextIds2 = (visitContextMode2 === "custom" && visitCtxIdsEl2)
        ? visitCtxIdsEl2.value.split(",").map(function(s) { return s.trim(); }).filter(Boolean)
        : [];

      var conditionTypeIds2 = (type === "diagnosis" && el.querySelector(".ev-dxtype-ids"))
        ? parseIdList(el.querySelector(".ev-dxtype-ids").value) : [];
      var drugRouteIds2 = (type === "drug" && el.querySelector(".ev-drug-route-ids"))
        ? parseIdList(el.querySelector(".ev-drug-route-ids").value) : [];
      var drugTypeIds2 = (type === "drug" && el.querySelector(".ev-drug-type-ids"))
        ? parseIdList(el.querySelector(".ev-drug-type-ids").value) : [];

      if (conceptTokens.length > 0) {
        var hasValue = (type === "lab" || type === "observation");
        var hasDesc  = (type !== "lab" && type !== "visit");
        var hasDV    = (type !== "lab" && type !== "visit");
        var hasVC    = (VISIT_LINKABLE.indexOf(type) >= 0);
        items.push({
          type: type,
          conceptId: conceptTokens[0],
          conceptIds: conceptTokens,
          codingMethod: codingMethod,
          descendants: hasDesc ? descendants : false,
          operator: hasValue ? operator : null,
          value: hasValue ? value : null,
          label: label || ("item_" + items.length),
          minCount: minCount,
          minSpacingDays: minSpacingDays,
          distinctVisits: hasDV ? distinctVisits : false,
          visitContext: hasVC ? visitContextMode2 : "all",
          visitContextIds: (hasVC && visitContextMode2 === "custom") ? visitContextIds2 : [],
          conditionTypeIds: conditionTypeIds2,
          drugRouteIds: drugRouteIds2,
          drugTypeIds: drugTypeIds2
        });
      }
    });

    return items;
  }

  // ── Collect the full study definition from the UI ─────────────

  function collectStudyDefinition() {
    return {
      entry: collectBlockData("entryBlock"),
      outcome: collectBlockData("outcomeBlock"),
      exclusions: collectListData("exclusionsBlock"),
      confounders: collectListData("confoundersBlock")
    };
  }

  // ── Pre-fill with the Fairview-style worked example ───────────
  //  Reproduces the Fairview AIM-AHEAD diabetic-nephropathy study:
  //  cohort entry, composite outcome, exclusions, comorbidity +
  //  medication confounders, covariates, and study-level censoring.

  function _exSetVal(id, val) {
    var el = document.getElementById(id);
    if (el) el.value = val;
  }

  function _exSetChecked(id, checked) {
    var el = document.getElementById(id);
    if (el) el.checked = !!checked;
  }

  function _exSetBlockMatch(containerId, mode) {
    var container = document.getElementById(containerId);
    if (!container) return;
    var sel = container.querySelector(".ev-match");
    if (sel) sel.value = mode;
  }

  function _exSetCovariates(values) {
    var els = document.querySelectorAll('input[name="covariates"]');
    Array.prototype.forEach.call(els, function (el) {
      el.checked = values.indexOf(el.value) >= 0;
    });
  }

  function applyFairviewExample(entryHandle, outcomeHandle, exclusionsHandle, confoundersHandle) {
    // Clear existing rows in all four blocks
    ["entryBlock", "outcomeBlock", "exclusionsBlock", "confoundersBlock"].forEach(function (id) {
      var container = document.getElementById(id);
      if (container) {
        container.querySelectorAll(".evidence-row").forEach(function (row) { row.remove(); });
      }
    });

    // ── Study-level settings (Fairview: 2016–2024, adults 18+, death censoring) ──
    _exSetVal("startYear", "2016");
    _exSetVal("endYear", "2024");
    _exSetVal("baselineDays", "365");
    _exSetVal("outcomeDays", "730");
    _exSetVal("minAgeAtEntry", "18");
    _exSetVal("maxAgeAtEntry", "");
    _exSetChecked("deathCensoring", true);

    // ── Cohort entry: 2+ Type 2 Diabetes diagnoses ≥30 days apart ──
    _exSetBlockMatch("entryBlock", "all");
    if (entryHandle) {
      entryHandle.addRow({
        type: "diagnosis", conceptId: "201826", conceptIds: ["201826"],
        codingMethod: "concept_id", descendants: true,
        minCount: 2, minSpacingDays: 30,
        label: "Type 2 Diabetes (2+ dx, 30d apart)"
      });
    }

    // ── Outcome: diabetic nephropathy — ANY confirmed path ──
    //  labs (2× ≥30d apart) OR 2+ nephropathy diagnoses ≥30d apart
    _exSetBlockMatch("outcomeBlock", "any");
    if (outcomeHandle) {
      outcomeHandle.addRow({
        type: "lab", conceptId: "3020564", conceptIds: ["3020564"],
        codingMethod: "concept_id", operator: ">", value: "1.4",
        minCount: 2, minSpacingDays: 30, label: "Creatinine > 1.4 (2x, 30d)"
      });
      outcomeHandle.addRow({
        type: "lab", conceptId: "3020460", conceptIds: ["3020460"],
        codingMethod: "concept_id", operator: "<", value: "60",
        minCount: 2, minSpacingDays: 30, label: "eGFR < 60 (2x, 30d)"
      });
      outcomeHandle.addRow({
        type: "lab", conceptId: "3025214", conceptIds: ["3025214"],
        codingMethod: "concept_id", operator: ">", value: "1.2",
        minCount: 2, minSpacingDays: 30, label: "Cystatin C > 1.2 (2x, 30d)"
      });
      outcomeHandle.addRow({
        type: "diagnosis", conceptId: "443767", conceptIds: ["443767"],
        codingMethod: "concept_id", descendants: true,
        minCount: 2, minSpacingDays: 30, label: "Diabetic nephropathy dx (2x, 30d)"
      });
    }

    // ── Exclusion: nondiabetic kidney disease (ICD-10 code list) ──
    if (exclusionsHandle) {
      exclusionsHandle.addRow({
        type: "diagnosis", codingMethod: "icd10",
        conceptId: "N04", conceptIds: ["N04", "N05.9", "Q61.2"],
        descendants: false, label: "Nondiabetic kidney disease"
      });
    }

    // ── Confounders: comorbidities (2+ dx, 30d apart) + kidney-protective drug classes (RxNorm) ──
    if (confoundersHandle) {
      confoundersHandle.addRow({
        type: "diagnosis", conceptId: "40481087", conceptIds: ["40481087"],
        codingMethod: "concept_id", descendants: true,
        minCount: 2, minSpacingDays: 30, label: "hypertension"
      });
      confoundersHandle.addRow({
        type: "diagnosis", conceptId: "315661", conceptIds: ["315661"],
        codingMethod: "concept_id", descendants: true,
        minCount: 2, minSpacingDays: 30, label: "cardiac_disease"
      });
      confoundersHandle.addRow({
        type: "diagnosis", conceptId: "80809", conceptIds: ["80809"],
        codingMethod: "concept_id", descendants: true, label: "acute_kidney_injury"
      });
      confoundersHandle.addRow({
        type: "drug", codingMethod: "rxnorm",
        conceptId: "29046", conceptIds: ["29046", "52175"],
        descendants: true, label: "RAAS_inhibitor"
      });
      confoundersHandle.addRow({
        type: "drug", codingMethod: "rxnorm",
        conceptId: "1545653", conceptIds: ["1545653", "1373458", "1488564"],
        descendants: true, label: "SGLT2_inhibitor"
      });
      confoundersHandle.addRow({
        type: "drug", codingMethod: "rxnorm",
        conceptId: "1991302", conceptIds: ["1991302", "1551291", "475968"],
        descendants: true, label: "GLP1_RA"
      });
      confoundersHandle.addRow({
        type: "drug", codingMethod: "rxnorm",
        conceptId: "9997", conceptIds: ["9997", "298869", "2562811"],
        descendants: true, label: "MRA"
      });
    }

    // ── Covariates mirroring Fairview demographics / labs / utilisation ──
    _exSetCovariates([
      "age_at_index", "sex_concept_id", "race_concept_id", "ethnicity_concept_id",
      "baseline_egfr", "baseline_creatinine", "baseline_bmi", "baseline_systolic_bp",
      "prior_hospitalization_flag", "prior_er_visit_flag", "prior_outcome_history"
    ]);

    if (typeof updateSelfCheck === "function") updateSelfCheck();
  }

  // ── Public API ────────────────────────────────────────────────

  RapidML.EvidenceUI = {
    renderBlock: renderBlock,
    collectBlockData: collectBlockData,
    collectListData: collectListData,
    collectStudyDefinition: collectStudyDefinition,
    applyFairviewExample: applyFairviewExample
  };

})();
