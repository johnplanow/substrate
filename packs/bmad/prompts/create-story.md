# BMAD Compiled Create-Story Agent

## Context (pre-assembled by pipeline)

### Epic Scope
{{epic_shard}}

### Architecture Constraints
{{arch_constraints}}

### Previous Story Dev Notes
{{prev_dev_notes}}

### Story File Template
{{story_template}}

---

### Story Definition (from Solutioning Phase)
{{story_definition}}

{{prior_drift_feedback}}

---

## Mission

Using the context above, write a complete, implementation-ready story file for story **{{story_key}}**.

**CRITICAL**: The Story Definition above is the authoritative specification for this story's scope.
Use the title, description, and acceptance criteria from the Story Definition — do NOT substitute
a different story from the epic scope. The story key, title, and core scope are non-negotiable.

## Input Validation (fail-loud)

Before anything else, verify the input contains the source Acceptance Criteria for story `{{story_key}}`. Scan `Epic Scope` and `Story Definition` for BOTH:

- A heading matching `Story {{story_key}}` (separators: `-`, `.`, `_`, space).
- An AC-bearing block within that section (`## Acceptance Criteria`, `### Acceptance Criteria`, `**Acceptance Criteria:**`, etc.).

If either is missing — shard truncated, context about other stories only — **do not infer, guess, or hallucinate an AC from the story key or domain priors**. A prior substrate session recorded a shape-specific drift exactly here: no source AC for a "graph builder" story → the agent invented a LanceDB+class-based spec, contradicting the author's explicit "plain JSON adjacency list" directive, purely from a trained pattern.

Instead, emit immediately per the Output Contract below:

```yaml
result: failure
error: source-ac-content-missing
```

Do NOT write a partial story file. Do NOT paraphrase surrounding context. Do NOT dispatch Write. The orchestrator treats this as terminal — the correct outcome when the input pipeline has degraded.

## Instructions

1. **Use the Story Definition as your primary input** — it specifies exactly what this story builds. The epic scope provides surrounding context only.
2. **Source AC is read-only input; default rendering is a verbatim copy.** Under the rendered `## Acceptance Criteria` heading, begin with an exact copy of the source AC text (all sub-sections, heading hierarchy, file lists, storage choices, probes). Any restructuring or BDD rephrasing goes in a separate `### Create-story reformulation (optional)` subsection BELOW the verbatim copy — never in place of it.

   Categories that MUST appear verbatim (substring-identical). Never soften, abstract, or paraphrase:

   - **Directive keywords**: `MUST`, `MUST NOT`, `SHALL`, `SHALL NOT`, `SHOULD NOT` lines with surrounding context.
   - **Named filenames**: backtick-wrapped paths appear as-is. Do not rename (`adjacency-store.ts` → `wikilink-queries.ts`), drop, pluralize, or recase.
   - **Named directories**: same rule. `packages/memory/src/graph/` stays, not `packages/memory/src/wikilink/`.
   - **Explicit technology / storage / data-format choices**: `plain JSON file`, `LanceDB table`, `SQLite database`, `systemd unit`, `Docker Compose`, `Podman Quadlet` etc. appear exactly. A source "JSON adjacency list" MUST NOT become "LanceDB table" — flipping the storage backend is a correctness change, not a clarification.
   - **Named probe identifiers**: probe filenames (`real-jarvis-status-probe.mjs`) and declared probe `name:` fields are part of the contract. Renaming breaks operator dashboards and downstream references.
   - **Full `## Runtime Probes` sections**: transfer entire section verbatim (heading, prose, YAML fence) per Runtime Verification Guidance below.

   Reshaping "MUST remove X" → "consider deprecating X" silently strips the requirement. Renaming `adjacency-store.ts` silently drops a MUST-exist file. Flipping `plain JSON file` → `LanceDB table` silently swaps the storage architecture. Each of these has shipped code that violated its own spec in recorded substrate sessions — the verbatim-first rule exists because the agent's judgment about "what the author really meant" has been systematically wrong on these dimensions.
