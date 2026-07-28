// Doctor migration for config and state left by the retired Phone Control lease model.
import fs from "node:fs/promises";
import path from "node:path";
import { resolveStateDir } from "../config/paths.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { createPluginStateKeyedStore } from "../plugin-state/plugin-state-store.js";
import { archiveLegacyStateSource } from "../plugins/doctor-state-migration-fs.js";

const PHONE_CONTROL_PLUGIN_ID = "phone-control";
const ARM_STATE_NAMESPACE = "armed";

// This is the exact pre-retirement setup seed. Keep it independent of the
// current dangerous-command set so future policy changes cannot widen cleanup.
export const RETIRED_PHONE_CONTROL_SEEDED_DENY_COMMANDS = [
  "camera.snap",
  "camera.clip",
  "screen.record",
  "computer.act",
  "mobile.ui.observe",
  "mobile.ui.act",
  "contacts.add",
  "calendar.add",
  "reminders.add",
  "sms.send",
  "sms.search",
  "health.summary",
] as const;

type RetiredArmState = {
  version?: unknown;
  addedToAllow?: unknown;
  removedFromDeny?: unknown;
};

export type RetiredPhoneControlCleanupPlan = {
  config: OpenClawConfig;
  configChanges: string[];
  cleanupPending: boolean;
  cleanupSafe: boolean;
  warnings: string[];
};

function resolveLegacyArmStatePath(env: NodeJS.ProcessEnv): string {
  return path.join(resolveStateDir(env), "plugins", PHONE_CONTROL_PLUGIN_ID, "armed.json");
}

function resolveStateDatabasePath(env: NodeJS.ProcessEnv): string {
  return path.join(resolveStateDir(env), "state", "openclaw.sqlite");
}

async function isFile(filePath: string): Promise<boolean> {
  try {
    return (await fs.stat(filePath)).isFile();
  } catch {
    return false;
  }
}

function readStringArrayField(value: unknown, field: keyof RetiredArmState): string[] {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return [];
  }
  const entries = (value as RetiredArmState)[field];
  return Array.isArray(entries)
    ? entries.filter((entry): entry is string => typeof entry === "string" && entry.trim() !== "")
    : [];
}

async function readLegacyArmState(filePath: string): Promise<unknown> {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8")) as unknown;
  } catch {
    return null;
  }
}

function openRetiredArmStateStore(env: NodeJS.ProcessEnv) {
  return createPluginStateKeyedStore<unknown>(PHONE_CONTROL_PLUGIN_ID, {
    namespace: ARM_STATE_NAMESPACE,
    maxEntries: 1,
    overflowPolicy: "reject-new",
    env,
  });
}

async function readRetiredArmStates(env: NodeJS.ProcessEnv): Promise<{
  states: unknown[];
  cleanupPending: boolean;
  cleanupSafe: boolean;
  warnings: string[];
}> {
  const legacyPath = resolveLegacyArmStatePath(env);
  const legacyExists = await isFile(legacyPath);
  const warnings: string[] = [];
  let sqliteReadFailed = false;
  let legacyState: unknown = null;
  if (legacyExists) {
    legacyState = await readLegacyArmState(legacyPath);
    if (legacyState === null) {
      warnings.push(`Could not read retired Phone Control lease state at ${legacyPath}.`);
    }
  }

  let sqliteEntries: Array<{ value: unknown }> = [];
  if (await isFile(resolveStateDatabasePath(env))) {
    try {
      sqliteEntries = await openRetiredArmStateStore(env).entries();
      if (sqliteEntries.length > 1) {
        sqliteReadFailed = true;
        warnings.push("Retired Phone Control lease journal contains multiple records.");
      }
    } catch (error) {
      sqliteReadFailed = true;
      warnings.push(`Could not read retired Phone Control lease journal: ${String(error)}`);
    }
  }
  const cleanupSafe =
    !sqliteReadFailed && (sqliteEntries.length === 1 || !legacyExists || legacyState !== null);
  // SQLite became the canonical journal before retirement. A legacy source may
  // coexist after an interrupted older migration, but it must not contribute
  // cleanup deltas when the authoritative SQLite record exists.
  const states = sqliteReadFailed
    ? []
    : sqliteEntries.length === 1
      ? sqliteEntries.map((entry) => entry.value)
      : legacyState === null
        ? []
        : [legacyState];
  return {
    states,
    cleanupPending: legacyExists || sqliteEntries.length > 0 || sqliteReadFailed,
    cleanupSafe,
    warnings,
  };
}

function isExactSeededDenyList(values: readonly string[]): boolean {
  const normalized = [...values].toSorted();
  const expected = [...RETIRED_PHONE_CONTROL_SEEDED_DENY_COMMANDS].toSorted();
  return (
    normalized.length === expected.length &&
    normalized.every((value, index) => value === expected[index])
  );
}

