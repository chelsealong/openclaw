import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { describe, expect, it } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { prepareSystemAgentRunAdmission } from "../agents/admitted-run-context.js";
import { prepareCliHistoryBoundary } from "../agents/cli-runner/history-boundary.js";
import { loadCliSessionPromptContext } from "../agents/cli-runner/session-history.js";
import type { PreparedCliRunContext } from "../agents/cli-runner/types.js";
import { SessionManager } from "../agents/sessions/session-manager.js";
import { runWithCliHistoryWriter } from "../config/sessions/cli-history-boundary.js";
import {
  loadTranscriptEvents,
  patchSessionEntryCore,
  resolveSessionTranscriptDatabasePath,
  upsertSessionEntryCore,
} from "../config/sessions/session-accessor.js";
import { runWithoutOwnedSessionTranscriptWrites } from "../config/sessions/transcript-write-context.js";
import {
  captureAgentRunTerminalWriteContext,
  clearAgentRunTerminalWriteContext,
  drainAgentRunTerminalWrites,
} from "../infra/agent-run-terminal-writes.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { createSessionLifecyclePersistenceOwner } from "./session-lifecycle-persistence-owner.js";

async function fixture() {
  const target = {
    agentId: "main",
    sessionId: "cli-timeout-history",
    sessionKey: "agent:main:main",
  };
  const runId = "cli-timeout-run";
  await upsertSessionEntryCore(target, {
    sessionId: target.sessionId,
    updatedAt: 1_000,
    startedAt: 1_000,
    lifecycleRunId: runId,
    activeWriterRunId: runId,
    status: "running",
  });
  const scope = { ...target, storePath: resolveSessionTranscriptDatabasePath(target) };
  const admission = prepareSystemAgentRunAdmission({}, runId, "main", "cli-timeout-test");
  const params: PreparedCliRunContext["params"] = {
    admittedRunContext: await admission.admit("embedded"),
    ...target,
    runId,
    sessionTarget: scope,
    sessionFile: target.sessionKey,
    provider: "test-cli",
    model: "test-model",
    prompt: "Continue the saved work.",
    workspaceDir: process.cwd(),
    timeoutMs: 1_000,
  };
  const credential = { type: "token" as const, provider: "test-cli", token: "account-a" };
  const writer = await prepareCliHistoryBoundary(params, { credential });
  expect(writer).toBeDefined();
  runWithCliHistoryWriter(writer, () => {
    SessionManager.open(scope).appendMessage({
      role: "user",
      content: "Prior account-owned request",
      timestamp: 1_000,
    });
  });
  const owner = createSessionLifecyclePersistenceOwner();
  const captured = captureAgentRunTerminalWriteContext(runId);
  if (!captured) {
    throw new Error("Expected the admitted runtime's terminal write context");
  }
  const persist = (phase: "end" | "error") =>
    runWithoutOwnedSessionTranscriptWrites(() => {
      const pending = owner.observe({
        ...target,
        writeContext: captured,
        event: {
          ...target,
          runId,
          stream: "lifecycle",
          seq: phase === "end" ? 2 : 3,
          ts: 2_000,
          data: { phase, startedAt: 1_000, endedAt: 2_000, aborted: true, stopReason: "timeout" },
        },
      });
      captured.track(pending);
      return pending;
    });
  const laterContext = async (token: string) => {
    const next = prepareSystemAgentRunAdmission({}, "next-cli-run", "main", "cli-timeout-test");
    await patchSessionEntryCore(scope, () => ({ activeWriterRunId: "next-cli-run" }));
    try {
      const nextParams = {
        ...params,
        runId: "next-cli-run",
        admittedRunContext: await next.admit("embedded"),
      };
      const nextWriter = await prepareCliHistoryBoundary(nextParams, {
        credential: { ...credential, token },
      });
      return await loadCliSessionPromptContext({
        ...nextParams,
        allowRawTranscriptReseed: true,
        rawTranscriptReseedReason: nextWriter ? "missing-transcript" : "auth-unknown",
      });
    } finally {
      next.close();
    }
  };
  return { target, admission, captured, persist, laterContext };
}

describe("CLI history through Gateway terminal persistence", () => {
  it.each(["end", "error"] as const)(
    "retains same-account context after %s outside the CLI stack",
    async (phase) => {
      await withOpenClawTestState({ scenario: "minimal" }, async () => {
        const f = await fixture();
        try {
          await f.persist(phase);
          await f.persist(phase === "end" ? "error" : "end");
        } finally {
          f.admission.close();
        }
        const context = await f.laterContext("account-a");
        expect(JSON.stringify(context.reseedMessages)).toContain("Prior account-owned request");
        expect(context.durableContext).toContain("This turn ended before a reply: Run timed out");
        const transcript = await loadTranscriptEvents(f.target);
        expect(
          transcript.filter((entry) => isRecord(entry) && entry.type === "custom_message"),
        ).toHaveLength(1);
        const otherAccount = await f.laterContext("account-b");
        expect(otherAccount.reseedMessages).toEqual([]);
        expect(otherAccount.durableContext).toBeUndefined();
      });
    },
  );

  it("keeps normal completion pending until its accepted write finishes", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      const f = await fixture();
      const release = createDeferred();
      const pending = release.promise.then(() => f.persist("end"));
      f.captured.track(pending);
      let completed = false;
      const finish = drainAgentRunTerminalWrites(f.admission.operationalRunInstance).finally(() => {
        f.admission.close();
        completed = true;
      });
      await Promise.resolve();
      expect(completed).toBe(false);
      release.resolve();
      await finish;
      expect((await f.laterContext("account-a")).durableContext).toContain("Run timed out");
    });
  });

  it.each(["close", "fallback"] as const)(
    "rejects a captured writer after %s without changing history",
    async (revoke) => {
      await withOpenClawTestState({ scenario: "minimal" }, async () => {
        const f = await fixture();
        const before = await loadTranscriptEvents(f.target);
        const pending = f.persist("end");
        if (revoke === "close") {
          f.admission.close();
        } else {
          clearAgentRunTerminalWriteContext(f.admission.operationalRunInstance);
        }
        try {
          await expect(pending).rejects.toThrow("Terminal write owner changed");
          expect(await loadTranscriptEvents(f.target)).toEqual(before);
        } finally {
          f.admission.close();
        }
      });
    },
  );
});
