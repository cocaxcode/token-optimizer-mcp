<p align="center">
  <h1 align="center">@cocaxcode/token-optimizer-mcp</h1>
  <p align="center">
    <strong>Know what your tokens cost. Control where they go.</strong><br/>
    14 tools &middot; 9 CLI commands &middot; 4 hooks &middot; Coach with 20 tips &middot; Measurement honesty &middot; Budget enforcement
  </p>
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/@cocaxcode/token-optimizer-mcp"><img src="https://img.shields.io/npm/v/@cocaxcode/token-optimizer-mcp.svg?style=flat-square&color=cb3837" alt="npm version" /></a>
  <a href="https://www.npmjs.com/package/@cocaxcode/token-optimizer-mcp"><img src="https://img.shields.io/npm/dm/@cocaxcode/token-optimizer-mcp.svg?style=flat-square" alt="npm downloads" /></a>
  <a href="https://opensource.org/licenses/MIT"><img src="https://img.shields.io/badge/license-MIT-blue.svg?style=flat-square" alt="License" /></a>
  <img src="https://img.shields.io/badge/node-%3E%3D20-339933?style=flat-square&logo=node.js&logoColor=white" alt="Node" />
  <img src="https://img.shields.io/badge/tools-14-blueviolet?style=flat-square" alt="14 tools" />
  <img src="https://img.shields.io/badge/tests-322-brightgreen?style=flat-square" alt="322 tests" />
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

Four hooks record everything silently in a per-project SQLite database. Fourteen MCP tools let the AI (and you) query stats, set budgets, search sessions, prune unused MCPs, and get proactive coaching tips. Nine CLI subcommands let you manage everything from the terminal. All data stays on your machine — nothing is synced, nothing is tracked, nothing leaves your disk.

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
-> 20 tips: opusplan, /compact, plan mode, serena, RTK, skills migration...
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
-> SessionStart:compact hook injects: recent files, recent commands, budget status,
   recently touched Serena symbols
-> You pick up where you left off
```

---

## Installation

### Claude Code (recommended)

**Step 1 — Register the MCP server:**

```bash
claude mcp add --scope user token-optimizer -- npx -y @cocaxcode/token-optimizer-mcp@latest --mcp
```

**Step 2 — Install globally (required for hooks):**

```bash
npm install -g @cocaxcode/token-optimizer-mcp
```

> **Why?** The 4 hooks (`PreToolUse`, `PostToolUse`, `SessionStart`) run via `npx @cocaxcode/token-optimizer-mcp --hook <name>`. Without a global install, `npx` can't find the binary and the hooks **fail silently** — no RTK bridge, no analytics, no compact recovery. The MCP server itself works fine with `npx -y`, but hooks need the package in PATH.

**Step 3 — Set up hooks:**

```bash
npx @cocaxcode/token-optimizer-mcp install
```

This registers the 4 core hooks and, if Serena is detected, also auto-registers the Serena-specific hooks (see [Serena integration](#serena-mcp--symbolic-file-reads) below).

**Step 4 — Restart Claude Code** (hooks are loaded at session start).

**Step 5 — Verify:**

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

The coach combines a **static knowledge base** of 20 tips with a **dynamic detector** of 12 rules that fire based on your recent activity.

### 20 tips

| Category | Tips |
|---|---|
| **Model/mode** | `use-opusplan`, `use-plan-mode`, `use-fast-mode`, `default-to-sonnet`, `use-haiku-for-simple` |
| **Context** | `use-compact-long-session`, `use-clear-rename-resume`, `use-sessionstart-compact-hook`, `use-memory-save` |
| **Tools** | `use-agent-explore`, `use-todowrite-long-task`, `use-skill-trigger`, `install-serena`, `install-rtk`, `prefer-serena-reads`, `use-serena-overview-first` |
| **Config** | `use-mcp-prune`, `migrate-claudemd-to-skills`, `use-settings-local`, `use-prompt-caching` |

Every tip includes: description, exact invocation command, when it applies, honest savings estimate, and the source of that claim.

### 12 detection rules

| Rule | Fires when | Suggests |
|---|---|---|
| `detect-context-threshold` | Context > 50/75/90% | `/compact` |
| `detect-long-reasoning-no-code` | 10+ events without edits | `plan mode`, `opusplan` |
| `detect-repeated-searches` | 3+ Grep/Glob in 20 events | `Agent Explore` |
| `detect-huge-file-reads` | Read > 50k tokens | `install serena` |
| `detect-many-bash-commands` | 11+ Bash in 100 events | `install RTK` |
| `detect-opus-for-simple-task` | Opus active, 6+ edits/Bash in 20 events | `switch to Sonnet/Haiku` |
| `detect-clear-opportunity` | Topic pivot detected (< 30% tool overlap) | `/rename + /clear + /resume` |
| `detect-post-milestone-opportunity` | 5+ edits + Bash + context > 40% | `/compact` at natural breakpoint |
| `detect-serena-read-cascade` | ≥5 `find_symbol` without `get_symbols_overview` | `use-serena-overview-first` |
| `detect-read-over-serena` | 3+ Read > 2k tokens in 30 events | `prefer-serena-reads` |
| `detect-claudemd-bloat` | *(stub — filesystem stat at runtime)* | `migrate-claudemd-to-skills` |
| `detect-skill-trigger-ignored` | *(stub — requires skill registry)* | `use-skill-trigger` |

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

## Complementary Tools: serena + RTK

token-optimizer-mcp **does not install anything automatically**. `doctor` detects and suggests — the user decides. These two tools work alongside token-optimizer to reduce token consumption at different levels.

### serena-mcp — symbolic file reads

Instead of reading entire files (500+ lines), serena uses **LSP** to read only the symbols (classes, functions, methods) you actually need. Saves **20-30%** on large file reads — or **60-90%** when using `get_symbols_overview` + `find_symbol` instead of `Read`.

**Step 1 — Install serena as MCP server:**

```bash
# Claude Code
claude mcp add --scope user serena -- serena start-mcp-server --context=claude-code --project-from-cwd

