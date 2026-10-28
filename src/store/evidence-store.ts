import type { RawResponse } from "../okx/public-client.ts";
import { hashJson, sha256 } from "../lib/hash.ts";
import { newId } from "../lib/ids.ts";
import { getRow, type Db } from "./db.ts";

export interface StoredRaw extends RawResponse {
  id: string;
  bodySha256: string;
}

export function saveRaw(db: Db, raw: RawResponse): string {
  const id = newId("raw");
  db.prepare("INSERT INTO raw_responses (id, endpoint, received_at, status, body, body_sha256) VALUES (?, ?, ?, ?, ?, ?)")
    .run(id, raw.endpoint, raw.receivedAt, raw.status, raw.body, sha256(raw.body));
  return id;
}

interface RawRow {
  id: string;
  endpoint: string;
  received_at: string;
  status: number;
  body: string;
  body_sha256: string;
}

export function getRaw(db: Db, id: string): StoredRaw | null {
  const row = getRow<RawRow>(db, "SELECT * FROM raw_responses WHERE id = ?", id);
  if (!row) return null;
  return { id: row.id, endpoint: row.endpoint, receivedAt: row.received_at, status: row.status, body: row.body, bodySha256: row.body_sha256 };
}

export type EvidenceKind = "market_snapshot" | "external_source";

export interface EvidenceInput {
  kind: EvidenceKind;
  /** API source identifier or source URL. */
  source: string;
  /** Original publication time when known. */
  publishedAt: string | null;
  collectedAt: string;
  label: "fact" | "inference";
  instIds: string[];
  content: unknown;
  rawRef: string | null;
  submittedBy: string;
}

export interface EvidenceItem extends EvidenceInput {
  id: string;
  contentSha256: string;
}

export function saveEvidence(db: Db, input: EvidenceInput): EvidenceItem {
  const item: EvidenceItem = { ...input, id: newId("ev"), contentSha256: hashJson(input.content) };
  db.prepare(
    `INSERT INTO evidence_items (id, kind, source, published_at, collected_at, label, inst_ids, content, content_sha256, raw_ref, submitted_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    item.id,
    item.kind,
    item.source,
    item.publishedAt,
    item.collectedAt,
    item.label,
    JSON.stringify(item.instIds),
    JSON.stringify(item.content),
    item.contentSha256,
    item.rawRef,
    item.submittedBy,
  );
  return item;
}

interface EvidenceRow {
  id: string;
  kind: EvidenceKind;
  source: string;
  published_at: string | null;
  collected_at: string;
  label: "fact" | "inference";
  inst_ids: string;
  content: string;
  content_sha256: string;
  raw_ref: string | null;
  submitted_by: string;
}

export function getEvidence(db: Db, id: string): EvidenceItem | null {
  const row = getRow<EvidenceRow>(db, "SELECT * FROM evidence_items WHERE id = ?", id);
  if (!row) return null;
  return {
    id: row.id,
    kind: row.kind,
    source: row.source,
    publishedAt: row.published_at,
    collectedAt: row.collected_at,
    label: row.label,
    instIds: JSON.parse(row.inst_ids) as string[],
    content: JSON.parse(row.content) as unknown,
    contentSha256: row.content_sha256,
    rawRef: row.raw_ref,
    submittedBy: row.submitted_by,
  };
}

export interface StoredBundle {
  id: string;
  createdAt: string;
  contentSha256: string;
  content: unknown;
}

export function saveBundle(db: Db, createdAt: string, content: unknown): StoredBundle {
  const bundle: StoredBundle = { id: newId("bundle"), createdAt, contentSha256: hashJson(content), content };
  db.prepare("INSERT INTO evidence_bundles (id, created_at, content, content_sha256) VALUES (?, ?, ?, ?)")
    .run(bundle.id, bundle.createdAt, JSON.stringify(content), bundle.contentSha256);
  return bundle;
}

interface BundleRow {
  id: string;
  created_at: string;
  content: string;
  content_sha256: string;
}

export function getBundle(db: Db, id: string): StoredBundle | null {
  const row = getRow<BundleRow>(db, "SELECT * FROM evidence_bundles WHERE id = ?", id);
  if (!row) return null;
  return { id: row.id, createdAt: row.created_at, contentSha256: row.content_sha256, content: JSON.parse(row.content) as unknown };
}

export function latestBundleId(db: Db): string | null {
  const row = getRow<{ id: string }>(db, "SELECT id FROM evidence_bundles ORDER BY created_at DESC, rowid DESC LIMIT 1");
  return row ? row.id : null;
}
