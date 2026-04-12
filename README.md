<p align="center">
  <h1 align="center">@cocaxcode/token-optimizer-mcp</h1>
  <p align="center">
    <strong>Know what your tokens cost. Control where they go.</strong><br/>
    13 tools &middot; 9 CLI commands &middot; 3 hooks &middot; Coach with 18 tips &middot; Measurement honesty &middot; Budget enforcement
  </p>
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/@cocaxcode/token-optimizer-mcp"><img src="https://img.shields.io/npm/v/@cocaxcode/token-optimizer-mcp.svg?style=flat-square&color=cb3837" alt="npm version" /></a>
  <a href="https://www.npmjs.com/package/@cocaxcode/token-optimizer-mcp"><img src="https://img.shields.io/npm/dm/@cocaxcode/token-optimizer-mcp.svg?style=flat-square" alt="npm downloads" /></a>
  <a href="https://opensource.org/licenses/MIT"><img src="https://img.shields.io/badge/license-MIT-blue.svg?style=flat-square" alt="License" /></a>
  <img src="https://img.shields.io/badge/node-%3E%3D20-339933?style=flat-square&logo=node.js&logoColor=white" alt="Node" />
  <img src="https://img.shields.io/badge/tools-13-blueviolet?style=flat-square" alt="13 tools" />
  <img src="https://img.shields.io/badge/tests-238-brightgreen?style=flat-square" alt="238 tests" />
</p>

<p align="center">
  <a href="#quick-overview">Overview</a> &middot;
  <a href="#just-talk-to-it">Just Talk to It</a> &middot;
  <a href="#installation">Installation</a> &middot;
  <a href="#coach-layer">Coach</a> &middot;
  <a href="#measurement-honesty">Honesty</a> &middot;
  <a href="#tool-reference">Tools</a> &middot;
  <a href="#cli-reference">CLI</a> &middot;
  <a href="#architecture">Architecture</a>
</p>

---

## Quick Overview

An MCP server that sits between Claude Code and your tools, measuring every interaction, enforcing token budgets, and actively coaching you on features you may not be using — like `/opusplan`, `/compact`, plan mode, or model switching.