# Or manually in ~/.claude.json → mcpServers:
{
  "serena": {
    "type": "stdio",
    "command": "serena",
    "args": ["start-mcp-server", "--context=claude-code", "--project-from-cwd"]
  }
}
```

> Requires `serena` installed: `pip install serena` or `pipx install serena` or `uvx --from git+https://github.com/oraios/serena serena start-mcp-server`

**Step 2 — Register your project (required per-project):**

Serena needs to know which projects to index. The first time you use serena in a project:

```
> "Activate this project in serena"
→ Claude calls mcp__serena__activate_project with the project path
→ Serena indexes the codebase via LSP
```

Or create `.serena/project.yml` in the project root for auto-detection:

```yaml
# .serena/project.yml — minimal config
name: my-project
```

Without a registered project, serena returns "No active project" and cannot do symbolic reads.

**Step 3 — Verify with token-optimizer:**

```bash
npx @cocaxcode/token-optimizer-mcp doctor
```

Expected output when fully configured:

```
[serena]  ✓ conf=0.40  signals: claude-json-registered, project-registered-for-cwd
```

If you see `✓` but no `project-registered-for-cwd`, serena is installed but the current project is not registered.

**Serena hook auto-registration**: when you run `token-optimizer-mcp install`, the installer probes for Serena automatically:

- If the **MCP server** is registered (detected via `~/.serena/`): installs the `serena-activate` hook — a lightweight SessionStart hook that emits the correct `ToolSearch` instruction so the agent can call Serena tools even when MCP tools are deferred at session start.
- If the **CLI** (`serena-hooks`) is also on PATH: additionally installs the 3 official Serena hooks (`remind`, `auto-approve`, `cleanup`). These are kept in sync — if the CLI disappears, the next `install` run removes the orphan entries.

**How token-optimizer integrates**: the `optimization_status` tool and `doctor` CLI detect serena presence across 5 signals (global settings, ~/.claude.json, project settings, local settings, project registration). The coach `detect-huge-file-reads` and `detect-read-over-serena` rules fire when Read usage is heavy and suggest using serena instead.

**Security note**: serena includes `execute_shell_command` among its tools. Review the configuration before enabling.

---

### RTK — Bash output filtering

RTK is a Rust CLI that **filters and compresses command output** before it reaches Claude Code. Instead of 500 lines of build output, RTK returns only errors, failures, or a compact summary. Saves **15-25%** on build/test cycles.

**Step 1 — Install RTK binary:**

```bash
# macOS
brew install standard-input/tap/rtk

# Windows — download signed binary from GitHub releases:
# https://github.com/standard-input/rtk/releases
# Place rtk.exe somewhere in your PATH (e.g., C:\tools\rtk\)

# Verify
rtk --version
```

**Step 2 — token-optimizer bridge (automatic via global install):**

