import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { openNodeSqliteDatabase } from "../infra/node-sqlite.js";
import { OPENCLAW_AGENT_SCHEMA_VERSION } from "./openclaw-agent-db-contract.js";
import { ensureOpenClawAgentDatabaseSchema } from "./openclaw-agent-db-schema.js";
import { OPENCLAW_AGENT_SCHEMA_SQL } from "./openclaw-agent-schema.generated.js";
import { ensureOpenClawAgentStandingIntentsSchema } from "./openclaw-agent-standing-intents-schema.js";

const STANDING_SCHEMA_START = "CREATE TABLE IF NOT EXISTS standing_intents (";
const STANDING_SCHEMA_END = "CREATE TABLE IF NOT EXISTS session_transcript_index_state (";

function schemaWithoutStandingIntents(): string {
  const start = OPENCLAW_AGENT_SCHEMA_SQL.indexOf(STANDING_SCHEMA_START);
  const end = OPENCLAW_AGENT_SCHEMA_SQL.indexOf(STANDING_SCHEMA_END, start);
  if (start < 0 || end < 0) {
    throw new Error("standing-intent schema markers missing in test fixture");
  }
  return `${OPENCLAW_AGENT_SCHEMA_SQL.slice(0, start)}${OPENCLAW_AGENT_SCHEMA_SQL.slice(end)}`;
}

describe("standing-intent additive agent schema", () => {
  let tempDir = "";

  afterEach(async () => {
    if (tempDir) {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it("accepts a current-version database before the lazy ensure and ensures idempotently", async () => {
    tempDir = await fs.realpath(
      await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-intent-schema-")),
    );
    const databasePath = path.join(tempDir, "openclaw-agent.sqlite");
    const db = openNodeSqliteDatabase(databasePath);
    try {
      db.exec(schemaWithoutStandingIntents());
      db.exec(`PRAGMA user_version = ${OPENCLAW_AGENT_SCHEMA_VERSION};`);
      db.prepare(
        `INSERT INTO schema_meta (
          meta_key, role, schema_version, agent_id, app_version, created_at, updated_at
        ) VALUES ('primary', 'agent', ?, 'main', 'test', 1, 1)`,
      ).run(OPENCLAW_AGENT_SCHEMA_VERSION);

      expect(() =>
        ensureOpenClawAgentDatabaseSchema(db, {
          agentId: "main",
          path: databasePath,
        }),
      ).not.toThrow();
      expect(
        db.prepare("SELECT 1 FROM sqlite_schema WHERE name = 'standing_intents'").get(),
      ).toBeUndefined();

      ensureOpenClawAgentStandingIntentsSchema(db);
      ensureOpenClawAgentStandingIntentsSchema(db);

      const tables = db
        .prepare(
          "SELECT name FROM sqlite_schema WHERE name IN ('standing_intents', 'standing_intents_fts') ORDER BY name",
        )
        .all() as Array<{ name: string }>;
      expect(tables.map((row) => row.name)).toStrictEqual([
        "standing_intents",
        "standing_intents_fts",
      ]);
      const columns = db.prepare("PRAGMA table_info(standing_intents)").all() as Array<{
        name: string;
        pk: number;
        type: string;
      }>;
      expect(columns.find((column) => column.name === "intent_key")).toMatchObject({
        type: "INTEGER",
        pk: 1,
      });
      expect(columns.find((column) => column.name === "id")).toMatchObject({
        type: "TEXT",
        pk: 0,
      });
      expect(db.prepare("PRAGMA user_version").get()).toMatchObject({
        user_version: OPENCLAW_AGENT_SCHEMA_VERSION,
      });
    } finally {
      db.close();
    }
  });
});