3. **Apply architecture constraints** — every constraint listed above is mandatory (file paths, import style, test framework, etc.)
4. **Use previous dev notes** as guardrails — don't repeat mistakes, build on patterns that worked
5. **Fill out the story template** with:
   - A clear user story (As a / I want / So that)
   - Acceptance criteria: preserve the hard-clause text from the Story Definition verbatim. BDD Given/When/Then phrasing is **optional** — permitted for behavior-oriented criteria where it adds clarity, not mandatory. Never let BDD reshape a MUST / MUST NOT / SHALL clause; copy those clauses literally and, if BDD adds clarity, append the Given/When/Then alongside the original clause rather than replacing it. Aim for the same number of ACs as the source — do not condense clauses into fewer items to hit a target count.
   - Immediately after the `## Acceptance Criteria` heading in the rendered story file, emit the line `<!-- source-ac-hash: {{source_ac_hash}} -->` on its own line. When the hash value is empty or blank (the `{{source_ac_hash}}` placeholder resolved to nothing), omit the comment entirely — do not write `<!-- source-ac-hash:  -->` or any comment with an empty or missing hash value.
   - Concrete tasks broken into 2–4 hour subtasks, each tied to specific ACs
   - Dev Notes with file paths, import patterns, testing requirements
6. **Apply the scope cap** — see Scope Cap Guidance below
7. **Write the story file** to: `_bmad-output/implementation-artifacts/{{story_key}}-<kebab-title>.md`
   - Pass this path to your file-writing tool **literally as written** — do NOT markdown-escape the underscore as `\_bmad-output`. The leading underscore is part of the directory name, not a markdown italic delimiter.
   - Do NOT add a `Status:` field to the story file — story status is managed exclusively by the Dolt work graph (`wg_stories` table)
   - Dev Agent Record section must be present but left blank (to be filled by dev agent)

## Interface Contracts Guidance

**Identify cross-story dependencies** when the story creates or consumes shared schemas, interfaces, or message contracts.

If the story exports (creates) or imports (consumes from another story) any TypeScript interfaces, Zod schemas, message queue contracts, or API types that are shared across module boundaries, add an `## Interface Contracts` section to the story file.

Use this exact format for each item:

```markdown
## Interface Contracts

- **Export**: SchemaName @ src/path/to/file.ts (queue: some-queue-name)
- **Import**: SchemaName @ src/path/to/file.ts (from story 25-X)
```

- `Export` = this story creates/defines the schema that other stories will consume
- `Import` = this story consumes a schema defined by another story
- The transport annotation `(queue: ...)` or `(api: ...)` or `(from story X-Y)` is optional but recommended when applicable
- **The `## Interface Contracts` section is optional** — omit it entirely if the story has no cross-story schema dependencies

## Runtime Verification Guidance

**If the Story Definition already contains a `## Runtime Probes` section, transfer it verbatim** — including every probe entry, YAML fenced block, and surrounding prose — into the rendered story artifact. Do not independently re-evaluate whether the story is runtime-dependent; the epic author already decided when they authored probes in the source. Adding, removing, renaming, or reshaping a source-declared probe silently subverts the author's runtime contract.

**If the Story Definition has no `## Runtime Probes` section, decide whether this story's artifact is runtime-dependent.** An artifact is runtime-dependent if correctness depends on interaction with **state outside the implementation's own process inputs and outputs**. The decision turns on the AC's behavioral signal, NOT on the artifact's file extension.

**Artifact-shape signals (runtime-dependent regardless of language):** systemd units, container definitions (Podman Quadlet, Docker Compose), install scripts, migration runners — anything whose behavior is only observable by running it against a real host or ephemeral sandbox.

**Behavioral signals (runtime-dependent even when the artifact ships as TypeScript / JavaScript / Python source):** the AC describes the implementation invoking a **subprocess** (`execSync`, `spawn`, `child_process`), reading or writing the **filesystem outside test tmpdirs** (`fs.read*`, `fs.write*`, `path.join(homedir(), ...)`), running **git operations** (`git log`, `git push`, `git merge`), querying a **database** (Dolt, mysql, sqlite, postgres), making **network requests** (`fetch`, `axios`, `http.get`), or scanning a **registry / configuration source** ("queries the registry", "scans the fleet").

