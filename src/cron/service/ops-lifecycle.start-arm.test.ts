import { expect, it, vi } from "vitest";
import {
  createCronRegressionState,
  setupCronRegressionFixtures,
} from "../../../test/helpers/cron/service-regression-fixtures.js";
import { openOpenClawStateDatabase } from "../../state/openclaw-state-db.js";
import { saveCronStore } from "../store.js";
import type { CronJob } from "../types.js";
import { start } from "./ops-lifecycle.js";

const fixtures = setupCronRegressionFixtures({ prefix: "cron-start-arm-" });

function createDueMainJob(id: string, nextRunAtMs: number): CronJob {
  return {
    id,
    name: id,
    enabled: true,
    deleteAfterRun: false,
    createdAtMs: nextRunAtMs,
    updatedAtMs: nextRunAtMs,
    schedule: { kind: "at", at: new Date(nextRunAtMs).toISOString() },
    sessionTarget: "main",
    wakeMode: "next-heartbeat",
    payload: { kind: "systemEvent", text: id },
    delivery: { mode: "none" },
    state: { nextRunAtMs },
  };
}

function installOneShotTerminalWriteFailure(jobId: string) {
  const database = openOpenClawStateDatabase().db;
  let rejected = false;
  database.function("reject_start_arm_terminal", (id: unknown, stateJson: unknown) => {
    if (id === jobId && typeof stateJson === "string") {
      const persisted = JSON.parse(stateJson) as CronJob["state"];
      if (!rejected && persisted.lastRunStatus !== undefined) {
        rejected = true;
        throw new Error("startup terminal write failed");
      }
    }
    return 0;
  });
  database.exec(`
    CREATE TEMP TRIGGER reject_start_arm_terminal
    AFTER UPDATE ON cron_jobs
    BEGIN
      SELECT reject_start_arm_terminal(NEW.job_id, NEW.state_json);
    END;
  `);
  return () => database.exec("DROP TRIGGER IF EXISTS reject_start_arm_terminal");
}

it("arms the scheduler and still rejects when startup catch-up fails", async () => {
  const store = fixtures.makeStorePath();
  const dueAt = Date.parse("2026-02-06T10:04:59.000Z");
  const overdue = createDueMainJob("start-arm-overdue", dueAt - 30_000);
  const upcoming = createDueMainJob("start-arm-upcoming", dueAt + 12_000);
  await saveCronStore(store.storePath, { version: 1, jobs: [overdue, upcoming] });

  const state = createCronRegressionState({
    storePath: store.storePath,
    nowMs: () => dueAt,
    enqueueSystemEvent: vi.fn(() => true),
    requestHeartbeat: vi.fn(),
  });
  const dropTrigger = installOneShotTerminalWriteFailure(overdue.id);
  try {
    await expect(start(state)).rejects.toThrow("startup terminal write failed");
    expect(state.timer).not.toBeNull();
    expect(state.stopped).toBe(false);
    expect(state.schedulingPaused).toBe(false);
  } finally {
    dropTrigger();
    if (state.timer) {
      clearTimeout(state.timer);
    }
  }
});
