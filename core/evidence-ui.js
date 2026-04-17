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
 *     conceptId:       OMOP concept ID string, e.g. "201826"
 *     descendants:     boolean - include concept_ancestor descendants?
 *     operator:        lab/observation only: ">" | "<" | ">=" | "<="
 *     value:           lab/observation only: numeric threshold
 *     label:           human-readable name (auto or manual)
 *     minCount:        minimum number of matching records (default 1)
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
 *   applyDiabetesExample(entry, outcome)    -> pre-fill example
 *   applyDiabetesLabExample(entry, outcome) -> pre-fill lab example
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

  var rowCounter = 0;

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

    row.innerHTML = [
      '<div class="w-36">',
      '  <label class="block text-[10px] font-semibold text-slate-500 mb-0.5">Type</label>',
      '  <select class="ev-type form-input border border-slate-300 p-1.5 w-full rounded text-xs">' + typeOptions + '</select>',
      '</div>',

      '<div class="w-32">',
      '  <label class="block text-[10px] font-semibold text-slate-500 mb-0.5">Concept ID</label>',
      '  <input type="text" class="ev-concept form-input border border-slate-300 p-1.5 w-full rounded text-xs" placeholder="e.g. 201826" value="' + (defaults.conceptId || "") + '"/>',
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
      var operator = el.querySelector(".ev-operator") ? el.querySelector(".ev-operator").value : ">";
      var value = el.querySelector(".ev-value") ? el.querySelector(".ev-value").value.trim() : "";
      var descendants = el.querySelector(".ev-descendants") ? el.querySelector(".ev-descendants").checked : true;
      var label = el.querySelector(".ev-label") ? el.querySelector(".ev-label").value.trim() : "";

      var minCountRaw = el.querySelector(".ev-min-count") ? parseInt(el.querySelector(".ev-min-count").value, 10) : 1;
      var minCount = (minCountRaw > 1) ? minCountRaw : 1;
      var distinctVisits = el.querySelector(".ev-distinct-visits") ? el.querySelector(".ev-distinct-visits").checked : false;
      var visitCtxEl = el.querySelector(".ev-visit-ctx");
      var visitContextMode = visitCtxEl ? visitCtxEl.value : "all";
      var visitCtxIdsEl = el.querySelector(".ev-visit-ctx-ids");
      var visitContextIds = (visitContextMode === "custom" && visitCtxIdsEl)
        ? visitCtxIdsEl.value.split(",").map(function(s) { return s.trim(); }).filter(Boolean)
        : [];

      if (conceptIdVal) {
        var hasValue = (type === "lab" || type === "observation");
        var hasDesc  = (type !== "lab" && type !== "visit");
        var hasDV    = (type !== "lab" && type !== "visit");
        var hasVC    = (VISIT_LINKABLE.indexOf(type) >= 0);
        rows.push({
          type: type,
          conceptId: conceptIdVal,
          descendants: hasDesc ? descendants : false,
          operator: hasValue ? operator : null,
          value: hasValue ? value : null,
          label: label || null,
          minCount: minCount,
          distinctVisits: hasDV ? distinctVisits : false,
          visitContext: hasVC ? visitContextMode : "all",
          visitContextIds: (hasVC && visitContextMode === "custom") ? visitContextIds : []
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
      var operator = el.querySelector(".ev-operator") ? el.querySelector(".ev-operator").value : ">";
      var value = el.querySelector(".ev-value") ? el.querySelector(".ev-value").value.trim() : "";
      var descendants = el.querySelector(".ev-descendants") ? el.querySelector(".ev-descendants").checked : true;
      var label = el.querySelector(".ev-label") ? el.querySelector(".ev-label").value.trim() : "";

      var minCountRaw = el.querySelector(".ev-min-count") ? parseInt(el.querySelector(".ev-min-count").value, 10) : 1;
      var minCount = (minCountRaw > 1) ? minCountRaw : 1;
      var distinctVisits = el.querySelector(".ev-distinct-visits") ? el.querySelector(".ev-distinct-visits").checked : false;
      var visitCtxEl2 = el.querySelector(".ev-visit-ctx");
      var visitContextMode2 = visitCtxEl2 ? visitCtxEl2.value : "all";
      var visitCtxIdsEl2 = el.querySelector(".ev-visit-ctx-ids");
      var visitContextIds2 = (visitContextMode2 === "custom" && visitCtxIdsEl2)
        ? visitCtxIdsEl2.value.split(",").map(function(s) { return s.trim(); }).filter(Boolean)
        : [];

      if (conceptIdVal) {
        var hasValue = (type === "lab" || type === "observation");
        var hasDesc  = (type !== "lab" && type !== "visit");
        var hasDV    = (type !== "lab" && type !== "visit");
        var hasVC    = (VISIT_LINKABLE.indexOf(type) >= 0);
        items.push({
          type: type,
          conceptId: conceptIdVal,
          descendants: hasDesc ? descendants : false,
          operator: hasValue ? operator : null,
          value: hasValue ? value : null,
          label: label || ("item_" + items.length),
          minCount: minCount,
          distinctVisits: hasDV ? distinctVisits : false,
          visitContext: hasVC ? visitContextMode2 : "all",
          visitContextIds: (hasVC && visitContextMode2 === "custom") ? visitContextIds2 : []
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

  // ── Pre-fill with example study (diabetes → nephropathy) ──────

  function applyDiabetesExample(entryHandle, outcomeHandle) {
    // Clear existing rows
    ["entryBlock", "outcomeBlock", "exclusionsBlock", "confoundersBlock"].forEach(function (id) {
      var container = document.getElementById(id);
      if (container) {
        container.querySelectorAll(".evidence-row").forEach(function (row) { row.remove(); });
      }
    });

    // Entry: Type 2 Diabetes diagnosis
    if (entryHandle) {
      entryHandle.addRow({ type: "diagnosis", conceptId: "201826", descendants: true });
    }

    // Outcome: Diabetic nephropathy
    if (outcomeHandle) {
      outcomeHandle.addRow({ type: "diagnosis", conceptId: "443767", descendants: true });
    }

    if (typeof updateSelfCheck === "function") updateSelfCheck();
  }

  function applyDiabetesLabExample(entryHandle, outcomeHandle) {
    // Clear existing rows
    ["entryBlock", "outcomeBlock", "exclusionsBlock", "confoundersBlock"].forEach(function (id) {
      var container = document.getElementById(id);
      if (container) {
        container.querySelectorAll(".evidence-row").forEach(function (row) { row.remove(); });
      }
    });

    // Entry: T2DM diagnosis + eGFR < 60
    if (entryHandle) {
      entryHandle.addRow({ type: "diagnosis", conceptId: "201826", descendants: true });
      entryHandle.addRow({ type: "lab", conceptId: "3020460", operator: "<", value: "60" });
    }

    // Outcome: eGFR < 30
    if (outcomeHandle) {
      outcomeHandle.addRow({ type: "lab", conceptId: "3020460", operator: "<", value: "30" });
    }

    if (typeof updateSelfCheck === "function") updateSelfCheck();
  }

  // ── Public API ────────────────────────────────────────────────

  RapidML.EvidenceUI = {
    renderBlock: renderBlock,
    collectBlockData: collectBlockData,
    collectListData: collectListData,
    collectStudyDefinition: collectStudyDefinition,
    applyDiabetesExample: applyDiabetesExample,
    applyDiabetesLabExample: applyDiabetesLabExample
  };

})();