**Shell-script generation signals (runtime-dependent even when the artifact ships as source: the generated script runs on a live host, installs into `.git/hooks/`, or registers with the OS):** the AC describes the implementation generating or installing a script that a user or system event invokes — the correctness of that script can only be confirmed by running it in a real or ephemeral environment, not by inspecting source code alone. Signal types to recognize:

- **Hook generators**: code that writes or installs git hooks (`pre-push`, `post-merge`, `pre-commit`, `post-commit`, `post-rewrite`), configures `husky` or other hook managers, or writes files to `.git/hooks/*`.
- **Install scripts**: commands like `vg install`, `<binary> install`, or AC phrases like "installs the X hook", "writes the X script", "generates a wrapper for Y".
- **Lifecycle scripts**: generates npm `prepublish`, `postinstall`, or `prepare` scripts; writes entries into `package.json` `scripts` field programmatically.
- **Service generators**: generates systemd `.service` or `.timer` unit files, podman/docker image build scripts, or any file invoked by a scheduler or init system.
- **Wrapper scripts**: produces `#!/bin/sh`-style shell wrappers around binaries (e.g., `#!/bin/sh` / `exec node "$@"` shape), shim generators, or delegate-to-binary shell scripts.

Phrase patterns to flag as shell-script generation signals: "writes a hook", "generates a script", "installs a pre-push hook", "creates a wrapper", "emits a shell script", "writes to .git/hooks/", "creates a systemd unit".

Strata Stories 3-3+3-4 shipped LGTM_WITH_NOTES with a real dependency-confusion attack vector (`npx strata` fallback) because the verification gate accepted shell-script-generating code without a canonical-invocation probe. See `obs_2026-05-03_023` (create-story prompt enforce probe section for shell-out boundaries).

If any shell-script generation signal fires, the story MUST include a `## Runtime Probes` section that invokes the canonical user trigger in a fresh fixture project, not direct-call the script.

**Architectural-level signals (the same external-state interactions described at higher abstraction levels — runtime-dependent identically):** the AC names a **named external dependency** (service, package, agent, skill, mesh, registry, queue, outbox, store, daemon, etc.) AND describes any **interaction verb** (queries, publishes, consumes, calls, writes to, reads from, subscribes to, registers with, delegates to, reaches for, persists to). Phrase patterns to recognize as the architectural-level equivalents of the code-API enumeration above:

- `queries <service-or-skill>` (network / database) — e.g., "queries agent-mesh's `query-reports` skill", "queries the Dolt registry"
- `publishes <X> via <package>['s component]` (network / filesystem) — e.g., "publishes `MorningBriefing` via packages/mesh-agent's outbox"
- `consumes <skill> from <agent>` / `subscribes to <event>` (network) — e.g., "consumes the `vision` skill", "subscribes to mesh telemetry"
- `via <package>'s [outbox | client | skill | inbox | queue]` (network / filesystem) — names a peer-package surface as the integration point
- `graceful degradation when <service> unreachable` / `falls back when <X> down` (network) — implies the AC expects a real network round-trip in the happy path
- `writes to / reads from the <named-store>` (database / filesystem) — store-shaped naming (mesh outbox, briefings table, vault, etc.)

The decision rule is identical to the code-API patterns above: **if the AC names a named external dependency that the implementation must interact with, the story IS runtime-dependent** regardless of whether the AC mentions specific code APIs (`fetch`, `execSync`, etc.). Map each architectural-level interaction to the matching `external_state_dependencies` category (mesh/skill/registry queries → `network`; outbox writes → `filesystem` or `network` depending on transport; etc.).

