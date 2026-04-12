// Advisory suggestions — Phase 4.3
// Takes an OptimizationStatus and returns Spanish actionable recommendations.

import type { OptimizationStatus } from '../lib/types.js'

export function buildSuggestions(status: OptimizationStatus): string[] {
  const suggestions: string[] = []

  if (!status.serena.present) {
    suggestions.push(
      [
        '[serena] Para lecturas simbolicas (menos tokens en archivos grandes), instala serena-mcp:',
        '  uvx --from git+https://github.com/oraios/serena serena start-mcp-server',
        '  Nota de seguridad: serena incluye execute_shell_command, revisa la configuracion.',
        '  Ahorro estimado: 20-30% en lecturas de archivos grandes.',
      ].join('\n'),
    )
  }

  if (!status.rtk.present) {
    suggestions.push(
      [
        '[rtk] Para filtrar salida ruidosa de Bash (builds, tests), instala RTK:',
        '  brew install standard-input/tap/rtk (macOS) o descarga binario firmado en github.com/standard-input/rtk',
        '  Nota de seguridad: RTK publica releases firmadas con GPG.',
        '  Ahorro estimado: 15-25% en ciclos build/test.',
      ].join('\n'),
    )
  }

  if (!status.mcp_pruning.present) {
    suggestions.push(
      [
        '[mcp-pruning] Reduce el coste de tool-schema activando un allowlist por proyecto:',
        '  Ejecuta mcp_prune_suggest para generar uno basado en tu historial y aplicalo con mcp_prune_apply.',
        '  Se escribe en .claude/settings.local.json (personal, no afecta al equipo).',
        '  Ahorro estimado: 5-12% por turno sobre el Tool Search nativo de Claude Code.',
      ].join('\n'),
    )
  }

  return suggestions
}
