/** Idempotent DDL, executed in order by openDb. Later features append their tables here. */
export const SCHEMA: string[] = [
  `CREATE TABLE IF NOT EXISTS raw_responses (
    id TEXT PRIMARY KEY,
    endpoint TEXT NOT NULL,
    received_at TEXT NOT NULL,
    status INTEGER NOT NULL,
    body TEXT NOT NULL,
    body_sha256 TEXT NOT NULL
  )`,
  `CREATE TRIGGER IF NOT EXISTS raw_responses_no_update BEFORE UPDATE ON raw_responses
    BEGIN SELECT RAISE(ABORT, 'raw responses are immutable'); END`,
  `CREATE TRIGGER IF NOT EXISTS raw_responses_no_delete BEFORE DELETE ON raw_responses
    BEGIN SELECT RAISE(ABORT, 'raw responses are immutable'); END`,
  `CREATE TABLE IF NOT EXISTS evidence_items (
    id TEXT PRIMARY KEY,
    kind TEXT NOT NULL CHECK (kind IN ('market_snapshot', 'external_source')),
    source TEXT NOT NULL,
    published_at TEXT,
    collected_at TEXT NOT NULL,
    label TEXT NOT NULL CHECK (label IN ('fact', 'inference')),
    inst_ids TEXT NOT NULL,
    content TEXT NOT NULL,
    content_sha256 TEXT NOT NULL,
    raw_ref TEXT REFERENCES raw_responses(id),
    submitted_by TEXT NOT NULL
  )`,
  `CREATE TRIGGER IF NOT EXISTS evidence_items_no_update BEFORE UPDATE ON evidence_items
    BEGIN SELECT RAISE(ABORT, 'evidence items are immutable'); END`,
  `CREATE TRIGGER IF NOT EXISTS evidence_items_no_delete BEFORE DELETE ON evidence_items
    BEGIN SELECT RAISE(ABORT, 'evidence items are immutable'); END`,
  `CREATE TABLE IF NOT EXISTS evidence_bundles (
    id TEXT PRIMARY KEY,
    created_at TEXT NOT NULL,
    content TEXT NOT NULL,
    content_sha256 TEXT NOT NULL
  )`,
  `CREATE TRIGGER IF NOT EXISTS evidence_bundles_no_update BEFORE UPDATE ON evidence_bundles
    BEGIN SELECT RAISE(ABORT, 'evidence bundles are immutable'); END`,
  `CREATE TRIGGER IF NOT EXISTS evidence_bundles_no_delete BEFORE DELETE ON evidence_bundles
    BEGIN SELECT RAISE(ABORT, 'evidence bundles are immutable'); END`,
  `CREATE TABLE IF NOT EXISTS audit_events (
    seq INTEGER PRIMARY KEY AUTOINCREMENT,
    at TEXT NOT NULL,
    type TEXT NOT NULL,
    ref TEXT NOT NULL,
    detail TEXT NOT NULL
  )`,
  `CREATE TRIGGER IF NOT EXISTS audit_events_no_update BEFORE UPDATE ON audit_events
    BEGIN SELECT RAISE(ABORT, 'audit events are append-only'); END`,
  `CREATE TRIGGER IF NOT EXISTS audit_events_no_delete BEFORE DELETE ON audit_events
    BEGIN SELECT RAISE(ABORT, 'audit events are append-only'); END`,
  `CREATE TABLE IF NOT EXISTS research_runs (
    id TEXT PRIMARY KEY,
    bundle_id TEXT NOT NULL REFERENCES evidence_bundles(id),
    bundle_sha256 TEXT NOT NULL,
    agent_mode TEXT NOT NULL CHECK (agent_mode IN ('parallel_independent', 'serial_degraded')),
    created_at TEXT NOT NULL,
    decision TEXT
  )`,
  `CREATE TABLE IF NOT EXISTS research_assignments (
    id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL REFERENCES research_runs(id),
    role TEXT NOT NULL,
    phase INTEGER NOT NULL CHECK (phase IN (1, 2, 3)),
    state TEXT NOT NULL CHECK (state IN ('open', 'completed', 'failed')),
    created_at TEXT NOT NULL,
    completed_at TEXT,
    outcome TEXT,
    submitted_sha256 TEXT,
    UNIQUE (run_id, role)
  )`,
  `CREATE TABLE IF NOT EXISTS risk_loss_scopes (
    id TEXT PRIMARY KEY,
    policy_id TEXT NOT NULL,
    policy_version INTEGER NOT NULL,
    policy_hash TEXT NOT NULL,
    policy_json TEXT NOT NULL,
    baseline_ref TEXT NOT NULL,
    baseline_at TEXT NOT NULL,
    baseline_ms INTEGER NOT NULL
  )`,
  `CREATE TRIGGER IF NOT EXISTS risk_loss_scopes_no_update BEFORE UPDATE ON risk_loss_scopes
    BEGIN SELECT RAISE(ABORT, 'risk loss scope is immutable'); END`,
  `CREATE TRIGGER IF NOT EXISTS risk_loss_scopes_no_delete BEFORE DELETE ON risk_loss_scopes
    BEGIN SELECT RAISE(ABORT, 'risk loss scope is immutable'); END`,
  `CREATE TABLE IF NOT EXISTS risk_loss_scope_arithmetic (
    scope_id TEXT PRIMARY KEY REFERENCES risk_loss_scopes(id),
    version INTEGER NOT NULL CHECK (version = 2)
  )`,
  `CREATE TRIGGER IF NOT EXISTS risk_loss_scope_arithmetic_no_update BEFORE UPDATE ON risk_loss_scope_arithmetic
    BEGIN SELECT RAISE(ABORT, 'risk arithmetic version is immutable'); END`,
  `CREATE TRIGGER IF NOT EXISTS risk_loss_scope_arithmetic_no_delete BEFORE DELETE ON risk_loss_scope_arithmetic
    BEGIN SELECT RAISE(ABORT, 'risk arithmetic version is immutable'); END`,
  `CREATE TABLE IF NOT EXISTS risk_loss_write_authorizations (
    id TEXT PRIMARY KEY,
    scope_id TEXT NOT NULL REFERENCES risk_loss_scope_arithmetic(scope_id),
    kind TEXT NOT NULL CHECK (kind IN ('capital', 'observation'))
  )`,
  `CREATE TRIGGER IF NOT EXISTS risk_loss_write_authorizations_no_update BEFORE UPDATE ON risk_loss_write_authorizations
    BEGIN SELECT RAISE(ABORT, 'risk arithmetic write authorization is immutable'); END`,
  `CREATE TRIGGER IF NOT EXISTS risk_loss_write_authorizations_no_delete BEFORE DELETE ON risk_loss_write_authorizations
    BEGIN SELECT RAISE(ABORT, 'risk arithmetic write authorization is immutable'); END`,
  `CREATE TABLE IF NOT EXISTS risk_capital_events (
    id TEXT PRIMARY KEY,
    scope_id TEXT NOT NULL REFERENCES risk_loss_scopes(id),
    exchange_ref TEXT NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('deposit', 'withdrawal')),
    amount_usdt TEXT NOT NULL,
    occurred_at TEXT NOT NULL,
    occurred_ms INTEGER NOT NULL,
    input_hash TEXT NOT NULL,
    UNIQUE (scope_id, exchange_ref)
  )`,
  `CREATE TRIGGER IF NOT EXISTS risk_capital_events_no_update BEFORE UPDATE ON risk_capital_events
    BEGIN SELECT RAISE(ABORT, 'capital event is immutable'); END`,
  `CREATE TRIGGER IF NOT EXISTS risk_capital_events_no_delete BEFORE DELETE ON risk_capital_events
    BEGIN SELECT RAISE(ABORT, 'capital event is immutable'); END`,
  `CREATE TRIGGER IF NOT EXISTS risk_capital_events_write_guard BEFORE INSERT ON risk_capital_events
    WHEN NOT EXISTS (SELECT 1 FROM risk_loss_write_authorizations WHERE id = NEW.id AND scope_id = NEW.scope_id AND kind = 'capital')
    BEGIN SELECT RAISE(ABORT, 'risk arithmetic write guard'); END`,
  `CREATE TABLE IF NOT EXISTS risk_equity_observations (
    id TEXT PRIMARY KEY,
    scope_id TEXT NOT NULL REFERENCES risk_loss_scopes(id),
    source_ref TEXT NOT NULL,
    observed_at TEXT NOT NULL,
    observed_ms INTEGER NOT NULL,
    equity_usdt TEXT NOT NULL,
    account_reconciled INTEGER NOT NULL CHECK (account_reconciled IN (0, 1)),
    capital_history_reconciled INTEGER NOT NULL CHECK (capital_history_reconciled IN (0, 1)),
    input_hash TEXT NOT NULL,
    result_json TEXT NOT NULL,
    UNIQUE (scope_id, source_ref)
  )`,
  `CREATE TRIGGER IF NOT EXISTS risk_equity_observations_no_update BEFORE UPDATE ON risk_equity_observations
    BEGIN SELECT RAISE(ABORT, 'equity observation is immutable'); END`,
  `CREATE TRIGGER IF NOT EXISTS risk_equity_observations_no_delete BEFORE DELETE ON risk_equity_observations
    BEGIN SELECT RAISE(ABORT, 'equity observation is immutable'); END`,
  `CREATE TRIGGER IF NOT EXISTS risk_equity_observations_write_guard BEFORE INSERT ON risk_equity_observations
    WHEN NOT EXISTS (SELECT 1 FROM risk_loss_write_authorizations WHERE id = NEW.id AND scope_id = NEW.scope_id AND kind = 'observation')
    BEGIN SELECT RAISE(ABORT, 'risk arithmetic write guard'); END`,
  `CREATE TABLE IF NOT EXISTS risk_loss_events (
    id TEXT PRIMARY KEY,
    scope_id TEXT NOT NULL REFERENCES risk_loss_scopes(id),
    observation_id TEXT NOT NULL REFERENCES risk_equity_observations(id),
    kind TEXT NOT NULL CHECK (kind IN ('review', 'soft_pause', 'hard_stop')),
    loss_usdt TEXT NOT NULL,
    created_at TEXT NOT NULL,
    UNIQUE (observation_id, kind)
  )`,
  `CREATE TRIGGER IF NOT EXISTS risk_loss_events_no_update BEFORE UPDATE ON risk_loss_events
    BEGIN SELECT RAISE(ABORT, 'risk loss event is immutable'); END`,
  `CREATE TRIGGER IF NOT EXISTS risk_loss_events_no_delete BEFORE DELETE ON risk_loss_events
    BEGIN SELECT RAISE(ABORT, 'risk loss event is immutable'); END`,
];

