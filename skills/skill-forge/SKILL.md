---
name: skill-forge
description: Discover repeated workflow patterns from session history and generate new skill scaffolds. Also monitors skill health — success rates, retries, corrections, and trends. Use when looking for automation opportunities, reviewing skill effectiveness, or generating new skills from observed patterns.
---

# Skill Forge & Dojo

Two systems for skill self-improvement, mostly automated:

1. **Forge** — mines session history for repeated multi-step workflows and proposes new skills
2. **Dojo** — tracks skill health (success rate, retries, user corrections) and flags weak skills

## Automation (runs without you asking)

- **On session start**: surfaces critical skill health issues as notifications, shows pending proposals in status bar
- **Before each prompt**: if your prompt involves a skill with known issues, injects health warnings into the system prompt so the agent is aware
- **On session shutdown**: runs incremental analysis on new sessions (batched — waits for 5+ new sessions), updates health metrics, auto-generates proposals for high-frequency patterns
- **On tool_call**: tracks which skills are loaded (SKILL.md reads) for health tracking

You only need to intervene to:
- Review and accept/reject proposals (`skill_forge_proposals`, `skill_forge_accept`)
- Investigate flagged skills (`skill_dojo_report`)
- Force a full re-analysis (`skill_forge_analyze incremental=false`)

## Manual Tools

```
# Force-run workflow mining (normally runs on shutdown)
→ skill_forge_analyze

# Review proposed skills
→ skill_forge_proposals

# Accept a proposal and generate the skill scaffold
→ skill_forge_accept index=0

# Check skill health dashboard
→ skill_dojo_health

# Deep dive on a specific skill
→ skill_dojo_report skill="cr-workflow"
```

## Improving a Weak Skill

When the dojo flags a skill:
1. Check `skill_dojo_report` for the specific issues
2. Review recent sessions where the skill failed (use session_search)
3. Check `memory_lessons` for corrections related to that skill
4. Update the SKILL.md with clearer instructions, better examples, or edge case handling
5. Health metrics update automatically as new sessions accumulate

## How It Works

### Pattern Mining
- Reads parsed session data from the session-search index
- Classifies tool calls into high-level actions (build, edit_java, git_commit, cr_upload, etc.)
- Deduplicates consecutive identical actions
- Extracts n-gram subsequences (3-7 steps), filters generic exploration patterns
- Counts occurrences across sessions, requires 8+ (configurable)

### Health Tracking
- Detects skill invocations by SKILL.md reads in session history
- Tracks the "segment" from skill load to next skill load or topic change
- Measures: success (no retries/corrections), retry count, user corrections, duration
- Computes trends by comparing recent vs older invocations
- Flags issues: high_failure_rate, excessive_retries, frequent_corrections, slow, unused

### State
- Persisted to `~/.pi/skill-evolution/state.json`
- Incremental by default — only processes new sessions
- `/skills` command for quick status check
