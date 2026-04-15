(function() {
  window.RapidML = window.RapidML || {};
  RapidML.Compiler = RapidML.Compiler || {};

  function buildArtifacts(config, methodologyId) {
    const manifest = {
      schemaVersion: "1.0.0",
      generatedAt: new Date().toISOString(),
      methodology: methodologyId,
      analysisTemplate: config.analysisTemplate,
      config: {
        db: config.db,
        schema: config.schema,
        outcomeConceptId: config.outcomeConceptId,
        outcomeRule: config.outcomeRule,
        startYear: config.startYear,
        endYear: config.endYear,
        baselineYears: config.baselineYears,
        outcomeYears: config.outcomeYears,
        cohortEntryMode: config.cohortEntryMode,
        cohortEntry: config.cohortEntry,
        debug: !!config.debug,
        bestPracticeMode: !!config.bestPracticeMode
      }
    };

    const attritionSql = [
      "-- Attrition summary (run after loading study.sql output into temp/result table)",
      "SELECT",
      "  COUNT(*) AS total_rows,",
      "  COUNT(DISTINCT person_id) AS unique_people,",
      "  SUM(CASE WHEN outcome_label = 1 THEN 1 ELSE 0 END) AS positive_rows",
      "FROM study_result;"
    ].join("\n");

    const dqSql = [
      "-- Data quality checks for study_result",
      "SELECT 'null_person_id' AS check_name, COUNT(*) AS issue_rows FROM study_result WHERE person_id IS NULL",
      "UNION ALL",
      "SELECT 'null_index_date' AS check_name, COUNT(*) AS issue_rows FROM study_result WHERE index_date IS NULL",
      "UNION ALL",
      "SELECT 'label_out_of_range' AS check_name, COUNT(*) AS issue_rows FROM study_result WHERE outcome_label NOT IN (0, 1);"
    ].join("\n");

    return [
      {
        filename: "manifest.json",
        content: JSON.stringify(manifest, null, 2),
        mimeType: "application/json"
      },
      {
        filename: "attrition.sql",
        content: attritionSql,
        mimeType: "text/plain"
      },
      {
        filename: "data_quality_report.sql",
        content: dqSql,
        mimeType: "text/plain"
      }
    ];
  }

  RapidML.Compiler.buildArtifacts = buildArtifacts;
})();
