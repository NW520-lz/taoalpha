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
];
