// A durably queued completion must not be reported as a delivery failure.
import { describe, expect, it, vi } from "vitest";

const subagentAnnounceDeliveryMocks = vi.hoisted(() => ({
  deliverSubagentAnnouncement: vi.fn(),
}));
vi.mock("../subagents/announce/subagent-announce-delivery.js", () => subagentAnnounceDeliveryMocks);

import { wakeMediaGenerationTaskCompletion } from "./media-generate-background-completion.js";
import { scheduleMediaGenerationTaskCompletion } from "./media-generate-background-shared.js";

describe("scheduleMediaGenerationTaskCompletion", () => {
  it("does not report a false delivery failure once completion is durably queued", async () => {
    vi.useFakeTimers();
    try {
      subagentAnnounceDeliveryMocks.deliverSubagentAnnouncement.mockResolvedValue({
        delivered: false,
        path: "queued",
        disposition: "session_queued",
      });
      const scheduled: Array<() => Promise<void>> = [];
      const onWakeFailure = vi.fn();
      const completeTaskRun = vi.fn();

      scheduleMediaGenerationTaskCompletion({
        lifecycle: {
          createTaskRun: vi.fn(),
          recordTaskProgress: vi.fn(),
          completeTaskRun,
          failTaskRun: vi.fn(),
          wakeTaskCompletion: (params) =>
            wakeMediaGenerationTaskCompletion({
              ...params,
              eventSource: "image_generation",
              announceType: "image generation task",
              toolName: "image_generate",
              completionLabel: "image",
            }),
        },
        handle: {
          taskId: "task-image-queued",
          runId: "tool:image_generate:queued",
          requesterSessionKey: "agent:main:cron:job:run:run-id",
          taskLabel: "proof image",
        },
        scheduleBackgroundWork: (work) => scheduled.push(work),
        progressSummary: "Generating image",
        toolName: "Image generation",
        onWakeFailure,
        run: async () => ({ provider: "openai", model: "gpt-image-1", count: 1, wakeResult: "ok" }),
      });

      const backgroundWork = scheduled[0]?.();
      // Bound the wait instead of racing the runner's own timeout: without
      // the fix this never settles inside the 120s handoff deadline.
      await vi.advanceTimersByTimeAsync(120_000);
      await backgroundWork;

      expect(completeTaskRun).toHaveBeenCalledWith(
        expect.objectContaining({ terminalResult: undefined }),
      );
      expect(onWakeFailure).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});
