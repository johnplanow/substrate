# Story 64.3: create-story regression-coverage gap closure

## Story

As a substrate pipeline developer,
I want fixture-based AC pattern tests that verify the create-story prompt's behavioral-signal guidance covers each enumerated signal phrase,
so that obs_017-class regressions — state-integrating TypeScript/JS stories shipping without probes because the prompt's omit clause was too broad — are caught deterministically by the test suite before reaching production.

## Acceptance Criteria

<!-- source-ac-hash: 710de399223ce75fed242f944889c01f47e7097074dc9b747866a2735e4fc661 -->

1. New test suite (or extension of `create-story.test.ts`):
   `behavioral-signal-coverage.test.ts` or similar.
2. Positive cases: AC text fixtures containing each phrase trigger the
   prompt's behavioral-signal section. Phrases: `execSync`, `spawn`,
   `child_process`, `git log`, `git push`, `git merge`,
   `path.join(homedir(), ...)`, `fs.readFile`, `fs.writeFile`,
   `fetch(`, `axios`, `Dolt`, `mysql`, `INSERT`, `SELECT`.
3. Negative cases: AC text fixtures with pure-function phrasing
   (`parse the input`, `format as JSON`, `sort by score`,
   `transform the array`) do NOT trigger probe-authoring guidance.
4. Each behavioral-signal phrase from Story 64-1's enumeration appears
   in at least one positive-case fixture.
5. obs_017 reproduction fixture: strata Story 2-4's actual AC text
   (paraphrased to avoid coupling) is a positive-case fixture.
6. Test methodology: static analysis (regex / substring assertion on
   rendered prompt + guidance section). No LLM dispatch.

## Tasks / Subtasks

