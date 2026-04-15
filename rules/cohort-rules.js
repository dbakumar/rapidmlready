/**
 * ============================================================================
 * COHORT RULES REGISTRY
 * ============================================================================
 * 
 * This file defines all predefined cohort entry rules used in the wizard.
 * A cohort rule answers: "When do patients enter the study?"
 * 
 * Each rule is stored with:
 * - id: unique identifier (used in HTML select dropdowns)
 * - label: user-friendly name displayed in UI
 * - help: detailed explanation shown when rule is selected
 * - inputRequirements: which input groups are needed for this rule
 * - inputRequirementMode: "all" (all required) or "any" (at least one required)
 * - description: extra detail for documentation
 * 
 * For developers:
 * - To ADD a new rule: add an object to the "rules" object below
 * - To USE a rule: call getRule(ruleId), getInputRequirements(ruleId), or isInputSatisfied(...)
 * - Input groups auto-show/hide based on updateFieldVisibility(ruleId)
 * ============================================================================
 */

window.RapidML = window.RapidML || {};

RapidML.CohortRules = {
  /**
   * RULE REGISTRY
   * Map of rule ID → rule definition
   * Each rule describes one way patients can enter the cohort
   */
  rules: {
    first_event: {
      id: "first_event",
      label: "1 condition record",
      help: "Patient enters cohort at the FIRST matching record of the selected condition concept. Simple and fast.",
      inputRequirements: { condition: true },
      inputRequirementMode: "all",
      description: "Earliest condition occurrence. Largest cohort, simplest logic."
    },

    visit_count: {
      id: "visit_count",
      label: "2 condition records on 2 distinct visits",
      help: "Patient enters AFTER the selected condition appears on 2 DIFFERENT VISITS. Reduces false positives.",
      inputRequirements: { condition: true },
      inputRequirementMode: "all",
      description: "Requires 2+ separate condition occurrences. Increases specificity."
    },

    condition_lab_diff_visits: {
      id: "condition_lab_diff_visits",
      label: "1 condition record and 1 lab record on different visits",
      help: "Patient enters ONLY when BOTH the condition AND lab threshold are met, on DIFFERENT VISITS.",
      inputRequirements: { condition: true, measurement: true },
      inputRequirementMode: "all",
      description: "Requires both clinical and lab evidence. Very specific entry criteria."
    },

    condition_or_lab: {
      id: "condition_or_lab",
      label: "1 condition record OR 1 lab record",
      help: "Patient enters when EITHER the condition occurs OR lab threshold is met, WHICHEVER HAPPENS FIRST.",
      inputRequirements: { condition: true, measurement: true },
      inputRequirementMode: "any",
      description: "Flexible entry: condition or lab, whichever comes first."
    }
  },

  /**
   * Retrieve a single rule by ID
   * Returns the rule object, or defaults to first_event if not found
   */
  getRule: function(ruleId) {
    return this.rules[ruleId] || this.rules.first_event;
  },

  /**
   * Get all rules as an array
   * Useful for populating dropdowns or iterating over all rules
   */
  getAll: function() {
    return Object.values(this.rules);
  },

  /**
   * Normalize rule input requirements to a complete shape.
   * This keeps the rest of the logic simple and future-proof.
   */
  getInputRequirements: function(ruleId) {
    const rule = this.getRule(ruleId);
    const requirements = rule.inputRequirements || {};
    return {
      condition: !!requirements.condition,
      measurement: !!requirements.measurement,
      procedure: !!requirements.procedure,
      observation: !!requirements.observation,
      mode: rule.inputRequirementMode === "any" ? "any" : "all"
    };
  },

  /**
   * Check whether a rule needs a specific input type.
   */
  requiresInput: function(ruleId, inputType) {
    const requirements = this.getInputRequirements(ruleId);
    return !!requirements[inputType];
  },

  /**
   * Evaluate whether provided inputs satisfy the selected rule.
   * inputState uses booleans for condition/measurement/procedure/observation.
   */
  isInputSatisfied: function(ruleId, inputState) {
    const requirements = this.getInputRequirements(ruleId);
    const requiredTypes = ["condition", "measurement", "procedure", "observation"]
      .filter(function(type) { return requirements[type]; });

    if (!requiredTypes.length) {
      return true;
    }

    if (requirements.mode === "any") {
      return requiredTypes.some(function(type) { return !!(inputState && inputState[type]); });
    }

    return requiredTypes.every(function(type) { return !!(inputState && inputState[type]); });
  },

  /**
   * Backward-compatible helper for legacy callers.
   */
  requiresLab: function(ruleId) {
    return this.requiresInput(ruleId, "measurement");
  },

  /**
   * Get all rule IDs that require lab input
   * Useful for validation: must have both condition AND lab values
   */
  labRequiredRules: function() {
    const self = this;
    return this.getAll().filter(function(r) {
      return self.requiresInput(r.id, "measurement");
    }).map(function(r) { return r.id; });
  },

  /**
   * Update help text on the page when user selects a rule
   * Finds the #cohortRuleHelp element and sets its text
   */
  updateHelp: function(ruleId) {
    const helpElement = document.getElementById("cohortRuleHelp");
    if (!helpElement) return;

    const rule = this.getRule(ruleId);
    helpElement.textContent = rule.help;
  },

  /**
   * Show/hide input groups for the selected rule.
   * The HTML can gradually add containers for procedure/observation as needed.
   */
  updateFieldVisibility: function(ruleId) {
    const requirements = this.getInputRequirements(ruleId);

    const groupToContainers = {
      condition: ["cohortConditionFields"],
      measurement: ["labRuleFields"],
      procedure: ["cohortProcedureFields"],
      observation: ["cohortObservationFields"]
    };

    Object.keys(groupToContainers).forEach(function(group) {
      groupToContainers[group].forEach(function(containerId) {
        const container = document.getElementById(containerId);
        if (container) {
          container.style.display = requirements[group] ? "block" : "none";
        }
      });
    });
  },

  /**
   * Backward-compatible helper for legacy callers.
   */
  updateLabFieldVisibility: function(ruleId) {
    this.updateFieldVisibility(ruleId);
  }
};
