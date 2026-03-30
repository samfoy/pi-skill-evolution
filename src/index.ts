/**
 * Skill Evolution — meta-skill and self-improvement loop for pi.
 *
 * Two systems:
 * 1. Skill Forge: mines session history for repeated workflows, proposes new skills
 * 2. Skill Dojo: tracks skill health (success rate, retries, corrections), flags weak skills
 *
 * Tools:
 * - skill_forge_analyze: run workflow mining on session history
 * - skill_forge_proposals: list pending skill proposals
 * - skill_forge_accept: accept a proposal and generate the skill scaffold
 * - skill_dojo_health: show skill health dashboard
 * - skill_dojo_report: detailed report for a specific skill
 *
 * Lifecycle:
 * - session_start: load state, surface critical issues/proposals
 * - before_agent_start: inject skill health warnings into system prompt when relevant
 * - agent_end: track skill invocations from this turn
 * - session_shutdown: persist state, run incremental analysis automatically
 */
import type { ExtensionAPI, AgentToolResult } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { loadState, saveState, mergePatterns, mergeHealth } from "./store.js";
import { minePatterns, loadSessionList } from "./miner.js";
import { extractInvocations, computeHealth } from "./tracker.js";
import { appendFeedback, readFeedback, countFeedback } from "./feedback.js";
import type { EvolutionState, SkillProposal } from "./types.js";
import type { FeedbackEntry } from "./feedback.js";
import { existsSync, readdirSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

type ToolResult = AgentToolResult<unknown>;
function ok(text: string): ToolResult { return { content: [{ type: "text", text }], details: {} }; }
function err(text: string): ToolResult { return { content: [{ type: "text", text: `Error: ${text}` }], details: {} }; }

const SKILLS_DIR = join(process.env.HOME || "~", ".pi", "agent", "skills");

export default function (pi: ExtensionAPI) {
  let state: EvolutionState | null = null;
  let cachedCtx: any = null;
  let sessionSkillReads: string[] = []; // skills loaded this session (for tracking)
  let sessionId: string | undefined;

  // Feedback tracking state
  let currentSkill: string | null = null;
  let pendingFeedback: FeedbackEntry[] = [];
  let lastToolName = "";
  let lastToolFailed = false;
  let retryCount = 0;

  // ─── Lifecycle ───────────────────────────────────────────────────

  pi.on("session_start", async (_event, ctx) => {
    cachedCtx = ctx;
    sessionId = ctx.sessionManager?.getSessionFile()?.match(/([a-f0-9-]{36})/)?.[1];
    try {
      // Check for session-search dependency
      const sessionIndexPath = join(process.env.HOME || "~", ".pi", "session-search", "index", "session-index.json");
      if (!existsSync(sessionIndexPath)) {
        ctx.ui.notify(
          "skill-evolution: session-search index not found. Install with: pi install npm:pi-session-search",
          "warning",
        );
        return;
      }

      state = loadState();
      const proposalCount = state.proposals.filter(p => p.status === "proposed").length;
      const criticals = Object.values(state.health).flatMap(
        h => h.issues.filter(i => i.severity === "critical")
      );
      const degrading = Object.values(state.health).filter(h => h.trend === "degrading");

      // Surface critical issues proactively
      if (criticals.length > 0) {
        ctx.ui.notify(
          `Skill health: ${criticals.length} critical issue(s) — ${criticals.map(i => i.description).join("; ")}`,
          "warning",
        );
      }

      // Nudge about pending proposals (but don't spam — only if >2)
      if (proposalCount > 2) {
        ctx.ui.setStatus("skill-evolution", `${proposalCount} skill proposals pending review`);
        setTimeout(() => ctx.ui.setStatus("skill-evolution", ""), 10000);
      }

      // Quiet status for degrading skills
      if (degrading.length > 0 && criticals.length === 0) {
        ctx.ui.setStatus(
          "skill-evolution",
          `${degrading.length} skill(s) trending down: ${degrading.map(h => h.skill).join(", ")}`,
        );
        setTimeout(() => ctx.ui.setStatus("skill-evolution", ""), 8000);
      }
    } catch (e: any) {
      ctx.ui.notify(`skill-evolution: ${e.message}`, "warning");
    }
  });

  // Inject skill health context when the agent is about to use a weak skill
  pi.on("before_agent_start", async (event, _ctx) => {
    if (!state) return;

    // Check if the user's prompt mentions any skill names that have issues
    const prompt = typeof event.prompt === "string" ? event.prompt : "";
    const healthEntries = Object.values(state.health);
    const relevantWarnings: string[] = [];

    for (const h of healthEntries) {
      if (h.issues.length === 0) continue;
      // Match if the skill name appears in the prompt or if the prompt
      // mentions a domain the skill covers
      const skillInPrompt = prompt.toLowerCase().includes(h.skill.replace(/-/g, " "))
        || prompt.toLowerCase().includes(h.skill);
      if (!skillInPrompt) continue;

      for (const issue of h.issues.filter(i => i.severity !== "info")) {
        relevantWarnings.push(`- ${h.skill}: ${issue.description}. ${issue.suggestion}`);
      }
    }

    if (relevantWarnings.length === 0) return;

    const block = [
      "\n<skill_health_warnings>",
      "The following skills have known issues. Be extra careful and consider the suggestions:",
      ...relevantWarnings,
      "</skill_health_warnings>",
    ].join("\n");

    return {
      systemPrompt: `${event.systemPrompt}${block}`,
    };
  });

  // Track which skills are loaded during the session (via tool_call interception)
  // Also track tool errors for feedback logging
  pi.on("tool_call", async (event, _ctx) => {
    if (event.toolName === "read") {
      const path = (event.input as Record<string, any>)?.path;
      if (typeof path === "string" && path.includes("SKILL.md")) {
        const skill = path.split("skills/").pop()?.split("/")[0];
        if (skill) {
          // Flush feedback for previous skill if it had issues
          if (currentSkill && retryCount >= 2) {
            pendingFeedback.push({
              skill: currentSkill,
              timestamp: new Date().toISOString(),
              symptom: `${retryCount} retries during skill execution`,
              detail: `Last failing tool: ${lastToolName}`,
              category: "excessive_retries",
              sessionId,
            });
          }
          currentSkill = skill;
          sessionSkillReads.push(skill);
          retryCount = 0;
          lastToolFailed = false;
          lastToolName = "";
        }
      }
    }

    if (currentSkill) {
      // Detect retry: same tool called again right after a failure
      if (lastToolFailed && event.toolName === lastToolName) {
        retryCount++;
      }
      lastToolName = event.toolName;
    }
  });

  // Track tool results for error detection
  pi.on("tool_execution_end", async (event, _ctx) => {
    if (!currentSkill) return;
    if (event.isError) {
      lastToolFailed = true;
      const errorText = event.result?.content
        ? (Array.isArray(event.result.content)
            ? event.result.content
                .filter((b: any) => b.type === "text")
                .map((b: any) => b.text)
                .join(" ")
                .slice(0, 200)
            : "")
        : "";

      // Log individual tool errors that look significant
      if (errorText && (
        errorText.includes("ExpiredToken") ||
        errorText.includes("not authorized") ||
        errorText.includes("Unknown parameter") ||
        errorText.includes("required")
      )) {
        pendingFeedback.push({
          skill: currentSkill,
          timestamp: new Date().toISOString(),
          symptom: `Tool ${event.toolName} failed`,
          detail: errorText,
          category: "tool_error",
          sessionId,
        });
      }
    } else {
      lastToolFailed = false;
    }
  });

  // Detect user corrections after skill usage
  pi.on("input", async (event, _ctx) => {
    if (!currentSkill) return;
    const text = typeof event.text === "string" ? event.text : "";
    const correctionPatterns = [
      /\bno[,.]?\s+(that's|thats|that is)\s+(not|wrong)/i,
      /\bactually[,.]?\s/i,
      /\bdon'?t\s+do\s+that\b/i,
      /\bnot\s+what\s+I\s+(asked|wanted|meant)/i,
      /\bthat'?s\s+not\s+right/i,
      /\bwrong\b/i,
      /\bundo\b/i,
      /\brevert\b/i,
    ];
    if (correctionPatterns.some(p => p.test(text))) {
      pendingFeedback.push({
        skill: currentSkill,
        timestamp: new Date().toISOString(),
        symptom: "User corrected the agent",
        detail: text.slice(0, 200),
        category: "user_correction",
        sessionId,
      });
    }
  });

  // Auto-analyze on shutdown — like pi-memory's consolidation
  pi.on("session_shutdown", async () => {
    if (!state) return;

    // Flush any remaining feedback for the current skill
    if (currentSkill && retryCount >= 2) {
      pendingFeedback.push({
        skill: currentSkill,
        timestamp: new Date().toISOString(),
        symptom: `${retryCount} retries during skill execution`,
        detail: `Last failing tool: ${lastToolName}`,
        category: "excessive_retries",
        sessionId,
      });
    }

    // Write all pending feedback entries
    let feedbackWritten = 0;
    for (const entry of pendingFeedback) {
      if (appendFeedback(entry)) feedbackWritten++;
    }
    if (feedbackWritten > 0 && cachedCtx) {
      cachedCtx.ui.setStatus("skill-evolution", `Logged ${feedbackWritten} feedback entries`);
    }

    if (cachedCtx) {
      cachedCtx.ui.setStatus("skill-evolution", "Analyzing session patterns...");
    }

    try {
      const sessions = loadSessionList();
      const alreadyAnalyzed = new Set(state.analyzedSessionIds);
      const newSessionCount = sessions.filter(s => !alreadyAnalyzed.has(s.id)).length;

      // Only run full analysis if there are enough new sessions (batch efficiency)
      if (newSessionCount >= 5) {
        const { patterns, analyzedIds } = minePatterns(sessions, alreadyAnalyzed, 8);

        // Extract health data from new sessions
        const allInvocations = [];
        for (const s of sessions) {
          if (alreadyAnalyzed.has(s.id)) continue;
          const invs = extractInvocations(s.file, s.id);
          allInvocations.push(...invs);
        }

        state.patterns = mergePatterns(state.patterns, patterns);
        state.analyzedSessionIds = [...new Set([...state.analyzedSessionIds, ...analyzedIds])];
        state.lastAnalysis = new Date().toISOString();

        if (allInvocations.length > 0) {
          const newHealth = computeHealth(allInvocations, state.health);
          state.health = mergeHealth(state.health, newHealth);
        }

        // Auto-generate proposals for new high-frequency patterns
        const existingSkills = new Set(listExistingSkills());
        for (const p of state.patterns) {
          if (p.sessionCount < 12) continue;
          if (state.proposals.some(pr => pr.pattern.label === p.label)) continue;
          if (p.skillsInvolved.length > 0 && p.skillsInvolved.every(s => existingSkills.has(s))) continue;

          state.proposals.push({
            name: generateSkillName(p.label),
            description: `Automates the ${p.label} workflow pattern (observed ${p.sessionCount}x across sessions)`,
            pattern: p,
            estimatedSavingsMs: 0,
            confidence: Math.min(0.95, 0.5 + (p.sessionCount / 100)),
            status: "proposed",
            proposedAt: new Date().toISOString(),
          });
        }
      }
    } catch {
      // Best-effort — don't crash on shutdown
    }

    saveState(state);
  });

  // ─── Tools ───────────────────────────────────────────────────────

  pi.registerTool({
    name: "skill_forge_analyze",
    label: "Skill Forge: Analyze",
    description: "Mine session history for repeated workflow patterns that could become skills. Returns discovered patterns ranked by frequency. Use periodically or when looking for automation opportunities.",
    parameters: Type.Object({
      min_occurrences: Type.Optional(Type.Number({ description: "Minimum sessions a pattern must appear in (default: 8)", default: 8 })),
      incremental: Type.Optional(Type.Boolean({ description: "Only analyze new sessions since last run (default: true)", default: true })),
    }),
    async execute(_id, params, _signal, _update, _ctx) {
      if (!state) return err("State not loaded");

      const sessions = loadSessionList();
      if (sessions.length === 0) return err("No sessions found in session-search index");

      const alreadyAnalyzed = params.incremental !== false
        ? new Set(state.analyzedSessionIds)
        : new Set<string>();

      const minOcc = params.min_occurrences || 8;
      const { patterns, analyzedIds } = minePatterns(sessions, alreadyAnalyzed, minOcc);

      // Also extract skill invocations for health tracking
      const allInvocations = [];
      for (const s of sessions) {
        if (alreadyAnalyzed.has(s.id)) continue;
        const invs = extractInvocations(s.file, s.id);
        allInvocations.push(...invs);
      }

      // Merge into state
      state.patterns = mergePatterns(state.patterns, patterns);
      state.analyzedSessionIds = [...new Set([...state.analyzedSessionIds, ...analyzedIds])];
      state.lastAnalysis = new Date().toISOString();

      if (allInvocations.length > 0) {
        const newHealth = computeHealth(allInvocations, state.health);
        state.health = mergeHealth(state.health, newHealth);
      }

      saveState(state);

      // Format results
      const lines: string[] = [
        `Analyzed ${analyzedIds.length} new sessions (${state.analyzedSessionIds.length} total).`,
        `Found ${state.patterns.length} workflow patterns.\n`,
      ];

      const top = state.patterns.slice(0, 15);
      for (const p of top) {
        const skills = p.skillsInvolved.length > 0 ? ` [skills: ${p.skillsInvolved.join(", ")}]` : "";
        const age = daysSince(p.lastSeen);
        const recency = age < 7 ? " (recent)" : age > 30 ? " (stale)" : "";
        lines.push(`  ${p.sessionCount}x  ${p.label}${skills}${recency}`);
      }

      if (allInvocations.length > 0) {
        lines.push(`\nTracked ${allInvocations.length} skill invocations across ${Object.keys(state.health).length} skills.`);
        const issues = Object.values(state.health).flatMap(h => h.issues.filter(i => i.severity !== "info"));
        if (issues.length > 0) {
          lines.push(`⚠ ${issues.length} skill health issues detected — use skill_dojo_health for details.`);
        }
      }

      // Auto-generate proposals for high-frequency patterns without existing skills
      const existingSkills = new Set(listExistingSkills());
      let newProposals = 0;
      for (const p of state.patterns) {
        if (p.sessionCount < minOcc * 1.5) continue; // higher bar for auto-proposals
        if (state.proposals.some(pr => pr.pattern.label === p.label)) continue;
        // Skip if the pattern is mostly covered by existing skills
        if (p.skillsInvolved.length > 0 && p.skillsInvolved.every(s => existingSkills.has(s))) continue;

        const proposal: SkillProposal = {
          name: generateSkillName(p.label),
          description: `Automates the ${p.label} workflow pattern (observed ${p.sessionCount}x across sessions)`,
          pattern: p,
          estimatedSavingsMs: 0,
          confidence: Math.min(0.95, 0.5 + (p.sessionCount / 100)),
          status: "proposed",
          proposedAt: new Date().toISOString(),
        };
        state.proposals.push(proposal);
        newProposals++;
      }

      if (newProposals > 0) {
        lines.push(`\n${newProposals} new skill proposals generated — use skill_forge_proposals to review.`);
        saveState(state);
      }

      return ok(lines.join("\n"));
    },
  });

  pi.registerTool({
    name: "skill_forge_proposals",
    label: "Skill Forge: Proposals",
    description: "List pending skill proposals generated from workflow pattern analysis. Review and accept/reject proposals.",
    parameters: Type.Object({
      status: Type.Optional(Type.String({ description: "Filter by status: proposed, accepted, rejected, implemented (default: proposed)" })),
    }),
    async execute(_id, params, _signal, _update, _ctx) {
      if (!state) return err("State not loaded");

      const filter = params.status || "proposed";
      const proposals = state.proposals.filter(p => p.status === filter);

      if (proposals.length === 0) {
        return ok(`No ${filter} proposals. Run skill_forge_analyze first to discover patterns.`);
      }

      const lines: string[] = [`${proposals.length} ${filter} proposal(s):\n`];
      for (let i = 0; i < proposals.length; i++) {
        const p = proposals[i];
        lines.push(`[${i}] ${p.name}`);
        lines.push(`    Pattern: ${p.pattern.label}`);
        lines.push(`    Frequency: ${p.pattern.sessionCount}x across sessions`);
        lines.push(`    Skills involved: ${p.pattern.skillsInvolved.join(", ") || "none"}`);
        lines.push(`    Confidence: ${(p.confidence * 100).toFixed(0)}%`);
        lines.push(`    Proposed: ${p.proposedAt.slice(0, 10)}`);
        lines.push("");
      }

      lines.push("Use skill_forge_accept with the proposal index to generate a skill scaffold.");
      return ok(lines.join("\n"));
    },
  });

  pi.registerTool({
    name: "skill_forge_accept",
    label: "Skill Forge: Accept Proposal",
    description: "Accept a skill proposal and generate a SKILL.md scaffold in the skills directory. The scaffold includes the workflow pattern, suggested instructions, and example sessions to reference.",
    parameters: Type.Object({
      index: Type.Number({ description: "Proposal index from skill_forge_proposals" }),
      name: Type.Optional(Type.String({ description: "Override the proposed skill name" })),
    }),
    async execute(_id, params, _signal, _update, _ctx) {
      if (!state) return err("State not loaded");

      const pending = state.proposals.filter(p => p.status === "proposed");
      if (params.index < 0 || params.index >= pending.length) {
        return err(`Invalid index. ${pending.length} proposals available (0-${pending.length - 1}).`);
      }

      const proposal = pending[params.index];
      const skillName = params.name || proposal.name;
      const skillDir = join(SKILLS_DIR, skillName);

      if (existsSync(skillDir)) {
        return err(`Skill directory already exists: ${skillDir}`);
      }

      // Generate SKILL.md scaffold
      const steps = proposal.pattern.steps.map(s => s.action).join(" → ");
      const skillMd = `---
name: ${skillName}
description: ${proposal.description}
---

# ${skillName}

Auto-generated skill scaffold from workflow pattern analysis.

## Pattern

\`${steps}\`

Observed ${proposal.pattern.sessionCount}x across sessions (${proposal.pattern.firstSeen.slice(0, 10)} to ${proposal.pattern.lastSeen.slice(0, 10)}).

## Skills Referenced

${proposal.pattern.skillsInvolved.map(s => `- ${s}`).join("\n") || "- (none — this is a new workflow)"}

## Instructions

<!-- TODO: Fill in the actual instructions for this workflow -->
<!-- Reference sessions where this pattern appeared: -->
<!-- ${proposal.pattern.sessionIds.slice(0, 5).join(", ")} -->

## Example Sessions

The following session IDs contain this workflow pattern. Use session_read to review them:

${proposal.pattern.sessionIds.slice(0, 5).map(id => `- \`${id}\``).join("\n")}
`;

      mkdirSync(skillDir, { recursive: true });
      writeFileSync(join(skillDir, "SKILL.md"), skillMd, "utf8");

      proposal.status = "accepted";
      saveState(state);

      return ok(`Created skill scaffold at ${skillDir}/SKILL.md\n\nNext steps:\n1. Review the referenced sessions to understand the workflow\n2. Fill in the Instructions section\n3. Test the skill in a session`);
    },
  });

  pi.registerTool({
    name: "skill_dojo_health",
    label: "Skill Dojo: Health Dashboard",
    description: "Show health metrics for all tracked skills — success rate, retries, corrections, trends, and issues. Use to identify skills that need improvement.",
    parameters: Type.Object({
      sort_by: Type.Optional(Type.String({ description: "Sort by: usage, success_rate, issues (default: issues)" })),
      min_invocations: Type.Optional(Type.Number({ description: "Only show skills with at least N invocations (default: 3)" })),
    }),
    async execute(_id, params, _signal, _update, _ctx) {
      if (!state) return err("State not loaded");

      const minInv = params.min_invocations || 3;
      let skills = Object.values(state.health).filter(h => h.totalInvocations >= minInv);

      if (skills.length === 0) {
        return ok("No skill health data yet. Run skill_forge_analyze first to process session history.");
      }

      const sortBy = params.sort_by || "issues";
      if (sortBy === "usage") {
        skills.sort((a, b) => b.totalInvocations - a.totalInvocations);
      } else if (sortBy === "success_rate") {
        skills.sort((a, b) => a.successRate - b.successRate);
      } else {
        // Sort by issue severity, then by usage
        skills.sort((a, b) => {
          const aScore = a.issues.reduce((s, i) => s + (i.severity === "critical" ? 3 : i.severity === "warning" ? 2 : 1), 0);
          const bScore = b.issues.reduce((s, i) => s + (i.severity === "critical" ? 3 : i.severity === "warning" ? 2 : 1), 0);
          if (bScore !== aScore) return bScore - aScore;
          return b.totalInvocations - a.totalInvocations;
        });
      }

      const lines: string[] = [`Skill Health Dashboard (${skills.length} skills tracked)\n`];

      // Issues summary
      const criticals = skills.flatMap(s => s.issues.filter(i => i.severity === "critical"));
      const warnings = skills.flatMap(s => s.issues.filter(i => i.severity === "warning"));
      if (criticals.length > 0 || warnings.length > 0) {
        lines.push(`Issues: ${criticals.length} critical, ${warnings.length} warnings\n`);
      }

      // Table
      lines.push("Skill                    | Uses | Success | Retries | Corrections | Trend");
      lines.push("-------------------------|------|---------|---------|-------------|------");

      for (const h of skills) {
        const name = h.skill.padEnd(24).slice(0, 24);
        const uses = String(h.totalInvocations).padStart(4);
        const success = `${(h.successRate * 100).toFixed(0)}%`.padStart(7);
        const retries = h.avgRetries.toFixed(1).padStart(7);
        const corrections = `${(h.correctionRate * 100).toFixed(0)}%`.padStart(11);
        const trendIcon = h.trend === "improving" ? "↑" : h.trend === "degrading" ? "↓" : "→";
        const issueIcons = h.issues.map(i =>
          i.severity === "critical" ? "🔴" : i.severity === "warning" ? "🟡" : ""
        ).filter(Boolean).join("");

        lines.push(`${name} | ${uses} | ${success} | ${retries} | ${corrections} | ${trendIcon} ${issueIcons}`);
      }

      // Detail on issues
      const allIssues = skills.flatMap(s => s.issues.filter(i => i.severity !== "info"));
      if (allIssues.length > 0) {
        lines.push("\nIssues:");
        for (const h of skills) {
          for (const issue of h.issues.filter(i => i.severity !== "info")) {
            const icon = issue.severity === "critical" ? "🔴" : "🟡";
            lines.push(`  ${icon} ${issue.description}`);
            lines.push(`    → ${issue.suggestion}`);
          }
        }
      }

      return ok(lines.join("\n"));
    },
  });

  pi.registerTool({
    name: "skill_dojo_report",
    label: "Skill Dojo: Skill Report",
    description: "Detailed health report for a specific skill — invocation history, failure patterns, and improvement suggestions.",
    parameters: Type.Object({
      skill: Type.String({ description: "Skill name to report on" }),
    }),
    async execute(_id, params, _signal, _update, _ctx) {
      if (!state) return err("State not loaded");

      const health = state.health[params.skill];
      if (!health) {
        const available = Object.keys(state.health).join(", ");
        return err(`No health data for '${params.skill}'. Tracked skills: ${available}`);
      }

      const lines: string[] = [
        `Skill Report: ${health.skill}`,
        `${"─".repeat(40)}`,
        `Total invocations: ${health.totalInvocations}`,
        `Success rate:      ${(health.successRate * 100).toFixed(1)}%`,
        `Avg retries:       ${health.avgRetries.toFixed(1)}`,
        `Correction rate:   ${(health.correctionRate * 100).toFixed(1)}%`,
        `Avg tool calls:    ${health.avgToolCalls.toFixed(1)}`,
        `Avg duration:      ${(health.avgDurationMs / 1000).toFixed(1)}s`,
        `Trend:             ${health.trend}`,
        `Last updated:      ${health.updatedAt.slice(0, 10)}`,
      ];

      if (health.issues.length > 0) {
        lines.push(`\nIssues:`);
        for (const issue of health.issues) {
          const icon = issue.severity === "critical" ? "🔴" : issue.severity === "warning" ? "🟡" : "ℹ️";
          lines.push(`  ${icon} [${issue.type}] ${issue.description}`);
          lines.push(`    Suggestion: ${issue.suggestion}`);
        }
      }

      // Find related workflow patterns
      const related = state.patterns.filter(p => p.skillsInvolved.includes(params.skill));
      if (related.length > 0) {
        lines.push(`\nRelated workflow patterns:`);
        for (const p of related.slice(0, 5)) {
          lines.push(`  ${p.sessionCount}x ${p.label}`);
        }
      }

      // Show recent feedback
      const feedback = readFeedback(params.skill, 10);
      if (feedback) {
        lines.push(`\nRecent feedback (from FEEDBACK.md):`);
        lines.push(feedback);
      } else {
        const fbCount = countFeedback(params.skill);
        if (fbCount === 0) {
          lines.push(`\nNo feedback entries yet.`);
        }
      }

      return ok(lines.join("\n"));
    },
  });

  // ─── Command ─────────────────────────────────────────────────────

  pi.registerCommand("skills", {
    description: "Quick skill health summary",
    handler: async (_args, ctx) => {
      if (!state) {
        ctx.ui.notify("Skill evolution state not loaded", "warning");
        return;
      }

      const healthEntries = Object.values(state.health);
      const issues = healthEntries.flatMap(h => h.issues.filter(i => i.severity !== "info"));
      const proposals = state.proposals.filter(p => p.status === "proposed");

      const parts: string[] = [];
      if (healthEntries.length > 0) parts.push(`${healthEntries.length} skills tracked`);
      if (issues.length > 0) parts.push(`${issues.length} issues`);
      if (proposals.length > 0) parts.push(`${proposals.length} proposals pending`);
      if (state.patterns.length > 0) parts.push(`${state.patterns.length} patterns`);

      ctx.ui.notify(
        parts.length > 0 ? parts.join(" · ") : "No data yet — run skill_forge_analyze",
        issues.length > 0 ? "warning" : "info",
      );
    },
  });
}

// ─── Helpers ─────────────────────────────────────────────────────────

function listExistingSkills(): string[] {
  try {
    return readdirSync(SKILLS_DIR, { withFileTypes: true })
      .filter(d => d.isDirectory())
      .map(d => d.name);
  } catch {
    return [];
  }
}

function generateSkillName(patternLabel: string): string {
  // Convert "build→edit_java→check_diagnostics" to "java-build-check"
  const parts = patternLabel.split("→").map(s =>
    s.replace(/^(load_skill|edit_|read_|tool_)/, "").replace(/_/g, "-")
  );
  const unique = [...new Set(parts)].filter(Boolean).slice(0, 3);
  return unique.join("-") || "auto-workflow";
}

function daysSince(isoDate: string): number {
  return (Date.now() - new Date(isoDate).getTime()) / 86_400_000;
}
