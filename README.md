# @cocaxcode/token-optimizer-mcp

> Capa de **orquestacion + observabilidad + coach** para optimizar tokens en Claude Code.

`token-optimizer-mcp` mide el uso de herramientas, fuerza presupuestos de tokens, recomienda instalar herramientas complementarias (serena, RTK) cuando detecta que ayudarian, y sugiere activamente tips que Claude Code ya soporta pero que el agente a veces no usa (`/opusplan`, `/compact`, plan mode, migrar CLAUDE.md a skills, etc.).

**No reemplaza** a serena-mcp (lecturas simbolicas LSP) ni a RTK (filtrado de Bash). **Coordina** con ellas y suma medicion honesta, presupuestos, recuperacion tras compactacion, busqueda de sesion y coaching activo.

## Caracteristicas

- **Medicion honesta**: cada evento lleva un `estimation_method` (`measured_exact`, `estimated_cumulative`, `estimated_serena_shadow`, `estimated_rtk_db`, ...). Los reportes siempre separan **Medido** de **Estimado**.
- **Presupuestos con precedencia**: `session > project` con modos `warn` (avisa) y `block` (bloquea Bash sobre el limite).
- **Coach activo**: 18 tips hardcodeados + 11 reglas de deteccion sobre eventos recientes + medidor de contexto con 3 fuentes (transcript JSONL → xray → estimacion acumulada).
- **prune-mcp activo**: genera allowlists desde el historial, los aplica a `settings.local.json` con backup + rollback + impact comparison.
- **13 MCP tools + 9 CLI subcommands + 3 hooks** (PreToolUse, PostToolUse, SessionStart:compact).

## Instalacion rapida

```bash
# instala el MCP + los 3 hooks en ~/.claude/settings.json
npx @cocaxcode/token-optimizer-mcp install

# comprueba que todo esta bien (y ve sugerencias de instalacion de serena/RTK)
npx @cocaxcode/token-optimizer-mcp doctor

# ver el estado
npx @cocaxcode/token-optimizer-mcp status
```

El comando `install` es idempotente: re-instalarlo no duplica hooks. Preserva handlers pre-existentes (coexiste con RTK).

## CLI reference

| Subcomando | Descripcion |
|---|---|
| `install` | Registra MCP server + 3 hooks + storage global/proyecto |
| `uninstall [--purge --confirm]` | Quita entradas; `--purge --confirm` borra tambien storage |
| `doctor` | Ejecuta las 4 probes + schema measurer + advisor (siempre exit 0) |
| `status` | Detect install, DB path, eventos hoy, tokens por fuente, budget activo |
| `report [--period=session\|day\|week\|month]` | Reporte con **Medido vs Estimado** y tabla de referencia publica |
| `budget set <session\|project> <limit> [--mode=warn\|block]` | Define presupuesto |
| `budget get` / `budget clear` | Consulta / elimina |
| `prune-mcp [--generate-from-history\|--apply\|--rollback\|--clear\|--impact]` | Gestion del allowlist de MCPs |
| `coach status\|list\|explain <tip_id>\|reset` | Coach activo: ver tips, detalles, reset del log |
| `config get\|set <key> <value>` | Lee/escribe `~/.token-optimizer/config.json` con dotted keys |

## MCP tools (13 tools)

**Presupuestos** (3): `budget_set`, `budget_check`, `budget_report`

**Sesion** (1): `session_search` — FTS5 BM25 sobre los eventos

**Orquestacion** (7):
- `mcp_usage_stats` / `mcp_cost_report` — estadisticas y rango Sonnet-Opus
- `optimization_status` — detecciones + prompt_caching con `estimation_method: "unknown"` honesto
- `mcp_prune_suggest` / `mcp_prune_apply` / `mcp_prune_rollback` / `mcp_prune_clear` — gestion del allowlist MCP; **las destructivas requieren `confirm: true`**

**Coach** (1): `coach_tips` — devuelve `{current, known_tricks, context, reference_data}`

**TOON** (2): `toon_encode` / `toon_decode` — wrappers para encoding compacto round-trip lossless

## Hooks

| Hook | Matcher | Accion |
|---|---|---|
| `PreToolUse` | `Bash` | Chequea presupuesto: passthrough / `additionalContext` / `decision: block`. **Nunca toca `updatedInput`** (coexiste con RTK). |
| `PostToolUse` | `*` | Enqueue async a SQLite + fire-and-forget a xray si `XRAY_URL` set. Target p95 ≤10ms. |
| `SessionStart` | `compact` | Inyecta markdown con archivos recientes, comandos, presupuesto, contexto relevante. Token-cap 2000. |

