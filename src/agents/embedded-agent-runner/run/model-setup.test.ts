// Startup can race the first provider-runtime snapshot load on a fresh gateway
// boot (see model.startup-retry.test.ts). resolveModelAsync exposes a
// retryTransientProviderRuntimeMiss option for exactly this case; the embedded
// run model setup must opt a resolution attempt into it only while that race
// is actually possible (the plugin registry load is in flight), not on every
// turn for the rest of the process lifetime — otherwise a persistently
// unknown model would re-run provider prepareDynamicModel hooks (e.g.
// OpenRouter's catalog fetch) twice on every single turn.
import { describe, expect, it, vi } from "vitest";
import type { RunEmbeddedAgentParams } from "./params.js";

const resolveModelAsyncMock = vi.fn();
const isPluginProvidersLoadInFlightMock = vi.fn(() => false);

vi.mock("../../../plugins/providers.runtime.js", () => ({
  isPluginProvidersLoadInFlight: (...args: unknown[]) => isPluginProvidersLoadInFlightMock(...args),
}));
vi.mock("../../../plugins/runtime.js", () => ({
  requireActivePluginRegistry: () => ({}),
}));
vi.mock("../../agent-scope.js", () => ({
  resolveDefaultAgentDir: () => "/tmp/agent",
}));
vi.mock("../../harness/runtime-plugin.js", () => ({
  ensureSelectedAgentHarnessPlugin: vi.fn(async () => {}),
}));
vi.mock("../../harness/selection.js", () => ({
  selectAgentHarness: () => ({ id: "openclaw" }),
}));
vi.mock("../../openai-routing.js", () => ({
  resolveSelectedOpenAIRuntimeProvider: ({ provider }: { provider: string }) => provider,
}));
vi.mock("../../prepared-model-runtime.js", () => ({
  prepareModelRuntimeSnapshot: vi.fn(async () => ({
    createStores: () => ({ authStorage: {}, modelRegistry: {} }),
  })),
}));
vi.mock("../model.js", () => ({
  createEmptyAgentDiscoveryStores: () => ({ authStorage: {}, modelRegistry: {} }),
  resolveModelAsync: resolveModelAsyncMock,
}));
vi.mock("./runtime-resolution.js", () => ({
  resolveRequestStreamTransportOverrides: () => undefined,
}));
vi.mock("./setup.js", () => ({
  buildBeforeModelResolveAttachments: () => undefined,
  createNativeModelOwnedRuntimeModel: () => {
    throw new Error("not expected: model is not native-owned in this test");
  },
  resolveHookModelSelection: async ({
    provider,
    modelId,
  }: {
    provider: string;
    modelId: string;
  }) => ({ provider, modelId }),
  resolveNativeModelOwnedHarnessId: () => undefined,
}));

describe("resolveEmbeddedRunModelSetup", () => {
  const runParams = {
    prompt: "hi",
    config: {},
    agentId: "agent-1",
    sessionId: "session-1",
    sessionKey: "agent:main:main",
    modelSelectionLocked: true,
  } as RunEmbeddedAgentParams;

  const baseParams = {
    runParams,
    provider: "anthropic",
    modelId: "claude-opus-5",
    agentDir: "/tmp/agent",
    workspaceDir: "/tmp/workspace",
    globalLane: "lane-1",
    hookRunner: undefined,
    hookContext: { sessionId: "session-1", workspaceDir: "/tmp/workspace" },
    onHooksResolved: () => {},
  };

  it("retries a transient provider-runtime miss on the direct resolution attempt", async () => {
    resolveModelAsyncMock.mockReset();
    isPluginProvidersLoadInFlightMock.mockReset();
    isPluginProvidersLoadInFlightMock.mockReturnValue(true);
    resolveModelAsyncMock.mockResolvedValueOnce({
      model: { id: "claude-opus-5", provider: "anthropic" },
      authStorage: {},
      modelRegistry: {},
    });

    const { resolveEmbeddedRunModelSetup } = await import("./model-setup.js");
    await resolveEmbeddedRunModelSetup(baseParams);

    expect(resolveModelAsyncMock).toHaveBeenCalledTimes(1);
    expect(resolveModelAsyncMock.mock.calls[0]?.[4]).toMatchObject({
      retryTransientProviderRuntimeMiss: true,
    });
  });

  it("retries a transient provider-runtime miss on the prepared-runtime fallback attempt", async () => {
    resolveModelAsyncMock.mockReset();
    isPluginProvidersLoadInFlightMock.mockReset();
    isPluginProvidersLoadInFlightMock.mockReturnValue(true);
    resolveModelAsyncMock
      .mockResolvedValueOnce({ authStorage: {}, modelRegistry: {} })
      .mockResolvedValueOnce({
        model: { id: "claude-opus-5", provider: "anthropic" },
        authStorage: {},
        modelRegistry: {},
      });

    const { resolveEmbeddedRunModelSetup } = await import("./model-setup.js");
    await resolveEmbeddedRunModelSetup(baseParams);

    expect(resolveModelAsyncMock).toHaveBeenCalledTimes(2);
    for (const call of resolveModelAsyncMock.mock.calls) {
      expect(call[4]).toMatchObject({ retryTransientProviderRuntimeMiss: true });
    }
  });

  it("does not opt into the retry once the provider-runtime plugin registry is no longer loading", async () => {
    // Steady-state misses are a genuinely unknown model, not a boot race. Opting
    // in here would make resolveModelAsync re-run prepareDynamicModel a second
    // time on every turn for a persistently misconfigured model id.
    resolveModelAsyncMock.mockReset();
    isPluginProvidersLoadInFlightMock.mockReset();
    isPluginProvidersLoadInFlightMock.mockReturnValue(false);
    resolveModelAsyncMock.mockResolvedValueOnce({
      model: { id: "claude-opus-5", provider: "anthropic" },
      authStorage: {},
      modelRegistry: {},
    });

    const { resolveEmbeddedRunModelSetup } = await import("./model-setup.js");
    await resolveEmbeddedRunModelSetup(baseParams);

    expect(resolveModelAsyncMock).toHaveBeenCalledTimes(1);
    expect(resolveModelAsyncMock.mock.calls[0]?.[4]).toMatchObject({
      retryTransientProviderRuntimeMiss: false,
    });
  });
});
