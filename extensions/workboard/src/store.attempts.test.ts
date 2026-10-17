import { describe, expect, it } from "vitest";
import { syncWorkboardSubagentEnded } from "./lifecycle-sync.js";
import { createWorkboardSqliteTestStore } from "./test/sqlite-store.js";

describe("Workboard shared-session attempts", () => {
  it.each([undefined, "shared-run"])(
    "persists terminal attempts for two cards sharing a session and run %s",
    async (runId) => {
      const store = createWorkboardSqliteTestStore();
      const sessionKey = "agent:main:shared-worker";
      const cards = [];
      for (let index = 0; index < 2; index += 1) {
        cards.push(
          await store.create({ title: "Shared worker", status: "running", sessionKey, runId }),
        );
      }
      const now = Math.max(...cards.map((card) => card.updatedAt)) + 1;
      for (const card of cards) {
        await store.syncLifecycle(card.id, {
          targetStatus: "review",
          executionStatus: "done",
          sourceUpdatedAt: now,
          stale: undefined,
          now,
          association: {
            expectedSessionKey: sessionKey,
            expectedRunId: runId,
            sessionKey,
            runId,
          },
        });
      }
      const attempts = [];
      for (const card of cards) {
        const persisted = await store.get(card.id);
        expect(persisted).toMatchObject({
          status: "review",
          metadata: {
            attempts: [
              expect.objectContaining({
                id: expect.any(String),
                status: "succeeded",
                sessionKey,
                ...(runId ? { runId } : {}),
              }),
            ],
          },
        });
        expect(persisted?.metadata?.attempts).toHaveLength(1);
        attempts.push(persisted?.metadata?.attempts?.[0]?.id);
      }
      expect(new Set(attempts).size).toBe(2);
    },
  );
  it("keeps a released managed attempt blocked after its card is requeued", async () => {
    const store = createWorkboardSqliteTestStore();
    const card = await store.create({ title: "Retry unfinished work", status: "ready" });
    const claim = await store.claim(card.id, { ownerId: "workboard-dispatcher" });
    const prepared = await store.prepareExecutionLaunch(card.id, {
      requestedSessionKey: "subagent:workboard-default-requeue",
      now: claim.card.updatedAt + 1,
      scope: { ownerId: "workboard-dispatcher", token: claim.token },
    });
    const sessionKey = "agent:main:subagent:workboard-default-requeue";
    const runId = "old-run";
    await store.acceptExecutionLaunch(card.id, {
      expectedLaunch: prepared.launch,
      expectedSessionKey: prepared.launch.requestedSessionKey,
      expectedRunId: prepared.launch.provisionalRunId,
      sessionKey,
      runId,
      execution: {
        id: "old-execution",
        kind: "agent-session",
        mode: "autonomous",
        status: "running",
        sessionKey,
        runId,
        startedAt: 1000,
        updatedAt: 1000,
      },
      acceptedAt: prepared.launch.preparedAt + 1,
    });
    const blocked = await store.block(card.id, {
      ownerId: "workboard-dispatcher",
      token: claim.token,
      reason: "Work remains unfinished.",
    });
    await store.unblock(card.id);
    await store.promote(card.id);

    const updated = await syncWorkboardSubagentEnded({
      store,
      event: {
        targetSessionKey: sessionKey,
        runId,
        endedAt: (await store.get(card.id))!.updatedAt + 1,
        outcome: "ok",
      },
    });

    expect(updated).toBe(0);
    await expect(store.get(card.id)).resolves.toMatchObject({
      status: "ready",
      execution: { status: "blocked", runId },
      metadata: {
        failureCount: 1,
        attempts: [
          expect.objectContaining({ status: "blocked", runId, error: "Work remains unfinished." }),
        ],
      },
    });
    expect(blocked.metadata?.claim).toBeUndefined();
    const retryClaim = await store.claim(card.id, { ownerId: "workboard-dispatcher" });
    expect(retryClaim.card.status).toBe("running");
    const retry = await store.prepareExecutionLaunch(card.id, {
      requestedSessionKey: prepared.launch.requestedSessionKey,
      now: retryClaim.card.updatedAt + 1,
      scope: { ownerId: "workboard-dispatcher", token: retryClaim.token },
    });
    await store.acceptExecutionLaunch(card.id, {
      expectedLaunch: retry.launch,
      expectedSessionKey: retry.launch.requestedSessionKey,
      expectedRunId: retry.launch.provisionalRunId,
      sessionKey,
      runId: "retry-run",
      execution: {
        id: "retry-execution",
        kind: "agent-session",
        mode: "autonomous",
        status: "running",
        sessionKey,
        runId: "retry-run",
        startedAt: 1000,
        updatedAt: 1000,
      },
      acceptedAt: retry.launch.preparedAt + 1,
    });
    const retryEnd = await syncWorkboardSubagentEnded({
      store,
      event: {
        targetSessionKey: sessionKey,
        runId: "retry-run",
        endedAt: (await store.get(card.id))!.updatedAt + 1,
        outcome: "ok",
      },
    });
    expect(retryEnd).toBe(1);
    await expect(store.get(card.id)).resolves.toMatchObject({ status: "review" });
  });
});
