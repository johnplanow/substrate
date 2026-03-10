/**
 * Repo-map module — Zod schemas.
 */

import { z } from 'zod'

export const SymbolKindSchema = z.enum(['function', 'class', 'interface', 'type', 'enum', 'import'])

export const ParsedSymbolSchema = z.object({
  name: z.string(),
  kind: SymbolKindSchema,
  filePath: z.string(),
  lineNumber: z.number(),
  signature: z.string(),
  exported: z.boolean(),
})

export type ParsedSymbol = z.infer<typeof ParsedSymbolSchema>
