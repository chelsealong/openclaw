/** Tests configured ACP binding thinking-default precedence. */
import { describe, expect, it } from "vitest";
import type { AgentAcpBinding } from "../../config/types.agents.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { acpConfiguredBindingConsumer } from "./acp-configured-binding-consumer.js";

const binding: AgentAcpBinding = {
  type: "acp",
  agentId: "codex",
  match: { channel: "discord" },
};

function materializeThinking(cfg: OpenClawConfig): string | undefined {
  const factory = acpConfiguredBindingConsumer.buildTargetFactory({
    cfg,
    binding,
    channel: "discord",
    agentId: "codex",
    target: { conversationId: "convo-1" },
    bindingConversationId: "convo-1",
  });
  const materialized = factory?.materialize({
    accountId: "default",
    conversation: { conversationId: "convo-1" },
  });
  return materialized?.record.metadata?.thinking as string | undefined;
}

const baseCfg = {
  session: { mainKey: "main", scope: "per-sender" },
  agents: {
    list: [{ id: "codex", model: "ollama-cloud/glm-5.2:cloud" }],
    defaults: {
      thinkingDefault: "adaptive",
      models: {
        "ollama-cloud/glm-5.2:cloud": { params: { thinking: "off" } },
      },
    },
  },
} satisfies OpenClawConfig;

describe("acpConfiguredBindingConsumer thinking precedence", () => {
  it("honors per-model params.thinking over the global default", () => {
    expect(materializeThinking(baseCfg)).toBe("off");
  });

  it("still lets an explicit per-agent thinkingDefault win over per-model policy", () => {
    const cfg = {
      ...baseCfg,
      agents: {
        ...baseCfg.agents,
        list: [{ id: "codex", model: "ollama-cloud/glm-5.2:cloud", thinkingDefault: "high" }],
      },
    } satisfies OpenClawConfig;

    expect(materializeThinking(cfg)).toBe("high");
  });

  it("falls back to the global default when neither agent nor per-model policy is set", () => {
    const cfg = {
      ...baseCfg,
      agents: { ...baseCfg.agents, defaults: { thinkingDefault: "adaptive" } },
    } satisfies OpenClawConfig;

    expect(materializeThinking(cfg)).toBe("adaptive");
  });
});
