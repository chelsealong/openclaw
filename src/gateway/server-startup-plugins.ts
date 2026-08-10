// Gateway plugin startup bootstrap and adjacent startup maintenance.
import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";
import { resolveAgentWorkspaceDir, resolveDefaultAgentId } from "../agents/agent-scope.js";
import { initSubagentRegistry } from "../agents/subagent-registry.js";
import type { AmbientEnvTriggerPolicy } from "../channels/config-presence.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { GATEWAY_SERVICE_KIND, GATEWAY_SERVICE_MARKER } from "../daemon/constants.js";
import {
  collectRegisteredEmbeddingProviderIds,
  collectUnregisteredConfiguredMemoryEmbeddingProviders,
  listAmbientOnlyConfiguredChannelIds,
} from "../plugins/channel-plugin-ids.js";
import { loadPluginLookUpTable } from "../plugins/plugin-lookup-table.js";
import type { PluginMetadataSnapshot } from "../plugins/plugin-metadata-snapshot.js";
import type { PluginRegistry, PluginRegistryParams } from "../plugins/registry-types.js";
import { createEmptyPluginRegistry } from "../plugins/registry.js";
import { getActivePluginRegistry, setActivePluginRegistry } from "../plugins/runtime.js";
import { resolveGatewayStartupPluginActivationConfig } from "./plugin-activation-runtime-config.js";
import { listGatewayMethods } from "./server-methods-list.js";

type GatewayPluginBootstrapLog = {
  info: (message: string) => void;
  warn: (message: string) => void;
  error: (message: string) => void;
  debug: (message: string) => void;
};

type GatewayStartupTrace = {
  detail: (name: string, metrics: ReadonlyArray<readonly [string, number | string]>) => void;
};

/** Returns the config snapshot used by channel/plugin startup maintenance. */
export function resolveGatewayStartupMaintenanceConfig(params: {
  cfgAtStart: OpenClawConfig;
  startupRuntimeConfig: OpenClawConfig;
}): OpenClawConfig {
  // Early config recovery may supply channel blocks after the start snapshot; startup
  // maintenance needs those owner configs even when the original snapshot was sparse.
  return params.cfgAtStart.channels === undefined &&
    params.startupRuntimeConfig.channels !== undefined
    ? {
        ...params.cfgAtStart,
        channels: params.startupRuntimeConfig.channels,
      }
    : params.cfgAtStart;
}

const LINUX_CONTROL_GROUP_KILL_MODE_PROBE_TIMEOUT_MS = 5000;

/** True only for the gateway's own generated Linux systemd service process. */
function isLinuxGatewayServiceProcess(): boolean {
  return (
    process.platform === "linux" &&
    process.env.OPENCLAW_SERVICE_MARKER?.trim() === GATEWAY_SERVICE_MARKER &&
    process.env.OPENCLAW_SERVICE_KIND?.trim() === GATEWAY_SERVICE_KIND
  );
}

/**
 * Confirms the running gateway service's live systemd KillMode once per boot,
 * before any tool run can start, so the process/supervisor child adapter can
 * gate detaching tool children on ground truth instead of the generated
 * unit's intent. A hand-edited unit file or a later KillMode drop-in
 * (process/none) makes this probe report false even though the unit and
 * OPENCLAW_SERVICE_MARKER/KIND env vars still look like control-group
 * (#120398 review). readSystemdServiceRuntime's unit-selection is user-first
 * on a dueling user/system install (#79375), which can be a *different* unit
 * than the one that actually launched this process; trusting that unit's
 * KillMode without confirming it reports this process as its MainPID would
 * let a coexisting unit's control-group override this process's real
 * KillMode. Any probe failure, ambiguous read, or unit/PID mismatch reports
 * false, which keeps children attached — the same safe default as before
 * this probe existed.
 */
async function confirmLinuxControlGroupKillModeAtStartup(
  log: Pick<GatewayPluginBootstrapLog, "warn">,
): Promise<void> {
  const { setConfirmedLinuxControlGroupKillMode } =
    await import("../process/supervisor/adapters/child.js");
  try {
    const { readSystemdServiceRuntime } = await import("../daemon/systemd.js");
    const runtime = await readSystemdServiceRuntime(process.env, {
      timeoutMs: LINUX_CONTROL_GROUP_KILL_MODE_PROBE_TIMEOUT_MS,
    });
    const resolvedUnitOwnsThisProcess = runtime.pid === process.pid;
    setConfirmedLinuxControlGroupKillMode(
      resolvedUnitOwnsThisProcess &&
        normalizeLowercaseStringOrEmpty(runtime.systemd?.killMode) === "control-group",
    );
  } catch (error) {
    log.warn(
      `Could not confirm the gateway service's live systemd KillMode; keeping tool children attached: ${String(error)}`,
    );
    setConfirmedLinuxControlGroupKillMode(false);
  }
}

