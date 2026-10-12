# orbitly-analytics

Orbitly's analytics warehouse: a dbt project on DuckDB.

- Raw data lands in `warehouse/orbitly.duckdb` (schema `raw`): `accounts`,
  `users`, `events`.
- `models/staging/` cleans the raw tables one-to-one.
- `models/marts/` holds the tables dashboards and the board deck read.
- `analyses/` holds one-off queries that never became models.

Run a model's SQL directly with `duckdb warehouse/orbitly.duckdb`.
Changes go through a pull request to `main` (`gh pr create`).
