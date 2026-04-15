/**
 * ============================================================================
 * OUTCOME RULES REGISTRY
 * ============================================================================
 * 
 * This file defines all predefined outcome rules used in the wizard.
 * An outcome rule answers: "How do we label patients in the follow-up window?"
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

RapidML.OutcomeRules = {
  /**
   * RULE REGISTRY
   * Map of rule ID → rule definition
   * Each rule describes one way to label outcomes in the follow-up period
   */
  rules: {
    condition_occurrence: {
      id: "condition_occurrence",
      label: "1 condition record in the outcome window",
      help: "Outcome is TRUE if the selected condition appears AT LEAST ONCE during the outcome follow-up window.",
      inputRequirements: { condition: true },
      inputRequirementMode: "all",
      description: "Any occurrence of the condition. Simplest outcome definition."
    },

    two_condition_records: {
      id: "two_condition_records",
      label: "2 condition records in the outcome window",
      help: "Outcome is TRUE ONLY if the selected condition appears AT LEAST 2 TIMES during the outcome follow-up window.",
      inputRequirements: { condition: true },
      inputRequirementMode: "all",
      description: "Requires 2 separate condition records. More specific outcome."
    },

    lab_threshold: {
      id: "lab_threshold",
      label: "1 lab record above or below threshold in the outcome window",
      help: "Outcome is TRUE if the selected lab measurement crosses the threshold (>, <, >=, <=) AT LEAST ONCE during the outcome follow-up window.",
      inputRequirements: { measurement: true },
      inputRequirementMode: "all",
      description: "Lab value crossing threshold. Quantitative outcome."
    },

    condition_or_lab: {
      id: "condition_or_lab",
      label: "1 condition record OR 1 lab record in the outcome window",
      help: "Outcome is TRUE if EITHER the condition appears OR the lab threshold is met during the outcome follow-up window.",
      inputRequirements: { condition: true, measurement: true },
      inputRequirementMode: "any",
      description: "Composite: condition or lab. Flexible outcome definition."
    }
  },

  /**
   * Retrieve a single rule by ID
   * Returns the rule object, or defaults to condition_occurrence if not found
   */
  getRule: function(ruleId) {
    return this.rules[ruleId] || this.rules.condition_occurrence;
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
   * Useful for validation: must have both measurement concept AND value
   */
  labRequiredRules: function() {
    const self = this;
    return this.getAll().filter(function(r) {
      return self.requiresInput(r.id, "measurement");
    }).map(function(r) { return r.id; });
  },

  /**
   * Check if a specific rule requires condition input
   * Most outcome rules need a condition concept, except pure lab rules
   */
  requiresCondition: function(ruleId) {
    return this.requiresInput(ruleId, "condition");
  },

  /**
   * Update help text on the page when user selects a rule
   * Finds the #outcomeRuleHelp element and sets its text
   */
  updateHelp: function(ruleId) {
    const helpElement = document.getElementById("outcomeRuleHelp");
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
      condition: ["outcomeConditionFields"],
      measurement: ["outcomeLabFields"],
      procedure: ["outcomeProcedureFields"],
      observation: ["outcomeObservationFields"]
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
