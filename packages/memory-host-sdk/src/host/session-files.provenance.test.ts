// Memory Host SDK tests cover transcript provenance and recall-loop hygiene.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildSessionEntry } from "./session-files.js";

let testDir = "";

beforeEach(async () => {
  testDir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "session-provenance-")));
});

afterEach(async () => {
  await fs.rm(testDir, { recursive: true, force: true });
});

async function writeTranscript(name: string, records: unknown[]): Promise<string> {
  const filePath = path.join(testDir, name);
  await fs.writeFile(filePath, records.map((record) => JSON.stringify(record)).join("\n"));
  return filePath;
}

describe("session transcript provenance", () => {
  it("classifies owner input and its agent-derived response", async () => {
    const filePath = await writeTranscript("owner.jsonl", [
      {
        type: "message",
        timestamp: "2026-07-01T10:00:00.000Z",
        message: {
          role: "user",
          content: "Owner preference.",
          __openclaw: { senderIsOwner: true },
        },
      },
      {
        type: "message",
        timestamp: "2026-07-01T10:01:00.000Z",
        message: { role: "assistant", content: "Derived summary." },
      },
    ]);

    const entry = await buildSessionEntry(filePath, { sessionKind: "interactive" });
    expect(entry?.lineProvenance).toEqual([
      {
        originClass: "owner",
        sessionKind: "interactive",
        observedAt: Date.parse("2026-07-01T10:00:00.000Z"),
      },
      {
        originClass: "agent",
        sessionKind: "interactive",
        observedAt: Date.parse("2026-07-01T10:01:00.000Z"),
      },
    ]);
  });

  it("excludes a structurally marked recalled turn", async () => {
    const filePath = await writeTranscript("recalled.jsonl", [
      {
        type: "message",
        message: {
          role: "user",
          content: "Recalled snippet that must not loop.",
          provenance: { kind: "internal_system", sourceTool: "memory_search" },
        },
      },
      {
        type: "message",
        message: { role: "assistant", content: "Paraphrase of the recalled snippet." },
      },
    ]);

    const entry = await buildSessionEntry(filePath);
    expect(entry?.content).toBe("");
    expect(entry?.lineMap).toEqual([]);
  });

  it("normalizes filesystem fallback observation times to SQLite integers", async () => {
    const filePath = await writeTranscript("mtime.jsonl", [
      {
        type: "message",
        message: {
          role: "user",
          content: "Owner preference without a message timestamp.",
          __openclaw: { senderIsOwner: true },
        },
      },
    ]);
    const mtime = new Date("2026-07-01T10:00:00.789Z");
    await fs.utimes(filePath, mtime, mtime);

    const entry = await buildSessionEntry(filePath, { sessionKind: "interactive" });
    expect(Number.isInteger(entry?.lineProvenance[0]?.observedAt)).toBe(true);
  });
});
