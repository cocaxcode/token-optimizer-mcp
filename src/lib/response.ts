// Shared MCP tool response helpers — Phase 2

export const text = (t: string) => ({
  content: [{ type: 'text' as const, text: t }],
})

export const error = (t: string) => ({
  content: [{ type: 'text' as const, text: `Error: ${t}` }],
  isError: true as const,
})
