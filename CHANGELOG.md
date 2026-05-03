# Changelog

> **Authoritative log going forward**: this file became unmaintained between v0.9.0 (March 2026) and v0.20.41 (April 2026). For the missing window, the version-stamped entries in `~/.claude/projects/-home-jplanow-code-jplanow-substrate/memory/MEMORY.md` and `git log --oneline` are the authoritative record. The headline arcs are backfilled below; per-version detail lives in the memory entries and commit messages.

## [0.20.46] — 2026-05-03

### Feature: AnthropicAdapter.stream() — streaming parity for direct-LLM providers

`packages/factory/src/llm/providers/anthropic.ts` previously implemented `complete()` only; `stream()` threw `streaming not yet implemented`. v0.20.46 closes that TODO with a working SSE parser that maps Anthropic's Messages API streaming protocol (`message_start` / `content_block_start` / `content_block_delta` / `message_delta` / `message_stop`) to the package's `StreamEvent` shape (`text_delta`, `tool_call_delta`, `reasoning_delta`, `usage`, `message_stop`). All three direct-LLM providers (`anthropic`, `openai`, `gemini`) now implement streaming uniformly.

Empirically smoke-validated against the live Anthropic API (claude-haiku-4-5, 657ms round-trip, ~$0.0000 cost). +7 unit tests.

**Who is affected:** Callers of `factory-command` direct-backend with `provider: 'anthropic'` who invoke `.stream()` — previously crashed at runtime, now stream cleanly.

**Who is NOT affected:** Substrate's main dispatch path (CLI-based `claude-code` adapter handles streaming via NDJSON event protocol on its own subprocess; unchanged).

## [0.20.45] — 2026-05-03

### Feature: source-ac-fidelity dependency-context detection (closes obs_2026-05-02_020)

Source-ac-fidelity now detects path mentions inside dependency-context phrases (`via \`X\``, `via \`X\`'s outbox`, `imports from \`X\``, `consumes \`X\``, `built atop \`X\``, `\`X\`-shipped`, `using \`X\`'s`) and routes them to the new `source-ac-dependency-reference` info-severity finding category instead of the default `source-ac-drift` error path. Mirrors the obs_016 negation-context heuristic shape; new exported `detectDependencyContextLines(lines)` parallel to `detectNegationContextLines`.

This is the third false-positive class fix on source-ac-fidelity:

| Obs | Family | Version |
|---|---|---|
| obs_013 | alternative-options (`**(a)**`/`**(b)**`) | v0.20.24 |
| obs_016 | negation phrases (`(NOT replaced)`, `MUST NOT`) | v0.20.40 |
| obs_020 | dependency-context phrases (`via X`, `imports from X`) | v0.20.45 |

**Who is affected:** Stories whose ACs name peer-package directory paths under dependency-context phrases (common shape: "publish via \`packages/foo\`'s outbox") — previously hard-failed verification on under-delivery, now pass with info-severity reference finding.

## [0.20.42 / 0.20.43 / 0.20.44] — 2026-05-02 / 03

### Feature: obs_2026-05-01_017 three-phase fix-out — create-story probe-awareness for state-integrating ACs

obs_017 surfaced a substrate-side blind spot: TypeScript modules whose ACs require real fs / git / Dolt / network integration shipped SHIP_IT through every verification gate because the create-story prompt told the agent to omit `## Runtime Probes` for "TypeScript code + tests" without checking whether that code interacts with external state. Three layers shipped, each closing a separate facet:

- **v0.20.42 (Phase 1) — prompt-content layer**: `packs/bmad/prompts/create-story.md` replaces the artifact-shape omit clause with a behavioral-signal section enumerating 6 interaction categories (subprocess `execSync`/`spawn`, filesystem `fs.read*` against host paths, git operations, database, network `fetch`/`axios`, registry/config scans). Omit clause narrowed to purely-algorithmic modules only.

- **v0.20.43 (Phase 2) — frontmatter + gate layer (Epic 64)**: New `external_state_dependencies: [...]` story-frontmatter field (Zod-validated, open-enum strings). New `runtime-probe-missing-declared-probes` finding category in `runtime-probe-check.ts` — when frontmatter declares dependencies AND no probes section exists, escalates to `error` severity and hard-gates SHIP_IT. Mirrors obs_016's missing-Runtime-Probes escalation pattern.

