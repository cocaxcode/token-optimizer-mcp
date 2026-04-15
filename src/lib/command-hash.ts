// Shared command hashing used by the PreToolUse and PostToolUse hooks to
// correlate a Bash call across the two hook invocations. PreToolUse writes a
// mark under this hash when it rewrites a command via rtk; PostToolUse looks
// up the hash to reclassify the event as source=rtk.
//
// The hash must be identical in both hooks for any single command. We normalise
// whitespace so that trivial differences (trailing newline, tab padding) don't
// break the match, but otherwise pass the command through verbatim.

import crypto from 'node:crypto'

export function hashCommand(command: string): string {
  const normalised = command.trim().replace(/\s+/g, ' ')
  return crypto.createHash('sha256').update(normalised).digest('hex').slice(0, 16)
}
