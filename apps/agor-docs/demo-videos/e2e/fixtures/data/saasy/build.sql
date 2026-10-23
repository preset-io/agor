-- SaaSy Co.: a fictional B2B SaaS company (field-service scheduling software
-- for HVAC, plumbing, electrical and similar trades) for the demo videos.
--
-- Builds the raw schema of SaaSy Co.'s analytics warehouse: accounts, users,
-- and 13 months of product events ending today. Deterministic: every
-- "random" value is a hash of its row's identity, so the same data comes
-- out on every machine (only the dates move, so "last month" always has
-- data).
--
--   duckdb warehouse.duckdb < build.sql
--
-- Planted for the MAU story: the warehouse has two legacy MAU queries that
-- disagree (see the analytics repo's analyses/), because product events
-- include passive ones (notification_received, email_opened) and internal
-- and sandbox accounts are mixed in with customers.

CREATE SCHEMA IF NOT EXISTS raw;

CREATE OR REPLACE MACRO rnd(salt, k) AS (hash(salt || ':' || k::VARCHAR) % 1000000) / 1000000.0;

CREATE OR REPLACE TABLE raw.accounts AS
WITH base AS (
  SELECT
    i AS account_id,
    rnd('plan', i) AS p,
    rnd('ind', i) AS q,
    rnd('age', i) AS a,
    rnd('churn', i) AS c
  FROM range(1, 241) t(i)
)
SELECT
  account_id,
  CASE
    WHEN account_id <= 3 THEN ['SaaSy Co. (internal)', 'SaaSy Co. QA sandbox', 'Demo: Sample Plumbing Co'][account_id]
    ELSE
      ['Summit', 'Bluegrass', 'Copperline', 'Northfield', 'Redstone', 'Harbor', 'Prairie', 'Ironwood', 'Lakeside', 'Granite', 'Cedar', 'Maple', 'Riverbend', 'Oakhurst', 'Pioneer', 'Keystone'][1 + (account_id * 7) % 16]
      || ' '
      || ['Heating & Air', 'Plumbing', 'Electric', 'Landscaping', 'Cleaning Co', 'Pest Control', 'Mechanical', 'Home Services'][1 + (account_id * 3) % 8]
  END AS name,
  CASE WHEN account_id <= 3 THEN 'internal' WHEN p < 0.55 THEN 'starter' WHEN p < 0.88 THEN 'growth' ELSE 'enterprise' END AS plan,
  CASE
    WHEN account_id <= 3 THEN 'internal'
    ELSE ['hvac', 'plumbing', 'electrical', 'landscaping', 'cleaning', 'pest_control', 'hvac', 'home_services'][1 + (account_id * 3) % 8]
  END AS industry,
  ['us-east', 'us-central', 'us-west', 'canada'][1 + (account_id * 5) % 4] AS region,
  account_id <= 3 AS is_internal,
  (current_date - INTERVAL (30 + floor(a * 700)) DAY)::TIMESTAMP AS created_at,
  CASE WHEN account_id > 3 AND c < 0.12 THEN (current_date - INTERVAL (floor(c * 2500)) DAY)::TIMESTAMP END AS churned_at
FROM base;

CREATE OR REPLACE TABLE raw.users AS
WITH sized AS (
  SELECT
    account_id,
    created_at,
    churned_at,
    is_internal,
    CASE plan WHEN 'starter' THEN 3 + floor(rnd('size', account_id) * 8)
              WHEN 'growth' THEN 10 + floor(rnd('size', account_id) * 25)
              WHEN 'enterprise' THEN 35 + floor(rnd('size', account_id) * 60)
              ELSE 12 END AS seats
  FROM raw.accounts
)
SELECT
  account_id * 1000 + n AS user_id,
  account_id,
  CASE WHEN is_internal THEN 'user' || (account_id * 1000 + n) || '@saasy.example'
       ELSE 'user' || (account_id * 1000 + n) || '@customer-' || account_id || '.example' END AS email,
  CASE WHEN n = 1 THEN 'admin' WHEN rnd('role', account_id * 1000 + n) < 0.25 THEN 'dispatcher' ELSE 'technician' END AS role,
  created_at + INTERVAL (floor(rnd('ucreated', account_id * 1000 + n) * 120)) DAY AS created_at
FROM sized, range(1, seats::BIGINT + 1) t(n);

-- One row per user per day they were active, then 1-6 events on that day.
CREATE OR REPLACE TABLE raw.events AS
WITH days AS (
  SELECT (current_date - INTERVAL (d) DAY)::DATE AS day FROM range(0, 395) t(d)
),
user_days AS (
  SELECT u.user_id, u.account_id, u.role, d.day, a.is_internal
  FROM raw.users u
  JOIN raw.accounts a USING (account_id)
  JOIN days d ON d.day >= u.created_at::DATE AND (a.churned_at IS NULL OR d.day < a.churned_at::DATE)
),
active AS (
  SELECT *
  FROM user_days
  -- Dormant seats (8%) never open the app; they only receive notifications below.
  WHERE rnd('passive-user', user_id) >= 0.08
    AND rnd('active', user_id || ':' || day) <
    CASE role WHEN 'technician' THEN 0.55 WHEN 'dispatcher' THEN 0.8 ELSE 0.45 END
    * CASE WHEN dayofweek(day) IN (0, 6) THEN 0.25 ELSE 1.0 END
),
exploded AS (
  SELECT a.*, k
  FROM active a, range(0, 1 + floor(rnd('n', user_id || ':' || day) * 6)::BIGINT) t(k)
)
SELECT
  row_number() OVER (ORDER BY day, user_id, k) AS event_id,
  user_id,
  account_id,
  CASE
    WHEN k = 0 AND rnd('ev', user_id || ':' || day) < 0.7 THEN 'login'
    ELSE CASE floor(rnd('ev', user_id || ':' || day || ':' || k) * 10)::INT
      WHEN 0 THEN 'job_created' WHEN 1 THEN 'job_scheduled' WHEN 2 THEN 'job_completed'
      WHEN 3 THEN 'job_completed' WHEN 4 THEN 'invoice_sent' WHEN 5 THEN 'report_viewed'
      WHEN 6 THEN 'notification_received' WHEN 7 THEN 'notification_received'
      WHEN 8 THEN 'email_opened' ELSE 'job_scheduled' END
  END AS event_name,
  CASE WHEN rnd('plat', user_id) < 0.6 THEN 'mobile' ELSE 'web' END AS platform,
  day::TIMESTAMP + INTERVAL (7 * 3600 + floor(rnd('t', user_id || ':' || day || ':' || k) * 11 * 3600)) SECOND AS occurred_at
FROM exploded;

-- Passive-only users: people who get notifications but never open the app.
-- They inflate any MAU that counts every event.
INSERT INTO raw.events
SELECT
  (SELECT max(event_id) FROM raw.events) + row_number() OVER () AS event_id,
  u.user_id,
  u.account_id,
  'notification_received',
  'mobile',
  (current_date - INTERVAL (floor(rnd('passive', u.user_id || ':' || m) * 28) + 28 * m) DAY)::TIMESTAMP + INTERVAL 9 HOUR
FROM raw.users u, range(0, 13) t(m)
WHERE rnd('passive-user', u.user_id) < 0.08;

CREATE OR REPLACE VIEW raw.warehouse_info AS
SELECT 'saasy' AS company, current_date AS built_on,
  (SELECT count(*) FROM raw.accounts) AS accounts,
  (SELECT count(*) FROM raw.users) AS users,
  (SELECT count(*) FROM raw.events) AS events;
