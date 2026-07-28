// Memory Host SDK module owns additive memory chunk provenance schema.
import type { DatabaseSync } from "node:sqlite";

export const MEMORY_INDEX_CHUNK_PROVENANCE_TABLE = "memory_index_chunk_provenance";

export const MEMORY_INDEX_CHUNK_PROVENANCE_SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS ${MEMORY_INDEX_CHUNK_PROVENANCE_TABLE} (
    chunk_id TEXT PRIMARY KEY,
    origin_class TEXT NOT NULL CHECK (origin_class IN ('owner', 'agent', 'untrusted', 'system')),
    session_kind TEXT NOT NULL CHECK (session_kind IN ('interactive', 'cron', 'heartbeat', 'subagent', 'unknown')),
    observed_at INTEGER NOT NULL,
    supersedes_key TEXT,
    FOREIGN KEY (chunk_id) REFERENCES memory_index_chunks(id) ON DELETE CASCADE
  ) STRICT;
`;

export function ensureMemoryChunkProvenance(db: DatabaseSync): void {
  // Ensure the table itself before the trigger/backfill so this stays a true
  // "ensure" on legacy databases created before provenance existed (e.g. the
  // full-reindex publish path), not only when the base schema already ran it.
  db.exec(MEMORY_INDEX_CHUNK_PROVENANCE_SCHEMA_SQL);
  db.exec(`
    CREATE TRIGGER IF NOT EXISTS memory_index_chunk_provenance_after_insert
    AFTER INSERT ON memory_index_chunks
    BEGIN
      -- Default by source: workspace memory files (MEMORY.md, USER.md,
      -- memory/*.md) are owner-controlled and default to 'agent' so they are
      -- eligible for dreaming promotion; session-transcript chunks default to
      -- 'untrusted' until the ingestion path classifies each message by sender.
      INSERT OR IGNORE INTO ${MEMORY_INDEX_CHUNK_PROVENANCE_TABLE} (
        chunk_id, origin_class, session_kind, observed_at
      ) VALUES (
        NEW.id,
        CASE WHEN NEW.source = 'memory' THEN 'agent' ELSE 'untrusted' END,
        'unknown',
        NEW.updated_at
      );
    END;

    UPDATE memory_index_sources
    SET hash = ''
    WHERE EXISTS (
      SELECT 1
      FROM memory_index_chunks AS chunk
      LEFT JOIN ${MEMORY_INDEX_CHUNK_PROVENANCE_TABLE} AS provenance
        ON provenance.chunk_id = chunk.id
      WHERE provenance.chunk_id IS NULL
        AND chunk.path = memory_index_sources.path
        AND chunk.source IS memory_index_sources.source
    );

    INSERT OR IGNORE INTO ${MEMORY_INDEX_CHUNK_PROVENANCE_TABLE} (
      chunk_id, origin_class, session_kind, observed_at
    )
    SELECT id, 'untrusted', 'unknown', updated_at FROM memory_index_chunks;
  `);
}