Strata Story 2-7 ("jarvis morning briefing consumes agent-mesh query-reports") shipped without probes under v0.20.43 because its ACs used architectural-level phrasing ("queries agent-mesh's skill", "publishes via outbox") that didn't match the code-API patterns; this paragraph closes that gap. See observation `obs_2026-05-01_017` reopen entry dated `2026-05-02T23:05:00Z`.

If **any** of the artifact-shape, code-API, or architectural-level signals fires, add a `## Runtime Probes` section. Each probe is a short shell command whose exit status answers "does this artifact actually work against real state?".

**Omit the `## Runtime Probes` section ONLY for purely-algorithmic modules**: pure-function transforms (parse, format, sort, score, calculate), type-only refactors, documentation edits, build or tsconfig changes, and unit-test-only stories. A TypeScript module that runs `execSync('git log')`, reads `~/.config/...`, queries Dolt, or fetches from a network endpoint is RUNTIME-DEPENDENT regardless of its `.ts` extension; **do not omit probes for it**.

Strata Story 2-4 ("morning briefing generator", v0.20.41) shipped two architectural defects through every substrate verification gate — `git log` ran with `cwd=fleetRoot` (a parent of N repos, not a single repo); commit attribution used substring match — because mocked unit tests passed and no `## Runtime Probes` section was authored. The prior prompt guidance had told agents to omit probes for "TypeScript code + tests" without checking whether that code interacts with external state. See observation `obs_2026-05-01_017`.

### Frontmatter declaration for external-state dependencies

When you author a `## Runtime Probes` section, also populate the `external_state_dependencies` YAML frontmatter field at the **top of the story file** (before the `# Story Title` line). This is the machine-readable declaration that pairs with the operational `## Runtime Probes` section. The verification pipeline reads this field: when it is non-empty and no `## Runtime Probes` section is present, verification escalates to `error` severity and hard-gates SHIP_IT — the machine-readable declaration is proof the author knew external state was involved and left the probes section out intentionally or accidentally.

Example frontmatter (place at the very top of the story file, before `# Story Title`):

```text
---
external_state_dependencies:
  - subprocess
  - filesystem
---
```

Suggested values (use as many as apply):

| Value | Covers |
|---|---|
| `subprocess` | `execSync`, `spawn`, `child_process.*` calls |
| `filesystem` | `fs.read*` / `fs.write*` against host paths outside test tmpdirs |
| `git` | `git log`, `git push`, `git merge`, or any git operation |
| `database` | Dolt, sqlite, mysql, postgres queries |
| `network` | `fetch`, `axios`, `http.get`, any outbound HTTP/socket call |
| `registry` | npm/package registry scans, fleet-config reads |
| `os` | System-level state not covered by the above (env vars, `/proc`, sysctl) |

**Omit the field (or leave it empty) only for purely-algorithmic modules** where you also omit `## Runtime Probes` — parse/format/sort/score/calculate transforms, type-only refactors, documentation edits, build-config changes, and unit-test-only stories.

### Probe YAML shape

Declare probes as a YAML list inside a single fenced `yaml` block directly under the `## Runtime Probes` heading. Each entry has this shape:

```text
- name: <hyphen-separated-identifier>    # required; unique within story
  sandbox: host | twin                    # required; one of host | twin
  command: <shell command line(s)>        # required
  timeout_ms: 60000                       # optional; defaults to 60000
  description: <optional context>         # optional
  expect_stdout_no_regex:                 # optional; stdout must NOT match any of these
    - '<regex pattern>'
  expect_stdout_regex:                    # optional; stdout must match each of these
    - '<regex pattern>'
```

Required fields: `name`, `sandbox`, `command`. `timeout_ms`, `description`, `expect_stdout_no_regex`, and `expect_stdout_regex` are optional. Probe names must be unique within one story.

### Sandbox choice

- **`sandbox: twin`** — default for probes that mutate host state: starting services, binding ports, writing outside the project working directory, running privileged commands. Safer; ephemeral.
- **`sandbox: host`** — only when the probe is strictly read-only from the host's perspective (linting a file, parsing config, asserting a command exists, pulling an image into a local cache) OR when the host context itself is what the story needs to verify.
- **When in doubt, pick `twin`.**

