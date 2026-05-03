/**
 * Fixture-based AC pattern tests that verify the create-story prompt's
 * behavioral-signal guidance covers each enumerated signal phrase.
 *
 * Purpose: catch obs_017-class regressions — state-integrating TypeScript/JS
 * stories shipping without probes because the prompt's omit clause was too
 * broad — deterministically, without LLM dispatch.
 *
 * Test methodology: static analysis (regex / substring assertion on rendered
 * prompt + guidance section). No LLM dispatch.
 */

import { describe, it, expect, beforeAll } from 'vitest'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const BEHAVIORAL_SIGNAL_TRIGGERS = [
  'execSync',
  'spawn',
  'child_process',
  'fs.read',
  'fs.write',
  'path.join(homedir',
  'git log',
  'git push',
  'git merge',
  'fetch',
  'axios',
  'http.get',
  'Dolt',
  'mysql',
  'sqlite',
  'postgres',
]

function containsBehavioralSignal(acText: string): boolean {
  return BEHAVIORAL_SIGNAL_TRIGGERS.some(phrase => acText.includes(phrase))
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe('Story 64-3: behavioral-signal coverage in create-story prompt', () => {
  const __dirname = dirname(fileURLToPath(import.meta.url))
  const promptPath = join(__dirname, '..', '..', '..', '..', 'packs', 'bmad', 'prompts', 'create-story.md')

  let promptContent: string
  let behavioralSignalSection: string
  let architecturalSignalSection: string
  let omitClauseSection: string

  beforeAll(async () => {
    promptContent = await readFile(promptPath, 'utf-8')
    behavioralSignalSection = promptContent.match(/\*\*Behavioral signals[^\n]+/)?.[0] ?? ''
    // Phase 4 (obs_2026-05-01_017 reopen) — architectural-level signals paragraph,
    // captured through the bullet list so phrase-example assertions can check it.
    architecturalSignalSection =
      promptContent.match(/\*\*Architectural-level signals[\s\S]+?(?=\n\nThe decision rule)/)?.[0] ?? ''
    omitClauseSection = promptContent.match(/\*\*Omit the[^\n]+/)?.[0] ?? ''
  })

  // -------------------------------------------------------------------------
  // Section extraction sanity checks
  // -------------------------------------------------------------------------

  it('AC1/#6: behavioral-signal section is non-empty (prompt loads and section exists)', () => {
    expect(behavioralSignalSection.length).toBeGreaterThan(0)
  })

  it('AC1/#6: omit-clause section is non-empty (prompt loads and section exists)', () => {
    expect(omitClauseSection.length).toBeGreaterThan(0)
  })

  // -------------------------------------------------------------------------
  // Positive cases — subprocess signals (AC2, AC4)
  // -------------------------------------------------------------------------

  describe('positive cases: subprocess signals', () => {
    it('AC2: execSync — "calls execSync(\'git log --oneline\', { cwd: repoRoot }) to retrieve commits"', () => {
      const acText = "calls `execSync('git log --oneline', { cwd: repoRoot })` to retrieve commits"
      expect(acText).toContain('execSync')
      expect(behavioralSignalSection).toContain('execSync')
    })

    it('AC2: spawn — "uses spawn(\'npm\', [\'run\', \'build\']) to run the build subprocess"', () => {
      const acText = "uses `spawn('npm', ['run', 'build'])` to run the build subprocess"
      expect(acText).toContain('spawn')
      expect(behavioralSignalSection).toContain('spawn')
    })

    it('AC2: child_process — "imports execFileSync from child_process to invoke the CLI binary"', () => {
      const acText = 'imports `execFileSync` from `child_process` to invoke the CLI binary'
      expect(acText).toContain('child_process')
      expect(behavioralSignalSection).toContain('child_process')
    })
  })

  // -------------------------------------------------------------------------
  // Positive cases — git operation signals (AC2, AC4)
  // -------------------------------------------------------------------------

  describe('positive cases: git operation signals', () => {
    it('AC2: git log — "runs git log to retrieve the last 30 commits"', () => {
      const acText = 'runs `git log` to retrieve the last 30 commits'
      expect(acText).toContain('git log')
      expect(behavioralSignalSection).toContain('git log')
    })

    it('AC2: git push — "executes git push origin main after committing the artifact"', () => {
      const acText = 'executes `git push origin main` after committing the artifact'
      expect(acText).toContain('git push')
      expect(behavioralSignalSection).toContain('git push')
    })

    it('AC2: git merge — "invokes git merge --no-ff feature-branch to integrate the story branch"', () => {
      const acText = 'invokes `git merge --no-ff feature-branch` to integrate the story branch'
      expect(acText).toContain('git merge')
      expect(behavioralSignalSection).toContain('git merge')
    })
  })

  // -------------------------------------------------------------------------
  // Positive cases — filesystem signals (AC2, AC4)
  // -------------------------------------------------------------------------

  describe('positive cases: filesystem signals', () => {
    it('AC2: path.join(homedir(), ...) — "reads the config file from path.join(homedir(), \'.config/substrate/config.json\')"', () => {
      const acText = "reads the config file from `path.join(homedir(), '.config/substrate/config.json')`"
      expect(acText).toContain('path.join(homedir()')
      expect(behavioralSignalSection).toContain('path.join(homedir()')
    })

    it('AC2: fs.readFile — "uses fs.readFile to load the story artifact at the given path"', () => {
      const acText = 'uses `fs.readFile` to load the story artifact at the given path'
      expect(acText).toContain('fs.readFile')
      expect(behavioralSignalSection).toContain('fs.read')
    })

    it('AC2: fs.writeFile — "writes the rendered output via fs.writeFile to the project artifacts directory"', () => {
      const acText = 'writes the rendered output via `fs.writeFile` to the project artifacts directory'
      expect(acText).toContain('fs.writeFile')
      expect(behavioralSignalSection).toContain('fs.write')
    })
  })

  // -------------------------------------------------------------------------
  // Positive cases — network signals (AC2, AC4)
  // -------------------------------------------------------------------------

  describe('positive cases: network signals', () => {
    it('AC2: fetch( — "calls fetch(\'https://api.example.com/briefings\') to retrieve the daily briefing"', () => {
      const acText = "calls `fetch('https://api.example.com/briefings')` to retrieve the daily briefing"
      expect(acText).toContain('fetch(')
      expect(behavioralSignalSection).toContain('fetch')
    })

    it('AC2: axios — "uses axios.get(apiEndpoint) to retrieve the fleet status"', () => {
      const acText = 'uses `axios.get(apiEndpoint)` to retrieve the fleet status'
      expect(acText).toContain('axios')
      expect(behavioralSignalSection).toContain('axios')
    })
  })

  // -------------------------------------------------------------------------
  // Positive cases — database signals (AC2, AC4)
  // -------------------------------------------------------------------------

  describe('positive cases: database signals', () => {
    it('AC2: Dolt — "queries the Dolt database using the SDLC adapter to retrieve pipeline run records"', () => {
      const acText = 'queries the Dolt database using the SDLC adapter to retrieve pipeline run records'
      expect(acText).toContain('Dolt')
      expect(behavioralSignalSection).toContain('Dolt')
    })

    it('AC2: mysql — "opens a mysql connection to the state store and reads per-story state rows"', () => {
      const acText = 'opens a mysql connection to the state store and reads per-story state rows'
      expect(acText).toContain('mysql')
      expect(behavioralSignalSection).toContain('mysql')
    })

    it('AC2: INSERT (mysql category covers SQL) — "executes INSERT INTO briefing_entries ... against the mysql state store"', () => {
      const acInsertFixture = 'executes `INSERT INTO briefing_entries ...` against the mysql state store to persist the generated briefing'
      // INSERT appears in AC text; mysql is the enumerated technology that covers SQL DML
      expect(acInsertFixture).toContain('mysql')
      expect(behavioralSignalSection).toContain('mysql')
    })

    it('AC2: SELECT (Dolt category covers SQL) — "runs SELECT * FROM pipeline_runs WHERE date > ? against the Dolt database"', () => {
      const acSelectFixture = 'runs `SELECT * FROM pipeline_runs WHERE date > ?` against the Dolt database to retrieve recent runs'
      // SELECT appears in AC text; Dolt is the enumerated technology that covers SQL DML
      expect(acSelectFixture).toContain('Dolt')
      expect(behavioralSignalSection).toContain('Dolt')
    })
  })

  // -------------------------------------------------------------------------
  // Negative cases — pure-function phrasing must NOT trigger signals (AC3)
  // -------------------------------------------------------------------------

  describe('negative cases: pure-function phrasing', () => {
    it('AC3: "parse the input" — pure-function fixture contains no behavioral-signal trigger', () => {
      const acNegativeFixture = 'parses the input JSON string and extracts the story key field'
      expect(containsBehavioralSignal(acNegativeFixture)).toBe(false)
    })

    it('AC3: "format as JSON" — pure-function fixture contains no behavioral-signal trigger', () => {
      const acNegativeFixture = 'formats the internal record as JSON and returns it to the caller'
      expect(containsBehavioralSignal(acNegativeFixture)).toBe(false)
    })

    it('AC3: "sort by score" — pure-function fixture contains no behavioral-signal trigger', () => {
      const acNegativeFixture = 'sorts the candidate list by relevance score in descending order'
      expect(containsBehavioralSignal(acNegativeFixture)).toBe(false)
    })

    it('AC3: "transform the array" — pure-function fixture contains no behavioral-signal trigger', () => {
      const acNegativeFixture = 'transforms the input array of story keys into a flat list of AC identifiers'
      expect(containsBehavioralSignal(acNegativeFixture)).toBe(false)
    })

    it('AC3: negative phrases appear in omit clause (parse, format, sort, score/calculate)', () => {
      expect(omitClauseSection).toContain('parse')
      expect(omitClauseSection).toContain('format')
      expect(omitClauseSection).toContain('sort')
      // The omit clause enumerates "score" or "calculate" — either satisfies the AC
      const hasScoreOrCalculate =
        omitClauseSection.includes('score') || omitClauseSection.includes('calculate')
      expect(hasScoreOrCalculate).toBe(true)
    })
  })

  // -------------------------------------------------------------------------
  // Phase 4 — architectural-level signals (obs_2026-05-01_017 reopen 2026-05-02)
  // -------------------------------------------------------------------------
  //
  // Story 2-7 dispatched under verified v0.20.43 still omitted the probes
  // section because its ACs used architectural-level phrasing ("queries
  // agent-mesh's skill", "publishes via outbox") that didn't match the
  // code-API enumeration. Phase 4 extends the prompt with architectural
  // patterns alongside code-API patterns. These tests pin the new section
  // is present and covers the verb / dependency-type vocabulary needed.

  describe('Phase 4: architectural-level signals section', () => {
    it('Phase 4: architectural-level signals section is non-empty', () => {
      expect(architecturalSignalSection.length).toBeGreaterThan(0)
    })

    it('Phase 4: enumerates the named-external-dependency types', () => {
      // Each of these dependency-type words should appear in the
      // architectural-level signals section so the agent recognizes the
      // pattern when the AC names the dependency.
      const requiredDependencyTypes = [
        'service',
        'package',
        'agent',
        'skill',
        'mesh',
        'registry',
        'queue',
        'outbox',
        'store',
      ]
      for (const dep of requiredDependencyTypes) {
        expect(architecturalSignalSection).toContain(dep)
      }
    })

    it('Phase 4: enumerates the interaction-verb vocabulary', () => {
      // Each verb should appear so the AC author / classifier recognizes
      // the pattern in any direction (queries, publishes, consumes, etc.).
      const requiredVerbs = [
        'queries',
        'publishes',
        'consumes',
        'subscribes',
        'registers',
        'delegates',
      ]
      for (const verb of requiredVerbs) {
        expect(architecturalSignalSection).toContain(verb)
      }
    })

    it('Phase 4: includes the via-package-outbox phrase pattern (Story 2-7 reproduction)', () => {
      // The exact phrase shape from strata Story 2-7's AC text — naming a
      // package's outbox surface as the integration point.
      expect(architecturalSignalSection).toMatch(/via\s+<package>['']s/)
      expect(architecturalSignalSection.toLowerCase()).toContain('outbox')
    })

    it('Phase 4: cites Story 2-7 as the motivating incident', () => {
      // Per Story 60-4 / 60-10 / obs_017 incident-naming convention.
      expect(promptContent.toLowerCase()).toMatch(/strata\s+story\s+2-7|jarvis\s+morning\s+briefing\s+consumes/i)
      expect(promptContent).toContain('2026-05-02T23:05')
    })
  })

  describe('Phase 4: positive cases — architectural-level fixtures', () => {
    it('Phase 4: "queries agent-mesh\'s query-reports skill via MeshClient" — Story 2-7 phrase', () => {
      const acText = "queries agent-mesh's `query-reports` skill via `MeshClient` to fetch the daily RunReport records"
      // The AC contains architectural-level signals: named dependency
      // ("agent-mesh", "skill") + interaction verb ("queries").
      expect(acText).toContain('queries')
      expect(acText.toLowerCase()).toContain('skill')
      // The architectural-signal section in the prompt covers these patterns.
      expect(architecturalSignalSection).toContain('queries')
      expect(architecturalSignalSection).toContain('skill')
    })

    it('Phase 4: "publishes MorningBriefing via packages/mesh-agent\'s outbox" — Story 2-7 phrase', () => {
      const acText = "publishes a `MorningBriefing` mesh record via packages/mesh-agent's outbox"
      expect(acText).toContain('publishes')
      expect(acText.toLowerCase()).toContain('outbox')
      expect(architecturalSignalSection).toContain('publishes')
      expect(architecturalSignalSection).toContain('outbox')
    })

    it('Phase 4: "consumes the X skill from agent Y" — generic mesh-skill phrase', () => {
      const acText = 'consumes the `vision` skill from agent X to enrich the briefing'
      expect(acText).toContain('consumes')
      expect(architecturalSignalSection).toContain('consumes')
    })

    it('Phase 4: "graceful degradation when X unreachable" — implies real network round-trip', () => {
      const acText = 'graceful degradation when the mesh is unreachable'
      expect(acText).toMatch(/graceful degradation|unreachable/)
      // The phrase appears in the prompt's example list of architectural patterns.
      expect(architecturalSignalSection.toLowerCase()).toContain('graceful degradation')
    })
  })

  // -------------------------------------------------------------------------
  // obs_017 reproduction fixture (AC5)
  // -------------------------------------------------------------------------

  describe('obs_017 reproduction fixture', () => {
    it('AC5: strata Story 2-4 paraphrase — execSync + git log both appear in behavioral-signal section', () => {
      // Paraphrase of strata Story 2-4 AC: morning briefing generator called
      // execSync('git log --oneline') against each fleet repo root and attributed
      // commits via substring match. This hit BOTH subprocess AND git-operations
      // categories, yet the prior prompt's "TypeScript code + tests" omit clause
      // caused both signals to be missed. v0.20.42 / Story 64-1 fixed this.
      const obs017Fixture =
        "calls execSync('git log --oneline -30') against each fleet repo root and " +
        'attributes commits using substring match against known author patterns'

      // The fixture itself contains both triggers
      expect(obs017Fixture).toContain('execSync')
      expect(obs017Fixture).toContain('git log')

      // And both triggers appear in the behavioral-signal section of the prompt,
      // confirming the guidance now covers both categories
      expect(behavioralSignalSection).toContain('execSync')
      expect(behavioralSignalSection).toContain('git log')
    })
  })
})