The **PreToolUse hook** acts as an RTK bridge — but it requires `npm install -g @cocaxcode/token-optimizer-mcp` (see [Installation](#installation)):

1. Claude wants to run `git status`
2. The hook calls `rtk rewrite "git status"`
3. RTK returns `rtk git status` (exit 0 = auto-allow)
4. The hook sets `updatedInput` so Claude runs the RTK-wrapped version
5. Output is filtered before it enters the context window

This happens **automatically** for every Bash command — no manual `rtk` invocation needed.

> **Important**: After installing, **restart Claude Code**. Hooks are loaded at session start — if the package wasn't installed when the session started, hooks won't fire until the next session.

RTK exit codes (all handled by the bridge):
- **0** — rewrite + auto-allow (e.g., `npm run build` → `rtk npm run build`)
- **1** — no RTK equivalent → passthrough (command runs as-is)
- **2** — deny rule → passthrough
- **3** — rewrite + allow (e.g., `git status` → `rtk git status`, `find` → `rtk find`)

> Both exit 0 and 3 set `permissionDecision: "allow"` so Claude Code applies the rewrite. Without this field, Claude Code ignores `updatedInput`.

**Step 3 — Verify with token-optimizer:**

```bash
npx @cocaxcode/token-optimizer-mcp doctor
```

Expected output when fully configured:

```
[rtk]  ✓ conf=0.40  signals: rtk-binary-in-path, token-optimizer-bridge-active
```

If you see `rtk-binary-in-path` but no `token-optimizer-bridge-active`, RTK is installed but the token-optimizer hooks are not — run `npx @cocaxcode/token-optimizer-mcp install` to set them up.

**What RTK can wrap** (partial list): `ls`, `tree`, `git`, `gh`, `test`, `err`, `json`, `diff`, `grep`, `docker`, `kubectl`, `pnpm`, `dotnet`, `psql`, `aws`, and more. Run `rtk --help` for the full list.

**Security note**: RTK publishes GPG-signed releases. Compiled in Rust. Open source at [github.com/standard-input/rtk](https://github.com/standard-input/rtk).

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
| `install` | Register MCP server + 4 hooks in `~/.claude/settings.json` (auto-registers Serena hooks if detected) |
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
| `PreToolUse` | `Bash` | Checks budget (passthrough / warn), then RTK rewrite. Sets `updatedInput` + `permissionDecision: "allow"` when RTK rewrites (exit 0/3). Budget warn always wins over RTK. |
| `PostToolUse` | `*` | Async analytics to SQLite. Fire-and-forget to xray. Target p95: 10ms. |
| `SessionStart` | `compact` | Injects markdown: recent files, commands, budget, recently touched Serena symbols. Token-capped at 2000. |
| `SessionStart` | *(any)* | **serena-activate** — when Serena is detected, emits the `ToolSearch` activation sequence so the agent can call Serena tools even when MCP tools are deferred. Noop when Serena is not installed. |

Additionally, if the `serena-hooks` CLI binary is on PATH, `install` registers the 3 official Serena hooks: `PreToolUse → remind`, `PreToolUse(mcp__serena__.*) → auto-approve`, and `Stop → cleanup`.

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
├── server.ts             # createServer() — registers 14 tools + 1 resource
├── cli/                  # 9 subcommands + dispatcher
├── hooks/                # pretooluse, posttooluse, sessionstart, serena-activate
├── tools/                # budget, session, orchestration, coach, toon
├── services/             # analytics-logger, budget-manager, session-retriever,
│                         #   stats, rtk-reader, serena-shadow, xray-client
├── orchestration/        # detector (probes), schema-measurer, advisor
├── coach/                # knowledge-base (20 tips), rules (12), detector,
│                         #   context-meter, reference-data, surface (dedupe)
├── lib/                  # types, paths, storage, token-estimator, response
└── db/                   # schema (DDL), connection (WAL), queries
```

**Stack**: TypeScript 5 strict ESM &middot; `@modelcontextprotocol/sdk` ^1.27 &middot; `better-sqlite3` ^11 (WAL + FTS5) &middot; Zod 3.25 &middot; Vitest 3.2+ &middot; tsup &middot; Node >=20

**322 tests** across 35 suites. All tools tested via `InMemoryTransport`.

---

## License

MIT

---

<p align="center">
  <sub>Savings estimates come from public documentation and community reports (sources cited). Your actual savings depend on your workflow. Use <code>token-optimizer-mcp report</code> to see real numbers.</sub>
</p>
