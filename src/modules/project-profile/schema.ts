/**
 * Project Profile module Zod validation schemas.
 *
 * Provides runtime validation for ProjectProfile objects loaded from
 * `.substrate/project-profile.yaml` override files.
 */

import { z } from 'zod'

/** Zod schema for the Language union type. */
export const LanguageSchema = z.enum([
  'typescript',
  'javascript',
  'go',
  'java',
  'kotlin',
  'rust',
  'python',
])

/** Zod schema for the BuildTool union type. */
export const BuildToolSchema = z.enum([
  'npm',
  'pnpm',
  'yarn',
  'bun',
  'go',
  'gradle',
  'maven',
  'cargo',
  'poetry',
  'pip',
  'uv',
  'turborepo',
])

/** Zod schema for a single package entry in a monorepo. */
export const PackageEntrySchema = z.object({
  path: z.string(),
  language: LanguageSchema,
  buildTool: BuildToolSchema.optional(),
  framework: z.string().optional(),
  tools: z.array(z.string()).optional(),
  buildCommand: z.string().optional(),
  testCommand: z.string().optional(),
  installCommand: z.string().optional(),
})

/** Zod schema for the full ProjectProfile object. */
export const ProjectProfileSchema = z.object({
  /**
   * A1.1 (acceptance-gate): operator-authored acceptance contract. The
   * canonical schema + parser live in `@substrate-ai/sdlc`
   * (`AcceptanceContractSchema`, packages/sdlc/src/acceptance/contract.ts)
   * and read the COMMITTED profile via `git show` — this passthrough only
   * keeps the block legal here so profile tooling never strips or rejects
   * it. Do not duplicate the shape (dual-schema drift, the Epic 79 lesson).
   */
  acceptance: z.unknown().optional(),
  project: z.object({
    type: z.enum(['single', 'monorepo']),
    tool: z.enum(['turborepo']).nullable().optional(),
    language: LanguageSchema.optional(),
    buildTool: BuildToolSchema.optional(),
    framework: z.string().optional(),
    buildCommand: z.string(),
    testCommand: z.string(),
    installCommand: z.string().optional(),
    packages: z.array(PackageEntrySchema).optional(),
  }),
})
