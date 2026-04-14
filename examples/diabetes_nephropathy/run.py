import os
from pathlib import Path

import pandas as pd
from sqlalchemy import create_engine, text
from sklearn.linear_model import LogisticRegression

print("Starting diabetes nephropathy example...")

def get_database_url() -> str:
	database_url = os.getenv("DATABASE_URL")
	if database_url:
		return database_url

	user = os.getenv("PGUSER", "postgres")
	password = os.getenv("PGPASSWORD", "HelloWorld")
	host = os.getenv("PGHOST", "localhost")
	port = os.getenv("PGPORT", "5432")
	database = os.getenv("PGDATABASE", "postgres")
	return f"postgresql+psycopg://{user}:{password}@{host}:{port}/{database}"


def load_sql(sql_path: Path) -> str:
	return sql_path.read_text(encoding="utf-8")


def run_query(sql_path: Path) -> pd.DataFrame:
	engine = create_engine(get_database_url())
	sql = load_sql(sql_path)
	with engine.connect() as connection:
		return pd.read_sql(text(sql), connection)


def train_example_model(df: pd.DataFrame) -> None:
	label_column = "outcome_label"
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

	numeric_features = df[feature_columns].select_dtypes(include=["number"]).copy()
	if numeric_features.empty:
		print("Skipping model training because no numeric feature columns were returned by the query.")
		return

	numeric_features = numeric_features.fillna(numeric_features.mean(numeric_only=True))
	model = LogisticRegression(max_iter=1000)
	model.fit(numeric_features, df[label_column])
	print(f"Model trained on {len(numeric_features)} rows with {len(numeric_features.columns)} numeric features.")


def main() -> None:
	script_dir = Path(__file__).resolve().parent
	sql_path = Path(os.getenv("SQL_FILE", script_dir / "study.sql"))
	output_csv = Path(os.getenv("OUTPUT_CSV", script_dir / "results.csv"))

	df = run_query(sql_path)
	df.to_csv(output_csv, index=False)

	print(f"Query returned {len(df)} rows and {len(df.columns)} columns.")
	print(f"Saved results to {output_csv}.")

	train_example_model(df)


if __name__ == "__main__":
	main()