/** Runs channel, session, and pairing maintenance before plugin bootstrap. */
export async function runGatewayStartupMaintenance(params: {
  cfgAtStart: OpenClawConfig;
  startupRuntimeConfig: OpenClawConfig;
  minimalTestGateway: boolean;
  log: GatewayPluginBootstrapLog;
}): Promise<void> {
  const startupMaintenanceConfig = resolveGatewayStartupMaintenanceConfig({
    cfgAtStart: params.cfgAtStart,
    startupRuntimeConfig: params.startupRuntimeConfig,
  });

  const startupTasks: Promise<void>[] = [];
  if (isLinuxGatewayServiceProcess()) {
    startupTasks.push(confirmLinuxControlGroupKillModeAtStartup(params.log));
  }

  const shouldRunStartupMaintenance =
    !params.minimalTestGateway || startupMaintenanceConfig.channels !== undefined;
  if (shouldRunStartupMaintenance) {
    const { runChannelPluginStartupMaintenance } =
      await import("../channels/plugins/lifecycle-startup.js");
    startupTasks.push(
      runChannelPluginStartupMaintenance({
        cfg: startupMaintenanceConfig,
        env: process.env,
        log: params.log,
      }),
    );
    if (!params.minimalTestGateway) {
      const { runStartupSessionMigration } = await import("./server-startup-session-migration.js");
      startupTasks.push(
        runStartupSessionMigration({
          cfg: params.cfgAtStart,
          env: process.env,
          log: params.log,
        }),
      );
      const { migrateLegacyDevicePairingStore } =
        await import("../infra/device-pairing-migration.js");
      const { migrateLegacyNodePairingStore } = await import("../infra/node-pairing-migration.js");
      startupTasks.push(
        // The device store import must complete before the node-surface fold:
        // the fold writes onto device records in SQLite and would drop every
        // legacy node row as an orphan if the devices were not imported yet.
        migrateLegacyDevicePairingStore({ log: params.log }).then(
          () =>
            migrateLegacyNodePairingStore({ log: params.log }).then(
              () => undefined,
              (error: unknown) => {
                // A failed fold must not block gateway startup; the legacy
                // files stay in place and the next boot retries.
                params.log.warn(`node pairing store migration failed: ${String(error)}`);
              },
            ),
          (error: unknown) => {
            params.log.warn(`device pairing store migration failed: ${String(error)}`);
          },
        ),
      );
    }
  }
  await Promise.all(startupTasks);
}

/** Builds plugin startup state and gateway method lists before the server binds. */
export async function prepareGatewayPluginBootstrap(params: {
  cfgAtStart: OpenClawConfig;
  activationSourceConfig?: OpenClawConfig;
  pluginMetadataSnapshot?: PluginMetadataSnapshot;
  workerProviderIds?: readonly string[];
  minimalTestGateway: boolean;
  log: GatewayPluginBootstrapLog;
  ambientEnvTriggers?: AmbientEnvTriggerPolicy;
}) {
  const activationSourceConfig = params.activationSourceConfig ?? params.cfgAtStart;
  initSubagentRegistry();

  // Activation uses the pre-runtime source so auto-enable policy cannot be skewed by
  // defaults injected while loading runtime config; runtime-only plugin config still merges in.
  const gatewayPluginConfig = params.minimalTestGateway
    ? params.cfgAtStart
    : resolveGatewayStartupPluginActivationConfig({
        runtimeConfig: params.cfgAtStart,
        activationSourceConfig,
        env: process.env,
        ...(params.pluginMetadataSnapshot?.manifestRegistry
          ? { manifestRegistry: params.pluginMetadataSnapshot.manifestRegistry }
          : {}),
        discovery: params.pluginMetadataSnapshot?.discovery,
        ambientEnvTriggers: params.ambientEnvTriggers,
      });
  const pluginsGloballyDisabled = gatewayPluginConfig.plugins?.enabled === false;
  const defaultAgentId = resolveDefaultAgentId(gatewayPluginConfig);
  const defaultWorkspaceDir = resolveAgentWorkspaceDir(gatewayPluginConfig, defaultAgentId);
  const pluginLookUpTable =
    params.minimalTestGateway || pluginsGloballyDisabled
      ? undefined
      : loadPluginLookUpTable({
          config: gatewayPluginConfig,
          workspaceDir: defaultWorkspaceDir,
          env: process.env,
          activationSourceConfig,
          metadataSnapshot: params.pluginMetadataSnapshot,
          workerProviderIds: params.workerProviderIds ?? [],
          ambientEnvTriggers: params.ambientEnvTriggers,
        });
  // Startup logging and lifecycle publication consume the process-stable metadata snapshot.
  // Minimal gateways skip runtime lookup-table construction, not metadata ownership.
  const pluginManifestRecords =
    pluginLookUpTable?.manifestRegistry.plugins ??
    params.pluginMetadataSnapshot?.manifestRegistry.plugins ??
    [];
  const startupPluginIds = [...(pluginLookUpTable?.startup.pluginIds ?? [])];
  const ambientAutostartSuppressedChannelIds =
    params.ambientEnvTriggers === "suppress"
      ? new Set(
          listAmbientOnlyConfiguredChannelIds({
            config: params.cfgAtStart,
            activationSourceConfig,
            env: process.env,
            includePersistedAuthState: false,
            manifestRecords: pluginManifestRecords,
          }),
        )
      : new Set<string>();

  const baseMethods = listGatewayMethods();
  const emptyPluginRegistry = createEmptyPluginRegistry();
  // Minimal gateway tests reuse an already-active registry when present. Production publishes
  // an empty pre-bind registry; every startup plugin runtime attaches after the listener binds.
  const pluginRegistry = params.minimalTestGateway
    ? (getActivePluginRegistry() ?? emptyPluginRegistry)
    : emptyPluginRegistry;
  setActivePluginRegistry(pluginRegistry);

  return {
    gatewayPluginConfigAtStart: gatewayPluginConfig,
    defaultWorkspaceDir,
    startupPluginIds,
    pluginManifestRecords,
    pluginMetadataSnapshot: pluginLookUpTable ?? params.pluginMetadataSnapshot,
    pluginLookUpTable,
    baseMethods,
    pluginRegistry,
    baseGatewayMethods: baseMethods,
    ambientAutostartSuppressedChannelIds,
  };
}

