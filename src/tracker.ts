/**
 * Skill Health Tracker — monitors skill effectiveness from session data.
 *
 * For each skill invocation (detected by SKILL.md read), tracks:
 * - Success: did the workflow complete without retries or user corrections?
 * - Retries: how many tool calls failed and were retried?
 * - Corrections: did the user say "no", "wrong", "actually", etc.?
 * - Duration: time from skill load to end of skill-driven segment
 * - Tool count: how many tool calls in the segment
 *
 * Computes per-skill health metrics and identifies issues.
 */
import { readFileSync } from "node:fs";
import type { SkillInvocation, SkillHealth, SkillIssue } from "./types.js";

// ─── Correction Detection ────────────────────────────────────────────

const CORRECTION_PATTERNS = [
  /\bno[,.]?\s+(that's|thats|that is)\s+(not|wrong)/i,
  /\bactually[,.]?\s/i,
  /\bwrong\b/i,
  /\bdon'?t\s+do\s+that\b/i,
  /\bstop\b/i,
  /\bnot\s+what\s+I\s+(asked|wanted|meant)/i,
  /\bundo\b/i,
  /\brevert\b/i,
  /\bthat'?s\s+not\s+right/i,
  /\binstead[,.]?\s/i,
  /\bI\s+said\b/i,
];

function isCorrection(text: string): boolean {
  return CORRECTION_PATTERNS.some((p) => p.test(text));
}

// ─── Invocation Extraction ───────────────────────────────────────────

interface SessionMessage {
  role: string;
  content: any[];
  timestamp?: number;
}

/**
 * Extract skill invocations from a raw session file.
 * A "skill invocation" starts when a SKILL.md is read and ends when:
 * - Another skill is loaded
 * - The user sends a new prompt (topic change)
 * - The session ends
 */
export function extractInvocations(
  jsonlPath: string,
  sessionId: string,
  maxEntries = 1500,
): SkillInvocation[] {
  const invocations: SkillInvocation[] = [];

  let currentSkill: string | null = null;
  let segmentStart = 0;
  let toolCalls = 0;
  let retries = 0;
  let userCorrected = false;
  let lastToolFailed = false;
  let lastToolName = "";

  function flushSegment(endTime: number) {
    if (!currentSkill) return;
    invocations.push({
      skill: currentSkill,
      sessionId,
      timestamp: new Date(segmentStart).toISOString(),
      succeeded: !userCorrected && retries <= 1,
      retries,
      userCorrected,
      toolCallCount: toolCalls,
      durationMs: endTime - segmentStart,
    });
    currentSkill = null;
    toolCalls = 0;
    retries = 0;
    userCorrected = false;
    lastToolFailed = false;
    lastToolName = "";
  }

  try {
    const lines = readFileSync(jsonlPath, "utf8").split("\n").filter(Boolean);
    for (let i = 0; i < Math.min(lines.length, maxEntries); i++) {
      const entry = JSON.parse(lines[i]);
      if (entry.type !== "message") continue;
      const msg: SessionMessage = entry.message;
      if (!msg) continue;
      const ts = msg.timestamp || 0;

      if (msg.role === "user") {
        // User message — check for corrections
        const text = extractText(msg.content);
        if (currentSkill && isCorrection(text)) {
          userCorrected = true;
        }
        // If this is a completely new prompt (not a correction), flush
        if (currentSkill && !isCorrection(text) && toolCalls > 2) {
          flushSegment(ts);
        }
      }

      if (msg.role === "assistant" && Array.isArray(msg.content)) {
        for (const block of msg.content) {
          if (block.type !== "toolCall") continue;
          const name: string = block.name || "";
          const args: Record<string, any> = block.arguments || {};

          // Detect skill load
          if (name === "read" && (args.path || "").includes("SKILL.md")) {
            const skill = (args.path || "").split("skills/").pop()?.split("/")[0] || "";
            if (skill && skill !== currentSkill) {
              flushSegment(ts);
              currentSkill = skill;
              segmentStart = ts;
            }
          }

          if (currentSkill) {
            toolCalls++;
            // Detect retry: same tool called again right after a failure
            if (lastToolFailed && name === lastToolName) {
              retries++;
            }
            lastToolName = name;
            lastToolFailed = false;
          }
        }
      }

      if (msg.role === "toolResult") {
        if (currentSkill) {
          const isError = (entry.message as any)?.isError;
          if (isError) lastToolFailed = true;
        }
      }
    }

    // Flush final segment
    if (currentSkill) {
      flushSegment(Date.now());
    }
  } catch {
    // Corrupt session
  }

  return invocations;
}

// ─── Health Computation ──────────────────────────────────────────────

/**
 * Compute health metrics for each skill from invocation data.
 */
export function computeHealth(
  invocations: SkillInvocation[],
  existingHealth: Record<string, SkillHealth> = {},
): Record<string, SkillHealth> {
  // Group by skill
  const bySkill = new Map<string, SkillInvocation[]>();
  for (const inv of invocations) {
    const list = bySkill.get(inv.skill) || [];
    list.push(inv);
    bySkill.set(inv.skill, list);
  }

  const health: Record<string, SkillHealth> = {};

  for (const [skill, invs] of bySkill) {
    const total = invs.length;
    if (total === 0) continue;

    const successes = invs.filter((i) => i.succeeded).length;
    const corrections = invs.filter((i) => i.userCorrected).length;
    const totalRetries = invs.reduce((sum, i) => sum + i.retries, 0);
    const totalToolCalls = invs.reduce((sum, i) => sum + i.toolCallCount, 0);
    const totalDuration = invs.reduce((sum, i) => sum + i.durationMs, 0);

    const successRate = successes / total;
    const correctionRate = corrections / total;
    const avgRetries = totalRetries / total;
    const avgToolCalls = totalToolCalls / total;
    const avgDurationMs = totalDuration / total;

    // Compute trend by comparing recent half vs older half
    const sorted = [...invs].sort(
      (a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime(),
    );
    const mid = Math.floor(sorted.length / 2);
    let trend: "improving" | "stable" | "degrading" = "stable";
    if (sorted.length >= 6) {
      const oldSuccess =
        sorted.slice(0, mid).filter((i) => i.succeeded).length / mid;
      const newSuccess =
        sorted.slice(mid).filter((i) => i.succeeded).length / (sorted.length - mid);
      if (newSuccess - oldSuccess > 0.15) trend = "improving";
      else if (oldSuccess - newSuccess > 0.15) trend = "degrading";
    }

    // Detect issues
    const issues: SkillIssue[] = [];

    if (successRate < 0.5 && total >= 5) {
      issues.push({
        type: "high_failure_rate",
        description: `${skill} succeeds only ${(successRate * 100).toFixed(0)}% of the time (${successes}/${total})`,
        severity: "critical",
        suggestion: `Review SKILL.md instructions — the agent frequently fails or needs retries when using this skill.`,
      });
    } else if (successRate < 0.75 && total >= 5) {
      issues.push({
        type: "high_failure_rate",
        description: `${skill} success rate is ${(successRate * 100).toFixed(0)}% (${successes}/${total})`,
        severity: "warning",
        suggestion: `Consider adding more examples or clarifying edge cases in the skill instructions.`,
      });
    }

    if (avgRetries > 2 && total >= 3) {
      issues.push({
        type: "excessive_retries",
        description: `${skill} averages ${avgRetries.toFixed(1)} retries per use`,
        severity: "warning",
        suggestion: `The skill instructions may be ambiguous or missing error handling guidance.`,
      });
    }

    if (correctionRate > 0.3 && total >= 5) {
      issues.push({
        type: "frequent_corrections",
        description: `User corrects the agent ${(correctionRate * 100).toFixed(0)}% of the time after loading ${skill}`,
        severity: "warning",
        suggestion: `The skill may be producing incorrect results. Check recent corrections in memory_lessons.`,
      });
    }

    if (avgDurationMs > 120_000 && total >= 3) {
      issues.push({
        type: "slow",
        description: `${skill} takes ${(avgDurationMs / 1000).toFixed(0)}s on average`,
        severity: "info",
        suggestion: `Consider breaking this into sub-skills or adding shortcuts for common cases.`,
      });
    }

    health[skill] = {
      skill,
      totalInvocations: total,
      successRate,
      avgRetries,
      correctionRate,
      avgToolCalls,
      avgDurationMs,
      trend,
      issues,
      updatedAt: new Date().toISOString(),
    };
  }

  // Check for unused skills (in existing health but no new invocations)
  for (const [skill, existing] of Object.entries(existingHealth)) {
    if (!health[skill]) {
      // Carry forward but mark as potentially unused if old
      const daysSinceUpdate =
        (Date.now() - new Date(existing.updatedAt).getTime()) / 86_400_000;
      if (daysSinceUpdate > 30) {
        existing.issues = [
          {
            type: "unused",
            description: `${skill} hasn't been used in ${daysSinceUpdate.toFixed(0)} days`,
            severity: "info",
            suggestion: `Consider archiving or merging with another skill.`,
          },
        ];
      }
      health[skill] = existing;
    }
  }

  return health;
}

// ─── Helpers ─────────────────────────────────────────────────────────

function extractText(content: any): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .filter((b: any) => b.type === "text")
      .map((b: any) => b.text)
      .join(" ");
  }
  return "";
}