## Coach layer

El coach combina un **catalogo estatico** de 18 tips con un **detector dinamico** de 11 reglas sobre los ultimos eventos. Salida via MCP tool `coach_tips` o CLI `coach status`.

### 18 tips en el knowledge base

Modelo/modo: `use-opusplan`, `use-plan-mode`, `use-fast-mode`, `default-to-sonnet`, `use-haiku-for-simple`
Contexto: `use-compact-long-session`, `use-clear-rename-resume`, `use-sessionstart-compact-hook`, `use-memory-save`
Herramientas: `use-agent-explore`, `use-todowrite-long-task`, `use-skill-trigger`, `install-serena`, `install-rtk`
Configuracion: `use-mcp-prune`, `migrate-claudemd-to-skills`, `use-settings-local`, `use-prompt-caching`

### 11 reglas de deteccion

`detect-context-threshold` (50/75/90%), `detect-long-reasoning-no-code`, `detect-repeated-searches`, `detect-huge-file-reads`, `detect-many-bash-commands`, `detect-unused-mcp-servers` (stub), `detect-clear-opportunity`, `detect-opus-for-simple-task`, `detect-claudemd-bloat` (stub), `detect-post-milestone-opportunity`, `detect-skill-trigger-ignored` (stub).

### Medidor de contexto (3 fuentes)

1. **Transcript JSONL** — `~/.claude/projects/{project-key}/{sessionId}.jsonl` → `estimation_method: measured_exact`
2. **Xray HTTP** — si `XRAY_URL` esta set, `GET /sessions/{id}/tokens` con timeout 300ms → `measured_exact`
3. **Acumulativo DB** — fallback: `SUM(tokens_estimated) + 15000 baseline` → `estimated_cumulative`

## Medicion honesta (measurement-honesty addendum)

Cada evento en `tool_calls` lleva un `estimation_method` desde el dia uno:

- `measured_exact` — contabilizado directamente desde la herramienta (builtin, own, mcp, xray)
- `estimated_rtk_db` / `estimated_rtk_marker` / `estimated_rtk_fallback` — con confianza decreciente
- `estimated_serena_shadow` / `estimated_serena_fallback` — con/sin medicion activa via fs.stat
- `estimated_cumulative` — fallback del coach context meter
- `reference_measured` — datos publicos verificables en la tabla de referencia
- `unknown` — sin fuente autoritativa

El reporte (`token-optimizer-mcp report`) siempre incluye la linea `Resumen: Medido: X tokens · Estimado: Y tokens`.

### Tabla de referencia publica (verified 2026-04-11)

| Feature | Ahorro | Fuente |
|---|---|---|
| Model switching (opusplan / default-to-sonnet) | 60-80% | mindstudio.ai, verdent.ai, claudelab.net |
| Progressive disclosure skills | ~15k tokens/sesion | claudefast.com |
| Prompt caching read hit | 10x mas barato | Anthropic docs |
| Claude Code Tool Search nativo | ~85% schema reduction (77k→8.7k) | observado |
| MCP pruning sobre Tool Search | ~5-12% por turno | estimacion interna |

## Sobre las herramientas recomendadas

### serena-mcp

- **Que hace**: lecturas simbolicas LSP (ahorra 20-30% en archivos grandes)
- **Instalacion**: `uvx --from git+https://github.com/oraios/serena serena start-mcp-server`
- **Seguridad**: serena incluye `execute_shell_command` entre sus tools. Revisa la configuracion antes de habilitar; considera restricciones a nivel de sistema operativo si no confias.

### RTK

- **Que hace**: filtra output ruidoso de Bash (builds, tests) antes de que llegue a Claude Code (ahorra 15-25% en ciclos build/test)
- **Instalacion**: `brew install standard-input/tap/rtk` (macOS) o binario firmado en github.com/standard-input/rtk
- **Seguridad**: RTK publica releases firmadas con GPG. Binario compilado en Rust.

**token-optimizer-mcp NO instala estas herramientas automaticamente.** `doctor` las detecta y sugiere comandos, pero la decision es del usuario.

## Configuracion

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

Para cambiar valores con dotted-key:

```bash
npx @cocaxcode/token-optimizer-mcp config set coach.enabled false
npx @cocaxcode/token-optimizer-mcp config set shadow_measurement.serena true
```

