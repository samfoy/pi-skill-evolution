# pi-skill-evolution

Meta-skill and self-improvement loop for [pi](https://github.com/badlogic/pi-mono). Mines your session history for repeated workflows, proposes new skills, and tracks skill health — automatically.

## What it does

Two systems:

**Skill Forge** — discovers repeated multi-step workflow patterns across your session history and proposes them as new skills. Patterns like "build → fix → build" or "commit → upload CR → update notes" that you do over and over get surfaced as candidates for formalization.

**Skill Dojo** — tracks how well each skill performs by analyzing session data: success rate, retry count, user correction rate, and trends over time. Flags skills that are degrading or have high failure rates so you can fix them.

## Install

```bash
pi install git:github.com/samfoy/pi-skill-evolution
# or
pi install npm:pi-skill-evolution
```

## Automation

Most of the work happens automatically:

- **On session start**: surfaces critical skill health issues and pending proposals
- **Before each prompt**: injects health warnings into the system prompt when you're about to use a skill with known issues
- **On session shutdown**: runs incremental pattern mining and health analysis (batched every 5+ new sessions)

You only intervene to:
- Review and accept/reject proposals
- Investigate flagged skills
- Force a full re-analysis

## Tools

| Tool | Description |
|------|-------------|
| `skill_forge_analyze` | Mine session history for workflow patterns |
| `skill_forge_proposals` | List pending skill proposals |
| `skill_forge_accept` | Accept a proposal and generate a SKILL.md scaffold |
| `skill_dojo_health` | Skill health dashboard — success rates, retries, trends |
| `skill_dojo_report` | Detailed report for a specific skill |

## Commands

| Command | Description |
|---------|-------------|
| `/skills` | Quick status summary |

## Example

```
> skill_dojo_health

Skill Health Dashboard (20 skills tracked)

Issues: 0 critical, 1 warnings

Skill                    | Uses | Success | Retries | Corrections | Trend
-------------------------|------|---------|---------|-------------|------
ticketing                |   45 |    71%  |     1.0 |          2% | →  🟡
internal-reader          |  117 |    91%  |     0.4 |          2% | →
cr-workflow              |   73 |    96%  |     0.2 |          4% | →
code-review              |   49 |    96%  |     0.1 |          0% | →
...
```

## Requirements

- [pi](https://github.com/badlogic/pi-mono) with the session-search extension (for session index data)
- Sessions accumulate over time — the more history, the better the pattern detection

## How it works

### Pattern Mining
- Reads parsed session data from the session-search index (`~/.pi/session-search/index/`)
- Classifies tool calls into high-level actions (build, git_commit, cr_upload, mcp_call, etc.)
- Deduplicates consecutive identical actions
- Extracts n-gram subsequences (3-7 steps), filters generic exploration patterns
- Counts occurrences across sessions, requires 8+ by default

### Health Tracking
- Detects skill invocations by SKILL.md reads in session history
- Tracks the segment from skill load to next skill load or topic change
- Measures: success (no retries/corrections), retry count, user corrections, duration
- Computes trends by comparing recent vs older invocations
- Flags: high_failure_rate, excessive_retries, frequent_corrections, slow, unused

### State
- Persisted to `~/.pi/skill-evolution/state.json`
- Incremental by default — only processes new sessions since last analysis

## License

MIT
