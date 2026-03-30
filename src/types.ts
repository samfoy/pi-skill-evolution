/**
 * Types for the skill evolution system.
 */

// ─── Workflow Mining ─────────────────────────────────────────────────

export interface WorkflowStep {
  /** High-level action category */
  action: string;
  /** Tool name used */
  tool: string;
  /** Key argument (e.g. skill name, file path pattern) */
  detail: string;
}

export interface WorkflowPattern {
  /** Unique ID for this pattern */
  id: string;
  /** Human-readable label */
  label: string;
  /** The sequence of steps */
  steps: WorkflowStep[];
  /** How many sessions this pattern appeared in */
  sessionCount: number;
  /** Session IDs where this pattern was observed */
  sessionIds: string[];
  /** Skills involved (from SKILL.md reads) */
  skillsInvolved: string[];
  /** First seen */
  firstSeen: string;
  /** Last seen */
  lastSeen: string;
}

export interface SkillProposal {
  /** Proposed skill name */
  name: string;
  /** Description for the SKILL.md frontmatter */
  description: string;
  /** The workflow pattern this would automate */
  pattern: WorkflowPattern;
  /** Estimated time savings per invocation (based on avg session duration) */
  estimatedSavingsMs: number;
  /** Confidence that this is a real repeating workflow (0-1) */
  confidence: number;
  /** Status */
  status: "proposed" | "accepted" | "rejected" | "implemented";
  /** When proposed */
  proposedAt: string;
}

// ─── Skill Health Tracking ───────────────────────────────────────────

export interface SkillInvocation {
  /** Skill name */
  skill: string;
  /** Session ID */
  sessionId: string;
  /** Timestamp */
  timestamp: string;
  /** Did the workflow succeed (no retries, no user correction)? */
  succeeded: boolean;
  /** Number of tool retries after skill was loaded */
  retries: number;
  /** Did the user correct the agent after skill was loaded? */
  userCorrected: boolean;
  /** Total tool calls in the skill-driven segment */
  toolCallCount: number;
  /** Duration of the skill-driven segment (ms) */
  durationMs: number;
}

export interface SkillHealth {
  /** Skill name */
  skill: string;
  /** Total invocations tracked */
  totalInvocations: number;
  /** Success rate (0-1) */
  successRate: number;
  /** Average retries per invocation */
  avgRetries: number;
  /** User correction rate (0-1) */
  correctionRate: number;
  /** Average tool calls per invocation */
  avgToolCalls: number;
  /** Average duration (ms) */
  avgDurationMs: number;
  /** Trend: improving, stable, degrading */
  trend: "improving" | "stable" | "degrading";
  /** Issues detected */
  issues: SkillIssue[];
  /** Last updated */
  updatedAt: string;
}

export interface SkillIssue {
  /** Issue type */
  type: "high_failure_rate" | "excessive_retries" | "frequent_corrections" | "slow" | "unused";
  /** Human-readable description */
  description: string;
  /** Severity: info, warning, critical */
  severity: "info" | "warning" | "critical";
  /** Suggested fix */
  suggestion: string;
}

// ─── Store ───────────────────────────────────────────────────────────

export interface EvolutionState {
  version: number;
  /** Discovered workflow patterns */
  patterns: WorkflowPattern[];
  /** Skill proposals (pending user review) */
  proposals: SkillProposal[];
  /** Per-skill health metrics */
  health: Record<string, SkillHealth>;
  /** Last full analysis timestamp */
  lastAnalysis: string;
  /** Sessions already analyzed (avoid re-processing) */
  analyzedSessionIds: string[];
}