function withCommandLists(
  cfg: OpenClawConfig,
  params: { allow?: string[]; deny?: string[] },
): OpenClawConfig {
  const commands = { ...cfg.gateway?.nodes?.commands };
  if (params.allow === undefined || params.allow.length === 0) {
    delete commands.allow;
  } else {
    commands.allow = params.allow;
  }
  if (params.deny === undefined || params.deny.length === 0) {
    delete commands.deny;
  } else {
    commands.deny = params.deny;
  }
  const nodes = { ...cfg.gateway?.nodes };
  delete nodes.commands;
  return {
    ...cfg,
    gateway: {
      ...cfg.gateway,
      nodes: {
        ...nodes,
        ...(Object.keys(commands).length > 0 ? { commands } : {}),
      },
    },
  };
}

/** Plans canonical config cleanup while retaining the journal until the config write succeeds. */
export async function prepareRetiredPhoneControlCleanup(params: {
  cfg: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
}): Promise<RetiredPhoneControlCleanupPlan> {
  const env = params.env ?? process.env;
  const residue = await readRetiredArmStates(env);
  if (!residue.cleanupSafe) {
    return {
      config: params.cfg,
      configChanges: [],
      cleanupPending: residue.cleanupPending,
      cleanupSafe: false,
      warnings: residue.warnings,
    };
  }
  const leaseAddedAllows = new Set(
    residue.states.flatMap((state) => readStringArrayField(state, "addedToAllow")),
  );
  const leaseRemovedDenies = residue.states.flatMap((state) =>
    readStringArrayField(state, "removedFromDeny"),
  );
  const currentAllow = params.cfg.gateway?.nodes?.commands?.allow;
  const currentDeny = params.cfg.gateway?.nodes?.commands?.deny;
  const reconstructedDeny = [...(currentDeny ?? [])];
  const reconstructedDenySet = new Set(reconstructedDeny);
  for (const command of leaseRemovedDenies) {
    if (!reconstructedDenySet.has(command)) {
      reconstructedDeny.push(command);
      reconstructedDenySet.add(command);
    }
  }
  const removeSeededDeny = currentDeny !== undefined && isExactSeededDenyList(reconstructedDeny);
  // The lease journal snapshots persistentAllows through deny-wins policy before
  // activation, so commands in removedFromDeny are lease-only even if also allowed.
  const leaseShadowedAllows = removeSeededDeny ? new Set(leaseRemovedDenies) : undefined;
  const nextAllow = currentAllow?.filter(
    (command) => !leaseAddedAllows.has(command.trim()) && !leaseShadowedAllows?.has(command.trim()),
  );
  const allowChanged = Boolean(currentAllow && nextAllow?.length !== currentAllow.length);
  const denyChanged = reconstructedDeny.length !== (currentDeny?.length ?? 0);
  if (!allowChanged && !denyChanged && !removeSeededDeny) {
    return {
      config: params.cfg,
      configChanges: [],
      cleanupPending: residue.cleanupPending,
      cleanupSafe: residue.cleanupSafe,
      warnings: residue.warnings,
    };
  }

  const configChanges: string[] = [];
  if (allowChanged) {
    configChanges.push("Removed stale Phone Control lease-only command allow entries.");
  }
  if (denyChanged && !removeSeededDeny) {
    configChanges.push("Restored command deny entries removed by Phone Control leases.");
  }
  if (removeSeededDeny) {
    configChanges.push("Removed the retired Phone Control setup deny seed.");
  }
  return {
    config: withCommandLists(params.cfg, {
      allow: nextAllow,
      deny: removeSeededDeny ? undefined : reconstructedDeny,
    }),
    configChanges,
    cleanupPending: residue.cleanupPending,
    cleanupSafe: residue.cleanupSafe,
    warnings: residue.warnings,
  };
}

/** Drops SQLite journal rows and archives the legacy file after config persistence. */
export async function finalizeRetiredPhoneControlCleanup(params: {
  env?: NodeJS.ProcessEnv;
}): Promise<{ changes: string[]; warnings: string[] }> {
  const env = params.env ?? process.env;
  const changes: string[] = [];
  const warnings: string[] = [];
  const legacyPath = resolveLegacyArmStatePath(env);
  if (await isFile(legacyPath)) {
    await archiveLegacyStateSource({
      filePath: legacyPath,
      label: "retired Phone Control lease state",
      changes,
      warnings,
    });
    // SQLite is authoritative while both sources exist. Keep that record until
    // the stale fallback source is gone, or a later retry could replay it.
    if (await isFile(legacyPath)) {
      return { changes, warnings };
    }
  }

  if (await isFile(resolveStateDatabasePath(env))) {
    try {
      const store = openRetiredArmStateStore(env);
      if ((await store.entries()).length > 0) {
        await store.clear();
        changes.push("Dropped the retired Phone Control lease journal.");
      }
    } catch (error) {
      warnings.push(`Failed to drop the retired Phone Control lease journal: ${String(error)}`);
    }
  }
  return { changes, warnings };
}
