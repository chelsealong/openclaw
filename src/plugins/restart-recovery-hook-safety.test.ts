import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  findRestartRecoveryUnsafeChatAdmissionHook,
  findRestartRecoveryUnsafeReplyHook,
} from "./restart-recovery-hook-safety.js";

const hookMocks = vi.hoisted(() => ({
  hasGlobalHooks: vi.fn<(hookName: string, ctx?: { trigger?: string }) => boolean>(),
}));

vi.mock("./hook-runner-global.js", () => ({
  hasGlobalHooks: hookMocks.hasGlobalHooks,
}));

describe("findRestartRecoveryUnsafeReplyHook", () => {
  beforeEach(() => {
    hookMocks.hasGlobalHooks.mockReset();
    hookMocks.hasGlobalHooks.mockReturnValue(false);
  });

  it("reports the first active unsafe reply hook", () => {
    hookMocks.hasGlobalHooks.mockImplementation(
      (hookName) => hookName === "before_agent_reply" || hookName === "before_message_write",
    );

    expect(findRestartRecoveryUnsafeReplyHook({ trigger: "user" })).toBe("before_agent_reply");
    expect(hookMocks.hasGlobalHooks).toHaveBeenCalledWith("before_agent_reply", {
      trigger: "user",
    });
  });

  it("does not exempt a checkpointed hook without a cross-process implementation digest", () => {
    hookMocks.hasGlobalHooks.mockImplementation(
      (hookName) => hookName === "before_agent_reply" || hookName === "before_message_write",
    );

    expect(findRestartRecoveryUnsafeReplyHook({ trigger: "user" })).toBe("before_agent_reply");
  });

  it("does not block a user recovery for a trigger-scoped reply hook", () => {
    hookMocks.hasGlobalHooks.mockImplementation(
      (hookName, ctx) => hookName === "before_agent_reply" && ctx?.trigger === "heartbeat",
    );

    expect(findRestartRecoveryUnsafeReplyHook({ trigger: "user" })).toBeUndefined();
  });

  it("allows deferred before_agent_reply at initial durable chat admission", () => {
    hookMocks.hasGlobalHooks.mockImplementation(
      (hookName) => hookName === "before_agent_reply" || hookName === "before_message_write",
    );

    expect(findRestartRecoveryUnsafeChatAdmissionHook()).toBe("before_message_write");
  });
});
