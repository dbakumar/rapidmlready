/**
 * ============================================================================
 * CONCEPT REFERENCE REGISTRY
 * ============================================================================
 * 
 * This file provides a centralized registry of common OMOP concept IDs.
 * Users can reference these IDs when filling out cohort and outcome rules.
 * 
 * Concept categories:
 * - Conditions: diseases and diagnoses (e.g., diabetes, nephropathy)
 * - Measurements: lab tests and vital signs (e.g., eGFR, blood pressure)
 * - Drugs: medication concepts (e.g., metformin, lisinopril)
 * - Procedures: clinical procedures (e.g., dialysis, transplant)
 * 
 * For developers:
 * - To ADD concepts: call RapidML.ConceptReference.addConcept() or addConcepts()
 * - Each concept needs: id (numeric), name (string)
 * - The UI auto-generates from renderAll() - no manual HTML needed
 * ============================================================================
 */

window.RapidML = window.RapidML || {};
RapidML.ConceptReference = {
  /**
   * CONDITION CONCEPTS
   * Diagnoses, diseases, conditions in OMOP standard format
   * Use these for cohort entry and outcome rules
   */
  conditions: [
    { id: "201826", name: "Type 2 Diabetes Mellitus" },
    { id: "443767", name: "Diabetic Nephropathy" },
    { id: "46269917", name: "Chronic Kidney Disease" },
    { id: "315661", name: "Heart Failure" },
    { id: "40481087", name: "Hypertension" },
    { id: "438962", name: "Acute myocardial infarction (AMI)" },
    { id: "4329847", name: "Stroke" },
    { id: "254761", name: "Pneumonia" },
    { id: "80809", name: "Acute kidney injury" }
  ],

  /**
   * LAB / MEASUREMENT CONCEPTS
   * Blood tests, vital signs, lab measurements
   * Use these for lab-based cohort and outcome rules
   */
  measurements: [
    { id: "3020460", name: "eGFR (kidney function)" },
    { id: "3024561", name: "Creatinine" },
    { id: "3004410", name: "HbA1c (diabetes control)" },
    { id: "3004249", name: "Systolic blood pressure" },
    { id: "3012888", name: "Diastolic blood pressure" },
    { id: "3006923", name: "Albumin" },
    { id: "3002962", name: "Blood glucose" },
    { id: "3013721", name: "Potassium" },
    { id: "3020437", name: "Calcium" }
  ],

  /**
   * DRUG / MEDICATION CONCEPTS
   * Medications and treatments
   */
  drugs: [
    { id: "1545999", name: "Metformin" },
    { id: "1551860", name: "Insulin" },
    { id: "1539403", name: "Lisinopril (ACE inhibitor)" },
    { id: "1308216", name: "Amlodipine (calcium channel blocker)" },
    { id: "1597756", name: "Atorvastatin (statin)" },
    { id: "1506270", name: "Aspirin" }
  ],

  /**
   * PROCEDURE CONCEPTS
   * Clinical procedures, surgeries, interventions
   */
  procedures: [
    { id: "4322976", name: "Kidney biopsy" },
    { id: "4039057", name: "Dialysis" },
    { id: "4027659", name: "Percutaneous coronary intervention (PCI)" },
    { id: "4043287", name: "Coronary artery bypass (CABG)" }
  ],

  /**
   * Get all category metadata
   * Each category has: key (property name), label (display name), icon (emoji)
   * Used for organizing the UI reference panel
   */
  getCategories: function() {
    return [
      { key: "conditions", label: "Conditions", icon: "🏥" },
      { key: "measurements", label: "Lab / Measurements", icon: "🧪" },
      { key: "drugs", label: "Drugs / Medications", icon: "💊" },
      { key: "procedures", label: "Procedures", icon: "🔬" }
    ];
  },

  /**
   * Get concepts for a single category
   * @param {string} category - One of: conditions, measurements, drugs, procedures
   * @returns {array} - Array of {id, name} objects, or empty array if not found
   */
  getByCategory: function(category) {
    return this[category] || [];
  },

  /**
   * Render HTML for a single category
   * Creates a formatted list with styled concept IDs (clickable to copy)
   * @param {string} category - One of: conditions, measurements, drugs, procedures
   * @returns {string} - HTML string for one category section
   */
  renderCategory: function(category) {
    const concepts = this.getByCategory(category);
    const categoryLabel = this.getCategories().find(c => c.key === category);
    
    if (!concepts || concepts.length === 0) {
      return "";
    }

    let html = '<div>\n';
    html += '  <h4 class="font-semibold text-slate-700 mb-2">' + (categoryLabel ? categoryLabel.label : category) + '</h4>\n';
    html += '  <ul class="text-xs md:text-sm space-y-1 text-slate-700">\n';
    
    concepts.forEach(function(concept) {
      html += '    <li><code class="bg-white px-1 py-0.5 rounded border cursor-pointer hover:bg-blue-50" data-concept-id="' + concept.id + '">✓ ' + concept.id + '</code> – ' + concept.name + '</li>\n';
    });
    
    html += '  </ul>\n';
    html += '</div>\n';
    
    return html;
  },

  /**
   * Render ALL categories as a complete HTML reference panel
   * Creates a grid layout with all concept categories
   * @returns {string} - HTML string for entire reference panel
   */
  renderAll: function() {
    const categories = this.getCategories();
    let html = '<div class="grid grid-cols-1 md:grid-cols-2 gap-4">\n';
    
    categories.forEach(function(cat) {
      html += this.renderCategory(cat.key);
    }, this);
    
    html += '</div>\n';
    return html;
  },

  /**
   * Add a SINGLE new concept to a category
   * Useful for extending the registry with domain-specific concepts
   * @param {string} category - One of: conditions, measurements, drugs, procedures
   * @param {string|number} id - OMOP concept ID
   * @param {string} name - Human-readable concept name
   */
  addConcept: function(category, id, name) {
    if (!this[category]) {
      this[category] = [];
    }
    this[category].push({ id: id, name: name });
  },

  /**
   * Add MULTIPLE new concepts to a category at once
   * Useful for batch updating concepts for a specific domain
   * @param {string} category - One of: conditions, measurements, drugs, procedures
   * @param {array} conceptArray - Array of {id, name} objects to add
   */
  addConcepts: function(category, conceptArray) {
    if (!this[category]) {
      this[category] = [];
    }
    this[category] = this[category].concat(conceptArray);
  }
};
