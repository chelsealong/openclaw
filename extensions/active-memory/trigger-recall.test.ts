import type { MemorySearchResult } from "openclaw/plugin-sdk/memory-core-host-engine-storage";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildTriggerRecallContext,
  isPromotedTrustedMemoryEntry,
  MAX_TRIGGER_CONTEXT_CHARS,
  scoreTriggerMatch,
  resolveTriggerRecall,
  selectStrongTriggerMatches,
} from "./trigger-recall.js";

const hoisted = vi.hoisted(() => ({
  search: vi.fn(),
  listTriggerCandidates: vi.fn(),
}));

vi.mock("openclaw/plugin-sdk/memory-host-search", () => ({
  getActiveMemorySearchManager: vi.fn(async () => ({
    manager: { search: hoisted.search, listTriggerCandidates: hoisted.listTriggerCandidates },
  })),
}));

function result(overrides: Partial<MemorySearchResult> = {}): MemorySearchResult {
  return {
    path: "MEMORY.md",
    startLine: 1,
    endLine: 2,
    score: 0.8,
    snippet: "User prefers aisle seats and extra connection time.",
    source: "memory",
    triggers: "when booking a flight; seat preferences",
    ...overrides,
  };
}

describe("active-memory trigger recall", () => {
  beforeEach(() => {
    hoisted.search.mockReset();
    hoisted.listTriggerCandidates.mockReset();
  });

  it("matches trigger phrases deterministically", () => {
    expect(scoreTriggerMatch("Can you help when booking a flight?", result())).toBeGreaterThan(0.8);
    expect(scoreTriggerMatch("Explain SQLite indexes", result())).toBeLessThan(0.5);
    expect(
      scoreTriggerMatch("This party starts at eight", result({ score: 0.2, triggers: "art" })),
    ).toBeLessThan(0.72);
    expect(
      scoreTriggerMatch("Project status", result({ score: 0, triggers: "project" })),
    ).toBeCloseTo(0.68);
  });

  it("limits automatic injection to curated or trusted-origin entries", () => {
    expect(isPromotedTrustedMemoryEntry(result())).toBe(true);
    expect(isPromotedTrustedMemoryEntry(result({ path: "USER.md" }))).toBe(true);
    expect(isPromotedTrustedMemoryEntry(result({ path: "memory/2026-07-27.md" }))).toBe(false);
    expect(isPromotedTrustedMemoryEntry(result({ source: "sessions" }))).toBe(false);
    expect(
      isPromotedTrustedMemoryEntry(result({ path: "memory/promoted.md", originClass: "owner" })),
    ).toBe(true);

    const matches = selectStrongTriggerMatches("when booking a flight", [
      result(),
      result({ path: "USER.md", startLine: 3 }),
      result({ path: "memory/2026-07-27.md", startLine: 4 }),
      result({ source: "sessions", path: "session.jsonl", startLine: 5 }),
    ]);
    expect(matches.map((entry) => entry.path)).toEqual(["MEMORY.md", "USER.md"]);

    const provenanceMatches = selectStrongTriggerMatches("when booking a flight", [
      result({ path: "memory/untrusted.md", originClass: "untrusted", score: 1 }),
      result({ path: "memory/owner.md", originClass: "owner", score: 1 }),
    ]);
    expect(provenanceMatches.map((entry) => entry.path)).toEqual(["memory/owner.md"]);
  });

  it("searches lexical-only so the reply path never embeds the query", async () => {
    hoisted.search.mockResolvedValue([result()]);
    hoisted.listTriggerCandidates.mockResolvedValue([]);
    await resolveTriggerRecall({
      cfg: {} as never,
      agentId: "main",
      query: "flight booking",
      message: "Help when booking a flight",
    });
    expect(hoisted.search).toHaveBeenCalledWith(
      "flight booking",
      expect.objectContaining({ lexicalOnly: true, qmdSearchModeOverride: "search" }),
    );
  });

  it("matches curated trigger candidates even when text retrieval fails", async () => {
    hoisted.search.mockRejectedValue(new Error("embedding unavailable"));
    hoisted.listTriggerCandidates.mockResolvedValue([result({ score: 0 })]);
    const recalled = await resolveTriggerRecall({
      cfg: {} as never,
      agentId: "main",
      query: "flight booking",
      message: "Help when booking a flight",
    });
    expect(recalled.hasStrongHit).toBe(true);
    expect(recalled.context).toContain("aisle seats");
  });

  it("injects at most three matches inside the bounded active-memory wrapper", () => {
    const matches = selectStrongTriggerMatches(
      "when booking a flight",
      Array.from({ length: 5 }, (_, index) =>
        result({
          path: index % 2 === 0 ? "MEMORY.md" : "USER.md",
          startLine: index + 1,
          snippet: `${String(index)} ${"x".repeat(900)}`,
        }),
      ),
    );
    const context = buildTriggerRecallContext(matches);
    expect(matches).toHaveLength(3);
    expect(context).toContain("<active_memory_plugin>");
    expect(context).toContain("</active_memory_plugin>");
    expect(context?.length).toBeLessThanOrEqual(MAX_TRIGGER_CONTEXT_CHARS + 80);
    expect(context).not.toContain("3 x");
  });
});