This is not a replacement for [serena](https://github.com/oraios/serena) (symbolic file reads) or [RTK](https://github.com/standard-input/rtk) (Bash output filtering). It **orchestrates** with them: detects whether they are installed, measures how much they save, suggests installing them when they would help, and reports everything with honest labels — splitting **Medido** (measured) from **Estimado** (estimated) so you always know what is real.

Three hooks record everything silently in a per-project SQLite database. Thirteen MCP tools let the AI (and you) query stats, set budgets, search sessions, prune unused MCPs, and get proactive coaching tips. Nine CLI subcommands let you manage everything from the terminal. All data stays on your machine — nothing is synced, nothing is tracked, nothing leaves your disk.

Works with **Claude Code**, **Claude Desktop**, **Cursor**, **Windsurf**, **VS Code**, **Codex CLI**, **Gemini CLI**, and any MCP-compatible client.

---

## Just Talk to It

You don't need to memorize tool names. Just say what you need.

### Know your costs

```
"How many tokens did I spend today?"
-> Breakdown by tool, by source, Sonnet-Opus cost range

"Show me the report for this week"
-> Per-source estimation_method labels + Medido vs Estimado split

"What optimizations am I missing?"
-> Probes serena, RTK, MCP pruning, prompt caching — shows install commands
```

### Control your budget

```
"Set a budget of 50k tokens for this session in warn mode"
-> Alerts when Bash approaches the limit

"Switch to block mode at 100k tokens"
-> Bash commands blocked when budget exceeded

"What's my budget status?"
-> Spent / remaining / percent / mode
```

### Get coached

```
"Any tips for me?"
-> 18 tips: opusplan, /compact, plan mode, serena, RTK, skills migration...
-> Active rules detect: too many searches, huge file reads, Opus on simple tasks

"Explain the use-opusplan tip"
-> Full detail: what, when, how to invoke, estimated savings, source of the claim

"I'm at 80% context — what should I do?"
-> Coach fires: /compact now, save state with mem_save, use Agent Explore
```

### Manage MCP pruning

```
"Which MCPs am I not using?"
-> Generates allowlist from 14-day history: used vs inactive servers

"Apply the allowlist"
-> Writes to settings.local.json with backup — not settings.json

"Undo that"
-> Byte-identical rollback from timestamped backup

"What was the impact?"
-> Before/after average tokens per event since the last snapshot
```

### Recover after /compact

```
(Claude Code auto-compacts the context)
-> SessionStart:compact hook injects: recent files, recent commands, budget status
-> You pick up where you left off
```

---

## Installation

### Claude Code (recommended)

```bash
claude mcp add --scope user token-optimizer -- npx -y @cocaxcode/token-optimizer-mcp@latest --mcp
```

Then verify:

```bash
npx @cocaxcode/token-optimizer-mcp doctor
```

Per-project analytics data is stored in `{project}/.token-optimizer/` and auto-added to `.gitignore`.

### Claude Desktop

Add to your config file (`~/Library/Application Support/Claude/claude_desktop_config.json` on macOS, `%APPDATA%\Claude\claude_desktop_config.json` on Windows):

```json
{
  "mcpServers": {
    "token-optimizer": {
      "command": "npx",
      "args": ["-y", "@cocaxcode/token-optimizer-mcp", "--mcp"]
    }
  }
}
```

<details>
<summary><strong>Cursor / Windsurf</strong></summary>

Add to `.cursor/mcp.json` or `.windsurf/mcp.json`:

```json
{
  "mcpServers": {
    "token-optimizer": {
      "command": "npx",
      "args": ["-y", "@cocaxcode/token-optimizer-mcp", "--mcp"]
    }
  }
}
```
</details>

<details>
<summary><strong>VS Code</strong></summary>

Add to `.vscode/mcp.json`:

```json
{
  "servers": {
    "token-optimizer": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "@cocaxcode/token-optimizer-mcp", "--mcp"]
    }
  }
}
```
</details>

<details>
<summary><strong>Codex CLI (OpenAI)</strong></summary>

```bash
codex mcp add token-optimizer -- npx -y @cocaxcode/token-optimizer-mcp --mcp
```
</details>

<details>
<summary><strong>Gemini CLI</strong></summary>

Add to `~/.gemini/settings.json`:

```json
{
  "mcpServers": {
    "token-optimizer": {
      "command": "npx",
      "args": ["-y", "@cocaxcode/token-optimizer-mcp", "--mcp"]
    }
  }
}
```
</details>

### Uninstall

```bash
npx @cocaxcode/token-optimizer-mcp uninstall
npx @cocaxcode/token-optimizer-mcp uninstall --purge --confirm   # also delete stored data
```

---

## Coach Layer

The coach combines a **static knowledge base** of 18 tips with a **dynamic detector** of 11 rules that fire based on your recent activity.

### 18 tips

| Category | Tips |
|---|---|
| **Model/mode** | `use-opusplan`, `use-plan-mode`, `use-fast-mode`, `default-to-sonnet`, `use-haiku-for-simple` |
| **Context** | `use-compact-long-session`, `use-clear-rename-resume`, `use-sessionstart-compact-hook`, `use-memory-save` |
| **Tools** | `use-agent-explore`, `use-todowrite-long-task`, `use-skill-trigger`, `install-serena`, `install-rtk` |
| **Config** | `use-mcp-prune`, `migrate-claudemd-to-skills`, `use-settings-local`, `use-prompt-caching` |

Every tip includes: description, exact invocation command, when it applies, honest savings estimate, and the source of that claim.

### 11 detection rules

| Rule | Fires when | Suggests |
|---|---|---|
| `detect-context-threshold` | Context > 50/75/90% | `/compact` |
| `detect-long-reasoning-no-code` | 10+ events without edits | `plan mode`, `opusplan` |
| `detect-repeated-searches` | 3+ Grep/Glob in 20 events | `Agent Explore` |
| `detect-huge-file-reads` | Read > 50k tokens | `install serena` |
| `detect-many-bash-commands` | 11+ Bash in 100 events | `install RTK` |
| `detect-opus-for-simple-task` | Opus active, no edits | `switch to Sonnet/Haiku` |
| `detect-clear-opportunity` | Topic pivot detected | `/rename + /clear + /resume` |
| `detect-post-milestone-opportunity` | 5+ edits + tests + context > 40% | `/compact` at natural breakpoint |

### Context meter (3-source fallback)

1. **Transcript JSONL** — parses `~/.claude/projects/{key}/{session}.jsonl` for real API tokens → `measured_exact`
2. **xray HTTP** — `GET /sessions/{id}/tokens` with 300ms timeout → `measured_exact`
3. **Cumulative DB** — `SUM(tokens_estimated) + 15k baseline` → `estimated_cumulative`

---

## Measurement Honesty

Every event in the analytics DB carries an `estimation_method` tag from day one. No mixing real numbers with guesses.

| Method | Meaning | Sources |
|---|---|---|
| `measured_exact` | Counted directly | builtin, own, mcp, xray |
| `estimated_rtk_db` | Read from RTK tracking.db | RTK |
| `estimated_rtk_marker` | Parsed from `[rtk: filtered N tokens]` | RTK |
| `estimated_serena_shadow` | `fs.stat` delta vs output size | serena (opt-in) |
| `estimated_cumulative` | SUM from DB + baseline | coach context meter |
| `reference_measured` | Public data, verifiable source | reference table |
| `unknown` | No authoritative source | prompt caching |

Reports always split:

```
Resumen: Medido: 45,230 tokens · Estimado: 12,100 tokens
```

### Reference data (public, verified 2026-04-11)

| Feature | Savings | Source |
|---|---|---|
| Model switching (opusplan / default-to-sonnet) | 60-80% cost | mindstudio.ai, verdent.ai |
| Progressive disclosure skills | ~15k tokens/session | claudefast.com |
| Prompt caching read hit | 10x cheaper | Anthropic docs |
| Claude Code Tool Search | ~85% schema reduction | observed (77k to 8.7k) |
| MCP pruning on top of Tool Search | ~5-12% per turn | internal estimate |

---

## About Recommended Tools

token-optimizer-mcp **does not install anything automatically**. `doctor` detects and suggests — the user decides.

### serena-mcp

Symbolic file reads via LSP. Reads only the symbols you need instead of the entire file. Saves 20-30% on large files.

```bash
uvx --from git+https://github.com/oraios/serena serena start-mcp-server
```

**Security note**: serena includes `execute_shell_command` among its tools. Review the configuration before enabling.

### RTK

Filters noisy Bash output (builds, tests) before it reaches Claude Code. Saves 15-25% on build/test cycles.

```bash
brew install standard-input/tap/rtk
```

**Security note**: RTK publishes GPG-signed releases. Compiled in Rust.

---

## Tool Reference

### Budget (3)

| Tool | Description |
|---|---|
| `budget_set` | Create/update a token budget (scope: session or project, mode: warn or block) |
| `budget_check` | Current spent / remaining / percent / mode |
| `budget_report` | Consumption grouped by tool and source for a period |

### Session (1)

| Tool | Description |
|---|---|
| `session_search` | FTS5 full-text search (BM25) over session events |

### Orchestration (7)

| Tool | Description |
|---|---|
| `mcp_usage_stats` | Token usage by tool and source |
| `mcp_cost_report` | Cost estimate with Sonnet-Opus range |
| `optimization_status` | Probe results for serena, RTK, MCP pruning, prompt caching |
| `mcp_prune_suggest` | Generate allowlist from history (read-only) |
| `mcp_prune_apply` | Apply allowlist to `settings.local.json` (`confirm: true` required) |
| `mcp_prune_rollback` | Restore from timestamped backup (`confirm: true` required) |
| `mcp_prune_clear` | Remove allowlist entirely (`confirm: true` required) |

### Coach (1)

| Tool | Description |
|---|---|
| `coach_tips` | Active hits + full knowledge base + context measurement + reference data |

### TOON (2)

| Tool | Description |
|---|---|
| `toon_encode` | Encode to compact JSON (token-efficient, round-trip lossless) |
| `toon_decode` | Decode compact JSON back to formatted object |

---

## CLI Reference

| Command | Description |
|---|---|
| `install` | Register MCP server + 3 hooks in `~/.claude/settings.json` |
| `uninstall` | Remove entries; `--purge --confirm` deletes stored data |
| `doctor` | Run all probes + schema measurer + advisor (always exits 0) |
| `status` | Install detection, DB path, events today, tokens by source, budget |
| `report` | Per-source breakdown with Medido/Estimado split + reference table |
| `budget` | `set`, `get`, `clear` from terminal |
| `prune-mcp` | `--generate-from-history`, `--apply`, `--rollback`, `--clear`, `--impact` |
| `coach` | `status`, `list`, `explain <tip_id>`, `reset` |
| `config` | `get [key]`, `set <key> <value>` with dotted paths |

---

## Hooks

| Hook | Matcher | What it does |
|---|---|---|
| `PreToolUse` | `Bash` | Checks budget: passthrough / warn / block. **Never sets `updatedInput`** — coexists with RTK. |
| `PostToolUse` | `*` | Async analytics to SQLite. Fire-and-forget to xray. Target p95: 10ms. |
| `SessionStart` | `compact` | Injects markdown: recent files, commands, budget. Token-capped at 2000. |

---

## Storage

```
~/.token-optimizer/                  # Global
├── config.json                      # User preferences (coach, shadow, RTK)

{project}/.token-optimizer/          # Per-project (auto-gitignored)
└── analytics.db                     # SQLite WAL — 8 tables + FTS5

{project}/.claude/
└── settings.local.json              # MCP allowlist (prune-mcp, gitignored by default)
```

### What is NOT stored

No credentials, no secrets, no full source code. Content is truncated to 4KB, input summaries to 512B. No data leaves your machine — xray integration is opt-in and local.

---

## Configuration

`~/.token-optimizer/config.json`:

```json
{
  "shadow_measurement": { "serena": false },
  "rtk_integration": { "rtk_db_path": null },
  "coach": {
    "enabled": true,
    "auto_surface": true,
    "posttooluse_throttle": 20,
    "sessionstart_tips_max": 3,
    "context_thresholds": { "info": 0.5, "warn": 0.75, "critical": 0.9 },
    "dedupe_window_seconds": 60,
    "stale_tip_days": 90
  }
}
```

```bash
npx @cocaxcode/token-optimizer-mcp config set coach.enabled false
npx @cocaxcode/token-optimizer-mcp config get coach.context_thresholds
```

---

## Architecture

```
src/
├── index.ts              # Entry — --mcp | --hook X | subcommand
├── server.ts             # createServer() — registers 13 tools
├── cli/                  # 9 subcommands + dispatcher
├── hooks/                # pretooluse, posttooluse, sessionstart
├── tools/                # budget, session, orchestration, coach, toon
├── services/             # analytics-logger, budget-manager, session-retriever,
│                         #   stats, rtk-reader, serena-shadow, xray-client
├── orchestration/        # detector (probes), schema-measurer, advisor
├── coach/                # knowledge-base (18), rules (11), detector,
│                         #   context-meter, reference-data, surface (dedupe)
├── lib/                  # types, paths, storage, token-estimator, response
└── db/                   # schema (DDL), connection (WAL), queries
```

**Stack**: TypeScript 5 strict ESM &middot; `@modelcontextprotocol/sdk` ^1.27 &middot; `better-sqlite3` ^11 (WAL + FTS5) &middot; Zod 3.25 &middot; Vitest 3.2+ &middot; tsup &middot; Node >=20

**238 tests** across 28 suites. All tools tested via `InMemoryTransport`.

---

## License

MIT

---

<p align="center">
  <sub>Savings estimates come from public documentation and community reports (sources cited). Your actual savings depend on your workflow. Use <code>token-optimizer-mcp report</code> to see real numbers.</sub>
</p>