- **v0.20.44 (Phase 4) — architectural-language layer**: After empirical smoke validation revealed that ACs phrased at architectural-abstraction level ("queries agent-mesh's skill via MeshClient", "publishes via outbox") didn't match the v0.20.42 code-API enumeration, Phase 4 added an "Architectural-level signals" paragraph parallel to the behavioral-signal one. Enumerates named-external-dependency types (service, package, agent, skill, mesh, registry, queue, outbox, store, daemon) + interaction verbs (queries, publishes, consumes, calls, writes-to, reads-from, subscribes, registers, delegates) + 6 phrase-pattern bullets.

Phase 3 (Epic 65, probe-author state-integrating dispatch) deferred behind eval-gate at Story 65-4 (≥75% catch rate target).

**Who is affected:** Story authors whose ACs describe state-integrating logic in TypeScript / JavaScript / Python — substrate now reliably prescribes runtime probes for these story classes regardless of which language the implementation ships in.

### Process: empirical prompt-edit smoke discipline (closes obs_2026-05-02_019)

Companion process fix: the `/ship` slash command (`.claude/commands/ship.md`) gained a conditional **Step 4.5** that triggers when staged changes touch `packs/bmad/prompts/*.md`. Dispatches a fixture epic via `npm run substrate:dev` and asserts the rendered story has the structural property the prompt change targets. Halts ship on assertion failure. CLAUDE.md gained a "Cross-Project Observation Lifecycle" section encoding reopen-evidence requirements (verify `substrate --version` before claiming "dispatched under vX.Y.Z").

## [0.20.31–0.20.41] — 2026-04-27 to 2026-04-29

### Feature: probe-author phase (Epic 60 — Phase 2, eval-validated)

Substrate gained a `probe-author` phase that derives `## Runtime Probes` sections from event-driven AC text via a separate dispatch (independent from create-story). Telemetry events: `probe-author:dispatched`, `probe-author:output-parsed`, `probe-author:appended-to-artifact`, `probe-author:skipped`, `probe-author:authored-probe-failed`. Probe-author probes carry an `_authoredBy: 'probe-author'` discriminator on `RuntimeProbe` / `StoredVerificationFinding` for KPI attribution.

A/B validation harness in v0.20.39 produced GREEN, 4/4 = 100% catch rate on the v1 defect corpus. v0.20.41 (Story 60-16) flipped `runtime-probe-missing-production-trigger` from warn → error severity, making missing-trigger detection a hard gate for event-driven ACs. New CLI surface: `substrate probe-author dispatch`, `substrate annotate`, `substrate metrics --probe-author-summary`.

**Who is affected:** Stories whose ACs describe event-driven mechanisms (git hooks, systemd timers, signal handlers, webhooks) — substrate now auto-derives production-trigger-invoking probes when create-story doesn't author them, and hard-fails verification when probes don't invoke a known production trigger.

### Feature: Epic 62 — code-review YAML output recovery (v0.20.33)

Code-review YAML parser auto-recovers from `bad indentation` errors by rewriting `<field>: <value-with-colon>` lines as block scalars (allowlist: description, message, error, notes, comment, finding, command, details, rationale, reason). New `orchestrator:code-review-output-malformed` event. Schema-validation failures don't burn retry budget.

### Feature: Epic 63 — runtime-probe error-shape auto-detection (v0.20.34)

Runtime-probe executor scans probe stdout for canonical error-envelope JSON shapes (`"isError": true`, `"status": "error"`) regardless of whether the author declared an assertion. New `runtime-probe-error-response` finding category. Closes obs_012.

### Feature: Sprint 21 — source-ac-fidelity negation-context detection (v0.20.40, obs_016)

Negation phrase detector marks paths inside paragraphs containing `(NOT replaced)`, `MUST NOT`, `documented (NOT`, `does NOT replace`, `deferred to`, `is gitignored` — routes path mentions to info-severity `source-ac-negation-reference` instead of error-severity `source-ac-drift`. Also: missing-Runtime-Probes escalates to error severity for event-driven ACs.

### Feature: Sprint 17 — verification + COMPLETE dedup (v0.20.35)

Three duplicated ~80-line verification + COMPLETE blocks collapsed into single `runVerificationAndComplete` helper. Net -86 lines.

## [0.20.0–0.20.30] — 2026-04-09 to 2026-04-26

### Library packaging arc

This window (~30 patch releases) shipped the npm packaging story, OIDC trusted publishing, dolt work-graph integration, story-scoped under-delivery detection, alpha-suffix story-key parsing, separator-tolerant story-section extraction, alternative-option detection, operational-path heuristic, manifest write serialization, retry-escalated terminal-run filtering, structured verification findings, and runtime verification gates. Per-version detail in MEMORY.md (versions v0.20.0 through v0.20.30) and `git log --oneline v0.20.0..v0.20.30`.

