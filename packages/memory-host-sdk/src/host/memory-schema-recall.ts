import type { DatabaseSync } from "node:sqlite";

const MEMORY_INDEX_CHUNKS_TABLE = "memory_index_chunks";

export function ensureMemoryRecallMetadataColumns(db: DatabaseSync): void {
  const rows = db.prepare(`PRAGMA table_info(${MEMORY_INDEX_CHUNKS_TABLE})`).all() as Array<{
    name?: unknown;
  }>;
  const columns = new Set(rows.flatMap((row) => (typeof row.name === "string" ? [row.name] : [])));
  // Null metadata is the compatibility contract for existing indexes: it is
  // ranking-neutral and never makes a chunk eligible for trigger injection.
  if (!columns.has("importance")) {
    db.exec(
      `ALTER TABLE ${MEMORY_INDEX_CHUNKS_TABLE} ADD COLUMN importance INTEGER ` +
        `CHECK (importance IS NULL OR importance BETWEEN 1 AND 10)`,
    );
  }
  if (!columns.has("triggers")) {
    db.exec(`ALTER TABLE ${MEMORY_INDEX_CHUNKS_TABLE} ADD COLUMN triggers TEXT`);
  }
}
