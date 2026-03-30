/**
 * Workflow Miner — extracts repeating multi-step patterns from session history.
 *
 * Reads parsed session data from the session-search index and identifies
 * tool call sequences that repeat across sessions. Groups them into
 * candidate workflow patterns that could become skills.
 */
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import type { WorkflowStep, WorkflowPattern } from "./types.js";

const SESSION_INDEX_PATH = join(
  process.env.HOME || "~",
  ".pi",
  "session-search",
  "index",
  "session-index.json",
);

// ─── Step Classification ─────────────────────────────────────────────

function classifyBashCommand(cmd: string): { action: string; detail: string } {
  if (/brazil-build|bb\s/.test(cmd)) return { action: "build", detail: "brazil" };
  if (/^cr\s|^cr$|cr --all/.test(cmd.trim())) return { action: "cr_upload", detail: "" };
  if (/git commit/.test(cmd)) return { action: "git_commit", detail: "" };
  if (/git diff|git status|git log/.test(cmd)) return { action: "git_check", detail: "" };
  if (/git checkout|git switch|git branch/.test(cmd)) return { action: "git_branch", detail: "" };
  if (/git rebase|git merge/.test(cmd)) return { action: "git_rebase", detail: "" };
  if (/mcp-call/.test(cmd)) return { action: "mcp_call", detail: "" };
  if (/tmux/.test(cmd)) return { action: "tmux", detail: "" };
  if (/vault_search|vault/.test(cmd.toLowerCase())) return { action: "vault_op", detail: "" };
  if (/sed\s.*Daily.Notes|vault.*Daily/.test(cmd)) return { action: "daily_note", detail: "" };
  if (/aws\s/.test(cmd)) return { action: "aws_cli", detail: "" };
  if (/rg\s|grep\s|find\s/.test(cmd)) return { action: "search_files", detail: "" };
  if (/npm|node\s/.test(cmd)) return { action: "node_run", detail: "" };
  if (/python3?\s/.test(cmd)) return { action: "python_run", detail: "" };
  if (/cat\s|head\s|tail\s|wc\s|ls\s/.test(cmd)) return { action: "inspect", detail: "" };
  return { action: "bash_other", detail: "" };
}

function classifyFilePath(path: string): string {
  if (path.endsWith(".java")) return "java";
  if (path.endsWith(".ts") || path.endsWith(".tsx")) return "ts";
  if (path.endsWith(".md")) return "md";
  if (path.endsWith(".json")) return "json";
  if (path.endsWith(".yaml") || path.endsWith(".yml")) return "yaml";
  if (path.includes("SKILL.md")) return "skill";
  return "other";
}

// ─── Session Parsing ─────────────────────────────────────────────────

interface RawSessionEntry {
  type: string;
  id: string;
  parentId: string | null;
  timestamp: string;
  message?: {
    role: string;
    content: any[];
    timestamp?: number;
  };
}

export function extractStepsFromSession(jsonlPath: string, maxEntries = 1000): {
  steps: WorkflowStep[];
  skills: string[];
  startTime: number;
  endTime: number;
} {
  const steps: WorkflowStep[] = [];
  const skills: string[] = [];
  let startTime = 0;
  let endTime = 0;

  try {
    const lines = readFileSync(jsonlPath, "utf8").split("\n").filter(Boolean);
    for (let i = 0; i < Math.min(lines.length, maxEntries); i++) {
      const entry: RawSessionEntry = JSON.parse(lines[i]);
      if (entry.type !== "message") continue;
      const msg = entry.message;
      if (!msg) continue;

      const ts = msg.timestamp || 0;
      if (startTime === 0) startTime = ts;
      endTime = ts;

      if (msg.role === "assistant" && Array.isArray(msg.content)) {
        for (const block of msg.content) {
          if (block.type !== "toolCall") continue;
          const name: string = block.name || "";
          const args: Record<string, any> = block.arguments || {};

          if (name === "read") {
            const path = args.path || "";
            if (path.includes("SKILL.md")) {
              const skill = path.split("skills/").pop()?.split("/")[0] || "";
              if (skill) {
                skills.push(skill);
                steps.push({ action: "load_skill", tool: "read", detail: skill });
              }
            } else {
              steps.push({ action: `read_${classifyFilePath(path)}`, tool: "read", detail: "" });
            }
          } else if (name === "edit") {
            const path = args.path || "";
            steps.push({ action: `edit_${classifyFilePath(path)}`, tool: "edit", detail: "" });
          } else if (name === "write") {
            steps.push({ action: "write_file", tool: "write", detail: "" });
          } else if (name === "bash") {
            const { action, detail } = classifyBashCommand(args.command || "");
            steps.push({ action, tool: "bash", detail });
          } else if (name === "lsp_diagnostics") {
            steps.push({ action: "check_diagnostics", tool: "lsp_diagnostics", detail: "" });
          } else if (name === "memory_remember" || name === "memory_search") {
            steps.push({ action: "memory_op", tool: name, detail: "" });
          } else if (name === "vault_search") {
            steps.push({ action: "vault_search", tool: name, detail: "" });
          } else if (name === "session_search" || name === "session_read") {
            steps.push({ action: "session_lookup", tool: name, detail: "" });
          } else {
            // Custom/MCP tools
            steps.push({ action: `tool_${name}`, tool: name, detail: "" });
          }
        }
      }
    }
  } catch {
    // Corrupt or unreadable session
  }

  return { steps, skills, startTime, endTime };
}

