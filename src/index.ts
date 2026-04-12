// token-optimizer-mcp entry point — Phase 1.12 + 1.14
// Routes: --mcp (MCP stdio server), --hook <kind>, or CLI subcommand (filled in Phase 4)

import { runPostToolUseHook } from './hooks/posttooluse.js'
import { runPreToolUseHook } from './hooks/pretooluse.js'
import { runSessionStartHook } from './hooks/sessionstart.js'

const args = process.argv.slice(2)

function printUsage(): void {
  console.error(
    'token-optimizer-mcp v0.1.0 — use --mcp, --hook <pretooluse|posttooluse|sessionstart>, or a subcommand',
  )
}

if (args.length === 0) {
  printUsage()
  process.exit(0)
}

const first = args[0]

if (first === '--hook') {
  const kind = args[1]
  switch (kind) {
    case 'posttooluse':
      runPostToolUseHook()
      process.exit(0)
      break
    case 'pretooluse':
      runPreToolUseHook()
      process.exit(0)
      break
    case 'sessionstart':
      runSessionStartHook()
      process.exit(0)
      break
    default:
      console.error(`Unknown hook: ${kind ?? '(none)'}`)
      process.exit(1)
  }
}

if (first === '--mcp') {
  const { StdioServerTransport } = await import('@modelcontextprotocol/sdk/server/stdio.js')
  const { createServer } = await import('./server.js')
  const server = createServer()
  const transport = new StdioServerTransport()
  await server.connect(transport)
  // Block until stdin closes
  await new Promise<void>((resolve) => {
    process.stdin.on('close', () => resolve())
    process.stdin.on('end', () => resolve())
  })
  process.exit(0)
}

// CLI subcommands — Phase 4.9
const { dispatchCli } = await import('./cli/dispatcher.js')
const exitCode = await dispatchCli(args)
process.exit(exitCode)