/** Migration 1: immutable research method records; run transactionally by openDb. */
export const MIGRATION_1: string[] = [
  `CREATE TABLE IF NOT EXISTS research_method_contexts (run_id TEXT PRIMARY KEY REFERENCES research_runs(id), content TEXT NOT NULL, content_sha256 TEXT NOT NULL)`,
  `CREATE TRIGGER IF NOT EXISTS method_context_no_update BEFORE UPDATE ON research_method_contexts BEGIN SELECT RAISE(ABORT, 'method context immutable'); END`,
  `CREATE TRIGGER IF NOT EXISTS method_context_no_delete BEFORE DELETE ON research_method_contexts BEGIN SELECT RAISE(ABORT, 'method context immutable'); END`,
  `CREATE TABLE IF NOT EXISTS decision_method_records (id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES research_runs(id), client_ref TEXT NOT NULL, content TEXT NOT NULL, content_sha256 TEXT NOT NULL, UNIQUE(run_id, client_ref))`,
  `CREATE TRIGGER IF NOT EXISTS method_records_no_update BEFORE UPDATE ON decision_method_records BEGIN SELECT RAISE(ABORT, 'method record immutable'); END`,
  `CREATE TRIGGER IF NOT EXISTS method_records_no_delete BEFORE DELETE ON decision_method_records BEGIN SELECT RAISE(ABORT, 'method record immutable'); END`,
];

