import type { StreamFn } from "openclaw/plugin-sdk/agent-core";
import { createAssistantMessageEventStream, type Model } from "openclaw/plugin-sdk/llm";
import { describe, expect, it } from "vitest";
import type { ThinkLevel } from "../../../auto-reply/thinking.js";
import { createMinimaxFastModeWrapper, createMinimaxThinkingDisabledWrapper } from "./minimax.js";

const minimaxModel = {
  api: "anthropic-messages",
  provider: "minimax",
  id: "MiniMax-M2.7",
} as Model<"anthropic-messages">;

function captureThinkingPayload({
  model = minimaxModel,
  payload = {},
  thinkingLevel,
  options = {},
}: {
  model?: Model;
  payload?: Record<string, unknown>;
  thinkingLevel?: ThinkLevel;
  options?: Parameters<StreamFn>[2];
} = {}) {
  const baseStreamFn: StreamFn = (streamModel, _context, streamOptions) => {
    streamOptions?.onPayload?.(payload, streamModel);
    return createAssistantMessageEventStream();
  };
  void createMinimaxThinkingDisabledWrapper(baseStreamFn, thinkingLevel)(
    model,
    { messages: [] },
    options,
  );
  return payload;
}

describe("createMinimaxThinkingDisabledWrapper", () => {
  it.each([
    ["minimax", "anthropic-messages", "MiniMax-M2.7", { type: "disabled" }],
    ["minimax-portal", "anthropic-messages", "MiniMax-M2.7", { type: "disabled" }],
    ["anthropic", "anthropic-messages", "claude-sonnet-4-6", undefined],
    ["minimax", "openai-completions", "MiniMax-M2.7", undefined],
    ["minimax", "anthropic-messages", "MiniMax-M3", undefined],
    ["minimax-portal", "anthropic-messages", "MiniMax-M3", undefined],
  ] as const)("sets default thinking for %s/%s/%s", (provider, api, id, expected) => {
    expect(
      captureThinkingPayload({ model: { ...minimaxModel, provider, api, id } }).thinking,
    ).toEqual(expected);
  });

  it.each([
    ["removes implicit disabled thinking", undefined, { type: "disabled" }, undefined],
    ["preserves explicit off thinking", "off", { type: "disabled" }, { type: "disabled" }],
    [
      "rewrites budget thinking to adaptive",
      "adaptive",
      { type: "enabled", budget_tokens: 1024 },
      { type: "adaptive" },
    ],
  ] as const)("%s for MiniMax-M3", (_name, thinkingLevel, thinking, expected) => {
    expect(
      captureThinkingPayload({
        model: { ...minimaxModel, id: "MiniMax-M3" },
        payload: { thinking },
        thinkingLevel,
      }).thinking,
    ).toEqual(expected);
  });

  it("restores explicit MiniMax-M3 maxTokens when rewriting budget thinking", () => {
    expect(
      captureThinkingPayload({
        model: { ...minimaxModel, id: "MiniMax-M3" },
        payload: { max_tokens: 8692, thinking: { type: "enabled", budget_tokens: 8192 } },
        thinkingLevel: "adaptive",
        options: { maxTokens: 500 },
      }),
    ).toMatchObject({ max_tokens: 500, thinking: { type: "adaptive" } });
  });

  it("preserves explicit enabled thinking for MiniMax-M3", () => {
    const capturedPayload = captureThinkingPayload({
      model: { ...minimaxModel, id: "MiniMax-M3" },
      payload: { thinking: { type: "disabled" } },
      options: {
        onPayload: (payload) => {
          (payload as Record<string, unknown>).thinking = { type: "enabled", budget_tokens: 1024 };
        },
      },
    });
    expect(capturedPayload.thinking).toEqual({ type: "enabled", budget_tokens: 1024 });
  });

  it("preserves an already-set thinking value", () => {
    expect(
      captureThinkingPayload({
        payload: { thinking: { type: "enabled", budget_tokens: 1024 } },
      }).thinking,
    ).toEqual({ type: "enabled", budget_tokens: 1024 });
  });

  it.each([
    ["low", "low"],
    ["xhigh", "xhigh"],
  ] as const)(
    "maps thinking level %s onto output_config.effort %s for MiniMax-M3.1",
    (level, effort) => {
      const payload = captureThinkingPayload({
        model: { ...minimaxModel, id: "MiniMax-M3.1-Flash-Preview" },
        thinkingLevel: level,
      });
      expect(payload.thinking).toEqual({ type: "adaptive" });
      expect(payload.output_config).toEqual({ effort });
    },
  );

  it("never sends disabled thinking for MiniMax-M3.1, even with an explicit off level", () => {
    const payload = captureThinkingPayload({
      model: { ...minimaxModel, id: "MiniMax-M3.1-Flash-Preview" },
      payload: { thinking: { type: "disabled" } },
      thinkingLevel: "off",
    });
    expect(payload.thinking).toEqual({ type: "adaptive" });
    expect(payload.output_config).toBeUndefined();
  });

  it("omits output_config.effort for MiniMax-M3.1 when no thinking level is selected", () => {
    const payload = captureThinkingPayload({
      model: { ...minimaxModel, id: "MiniMax-M3.1-Flash-Preview" },
    });
    expect(payload.thinking).toEqual({ type: "adaptive" });
    expect(payload.output_config).toBeUndefined();
  });
});

describe("createMinimaxFastModeWrapper", () => {
  it("rewrites MiniMax-M2.7 to highspeed variant in fast mode", () => {
    let capturedId = "";
    const baseStreamFn: StreamFn = (model) => {
      capturedId = model.id;
      return createAssistantMessageEventStream();
    };
    void createMinimaxFastModeWrapper(baseStreamFn, true)(minimaxModel, { messages: [] }, {});
    expect(capturedId).toBe("MiniMax-M2.7-highspeed");
  });

  it("resolves dynamic fast mode for each stream call", () => {
    const capturedIds: string[] = [];
    const baseStreamFn: StreamFn = (model) => {
      capturedIds.push(model.id);
      return createAssistantMessageEventStream();
    };
    let enabled = true;
    const wrapped = createMinimaxFastModeWrapper(baseStreamFn, () => enabled);
    void wrapped(minimaxModel, { messages: [] }, {});
    enabled = false;
    void wrapped(minimaxModel, { messages: [] }, {});
    expect(capturedIds).toEqual(["MiniMax-M2.7-highspeed", "MiniMax-M2.7"]);
  });
});