// ─── Pattern Extraction ──────────────────────────────────────────────

/**
 * Deduplicate consecutive identical steps (e.g. bash→bash→bash becomes one bash).
 */
function dedupeConsecutive(steps: WorkflowStep[]): WorkflowStep[] {
  if (steps.length === 0) return [];
  const result = [steps[0]];
  for (let i = 1; i < steps.length; i++) {
    if (steps[i].action !== result[result.length - 1].action) {
      result.push(steps[i]);
    }
  }
  return result;
}

/**
 * Extract n-gram subsequences from a step sequence.
 */
function extractNgrams(steps: WorkflowStep[], minLen: number, maxLen: number): string[][] {
  const actions = steps.map((s) => s.action);
  const ngrams: string[][] = [];
  for (let len = minLen; len <= maxLen; len++) {
    for (let i = 0; i <= actions.length - len; i++) {
      ngrams.push(actions.slice(i, i + len));
    }
  }
  return ngrams;
}

/**
 * Mine workflow patterns from all indexed sessions.
 * Returns patterns sorted by frequency (most common first).
 */
export function minePatterns(
  sessionFiles: { file: string; id: string; startedAt: string }[],
  alreadyAnalyzed: Set<string>,
  minOccurrences = 8,
  minSteps = 3,
  maxSteps = 7,
): { patterns: WorkflowPattern[]; analyzedIds: string[] } {
  // Count n-gram occurrences across sessions
  const ngramCounts = new Map<string, {
    count: number;
    sessionIds: string[];
    skills: Set<string>;
    firstSeen: string;
    lastSeen: string;
  }>();

  const newlyAnalyzed: string[] = [];

  for (const { file, id, startedAt } of sessionFiles) {
    if (alreadyAnalyzed.has(id)) continue;
    newlyAnalyzed.push(id);

    const { steps, skills } = extractStepsFromSession(file);
    if (steps.length < minSteps) continue;

    const deduped = dedupeConsecutive(steps);
    const ngrams = extractNgrams(deduped, minSteps, maxSteps);

    // Deduplicate ngrams within this session
    const seen = new Set<string>();
    for (const ngram of ngrams) {
      const key = ngram.join("→");
      if (seen.has(key)) continue;
      seen.add(key);

      const existing = ngramCounts.get(key);
      if (existing) {
        existing.count++;
        existing.sessionIds.push(id);
        for (const s of skills) existing.skills.add(s);
        if (startedAt < existing.firstSeen) existing.firstSeen = startedAt;
        if (startedAt > existing.lastSeen) existing.lastSeen = startedAt;
      } else {
        ngramCounts.set(key, {
          count: 1,
          sessionIds: [id],
          skills: new Set(skills),
          firstSeen: startedAt,
          lastSeen: startedAt,
        });
      }
    }
  }

  // Filter to patterns that meet minimum occurrence threshold
  const patterns: WorkflowPattern[] = [];
  for (const [key, data] of ngramCounts) {
    if (data.count < minOccurrences) continue;

    const actions = key.split("→");
    // Skip patterns that are just repeated single actions
    if (new Set(actions).size <= 1) continue;
    // Skip patterns that are mostly generic exploration actions
    const GENERIC_ACTIONS = new Set([
      "inspect", "bash_other", "search_files", "read_ts", "read_java",
      "read_md", "read_json", "read_yaml", "read_other", "read_skill",
    ]);
    const meaningfulCount = actions.filter((a) => !GENERIC_ACTIONS.has(a)).length;
    if (meaningfulCount < 2) continue;

    patterns.push({
      id: `wp_${Buffer.from(key).toString("base64url").slice(0, 12)}`,
      label: key,
      steps: actions.map((a) => ({ action: a, tool: "", detail: "" })),
      sessionCount: data.count,
      sessionIds: data.sessionIds.slice(0, 20), // cap for storage
      skillsInvolved: [...data.skills],
      firstSeen: data.firstSeen,
      lastSeen: data.lastSeen,
    });
  }

  // Sort by frequency, then by length (prefer longer patterns)
  patterns.sort((a, b) => {
    const freqDiff = b.sessionCount - a.sessionCount;
    if (freqDiff !== 0) return freqDiff;
    return b.steps.length - a.steps.length;
  });

  // Deduplicate: remove shorter patterns that are strict subsets of longer ones
  const filtered: WorkflowPattern[] = [];
  for (const p of patterns) {
    const isSubset = filtered.some((existing) => {
      if (existing.steps.length <= p.steps.length) return false;
      const existingLabel = existing.label;
      return existingLabel.includes(p.label);
    });
    if (!isSubset) filtered.push(p);
  }

  return { patterns: filtered.slice(0, 50), analyzedIds: newlyAnalyzed };
}

/**
 * Load session file list from the session-search index.
 */
export function loadSessionList(): { file: string; id: string; startedAt: string }[] {
  if (!existsSync(SESSION_INDEX_PATH)) return [];
  try {
    const raw = JSON.parse(readFileSync(SESSION_INDEX_PATH, "utf8"));
    return Object.entries(raw.sessions || {}).map(([id, entry]: [string, any]) => ({
      file: entry.session.file,
      id,
      startedAt: entry.session.startedAt,
    }));
  } catch {
    return [];
  }
}