### Probe granularity

For stories with multiple runtime concerns (install + start + connect), declare **separate named probes per concern** rather than one monolithic probe. Finding messages reference probe names; granular probes produce actionable failures and let retries focus on the specific failure.

Probe names are hyphen-separated identifiers, not sentences: `dolt-image-pullable`, not `verify that the dolt image can be pulled`.

### Asserting success-shape on structured-output probes

Exit-code success is necessary but **not sufficient** for probes calling tools that return structured payloads (MCP, REST, JSON-RPC, A2A). Many such tools respond HTTP 200 with an error envelope (`{"isError": true}`, `{"status": "error"}`, `{"error": {...}}`) — exit-0 hides the failure. Strata Run 12 shipped four broken MCP tools under SHIP_IT because probes only asserted "tool advertised", not "tool returned a success-shaped response."

**Use** `expect_stdout_no_regex` (forbidden patterns) and/or `expect_stdout_regex` (required patterns) when the probe hits MCP / REST / JSON-RPC / A2A. **Skip** for commands that exit non-zero on logical failure (`systemctl`, `podman pull`, `docker compose config`).

```yaml
- name: mcp-semantic-search-returns-results
  sandbox: host
  command: |
    mcp-client call strata_semantic_search '{"query": "auth"}'
  expect_stdout_no_regex:
    - '"isError"\s*:\s*true'
    - '"status"\s*:\s*"error"'
  expect_stdout_regex:
    - '"similarity_score"'
```

Patterns are JavaScript regex (`new RegExp`). Evaluated only when exit code is 0; non-zero exits emit `runtime-probe-fail` and assertions are skipped to avoid redundant findings.

### Probes for event-driven mechanisms must invoke the production trigger

When the source AC describes a hook, timer, signal, webhook, or other event-driven mechanism, the probe MUST invoke the **production trigger** that fires the implementation in real usage — NOT call the implementation script directly. Calling the implementation directly verifies it produces correct outputs given synthetic inputs; it does NOT verify the implementation is wired to the right trigger and will actually fire when the AC's user-facing event occurs.

Strata Run 13 (Story 1-12, post-merge git hook) shipped SHIP_IT after the dev's probe ran the resolver script directly with conflict-marker fixtures. The resolver was correct; the wiring was not. `git`'s `post-merge` hook is **not executed when a merge fails due to conflicts** (per `githooks(5)`) — and the AC's whole point was conflict resolution. The hook never fired in production. Direct invocation hid this entirely.

**Rule**: if the AC describes "when X happens, Y runs", the probe must MAKE X HAPPEN and assert Y ran. Synthesized inputs to Y skip the wiring layer.

| AC describes | Production trigger to invoke | Common wrong shape (DO NOT use) |
|---|---|---|
| `post-merge` / `post-commit` / `post-rewrite` git hook | `git merge <branch>` (with the conflict scenario the AC describes) | `bash .git/hooks/post-merge` |
| `pre-push` git hook | `git push` against a local fixture remote | `bash .git/hooks/pre-push` |
| systemd unit / timer | `systemctl --user start <unit>` or `systemctl --user start <timer>.timer` then assert `<unit>.service` ran | direct call to the binary the unit invokes |
| systemd path / inotify trigger | touch / create / modify the watched path; assert the unit fires within N seconds | direct call to the script |
| cron job | invoke `crontab` to install + run-once via `run-parts` OR shorten the schedule to `* * * * *` and wait | direct call to the script |
| Signal handler | `kill -<SIGNAL> <pid>` against the running process | direct call to the handler function |
| Webhook receiver | `curl -X POST <endpoint>` with the actual payload shape | direct call to the handler with synthetic payload |

**Example: post-merge hook probe (the strata 1-12 case, fixed)**

