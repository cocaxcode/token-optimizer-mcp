// CLI subcommand dispatcher — Phase 4.9
// Routes argv[0] to the appropriate subcommand module (lazy-imported).

export async function dispatchCli(argv: string[]): Promise<number> {
  const [sub, ...rest] = argv
  switch (sub) {
    case 'install': {
      const mod = await import('./install.js')
      return mod.runInstall(rest)
    }
    case 'uninstall': {
      const mod = await import('./uninstall.js')
      return mod.runUninstall(rest)
    }
    case 'doctor': {
      const mod = await import('./doctor.js')
      return mod.runDoctor(rest)
    }
    case 'status': {
      const mod = await import('./status.js')
      return mod.runStatus(rest)
    }
    case 'report': {
      const mod = await import('./report.js')
      return mod.runReport(rest)
    }
    case 'budget': {
      const mod = await import('./budget.js')
      return mod.runBudgetCli(rest)
    }
    case 'config': {
      const mod = await import('./config.js')
      return mod.runConfigCommand(rest)
    }
    case 'prune-mcp': {
      const mod = await import('./prune-mcp.js')
      return mod.runPruneMcp(rest)
    }
    case 'coach': {
      const mod = await import('./coach.js')
      return mod.runCoachCli(rest)
    }
    default:
      console.error(`Subcomando desconocido: ${sub ?? '(ninguno)'}`)
      console.error(
        'Disponibles: install, uninstall, doctor, status, report, budget, prune-mcp, coach, config',
      )
      return 1
  }
}
