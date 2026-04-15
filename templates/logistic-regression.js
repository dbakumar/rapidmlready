/**
 * RapidML Analysis Template Plugin: Logistic Regression
 * 
 * Language: Python
 * Framework: scikit-learn + pandas
 * Generates: run.py script for model training and evaluation
 * 
 * Features:
 * - Loads cohort data from PostgreSQL via study.sql
 * - Handles missing values (mean imputation)
 * - Standardizes features for logistic regression
 * - Trains binary classifier
 * - Exports results to CSV
 * 
 * Self-registers on RapidML.AnalysisTemplates
 */

const logisticRegressionTemplate = {
  id: "logistic-regression",
  label: "Logistic regression (default)",
  language: "python",
  filename: "run.py",
  
  buildScript: function(config) {
    return `"""RapidML generated analysis script: Logistic Regression.

This program executes the generated study SQL, writes the result dataset,
and trains a baseline logistic regression model when feasible.
"""

import os
from pathlib import Path

import pandas as pd
from sqlalchemy import create_engine, text
from sklearn.linear_model import LogisticRegression
from sklearn.preprocessing import StandardScaler

print("Starting analysis...")

def get_database_url() -> str:
	"""Resolve SQLAlchemy database URL from environment variables.

	Set DATABASE_URL for a full connection string, or set individual
	variables: PGUSER, PGPASSWORD, PGHOST, PGPORT, PGDATABASE.
	The script will exit with a clear error if credentials are missing.
	"""
	database_url = os.getenv("DATABASE_URL")
	if database_url:
		return database_url

	user = os.getenv("PGUSER")
	password = os.getenv("PGPASSWORD")
	host = os.getenv("PGHOST", "localhost")
	port = os.getenv("PGPORT", "5432")
	database = os.getenv("PGDATABASE", "postgres")

	if not user or not password:
		raise EnvironmentError(
			"Database credentials not configured. "
			"Set DATABASE_URL or both PGUSER and PGPASSWORD environment variables."
		)
	return f"postgresql+psycopg://{user}:{password}@{host}:{port}/{database}"


def load_sql(sql_path: Path) -> str:
	"""Load SQL text from study.sql (or custom SQL_FILE path)."""
	return sql_path.read_text(encoding="utf-8")


def run_query(sql_path: Path) -> pd.DataFrame:
	"""Execute study SQL and return a pandas DataFrame."""
	engine = create_engine(get_database_url())
	sql = load_sql(sql_path)
	with engine.connect() as connection:
		return pd.read_sql(text(sql), connection)


def train_model(df: pd.DataFrame) -> None:
	"""Train logistic regression on numeric features when label quality is valid."""
	label_column = "outcome_label"

	# Exclude IDs and time-window metadata from model features.
	excluded_columns = [
		"person_id",
		"t0",
		"exposure_index_date",
		"index_date",
		"baseline_start",
		"baseline_end",
		"outcome_start",
		"outcome_end",
		label_column,
	]

	if label_column not in df.columns:
		print(f"Skipping model training because '{label_column}' is not present.")
		return

	if df[label_column].nunique(dropna=True) < 2:
		print("Skipping model training because the label has fewer than 2 classes.")
		return

	feature_columns = [column for column in df.columns if column not in excluded_columns]
	if not feature_columns:
		print("Skipping model training because no feature columns were returned by the query.")
		return

	# Start from numeric columns only for baseline logistic regression.
	numeric_features = df[feature_columns].select_dtypes(include=["number"]).copy()
	if numeric_features.empty:
		print("Skipping model training because no numeric feature columns were returned by the query.")
		return

	# Mean-impute missing numeric values and standardize before model fit.
	numeric_features = numeric_features.fillna(numeric_features.mean(numeric_only=True))
	scaler = StandardScaler()
	X_scaled = scaler.fit_transform(numeric_features)
	
	# Train baseline logistic regression model.
	model = LogisticRegression(max_iter=1000)
	model.fit(X_scaled, df[label_column])
	
	print(f"Model trained on {len(numeric_features)} rows with {len(numeric_features.columns)} numeric features.")
	print(f"Model coefficients (mean-scaled): {dict(zip(numeric_features.columns, model.coef_[0]))}")


def main() -> None:
	"""Main workflow: run SQL, save output, then train model."""
	script_dir = Path(__file__).resolve().parent
	sql_path = Path(os.getenv("SQL_FILE", script_dir / "study.sql"))
	output_csv = Path(os.getenv("OUTPUT_CSV", script_dir / "results.csv"))

	# 1) Build cohort-feature dataset from SQL.
	df = run_query(sql_path)
	# 2) Persist dataset for QA and downstream analyses.
	df.to_csv(output_csv, index=False)

	print(f"Query returned {len(df)} rows and {len(df.columns)} columns.")
	print(f"Saved results to {output_csv}.")

	# 3) Train a baseline model (if label/features are valid).
	train_model(df)


if __name__ == "__main__":
	main()`;
  }
};

/* =======================
   Register analysis template plugin
   ======================= */
if (typeof RapidML !== 'undefined' && RapidML.AnalysisTemplates && RapidML.AnalysisTemplates.register) {
  RapidML.AnalysisTemplates.register(logisticRegressionTemplate);
}
