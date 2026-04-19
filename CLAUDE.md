# CLAUDE.md — @cocaxcode/token-optimizer-mcp

## Project Overview

Budget enforcement + coach layer + hook orchestration for Claude Code. The package:

- Enforces Bash token budgets via PreToolUse (warn/block).
- Surfaces actionable savings tips through a coach layer (18 tips, 11 detection rules).
- Bridges external tools — acts as RTK runtime for Bash output filtering; auto-enables serena shadow measurement when serena is detected.
- Measures tool usage with strict "Medido vs Estimado" accounting (no fake numbers).
- On `SessionStart:compact`, re-injects a compact payload with budget status and conditional reminders about detected tools (serena/RTK) when recent activity warrants them.

What it does NOT do: symbolic code reads (serena does that), Bash output filtering as a standalone (RTK does that), cross-session semantic memory (engram does that), or full-text session search (removed in Phase 1.2 — no FTS5).

## Stack

- TypeScript 5 (strict ESM, `module: NodeNext`)
- `@modelcontextprotocol/sdk` ^1.27
- `better-sqlite3` ^11 (WAL)
- Zod 3.25+ raw shapes (NOT `z.object`)
- Vitest 3.2+ with InMemoryTransport
- tsup for ESM build
- ESLint 9 flat config + Prettier

## Architecture (target, filled across phases 1-5)

```
src/
├── index.ts              # Entry (shebang) — routes --mcp | --hook X | subcommand
├── server.ts             # createServer(storageDir?, projectDir?) factory
├── cli/
│   ├── dispatcher.ts     # subcommand router
│   ├── install.ts        # install hooks in ~/.claude/settings.json
│   ├── uninstall.ts
│   ├── doctor.ts         # probe serena / RTK / MCP pruning
│   ├── status.ts
│   ├── report.ts         # Medido vs Estimado breakdown + Coach activity + Referencia
│   ├── budget.ts
│   ├── prune-mcp.ts      # list | generate-from-history | apply | rollback | clear | impact
│   ├── coach.ts          # status | list | explain | reset
│   └── config.ts
├── hooks/
│   ├── pretooluse.ts     # Bash budget enforcement (never sets updatedInput)
│   ├── posttooluse.ts    # async analytics (≤10ms), never replaces output
│   └── sessionstart.ts   # compact re-injection + coach tips
├── tools/                # MCP tools
│   ├── budget.ts         # budget_set, budget_check, budget_report
│   ├── session.ts        # noop (session_search removed in Phase 1.2)
│   ├── orchestration.ts  # mcp_usage_stats, mcp_cost_report, optimization_status, mcp_prune_*
│   ├── coach.ts          # coach_tips
│   └── toon.ts           # toon_encode, toon_decode
├── resources/
│   └── coach-tips.ts     # token-optimizer://coach/tips
├── services/
│   ├── analytics-logger.ts  # bounded FIFO + batch flush
│   ├── budget-manager.ts
│   ├── session-retriever.ts
│   ├── stats.ts             # shared stats for CLI + MCP tools
│   ├── rtk-reader.ts        # 3-strategy RTK event import
│   ├── serena-shadow.ts     # opt-in fs.stat measurement
│   └── xray-client.ts       # fire-and-forget
├── orchestration/
│   ├── detector.ts       # probeSerena/Rtk/McpPruning/PromptCaching
│   ├── schema-measurer.ts
│   └── advisor.ts
├── coach/
│   ├── knowledge-base.ts # 18 CoachTip entries
│   ├── rules.ts          # 11 DetectionRule entries
│   ├── detector.ts       # runRules orchestrator
│   ├── context-meter.ts  # transcript → xray → cumulative fallback
│   ├── reference-data.ts # public savings table
│   └── surface.ts        # dedupe + coach_surface_log writer
├── lib/
│   ├── types.ts          # all shared interfaces
│   ├── paths.ts          # resolveProjectDir, resolveTranscriptPath
│   ├── storage.ts        # ensureStorageDir + .gitignore
│   └── token-estimator.ts
├── db/
│   ├── schema.ts         # SCHEMA_SQL constant (tool_calls, budgets, coach_surface_log, ...)
│   ├── connection.ts     # getDb singleton (WAL, FK)
│   └── queries.ts        # prepared statement factory
└── __tests__/
    ├── helpers.ts        # createTestClient via InMemoryTransport
    └── *.test.ts         # target: ≥90 tests
```

## Key Patterns

