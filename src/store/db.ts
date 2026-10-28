import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { SCHEMA } from "./schema.ts";

export type Db = DatabaseSync;
export type SqlParam = null | number | bigint | string;

export function openDb(path: string): Db {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  // busy_timeout first so the WAL switch waits for other processes; recursive_triggers makes INSERT OR REPLACE fire the immutability DELETE triggers.
  db.exec("PRAGMA busy_timeout = 5000; PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA recursive_triggers = ON;");
  for (const statement of SCHEMA) db.exec(statement);
  return db;
}

/** BEGIN IMMEDIATE takes the write lock up front, so concurrent CLI processes serialize instead of racing. */
export function inTransaction<T>(db: Db, fn: () => T): T {
  db.exec("BEGIN IMMEDIATE");
  try {
    const result = fn();
    db.exec("COMMIT");
    return result;
  } catch (err) {
    // SQLite may already have rolled back (e.g. after an I/O error); a second ROLLBACK would mask the original error.
    if (db.isTransaction) db.exec("ROLLBACK");
    throw err;
  }
}

export function getRow<T>(db: Db, sql: string, ...params: SqlParam[]): T | undefined {
  return db.prepare(sql).get(...params) as unknown as T | undefined;
}

export function allRows<T>(db: Db, sql: string, ...params: SqlParam[]): T[] {
  return db.prepare(sql).all(...params) as unknown as T[];
}
