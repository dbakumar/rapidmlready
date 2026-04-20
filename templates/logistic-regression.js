/**
 * ============================================================================
 * LOGISTIC-REGRESSION.JS  -  Analysis Template Plugin: Logistic Regression
 * ============================================================================
 *
 * PURPOSE:
 *   Generates a Python script (run.py) that:
 *   1. Connects to the database using SQLAlchemy
 *   2. Executes the generated study.sql
 *   3. Exports the cohort data to CSV
 *   4. Trains a baseline logistic regression model (scikit-learn)
 *
 * HOW IT WORKS:
 *   This file defines a template plugin object with a buildScript(config)
 *   method.  When the user clicks "Generate Package", generator.js calls
 *   buildScript() to produce the Python source code as a string, which
 *   is then included in the downloadable zip.
 *
 * PLUGIN INTERFACE:
 *   id             -> "logistic-regression"
 *   label          -> "Logistic regression (default)"
 *   language       -> "python"
 *   filename       -> "run.py"
 *   buildScript()  -> complete Python script string
 *
 * SELF-REGISTERS on RapidML.AnalysisTemplates
 *
 * DEPENDS ON:  core/generator.js (RapidML.AnalysisTemplates.register)
 * ============================================================================
 */

var logisticRegressionTemplate = {
  id: "logistic-regression",
  label: "Logistic regression (default)",
  language: "python",
  filename: "run.py",

  /**
   * Generate a complete Python analysis script.
   *
   * The script connects to a PostgreSQL database, runs the study SQL,
   * saves results to CSV, and trains a logistic regression classifier.
   *
   * @param  {object} config  normalised study configuration (unused here
   *                          because the script is self-contained)
   * @return {string}         Python source code
   */
  buildScript: function(config) {
    return [
      '"""RapidML generated analysis script: Logistic Regression.',
      '',
      'This program executes the generated study SQL, writes the result dataset,',
      'and trains a baseline logistic regression model when feasible.',
      '"""',
      '',
      'import os',
      'from pathlib import Path',
      '',
      'import pandas as pd',
      'from sqlalchemy import create_engine, text',
      'from sklearn.linear_model import LogisticRegression',
      'from sklearn.preprocessing import StandardScaler',
      '',
      'print("Starting analysis...")',
      '',
      '',
      'def get_database_url() -> str:',
      '\t"""Resolve SQLAlchemy database URL from environment variables.',
      '',
      '\tSet DATABASE_URL for a full connection string, or set individual',
      '\tvariables: PGUSER, PGPASSWORD, PGHOST, PGPORT, PGDATABASE.',
      '\tThe script will exit with a clear error if credentials are missing.',
      '\t"""',
      '\tdatabase_url = os.getenv("DATABASE_URL")',
      '\tif database_url:',
      '\t\treturn database_url',
      '',
      '\tuser = os.getenv("PGUSER")',
      '\tpassword = os.getenv("PGPASSWORD")',
      '\thost = os.getenv("PGHOST", "localhost")',
      '\tport = os.getenv("PGPORT", "5432")',
      '\tdatabase = os.getenv("PGDATABASE", "postgres")',
      '',
      '\tif not user or not password:',
      '\t\traise EnvironmentError(',
      '\t\t\t"Database credentials not configured. "',
      '\t\t\t"Set DATABASE_URL or both PGUSER and PGPASSWORD environment variables."',
      '\t\t)',
      '\treturn f"postgresql+psycopg://{user}:{password}@{host}:{port}/{database}"',
      '',
      '',
      'def load_sql(sql_path: Path) -> str:',
      '\t"""Load SQL text from study.sql (or custom SQL_FILE path)."""',
      '\treturn sql_path.read_text(encoding="utf-8")',
      '',
      '',
      'def run_query(sql_path: Path) -> pd.DataFrame:',
      '\t"""Execute study SQL and return a pandas DataFrame."""',
      '\tengine = create_engine(get_database_url())',
      '\tsql = load_sql(sql_path)',
      '\twith engine.connect() as connection:',
      '\t\treturn pd.read_sql(text(sql), connection)',
      '',
      '',
      'def train_model(df: pd.DataFrame) -> None:',
      '\t"""Train logistic regression on numeric features when label quality is valid."""',
      '\tlabel_column = "outcome_label"',
      '',
      '\t# Exclude IDs and time-window metadata from model features.',
      '\texcluded_columns = [',
      '\t\t"person_id",',
      '\t\t"t0",',
      '\t\t"exposure_index_date",',
      '\t\t"index_date",',
      '\t\t"baseline_start",',
      '\t\t"baseline_end",',
      '\t\t"outcome_start",',
      '\t\t"outcome_end",',
      '\t\tlabel_column,',
      '\t]',
      '',
      '\tif label_column not in df.columns:',
      '\t\tprint(f"Skipping model training because \'{label_column}\' is not present.")',
      '\t\treturn',
      '',
      '\tif df[label_column].nunique(dropna=True) < 2:',
      '\t\tprint("Skipping model training because the label has fewer than 2 classes.")',
      '\t\treturn',
      '',
      '\tfeature_columns = [column for column in df.columns if column not in excluded_columns]',
      '\tif not feature_columns:',
      '\t\tprint("Skipping model training because no feature columns were returned by the query.")',
      '\t\treturn',
      '',
      '\t# Start from numeric columns only for baseline logistic regression.',
      '\tnumeric_features = df[feature_columns].select_dtypes(include=["number"]).copy()',
      '\tif numeric_features.empty:',
      '\t\tprint("Skipping model training because no numeric feature columns were returned by the query.")',
      '\t\treturn',
      '',
      '\t# Mean-impute missing numeric values and standardize before model fit.',
      '\tnumeric_features = numeric_features.fillna(numeric_features.mean(numeric_only=True))',
      '\tscaler = StandardScaler()',
      '\tX_scaled = scaler.fit_transform(numeric_features)',
      '\t',
      '\t# Train baseline logistic regression model.',
      '\tmodel = LogisticRegression(max_iter=1000)',
      '\tmodel.fit(X_scaled, df[label_column])',
      '\t',
      '\tprint(f"Model trained on {len(numeric_features)} rows with {len(numeric_features.columns)} numeric features.")',
      '\tprint(f"Model coefficients (mean-scaled): {dict(zip(numeric_features.columns, model.coef_[0]))}")',
      '',
      '',
      'def main() -> None:',
      '\t"""Main workflow: run SQL, save output, then train model."""',
      '\tscript_dir = Path(__file__).resolve().parent',
      '\tsql_path = Path(os.getenv("SQL_FILE", script_dir / "study.sql"))',
      '\toutput_csv = Path(os.getenv("OUTPUT_CSV", script_dir / "results.csv"))',
      '',
      '\t# 1) Build cohort-feature dataset from SQL.',
      '\tdf = run_query(sql_path)',
      '\t# 2) Persist dataset for QA and downstream analyses.',
      '\tdf.to_csv(output_csv, index=False)',
      '',
      '\tprint(f"Query returned {len(df)} rows and {len(df.columns)} columns.")',
      '\tprint(f"Saved results to {output_csv}.")',
      '',
      '\t# 3) Train a baseline model (if label/features are valid).',
      '\ttrain_model(df)',
      '',
      '',
      'if __name__ == "__main__":',
      '\tmain()'
    ].join("\n");
  }
};

/* =======================
   Register analysis template plugin
   ======================= */
if (typeof RapidML !== "undefined" && RapidML.AnalysisTemplates && RapidML.AnalysisTemplates.register) {
  RapidML.AnalysisTemplates.register(logisticRegressionTemplate);
}