Headline arcs in this window:

- **Epic 41 (v0.20.0–v0.20.5)** — `@substrate-ai/core` package extraction, OIDC trusted publishing setup
- **Epic 55 (v0.20.5–v0.20.10)** — structured verification findings (severity + category instead of free-text)
- **Epic 56 (v0.20.7–v0.20.10)** — runtime verification gates (initial probe-awareness, probe execution against twin sandbox)
- **Epic 57 (v0.20.9)** — manifest write serialization (closes lost-update race in `RunManifest.patchStoryState`)
- **Epic 58 (v0.20.13–v0.20.20)** — source-ac-fidelity check + AC-preservation directive (`MUST` / `MUST NOT` / `SHALL` / path verbatim transfer)
- **Epic 31 (long-running)** — Dolt work-graph (`wg_stories`, `story_dependencies`, `ready_stories` view, cycle detection)
- **Story 60-7 (v0.20.28)** — operational-path heuristic (`.git/hooks/`, `/usr/local/bin/`, `~/...` paths emit info, not error)
- **Story 60-5 (v0.20.24)** — alternative-option group detection (`**(a)**` / `**(b)**` AC structures)

## [0.9.0] — 2026-03-22

### Feature: @substrate-ai/core package extraction (Epic 41)

The `@substrate-ai/core` npm workspace package now contains all general-purpose agent
infrastructure modules previously embedded in the Substrate monolith. Downstream packages
(SDLC, factory) can import from `@substrate-ai/core` without coupling to SDLC-specific types.

Stories 41-1 through 41-12 migrated the following module groups into `packages/core/src/`:
adapters, config, dispatch, events, git, persistence, routing, telemetry, supervisor, budget,
cost-tracker, monitor, and version-manager.

**Backward-compatibility shim strategy:** Every `src/` module in the monolith that was migrated
retains a thin re-export shim (e.g., `src/events/index.ts` re-exports from `@substrate-ai/core`)
so that existing internal import paths continue to resolve without modification. No call sites
outside `packages/core/` were changed.

**Who is affected:**
- Downstream packages that previously imported from `substrate-ai` internals and now want
  transport-agnostic types: import from `@substrate-ai/core` directly.
- CI and integration test environments: no change required — the shim layer is transparent.

**Who is NOT affected:**
- Existing CLI users — the `substrate` command behavior is unchanged.
- Projects importing from `substrate-ai` top-level exports — all public API surface is intact.

## [0.5.0] — 2026-03-14

### Breaking: Full SQLite removal — better-sqlite3 removed (Epic 29)

`better-sqlite3` and `@types/better-sqlite3` have been completely removed from the project. The `SqliteDatabaseAdapter`, `LegacySqliteAdapter`, all 11 SQLite migration files, and the WASM mock infrastructure have been deleted. The `backend: 'sqlite'` config option no longer exists.

**Who is affected:**
- Developers who called `createDatabaseAdapter({ backend: 'sqlite', ... })` — this backend has been removed entirely. Use `'auto'` or `'dolt'` instead.
- Users of `substrate monitor` and `substrate metrics` who relied on reading historical `.db` SQLite files — these commands now use Dolt (when available) or in-memory storage
- Any code importing from `src/persistence/sqlite-adapter.ts` or `src/persistence/migrations/` — these files are deleted

**Who is NOT affected:**
- CI environments using `InMemoryDatabaseAdapter` (no change)
- Environments with Dolt installed and initialized (primary supported backend)
- Fresh installations — `npm install substrate-ai` now completes without any C++ native addon compilation

**Remediation (if you have historical SQLite data):**
Run `substrate migrate` (from Epic 26-13) **before** upgrading to this version to move data to Dolt. After upgrade, run with `--dolt` or ensure Dolt is available on PATH.

### Breaking: FileStateStore no longer persists metrics to SQLite (Epic 29)

`FileStateStore` has been updated to be a pure in-memory TypeScript implementation with no `better-sqlite3` dependency. The `db?` option on `FileStateStoreOptions` has been removed — the constructor now only accepts `basePath?: string`.

**Who is affected:** Users who ran substrate pipeline runs before Epic 29 (v0.4.x) and have historical metrics stored in `.substrate/*.db` SQLite files.

**Remediation:** If you want to retain historical SQLite metric data, run `substrate migrate` (from Epic 26-13) **before** upgrading to v0.4.x to move data to Dolt. After upgrade, all new metrics are stored in Dolt when Dolt is available on your PATH, or are ephemeral in-memory when `FileStateStore` is used (CI environments).