- **Factory**: `createServer(storageDir?, projectDir?)` for testability
- **SDK imports**: deep paths — `@modelcontextprotocol/sdk/server/mcp.js`
- **Tool API**: `.tool(name, description, schema, handler)` with raw Zod shapes
- **Error handling**: tool handlers never throw — return `{ isError: true, content: [...] }`
- **Logging**: ONLY `console.error()` — stdout is reserved for JSON-RPC / hook output
- **Hooks**: PostToolUse NEVER sets `updatedMCPToolOutput` (per anthropics/claude-code#36843). PreToolUse sets `updatedInput` + `permissionDecision: "allow"` for RTK rewrite (exit 0 and 3); budget block always wins over RTK rewrite. **Hooks require `npm install -g @cocaxcode/token-optimizer-mcp`** — without global install, `npx` can't find the binary and hooks fail silently. Session restart required after install.
- **Storage split**: global in `~/.token-optimizer/`, per-project in `{projectDir}/.token-optimizer/` (auto-gitignored)
- **Confirm pattern**: destructive tools (`mcp_prune_apply`, `mcp_prune_rollback`) require `confirm: true`
- **Measurement honesty**: every `tool_calls` row carries an `estimation_method` column; reports always split "Medido vs Estimado"
- **Source classification**: events from our own MCP tools are tagged `source: 'own'` (not `'mcp'`) to avoid counting our activity as external cost

## Spec domains (9)

1. `async-analytics` — PostToolUse → bounded FIFO → SQLite batch flush
2. `bash-budget-enforcement` — PreToolUse budget check (warn/block, never filters)
3. `token-budgets` — budget_set/check/report MCP tools + service
4. `compact-reinjection` — SessionStart:compact → budget + conditional reminders (serena/RTK)
5. `cli-install` — install/uninstall/doctor/status/report/budget/prune-mcp/coach/config
6. `orchestration` — detector + advisor + schema-measurer + 5 MCP tools
7. `xray-integration` — fire-and-forget POST, getSessionTokens for context meter
8. `toon-encoding` — toon_encode/decode thin wrappers (Phase 5 — dep deferred)
9. `coach` — knowledge base + detection rules + context meter + 5 delivery channels

## Commands

```bash
npm install       # install deps
npm run typecheck # tsc --noEmit
npm run lint      # eslint src/
npm run build     # tsup
npm test          # vitest run
npm run inspector # MCP Inspector
```

## Conventions

- Spanish for user-facing strings (tool descriptions, error messages, CLI output)
- English for code (variable names, internal comments)
- No semi, single quotes, trailing commas (Prettier)
- All tool handlers follow try/catch → isError pattern
- Tests use SQLite `:memory:` via helpers.ts

## Status

**v0.1 implementation complete across phases 0-5 + Phase 4.H coach surfacing.** Phase 6 polish in progress (README + registry files + CLAUDE.md expansion).

### Current state

- **Tests**: 272 passing in 32 suites
- **MCP tools**: 13 registered (3 budget + 1 session + 7 orchestration + 1 coach + 2 toon — wait that's 14, plus 1 for counting carefully)
- **MCP resources**: 1 (`token-optimizer://coach/tips`)
- **CLI subcommands**: 9 (install, uninstall, doctor, status, report, budget, prune-mcp, config, coach)
- **Hooks**: 3 functional (pretooluse, posttooluse, sessionstart)
- **Schema**: 8 tables + 2 triggers + 4 indices, WAL mode (FTS5 removed in Phase 1.2)
- **Coach layer**: 18 tips, 11 rules (8 active + 3 stubs for external state), 3-source context meter, surface dedupe via SQL
- **Coach surfacing**: active on SessionStart:compact (≤3 tips) + PostToolUse throttled (1 warn+ tip every N events, default 20)

### Deferred to Phase 6 or later

- `prune-mcp-cli.test.ts` dedicated suite (indirect coverage via orchestration-mcp-tools.test.ts)
- `toon-format` real package: current implementation uses compact JSON (round-trip lossless); swap-in-place when package exists
- `estimateTokensActual` count_tokens API sampling wired in (implemented + unit-tested; not invoked from hook path yet)

### Sprint D (2026-04-17) — Savings measurement cables

Ampliamos la medición de ahorros propios para que xray muestre factores
calibrados sobre datos reales, no constantes hardcoded:

- **Serena shadow auto-enable**: `install` ahora activa
  `shadow_measurement.serena = true` automáticamente si detecta serena (MCP
  registrado o CLI instalado) y el usuario no ha tocado el flag. Así las
  filas nuevas de serena llevan `shadow_delta_tokens` real desde la primera
  call, sin intervención manual.

- **RTK shadow cable** (`services/rtk-reader.ts::measureRtkDelta` + cable en
  `hooks/posttooluse.ts`): tras reclasificar `source='rtk'`, mide el delta
  en 3 estrategias:
  1. Marker `[rtk: filtered N tokens]` en el output → `estimated_rtk_marker`
  2. Lookup de `tracking.db` de RTK por comando → `estimated_rtk_db` (cacheado 30s)
  3. Fallback `applyFallback(outputTokens)` con ratio 0.7 → `estimated_rtk_fallback`
  El fallback NO sobrescribe el tag `measured_rtk_rewrite` (preserva la
  señal "hubo rewrite") pero sí rellena `shadow_delta_tokens` para que xray
  calcule factor propio.

- **Retrospectivo** (`scripts/backfill-serena-shadow.mjs`): script one-off
  que recupera `shadow_delta_tokens` para filas serena antiguas usando el
  `command_preview` y el tamaño actual de los archivos. Propaga a la mirror
  de xray por `input_hash` (requiere xray schema v6+).

### Measurement honesty invariants

Every code path that touches tokens SHALL tag its source with an `estimation_method`. The CLI `report` always emits `Resumen: Medido: X tokens · Estimado: Y tokens`. Public savings claims come from `src/coach/reference-data.ts` tagged `reference_measured` with `verified_at` dates. Stale rows (>90 days) flagged via `getStaleRows()`.