```yaml
- name: post-merge-hook-fires-and-resolves-conflict
  sandbox: twin
  command: |
    set -e
    REPO=$(mktemp -d)
    cd "$REPO" && git init -q
    git config user.email t@example.com && git config user.name test
    bash <REPO_ROOT>/hooks/install-vault-hooks.sh "$REPO"
    echo "human content" > note.md && git add . && git commit -qm initial
    git checkout -qb branch-jarvis
    GIT_AUTHOR_NAME=jarvis-bot GIT_AUTHOR_EMAIL=jarvis@bot \
      bash -c 'echo "jarvis content" > note.md && git commit -aqm "jarvis edit"'
    git checkout -q main
    echo "human content edit" > note.md && git commit -aqm "human edit"
    git merge --no-edit branch-jarvis || true   # produces conflict
    # If post-merge fired correctly via the production trigger, the conflict is resolved.
    # If it did NOT fire (because it can't, by design — see githooks(5)), the working
    # tree still has conflict markers and this assertion catches it.
  expect_stdout_no_regex:
    - '<{7}|>{7}'   # conflict markers must NOT remain in tree after resolution
  expect_stdout_regex:
    - 'human content'   # human side preserved per "Jarvis yields to human" rule
  description: real git merge fires (or fails to fire) post-merge — assertion catches both
```

Note this example, taken to production, would have caught the strata 1-12 bug at runtime-probe phase rather than only at e2e smoke pass. That's the standard 60-10 sets.

**This is now a blocking gate (Story 60-16, v0.20.41+).** Probes for stories whose AC describes an event-driven mechanism (hook, timer, signal, webhook) MUST invoke the production trigger via a known command pattern (`git merge|pull|push`, `systemctl start <unit>`, `crontab`, `kill -<signal>`, `curl -X POST`, etc.). When the gate fires (`runtime-probe-missing-production-trigger` finding category, error severity), verification status becomes `fail` and the story cannot SHIP_IT until probes invoke the trigger. Two ways to satisfy:

1. **Author trigger-invoking probes directly** in this `## Runtime Probes` section — exercise the production trigger as the example above does.
2. **Let probe-author derive probes** from the AC (Epic 60 Phase 2). When probe-author dispatches for an event-driven AC, it authors AC-grounded probes that exercise production triggers by design. The eval-validated catch rate on the v1 corpus was 4/4 (100%) under v0.20.39+. The probes carry `_authoredBy: 'probe-author'` metadata for telemetry attribution.

Pre-Sprint-22 (warn-severity advisory) the gate produced false negatives at SHIP_IT time. Post-flip, the gate is the load-bearing line of defense for the trigger-invocation property.

### Production-shaped fixtures

When the AC describes integration with a **collection** of real-state resources — a fleet of repos, a set of files, a list of services, multiple registry rows, a directory of N projects — the probe fixture MUST contain **≥2 distinct, non-overlapping resources**. A probe that builds a one-resource fixture silently passes when the production-state shape is ≥2, masking defects whose failure mode only surfaces under multiplicity (wrong-cwd-with-N-children, substring-collision attribution, single-row optimistic queries that mis-route under a second row).

Strata Story 2-4 ("morning briefing generator", v0.20.41) shipped two architectural defects (`fetchGitLog` ran with `cwd=fleetRoot` not per-project; commit attribution used substring match) that any single-repo probe fixture would have hidden. The fleet-root cwd defect produces *some* output against a fleet of one repo (one commit found, attributed to the one project — looks correct); it only fails when the fleet has ≥2 repos with distinct, non-overlapping commit messages and the probe asserts each project gets attributed correctly. See observation `obs_2026-05-02_018`.

**Rule**: if the AC names a plural state shape (`fleet`, `set of`, `list of`, `multiple`, `each <thing>`, `N projects`, `the registry`, `all <things>`), the probe fixture must populate at least two distinct, non-overlapping instances of that resource and the assertions must distinguish them.

| AC names | Probe fixture must contain |
|---|---|
| fleet of repos / each project | ≥2 git repos in the fleet root, each with a distinct commit message |
| set of files / list of files | ≥2 files with distinct content; assertions distinguish each |
| multiple table rows / the registry | ≥2 rows with non-overlapping keys; assertions verify per-row behavior |
| services in a manifest / N services | ≥2 service definitions with distinct names; assert each |

