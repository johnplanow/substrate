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

**If the Story Definition has no `## Runtime Probes` section, decide whether this story's artifact is runtime-dependent.** An artifact is runtime-dependent if correctness depends on execution — systemd units, container definitions (Podman Quadlet, Docker Compose), install scripts, migration runners, anything whose behavior is only observable by running it against a real host or ephemeral sandbox.

If the artifact is runtime-dependent, add a `## Runtime Probes` section to the story file. Each probe is a short shell command whose exit status answers "does this artifact actually work?".

**If the artifact is NOT runtime-dependent — TypeScript/JavaScript code + tests, type-only refactors, documentation, build or tsconfig edits — omit the `## Runtime Probes` section entirely.** Adding one for a static-output story produces a `pass` (skip) with no benefit. The default substrate self-development case (source code + tests) has no probes.

### Probe YAML shape

Declare probes as a YAML list inside a single fenced `yaml` block directly under the `## Runtime Probes` heading. Each entry has this shape:

```text
- name: <hyphen-separated-identifier>    # required; unique within story
  sandbox: host | twin                    # required; one of host | twin
  command: <shell command line(s)>        # required
  timeout_ms: 60000                       # optional; defaults to 60000
  description: <optional context>         # optional
```

Required fields: `name`, `sandbox`, `command`. `timeout_ms` and `description` are optional. Probe names must be unique within one story.

### Sandbox choice

- **`sandbox: twin`** — default for probes that mutate host state: starting services, binding ports, writing outside the project working directory, running privileged commands. Safer; ephemeral.
- **`sandbox: host`** — only when the probe is strictly read-only from the host's perspective (linting a file, parsing config, asserting a command exists, pulling an image into a local cache) OR when the host context itself is what the story needs to verify.
- **When in doubt, pick `twin`.**

### Probe granularity

For stories with multiple runtime concerns (install + start + connect), declare **separate named probes per concern** rather than one monolithic probe. Finding messages reference probe names; granular probes produce actionable failures and let retries focus on the specific failure.

Probe names are hyphen-separated identifiers, not sentences: `dolt-image-pullable`, not `verify that the dolt image can be pulled`.

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
