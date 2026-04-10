/**
 * Project Profile module type definitions.
 *
 * Defines the TypeScript types for project profile detection and configuration.
 * These types describe a project's language stack, build system, and package
 * structure — used by downstream pipeline components (build gate, contract
 * verifier, test patterns, compiled workflows).
 */

/** Supported programming languages for project detection. */
export type Language = 'typescript' | 'javascript' | 'go' | 'java' | 'kotlin' | 'rust' | 'python'

/** Supported build tools for project detection. */
export type BuildTool =
  | 'npm'
  | 'pnpm'
  | 'yarn'
  | 'bun'
  | 'go'
  | 'gradle'
  | 'maven'
  | 'cargo'
  | 'poetry'
  | 'pip'
  | 'turborepo'

/**
 * Represents a single package in a monorepo.
 * The `path` field is relative to the project root (e.g., `apps/lock-service`).
 */
export interface PackageEntry {
  /** Relative path from project root, e.g. "apps/lock-service" */
  path: string
  language: Language
  buildTool?: BuildTool
  /** Optional framework identifier, e.g. "nextjs", "node" */
  framework?: string
  /** Optional tool identifiers, e.g. ["prisma", "flyway"] */
  tools?: string[]
  /** Per-package build command override */
  buildCommand?: string
  /** Per-package test command override */
  testCommand?: string
  /** Per-package install command override */
  installCommand?: string
}

/**
 * The full project profile, describing the project's type, build system,
 * and (for monorepos) individual package entries.
 */
export interface ProjectProfile {
  project: {
    /** Whether this is a single-package or monorepo project */
    type: 'single' | 'monorepo'
    /** The monorepo tool used (if any) */
    tool?: 'turborepo' | null
    /** Primary language for single projects */
    language?: Language
    /** Primary build tool for single projects */
    buildTool?: BuildTool
    /** Framework identifier for single projects, e.g. "nextjs", "node" */
    framework?: string
    /** Root-level build command */
    buildCommand: string
    /** Root-level test command */
    testCommand: string
    /** Root-level install command for adding new dependencies */
    installCommand?: string
    /** Package entries (populated for monorepos) */
    packages?: PackageEntry[]
  }
}