/** Migration 2: freeze the exact decision used by method records. */
export const MIGRATION_2: string[] = [
  `CREATE TABLE IF NOT EXISTS research_decision_seals (run_id TEXT PRIMARY KEY REFERENCES research_runs(id), decision_sha256 TEXT NOT NULL)`,
  `CREATE TRIGGER IF NOT EXISTS decision_seals_no_update BEFORE UPDATE ON research_decision_seals BEGIN SELECT RAISE(ABORT, 'decision seal immutable'); END`,
  `CREATE TRIGGER IF NOT EXISTS decision_seals_no_delete BEFORE DELETE ON research_decision_seals BEGIN SELECT RAISE(ABORT, 'decision seal immutable'); END`,
];

/** Migration 3: isolated conflict fingerprints; no submitted text or URLs. */
export const MIGRATION_3: string[] = [
 `CREATE TABLE IF NOT EXISTS research_submission_conflicts (id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES research_runs(id), assignment_id TEXT NOT NULL REFERENCES research_assignments(id), phase INTEGER NOT NULL, role TEXT NOT NULL, original_sha256 TEXT NOT NULL, payload_sha256 TEXT NOT NULL, kind TEXT NOT NULL, created_at TEXT NOT NULL, record_sha256 TEXT NOT NULL, UNIQUE(assignment_id,payload_sha256))`,
 `CREATE TRIGGER IF NOT EXISTS submission_conflicts_no_update BEFORE UPDATE ON research_submission_conflicts BEGIN SELECT RAISE(ABORT, 'submission conflicts immutable'); END`,
 `CREATE TRIGGER IF NOT EXISTS submission_conflicts_no_delete BEFORE DELETE ON research_submission_conflicts BEGIN SELECT RAISE(ABORT, 'submission conflicts immutable'); END`,
];