/**
 * Warn when `memory.search.provider` selects a memory embedding provider
 * that no loaded plugin registered. Without the owning plugin, `active-memory`
 * cannot embed and silently falls back to keyword/FTS-only recall.
 */
export function warnUnregisteredConfiguredMemoryEmbeddingProviders(params: {
  config: OpenClawConfig;
  pluginRegistry: Partial<Pick<PluginRegistry, "embeddingProviders" | "memoryEmbeddingProviders">>;
  log: Pick<GatewayPluginBootstrapLog, "warn">;
}): void {
  const unregistered = collectUnregisteredConfiguredMemoryEmbeddingProviders({
    config: params.config,
    registeredProviderIds: collectRegisteredEmbeddingProviderIds(params.pluginRegistry),
  });
  for (const provider of unregistered) {
    const path = `memory.search.${provider.source}`;
    params.log.warn(
      `${path}="${provider.configuredId}" is configured, but no loaded plugin registered a memory embedding provider that can serve "${provider.configuredId}". Semantic memory recall will fall back to keyword/FTS-only search. Ensure the plugin that provides "${provider.configuredId}" is installed and enabled.`,
    );
  }
}

/** Loads startup plugin runtimes after the gateway listener binds. */
export async function loadGatewayStartupPluginRuntime(params: {
  cfg: OpenClawConfig;
  activationSourceConfig?: OpenClawConfig;
  workspaceDir: string;
  log: GatewayPluginBootstrapLog;
  baseMethods: string[];
  coreGatewayMethodNames?: readonly string[];
  hostServices?: PluginRegistryParams["hostServices"];
  startupPluginIds: string[];
  pluginLookUpTable?: ReturnType<typeof loadPluginLookUpTable>;
  startupTrace?: GatewayStartupTrace;
  ambientEnvTriggers?: AmbientEnvTriggerPolicy;
}) {
  // Keep server-plugin-bootstrap behind one lazy boundary; startup config tests can exercise
  // planning without importing plugin package runtimes.
  const { loadGatewayStartupPlugins } = await import("./server-plugin-bootstrap.js");
  const loaded = loadGatewayStartupPlugins({
    cfg: params.cfg,
    activationSourceConfig: params.activationSourceConfig,
    workspaceDir: params.workspaceDir,
    log: params.log,
    coreGatewayMethodNames: params.coreGatewayMethodNames ?? params.baseMethods,
    baseMethods: params.baseMethods,
    ...(params.hostServices !== undefined && {
      hostServices: params.hostServices,
    }),
    pluginIds: params.startupPluginIds,
    pluginLookUpTable: params.pluginLookUpTable,
    channelPluginLoadIntent: "full",
    startupTrace: params.startupTrace,
    ambientEnvTriggers: params.ambientEnvTriggers,
  });
  warnUnregisteredConfiguredMemoryEmbeddingProviders({
    config: params.cfg,
    pluginRegistry: loaded.pluginRegistry,
    log: params.log,
  });
  return loaded;
}
