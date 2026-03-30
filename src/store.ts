/**
 * Evolution Store — persists workflow patterns, proposals, and health data.
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import type { EvolutionState, WorkflowPattern, SkillHealth } from "./types.js";

const STATE_DIR = join(process.env.HOME || "~", ".pi", "skill-evolution");
const STATE_PATH = join(STATE_DIR, "state.json");

const EMPTY_STATE: EvolutionState = {
  version: 1,
  patterns: [],
  proposals: [],
  health: {},
  lastAnalysis: "",
  analyzedSessionIds: [],
};

export function loadState(): EvolutionState {
  if (!existsSync(STATE_PATH)) return { ...EMPTY_STATE };
  try {
    const raw = JSON.parse(readFileSync(STATE_PATH, "utf8"));
    if (raw.version !== 1) return { ...EMPTY_STATE };
    return raw as EvolutionState;
  } catch {
    return { ...EMPTY_STATE };
  }
}

export function saveState(state: EvolutionState): void {
  mkdirSync(STATE_DIR, { recursive: true });
  writeFileSync(STATE_PATH, JSON.stringify(state, null, 2), "utf8");
}

export function mergePatterns(
  existing: WorkflowPattern[],
  discovered: WorkflowPattern[],
): WorkflowPattern[] {
  const byLabel = new Map<string, WorkflowPattern>();
  for (const p of existing) byLabel.set(p.label, p);

  for (const p of discovered) {
    const prev = byLabel.get(p.label);
    if (prev) {
      // Merge: update counts, session IDs, timestamps
      const mergedIds = new Set([...prev.sessionIds, ...p.sessionIds]);
      prev.sessionCount = mergedIds.size;
      prev.sessionIds = [...mergedIds].slice(0, 30);
      prev.skillsInvolved = [...new Set([...prev.skillsInvolved, ...p.skillsInvolved])];
      if (p.firstSeen < prev.firstSeen) prev.firstSeen = p.firstSeen;
      if (p.lastSeen > prev.lastSeen) prev.lastSeen = p.lastSeen;
    } else {
      byLabel.set(p.label, p);
    }
  }

  return [...byLabel.values()].sort((a, b) => b.sessionCount - a.sessionCount);
}

export function mergeHealth(
  existing: Record<string, SkillHealth>,
  computed: Record<string, SkillHealth>,
): Record<string, SkillHealth> {
  // Computed health replaces existing for skills that have new data
  return { ...existing, ...computed };
}