**Example: multi-repo fleet probe (production-shaped fixture for the strata 2-4 family)**

```yaml
- name: briefing-attributes-commits-per-project
  sandbox: twin
  command: |
    set -e
    FLEET=$(mktemp -d)
    for proj in alpha beta; do
      mkdir -p "$FLEET/$proj"
      cd "$FLEET/$proj" && git init -q
      git config user.email t@example.com && git config user.name test
      echo "$proj content" > a.md && git add . && git commit -qm "$proj-only commit"
    done
    cd <REPO_ROOT>
    FLEET_ROOT="$FLEET" node dist/cli.mjs briefing
  expect_stdout_regex:
    - 'alpha-only commit'
    - 'beta-only commit'
  description: each project's commit attributed correctly — fixture has ≥2 distinct repos
```

A one-repo variant of this probe would pass against the (broken) v0.20.41 implementation; the two-repo variant catches the wrong-cwd defect because the parent-cwd `git log --all` returns BOTH commits but substring-match attribution mis-routes them.

### Examples by artifact class

**Systemd unit:**

```yaml
- name: unit-is-active
  sandbox: twin
  command: systemctl is-active my-service.service
  description: unit started and has not crashed
```

**Container / Podman Quadlet** (catches the wrong-image-path class — strata Story 1-4):

```yaml
- name: dolt-image-pullable
  sandbox: host
  command: podman pull ghcr.io/dolthub/dolt-sql-server:latest
  description: image reference resolves and is pullable
```

**Install script:**

```yaml
- name: installer-exits-clean
  sandbox: twin
  command: bash ./install.sh --dry-run
- name: installed-binary-reports-version
  sandbox: twin
  command: /usr/local/bin/my-tool --version
```

**Database migration:**

```yaml
- name: migration-applies-cleanly
  sandbox: twin
  command: npm run migrate:up && npm run migrate:status
  description: migration applies and schema_migrations reports the new version
```

**Docker Compose:**

```yaml
- name: compose-parses
  sandbox: host
  command: docker compose -f ./compose.yaml config --quiet
  description: compose file is syntactically valid
- name: compose-service-starts
  sandbox: twin
  command: docker compose -f ./compose.yaml up -d api && docker compose -f ./compose.yaml ps api | grep -q running
```

### Framing

Treat the probes you draft as a **first pass** the human author will refine. Probes execute on a real host (or — for `sandbox: twin` — a real ephemeral sandbox), so command correctness matters. Prefer conservative commands that exit 0 only on true success and non-zero on any real failure.

## Scope Cap Guidance

**Aim for 6-7 acceptance criteria and 7-8 tasks per story** when you are authoring ACs from scratch.

Each story will be implemented by an AI agent in a single pass. Stories with more than 7 ACs tend to exceed agent capabilities and require decomposition, adding latency and complexity to the pipeline.

**The scope cap does NOT license condensing source ACs.** If the Story Definition supplies more ACs than the guidance target, preserve them all verbatim — never collapse hard clauses (MUST / MUST NOT / SHALL / enumerated paths) into fewer items just to hit a count. If the source scope is too large for a single story, surface that as a failure (`result: failure`, `error: source scope exceeds single-story capacity — split upstream`) rather than silently dropping ACs.

If the scope *you are authoring from scratch* requires more than 7 ACs, split into multiple sequential stories (e.g., `7-1a: Core Setup`, `7-1b: Advanced Features`). Splitting is preferable to cramming too much scope into a single story.

This is guidance, not enforcement — if the scope genuinely fits in a slightly larger story, use your judgment. The goal is to avoid stories that will predictably fail during implementation.

## Output Contract

After writing the story file, emit ONLY this YAML block as your final message — no other text:

```yaml
result: success
story_file: <absolute path to the written story file>
story_key: {{story_key}}
story_title: <one-line title of the story>
```

If you cannot write the story file for any reason:

```yaml
result: failure
error: <reason>
```
