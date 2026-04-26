// SessionStart hook entry — Phase 3.5
// Only acts on matcher === 'compact'. Other matchers exit silently with empty stdout.

import fs from 'node:fs'
import { getDb } from '../db/connection.js'
import { SessionRetriever } from '../services/session-retriever.js'
import {
  resolveProjectDir,
  resolveAnalyticsDbPath,
  projectHash,
} from '../lib/paths.js'
import { ensureStorageDir } from '../lib/storage.js'
import { renderReinjectionMarkdown } from '../services/session-retriever.js'
import { buildCoachSectionMarkdown } from '../coach/session-section.js'
import { loadConfig } from '../cli/config.js'
import { buildQueries } from '../db/queries.js'
import { probeSerena, probeRtk } from '../orchestration/detector.js'

export interface SessionStartInput {
  session_id?: string
  matcher?: 'startup' | 'resume' | 'compact' | string
}

export interface RunSessionStartOptions {
  stdin?: string
  dbPath?: string
  projectDir?: string
  writeStdout?: boolean
  budgetTokens?: number
  coachEnabled?: boolean
  coachMaxTips?: number
  coachDedupeWindowSeconds?: number
  coachDetectionLogEnabled?: boolean
  activeModel?: string
  home?: string
}

function readStdinSync(): string {
  try {
    return fs.readFileSync(0, 'utf8')
  } catch {
    return ''
  }
}

export async function runSessionStartHook(
  opts: RunSessionStartOptions = {},
): Promise<string> {
  const raw = opts.stdin ?? readStdinSync()
  let parsed: SessionStartInput = {}
  try {
    parsed = raw ? (JSON.parse(raw) as SessionStartInput) : {}
  } catch {
    // swallow
  }

  // Only emit content on compact matcher; stay silent otherwise
  if (parsed.matcher !== 'compact') {
    if (opts.writeStdout !== false) {
      process.stdout.write('')
    }
    return ''
  }

  const sessionId = parsed.session_id ?? 'default'
  let markdown = ''
  try {
    const projectDir = opts.projectDir ?? resolveProjectDir()
    let dbPath: string
    if (opts.dbPath !== undefined) {
      dbPath = opts.dbPath
    } else {
      ensureStorageDir(projectDir)
      dbPath = resolveAnalyticsDbPath(projectDir)
    }
    const db = getDb(dbPath)
    const queries = buildQueries(db)
    const retriever = new SessionRetriever(db)
    const serenaAvailable = probeSerena({ home: opts.home }).present
    const rtkAvailable = probeRtk({ home: opts.home }).present
    const payload = retriever.buildReinjectionPayload(
      sessionId,
      projectHash(projectDir),
      opts.budgetTokens ?? 2000,
      { serenaAvailable, rtkAvailable },
    )
    markdown = renderReinjectionMarkdown(payload)

    // Serena symbols section — re-inject recently touched symbols so the agent
    // knows which files were being read before compaction.
    try {
      const touches = queries.getRecentSerenaSymbols(sessionId, 15)
      if (touches.length > 0) {
        const lines = touches.map(({ tool_name, relative_path, name_path }) => {
          const symbol = name_path ? ` → \`${name_path}\`` : ''
          const tool = tool_name.replace('mcp__serena__', '')
          return `- \`${relative_path}\`${symbol} (${tool})`
        })
        const serenaSection =
          `## Símbolos Serena recientes\n` +
          `Estos archivos/símbolos fueron leídos antes del compacto:\n\n` +
          lines.join('\n')
        markdown = markdown ? `${markdown}\n\n${serenaSection}` : serenaSection
      }
    } catch {
      // Never block on this
    }

    // Coach section (Phase 4.H) — append tips when rules fire
    const cfg = loadConfig(opts.home)
    const coachEnabled = opts.coachEnabled ?? (cfg.coach.enabled && cfg.coach.auto_surface)
    if (coachEnabled) {
      const coachOpts: Parameters<typeof buildCoachSectionMarkdown>[0] = {
        db,
        sessionId,
        projectDir,
        maxTips: opts.coachMaxTips ?? cfg.coach.sessionstart_tips_max,
        dedupeWindowSeconds:
          opts.coachDedupeWindowSeconds ?? cfg.coach.dedupe_window_seconds,
        via: 'sessionstart',
        detectionLogEnabled:
          opts.coachDetectionLogEnabled ?? cfg.coach.detection_log_enabled,
      }
      if (opts.activeModel !== undefined) coachOpts.activeModel = opts.activeModel
      const coachResult = await buildCoachSectionMarkdown(coachOpts)
      if (coachResult.markdown) {
        markdown = markdown ? `${markdown}\n\n${coachResult.markdown}` : coachResult.markdown
      }
    }
  } catch {
    // Fall through with whatever markdown we managed to build; never throw from a hook
  }

  if (opts.writeStdout !== false) {
    process.stdout.write(markdown)
  }
  return markdown
}
