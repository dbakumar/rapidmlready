/**
 * RapidML Analysis Template Plugin: Decision Tree
 */

const decisionTreeTemplate = {
  id: "decision-tree",
  label: "Decision tree",
  language: "python",
  filename: "run_decision_tree.py",

  buildScript: function() {
        return `"""RapidML generated analysis script: Decision Tree.

Runs the generated study SQL, exports the resulting dataset, and trains
a baseline decision-tree classifier when outcome labels are usable.
"""

import os
from pathlib import Path

import pandas as pd
from sqlalchemy import create_engine, text
from sklearn.impute import SimpleImputer
from sklearn.metrics import classification_report
from sklearn.model_selection import train_test_split
from sklearn.tree import DecisionTreeClassifier


def get_database_url() -> str:
    """Resolve SQLAlchemy database URL from environment variables.

    Set DATABASE_URL for a full connection string, or set individual
    variables: PGUSER, PGPASSWORD, PGHOST, PGPORT, PGDATABASE.
    The script will exit with a clear error if credentials are missing.
    """
    db_url = os.getenv("DATABASE_URL")
    if db_url:
        return db_url
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


def run_query(sql_path: Path) -> pd.DataFrame:
    """Execute study SQL and return result rows as a DataFrame."""
    engine = create_engine(get_database_url())
    sql = sql_path.read_text(encoding="utf-8")
    with engine.connect() as connection:
        return pd.read_sql(text(sql), connection)


def main() -> None:
    """Main workflow: execute SQL, save CSV, train/evaluate model."""
    script_dir = Path(__file__).resolve().parent
    sql_path = Path(os.getenv("SQL_FILE", script_dir / "study.sql"))
    output_csv = Path(os.getenv("OUTPUT_CSV", script_dir / "results.csv"))

    # 1) Build model-ready dataset from study.sql.
    df = run_query(sql_path)
    # 2) Save dataset for validation and reproducibility.
    df.to_csv(output_csv, index=False)
    print(f"Saved {len(df)} rows to {output_csv}")

    # 3) Validate label quality before training.
    if "outcome_label" not in df.columns:
        print("No outcome_label column found; skipping model training.")
        return

    y = df["outcome_label"]
    if y.nunique(dropna=True) < 2:
        print("Label has fewer than 2 classes; skipping model training.")
        return

    # 4) Keep only numeric feature columns and exclude timeline identifiers.
    blocked = {
        "person_id", "t0", "exposure_index_date", "index_date",
        "baseline_start", "baseline_end", "outcome_start", "outcome_end", "outcome_label"
    }
    X = df[[c for c in df.columns if c not in blocked]].select_dtypes(include=["number"]).copy()
    if X.empty:
        print("No numeric features available; skipping model training.")
        return

    # 5) Impute missing values and split train/test.
    imputer = SimpleImputer(strategy="median")
    X = pd.DataFrame(imputer.fit_transform(X), columns=X.columns)

    X_train, X_test, y_train, y_test = train_test_split(
        X, y, test_size=0.25, random_state=42, stratify=y
    )

    # 6) Train baseline decision tree and print evaluation report.
    model = DecisionTreeClassifier(max_depth=5, min_samples_leaf=20, random_state=42)
    model.fit(X_train, y_train)
    y_pred = model.predict(X_test)

    print("Decision Tree report:")
    print(classification_report(y_test, y_pred, digits=4))


if __name__ == "__main__":
    main()
`;
  }
};

if (typeof RapidML !== "undefined" && RapidML.AnalysisTemplates && RapidML.AnalysisTemplates.register) {
  RapidML.AnalysisTemplates.register(decisionTreeTemplate);
}
