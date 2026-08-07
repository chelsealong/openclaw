import type { ModelProviderConfig } from "openclaw/plugin-sdk/provider-model-shared";
import { normalizeOptionalString } from "openclaw/plugin-sdk/string-coerce-runtime";
import { XAI_BASE_URL } from "./model-definitions.js";
import { normalizeXaiModelId } from "./model-id.js";
import { isXaiProviderId } from "./provider-id.js";

type XaiRouteConfig = { models?: { providers?: Record<string, ModelProviderConfig | undefined> } };

const XAI_NATIVE_ENDPOINT_HOSTS = new Set(["api.x.ai"]);

function resolveHostname(value: string): string | undefined {
  try {
    return new URL(value).hostname.toLowerCase();
  } catch {
    return undefined;
  }
}

function isXaiNativeEndpoint(baseUrl: unknown): boolean {
  return (
    typeof baseUrl === "string" && XAI_NATIVE_ENDPOINT_HOSTS.has(resolveHostname(baseUrl) ?? "")
  );
}

/** Resolves the authored `models.providers.xai` entry, tolerating the `x-ai` alias key. */
function resolveAuthoredXaiProviderConfig(
  config: XaiRouteConfig | undefined,
  provider: string,
): ModelProviderConfig | undefined {
  const providers = Object.entries(config?.models?.providers ?? {});
  const requestedProvider = provider.trim();
  const providerKey =
    providers.find(([providerId]) => providerId.trim() === requestedProvider)?.[0] ??
    providers.find(([providerId]) => isXaiProviderId(providerId))?.[0];
  return providers.find(([providerId]) => providerId === providerKey)?.[1];
}

/** Completions authored directly in config is a current transport contract, not stale state. */
function resolveAuthoredXaiCompletionsRoute(params: {
  provider: string;
  modelId?: string;
  config?: XaiRouteConfig;
}): boolean {
  const providerConfig = resolveAuthoredXaiProviderConfig(params.config, params.provider);
  if (!providerConfig) {
    return false;
  }
  const requestedModelId =
    params.modelId !== undefined ? normalizeXaiModelId(params.modelId) : undefined;
  const modelConfig = providerConfig.models?.find(
    (model) => normalizeXaiModelId(model.id) === requestedModelId,
  );
  const effectiveApi = modelConfig?.api ?? providerConfig.api;
  return effectiveApi === "openai-completions";
}

function shouldUseXaiResponsesTransport(params: {
  provider: string;
  modelId?: string;
  api?: unknown;
  baseUrl?: unknown;
  config?: XaiRouteConfig;
}): boolean {
  const hasDefaultXaiRoute =
    isXaiProviderId(params.provider) && !normalizeOptionalString(params.baseUrl);
  if (params.api === "openai-responses") {
    return hasDefaultXaiRoute;
  }
  if (params.api !== "openai-completions") {
    return false;
  }
  if (isXaiProviderId(params.provider) && resolveAuthoredXaiCompletionsRoute(params)) {
    return false;
  }
  return isXaiNativeEndpoint(params.baseUrl) || hasDefaultXaiRoute;
}

export function resolveXaiTransport(params: {
  provider: string;
  modelId?: string;
  api?: unknown;
  baseUrl?: unknown;
  config?: XaiRouteConfig;
}): { api: "openai-responses"; baseUrl?: string } | undefined {
  if (!shouldUseXaiResponsesTransport(params)) {
    return undefined;
  }
  return {
    api: "openai-responses",
    baseUrl:
      normalizeOptionalString(params.baseUrl) ??
      (isXaiProviderId(params.provider) ? XAI_BASE_URL : undefined),
  };
}
