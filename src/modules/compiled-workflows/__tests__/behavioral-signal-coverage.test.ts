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
  let omitClauseSection: string

  beforeAll(async () => {
    promptContent = await readFile(promptPath, 'utf-8')
    behavioralSignalSection = promptContent.match(/\*\*Behavioral signals[^\n]+/)?.[0] ?? ''
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