## Scopes de settings (importante)

| Archivo | Scope | Tracked en git | Usado por |
|---|---|---|---|
| `~/.claude/settings.json` | Global (usuario) | - | `install` escribe aqui |
| `{proyecto}/.claude/settings.json` | Proyecto (equipo) | si | Detector lo lee |
| `{proyecto}/.claude/settings.local.json` | Proyecto (personal) | gitignored | `prune-mcp apply` escribe aqui |

El allowlist de MCP pruning va a `settings.local.json` (personal, gitignored) para no afectar al equipo.

## Rollback story

Cada operacion destructiva de `prune-mcp` crea un backup con timestamp ISO:

```bash
# Apply con backup automatico
npx @cocaxcode/token-optimizer-mcp prune-mcp --apply

# Restaura el ultimo backup
npx @cocaxcode/token-optimizer-mcp prune-mcp --rollback

# Restaura uno especifico
npx @cocaxcode/token-optimizer-mcp prune-mcp --rollback --to=2026-04-12T05-30-00-000Z

# Compara promedios antes/despues
npx @cocaxcode/token-optimizer-mcp prune-mcp --impact
```

Cada snapshot se registra en `optimization_snapshots` para trazabilidad.

## Integracion con xray

Si tienes xray corriendo, exporta `XRAY_URL=http://localhost:PORT`. El hook `PostToolUse` hara fire-and-forget a `/hooks/token-optimizer` y el coach context meter usara `/sessions/{id}/tokens` como fuente primaria (`measured_exact`).

Todas las llamadas a xray son **silenciosas en fallo** (no stderr, no throw, no bloqueo del hook).

## Arquitectura

```
src/
├── index.ts              # Entry (shebang) — --mcp | --hook X | subcomando
├── server.ts             # createServer factory con 13 tools
├── cli/                  # install, uninstall, doctor, status, report, budget,
│                         #   prune-mcp, coach, config, dispatcher
├── hooks/                # pretooluse (bash budget), posttooluse (async analytics),
│                         #   sessionstart (compact reinjection)
├── tools/                # budget, session, orchestration, coach, toon
├── services/             # analytics-logger, budget-manager, session-retriever,
│                         #   stats, rtk-reader, serena-shadow, xray-client
├── orchestration/        # detector (probes), schema-measurer, advisor
├── coach/                # knowledge-base (18), rules (11), detector, context-meter,
│                         #   reference-data, surface (dedupe)
├── lib/                  # types, paths, storage, token-estimator, response
└── db/                   # schema (SQL DDL), connection (WAL), queries
```

## Desarrollo

```bash
npm install
npm run build       # tsup, 2 entries (cli con shebang + server como lib)
npm run test        # vitest, 238 tests
npm run typecheck
npm run lint
npm run inspector   # MCP Inspector
```

### Stack

TypeScript 5 strict ESM · `@modelcontextprotocol/sdk` ^1.27 · `better-sqlite3` ^11 (WAL + FTS5) · Zod 3.25 raw shapes · Vitest 3.2+ con InMemoryTransport · tsup · ESLint 9 flat config + Prettier

### Convenciones

- Strings de usuario en **espanol**; codigo, variables e imports en ingles
- `console.error()` UNICAMENTE (stdout reservado para JSON-RPC y hook output)
- Tool handlers siguen `try/catch → return error(...)` con envelope `{isError: true}`
- Operaciones destructivas requieren `confirm: true` (tests incluidos)

## Test suite

238 tests en 28 suites. Cobertura:

- **Phase 0** (sanity): 2
- **Phase 1** (core: types, paths, storage, token-estimator, schema, connection, queries, analytics-logger, posttooluse hook): 40
- **Phase 2** (budgets): 34
- **Phase 3** (compact & session search + column migration): 25
- **Phase 4.A-4.D** (detector, schema-measurer, advisor, stats, rtk-reader, serena-shadow, cli-install, cli-doctor, cli-report, cli-config): 64
- **Phase 4.E-4.H** (orchestration MCP tools, coach): 57
- **Phase 5** (xray-client, toon): 16

## Licencia

MIT © 2026 cocaxcode

## Disclaimer de fair use

Las cifras de ahorro en este README son estimaciones basadas en documentacion publica de Anthropic y reportes de la comunidad. El ahorro real en tu sesion depende de tu flujo de trabajo. Usa `token-optimizer-mcp report` para ver tu histograma real con split Medido/Estimado.
