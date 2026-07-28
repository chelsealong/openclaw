import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import type { MemorySearchResult } from "openclaw/plugin-sdk/memory-core-host-engine-storage";
import { getActiveMemorySearchManager } from "openclaw/plugin-sdk/memory-host-search";
import { truncateUtf16Safe } from "openclaw/plugin-sdk/text-utility-runtime";
import { buildPromptPrefix } from "./prompt.js";

const TRIGGER_CANDIDATE_LIMIT = 24;
const TRIGGER_INJECTION_LIMIT = 3;
const MAX_TRIGGER_CONTEXT_CHARS = 1800;
const STRONG_TRIGGER_MATCH_SCORE = 0.72;
const WORD_RE = /[\p{L}\p{N}_]+/gu;

type TriggerRecallMatch = MemorySearchResult & { matchScore: number };

function normalizeWords(value: string): string[] {
  return (value.toLowerCase().match(WORD_RE) ?? []).filter((word) => word.length > 1);
}

function splitTriggerPhrases(value: string): string[] {
  return value
    .split(/[\n;|]+/u)
    .map((phrase) => phrase.trim())
    .filter(Boolean);
}

function scoreTriggerPhrase(message: string, phrase: string): number {
  const messageWords = normalizeWords(message);
  const triggerWords = [...new Set(normalizeWords(phrase))];
  if (triggerWords.length === 0) {
    return 0;
  }
  if (triggerWords.length === 1) {
    return messageWords.includes(triggerWords[0] ?? "") ? 0.85 : 0;
  }
  const hasExactSequence = messageWords.some((_, start) =>
    triggerWords.every((word, offset) => messageWords[start + offset] === word),
  );
  if (hasExactSequence) {
    return 1;
  }
  const messageWordSet = new Set(messageWords);
  const overlap = triggerWords.filter((word) => messageWordSet.has(word)).length;
  if (overlap === 0) {
    return 0;
  }
  const coverage = overlap / triggerWords.length;
  return coverage * 0.8 + Math.min(1, overlap / 2) * 0.2;
}

export function isPromotedTrustedMemoryEntry(
  entry: Pick<MemorySearchResult, "path" | "source" | "originClass">,
): boolean {
  if (entry.originClass === "owner" || entry.originClass === "agent") {
    return true;
  }
  if (entry.source !== "memory") {
    return false;
  }
  const normalized = entry.path.replaceAll("\\", "/").replace(/^\.\//u, "").toUpperCase();
  return normalized === "MEMORY.MD" || normalized === "USER.MD";
}

export function scoreTriggerMatch(message: string, entry: MemorySearchResult): number {
  if (!entry.triggers) {
    return 0;
  }
  const triggerScore = Math.max(
    0,
    ...splitTriggerPhrases(entry.triggers).map((phrase) => scoreTriggerPhrase(message, phrase)),
  );
  const relevance = Math.max(0, Math.min(1, entry.score));
  return triggerScore * 0.8 + relevance * 0.2;
}

export function selectStrongTriggerMatches(
  message: string,
  entries: MemorySearchResult[],
): TriggerRecallMatch[] {
  return entries
    .filter(isPromotedTrustedMemoryEntry)
    .map((entry) => Object.assign({}, entry, { matchScore: scoreTriggerMatch(message, entry) }))
    .filter((entry) => entry.matchScore >= STRONG_TRIGGER_MATCH_SCORE)
    .toSorted(
      (left, right) =>
        right.matchScore - left.matchScore ||
        left.path.localeCompare(right.path) ||
        left.startLine - right.startLine,
    )
    .slice(0, TRIGGER_INJECTION_LIMIT);
}

export function buildTriggerRecallContext(matches: TriggerRecallMatch[]): string | undefined {
  if (matches.length === 0) {
    return undefined;
  }
  const summary = matches
    .map((entry) => `- ${entry.snippet.trim()} (Source: ${entry.path}#L${String(entry.startLine)})`)
    .join("\n");
  return buildPromptPrefix(truncateUtf16Safe(summary, MAX_TRIGGER_CONTEXT_CHARS));
}

export async function resolveTriggerRecall(params: {
  cfg: OpenClawConfig;
  agentId: string;
  query: string;
  message: string;
  signal?: AbortSignal;
}): Promise<{ context?: string; hasStrongHit: boolean }> {
  const lookup = await getActiveMemorySearchManager({
    cfg: params.cfg,
    agentId: params.agentId,
  });
  if (!lookup.manager) {
    return { hasStrongHit: false };
  }
  const [retrieved, triggerCandidates] = await Promise.all([
    lookup.manager
      .search(params.query, {
        maxResults: TRIGGER_CANDIDATE_LIMIT,
        minScore: 0,
        sources: ["memory"],
        signal: params.signal,
        // Lane-1 runs on every eligible inbound message; it must stay
        // deterministic and local. Keyword-only here, "search" mode on QMD.
        lexicalOnly: true,
        qmdSearchModeOverride: "search",
      })
      .catch(() => []),
    lookup.manager.listTriggerCandidates?.().catch(() => []) ?? [],
  ]);
  const candidates = [
    ...new Map(
      [...triggerCandidates, ...retrieved].map((entry) => [
        `${entry.source}:${entry.path}:${String(entry.startLine)}:${String(entry.endLine)}`,
        entry,
      ]),
    ).values(),
  ];
  const matches = selectStrongTriggerMatches(params.message, candidates);
  const context = buildTriggerRecallContext(matches);
  return { ...(context ? { context } : {}), hasStrongHit: matches.length > 0 };
}

export { MAX_TRIGGER_CONTEXT_CHARS, STRONG_TRIGGER_MATCH_SCORE };