- [ ] Task 1: Create `behavioral-signal-coverage.test.ts` in `src/modules/compiled-workflows/__tests__/` (AC: #1, #6)
  - [ ] Add file-read boilerplate: load `create-story.md` prompt from `packs/bmad/prompts/create-story.md` via `readFile` in `beforeAll`
  - [ ] Extract the behavioral-signal paragraph using a regex that captures from `**Behavioral signals` through the end of that sentence — store as `behavioralSignalSection`
  - [ ] Extract the omit clause paragraph using a regex that captures from `**Omit the` through the end of that sentence — store as `omitClauseSection`
  - [ ] Confirm no LLM dispatch or `runCreateStory` invocation is used anywhere in the file — static analysis only

- [ ] Task 2: Implement positive-case fixtures for subprocess, filesystem, and git signal phrases (AC: #2, #4)
  - [ ] Fixture + assertion for `execSync`: AC text "calls `execSync('git log --oneline', { cwd: repoRoot })` to retrieve commits"; assert `behavioralSignalSection` contains `execSync`
  - [ ] Fixture + assertion for `spawn`: AC text "uses `spawn('npm', ['run', 'build'])` to run the build subprocess"; assert `behavioralSignalSection` contains `spawn`
  - [ ] Fixture + assertion for `child_process`: AC text "imports `execFileSync` from `child_process` to invoke the CLI binary"; assert `behavioralSignalSection` contains `child_process`
  - [ ] Fixture + assertion for `git log`: AC text "runs `git log` to retrieve the last 30 commits"; assert `behavioralSignalSection` contains `git log`
  - [ ] Fixture + assertion for `git push`: AC text "executes `git push origin main` after committing the artifact"; assert `behavioralSignalSection` contains `git push`
  - [ ] Fixture + assertion for `git merge`: AC text "invokes `git merge --no-ff feature-branch` to integrate the story branch"; assert `behavioralSignalSection` contains `git merge`
  - [ ] Fixture + assertion for `path.join(homedir(), ...)`: AC text "reads the config file from `path.join(homedir(), '.config/substrate/config.json')`"; assert `behavioralSignalSection` contains `path.join(homedir()`
  - [ ] Fixture + assertion for `fs.readFile`: AC text "uses `fs.readFile` to load the story artifact at the given path"; assert `behavioralSignalSection` contains `fs.read`
  - [ ] Fixture + assertion for `fs.writeFile`: AC text "writes the rendered output via `fs.writeFile` to the project artifacts directory"; assert `behavioralSignalSection` contains `fs.write`

- [ ] Task 3: Implement positive-case fixtures for network, database, and SQL signal phrases (AC: #2, #4)
  - [ ] Fixture + assertion for `fetch(`: AC text "calls `fetch('https://api.example.com/briefings')` to retrieve the daily briefing"; assert `behavioralSignalSection` contains `fetch`
  - [ ] Fixture + assertion for `axios`: AC text "uses `axios.get(apiEndpoint)` to retrieve the fleet status"; assert `behavioralSignalSection` contains `axios`
  - [ ] Fixture + assertion for `Dolt`: AC text "queries the Dolt database using the SDLC adapter to retrieve pipeline run records"; assert `behavioralSignalSection` contains `Dolt`
  - [ ] Fixture + assertion for `mysql`: AC text "opens a mysql connection to the state store and reads per-story state rows"; assert `behavioralSignalSection` contains `mysql`
  - [ ] Fixture + assertion for `INSERT`: AC text "executes `INSERT INTO briefing_entries ...` against the mysql state store to persist the generated briefing"; assert `behavioralSignalSection` contains `mysql` (INSERT phrase appears in AC, database tool `mysql` covers the category in the prompt)
  - [ ] Fixture + assertion for `SELECT`: AC text "runs `SELECT * FROM pipeline_runs WHERE date > ?` against the Dolt database to retrieve recent runs"; assert `behavioralSignalSection` contains `Dolt` (SELECT phrase appears in AC, database tool `Dolt` covers the category in the prompt)

- [ ] Task 4: Implement negative-case fixtures and obs_017 reproduction (AC: #3, #5)
  - [ ] Negative fixture + assertion for `parse the input`: AC text "parses the input JSON string and extracts the story key field"; assert the fixture contains NONE of the phrases enumerated in `behavioralSignalSection` (i.e., no `execSync`, `spawn`, `child_process`, `git log`, `fs.read`, `fetch`, `axios`, `Dolt`, `mysql`)
  - [ ] Negative fixture + assertion for `format as JSON`: AC text "formats the internal record as JSON and returns it to the caller"; same negative assertion
  - [ ] Negative fixture + assertion for `sort by score`: AC text "sorts the candidate list by relevance score in descending order"; same negative assertion
  - [ ] Negative fixture + assertion for `transform the array`: AC text "transforms the input array of story keys into a flat list of AC identifiers"; same negative assertion
  - [ ] Verify negative phrases appear in the omit clause: assert `omitClauseSection` mentions `parse`, `format`, `sort`, and `score` or `calculate`
  - [ ] obs_017 reproduction fixture: AC text paraphrasing strata Story 2-4 — "calls `execSync('git log --oneline -30')` against each fleet repo root and attributes commits using substring match against known author patterns"; assert both `execSync` AND `git log` appear in `behavioralSignalSection` (covers both the subprocess and git-operations categories)

## Dev Notes

### Architecture Constraints

- **No LLM dispatch**: `runCreateStory` must NOT be called from `behavioral-signal-coverage.test.ts`. The test is purely static analysis of the prompt template file.
- **No mock setup**: Since there is no `runCreateStory` call, no `vi.mock` boilerplate for `adapter`, `dispatcher`, `pack`, or `contextCompiler` is needed. The test file imports only `readFile` (node:fs/promises) and vitest primitives.
- **Prompt path**: resolved relative to `import.meta.url` using `fileURLToPath` + `dirname` + `join`, matching the pattern in `create-story.test.ts` (lines 1872–1873). Target: `packs/bmad/prompts/create-story.md` relative to project root.
- **Test framework**: vitest only — no Jest. Import from `'vitest'`, not `'@jest/globals'`.

### File Paths

- New file: `src/modules/compiled-workflows/__tests__/behavioral-signal-coverage.test.ts`
- Prompt file read: `packs/bmad/prompts/create-story.md` (existing, updated in v0.20.42 / Story 64-1)
- Reference test for file-read pattern: `src/modules/compiled-workflows/__tests__/create-story.test.ts` lines 1871–1879

### Test Design: Behavioral-Signal Section Extraction

The behavioral-signal section is a single dense paragraph on one logical line in the prompt, starting with `**Behavioral signals`. Extract it with:

```typescript
const behavioralSignalSection = promptContent.match(
  /\*\*Behavioral signals[^\n]+/
)?.[0] ?? ''
```

This captures the entire enumeration: subprocess (`execSync`, `spawn`, `child_process`), filesystem (`fs.read*`, `fs.write*`, `path.join(homedir(), ...)`), git operations (`git log`, `git push`, `git merge`), database (Dolt, mysql, sqlite, postgres), network requests (`fetch`, `axios`, `http.get`), registry/configuration.

The omit clause is similarly a single line starting with `**Omit the`:

```typescript
const omitClauseSection = promptContent.match(
  /\*\*Omit the[^\n]+/
)?.[0] ?? ''
```

### Test Design: Positive-Case Assertion Pattern

For most phrases the assertion is direct:
```typescript
expect(behavioralSignalSection).toContain('execSync')
```

For `fs.readFile` and `fs.writeFile`, the prompt uses glob-style `fs.read*` and `fs.write*`, so assert on the prefix:
```typescript
expect(behavioralSignalSection).toContain('fs.read')   // covers fs.readFile, fs.readFileSync, fs.read*
expect(behavioralSignalSection).toContain('fs.write')  // covers fs.writeFile, fs.writeFileSync, fs.write*
```

For `INSERT` and `SELECT`, the prompt enumerates the database TECHNOLOGY (Dolt, mysql) rather than SQL keywords. The fixture AC text includes both the SQL keyword and the technology name. The assertion checks the technology name in the behavioral-signal section, confirming the database category covers SQL operations performed against those databases:
```typescript
// INSERT fixture: AC text includes both INSERT and mysql → mysql is the enumerated trigger
expect(acInsertFixture).toContain('mysql')
expect(behavioralSignalSection).toContain('mysql')

// SELECT fixture: AC text includes both SELECT and Dolt → Dolt is the enumerated trigger
expect(acSelectFixture).toContain('Dolt')
expect(behavioralSignalSection).toContain('Dolt')
```

### Test Design: Negative-Case Assertion Pattern

The negative-case test is a compound assertion: for each pure-function fixture, verify that NO phrase from the behavioral-signal enumeration appears in the fixture:

```typescript
const BEHAVIORAL_SIGNAL_TRIGGERS = [
  'execSync', 'spawn', 'child_process',
  'fs.read', 'fs.write', 'path.join(homedir',
  'git log', 'git push', 'git merge',
  'fetch', 'axios', 'http.get',
  'Dolt', 'mysql', 'sqlite', 'postgres',
]

function containsBehavioralSignal(acText: string): boolean {
  return BEHAVIORAL_SIGNAL_TRIGGERS.some(phrase => acText.includes(phrase))
}

// For each negative fixture:
expect(containsBehavioralSignal(acNegativeFixture)).toBe(false)
```

This is the correct inversion: a pure-function AC that doesn't mention any external-state interaction should not hit the behavioral-signal section.

### obs_017 Reproduction Fixture

The reproduction fixture paraphrases strata Story 2-4's exact failure shape (from `obs_2026-05-01_017`):
- Story 2-4 AC described a TypeScript function that called `execSync('git log')` against the fleet root
- This combination hits BOTH the subprocess category (`execSync`) AND the git-operations category (`git log`)
- The prior prompt's "TypeScript code + tests" omit clause would have missed both signals
- v0.20.42 (Story 64-1) rewrote the guidance to subordinate artifact-shape to behavioral signal

The fixture:
```
"calls execSync('git log --oneline -30') against each fleet repo root and attributes commits using substring match against known author patterns"
```

Asserts both `execSync` and `git log` appear in `behavioralSignalSection` — confirming the EXACT two signals the original story omitted.

### Testing Requirements

- Run `npm run test:fast` (unit tests only) to validate: ~50s. No e2e.
- Run `npm run test:changed` for tightest feedback during iteration.
- File produces no LLM dispatch mock setup — it's the simplest kind of test in the suite.
- Expected additions: ~14 positive cases + 4 negative cases + 1 obs_017 reproduction = ~19 `it()` blocks total (or similar grouping into compound tests — dev discretion).

## Dev Agent Record

### Agent Model Used
### Completion Notes List
### File List

## Change Log
