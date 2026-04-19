# Story 56-create-story-probe-awareness: Teach create-story to propose runtime probes

## Story

As a substrate operator,
I want the `create-story` agent to proactively propose `## Runtime Probes` declarations when a story's output is runtime-dependent (systemd units, containers, install scripts, migrations, compose files, anything whose correctness depends on execution),
so that stories authored after Epic 56 Phase 2 shipped automatically come with the verification gate the pipeline can now enforce.

## Context

Epic 56 Phase 2 wired `RuntimeProbeCheck` into the default Tier A
pipeline. Authors who know about it can declare probes in story
markdown today and the pipeline executes them. Authors who don't are
unchanged — their stories ship without probes and pass with a skip
note.

For adoption to actually close the strata Story 1-4 class of gap, the
`create-story` agent that produces story markdown has to know to
suggest probes when they would catch runtime failures.

This story updates the agent prompt, not the pipeline. It's pure
behavioral-instruction work.

## Acceptance Criteria

### AC1: Prompt template adds a probe-awareness section
**Given** the `packs/bmad/prompts/create-story.md` prompt template
**When** the agent renders it for any create-story dispatch
**Then** the template includes a "Runtime Verification" section
instructing the agent to evaluate whether the story's artifact is
runtime-dependent, and if so, draft one or more probes under a
`## Runtime Probes` section in the output story markdown
**And** the section includes concrete examples of runtime-dependent
artifact classes (systemd unit, container, migration, install script,
compose file) with one probe example each
**And** the section includes the YAML shape (`name`, `sandbox`,
`command`, `timeout_ms?`, `description?`) so the agent does not have
to re-derive the schema

### AC2: Guidance on sandbox choice
**Given** the agent is evaluating a probe declaration
**When** deciding `sandbox: host` vs `sandbox: twin`
**Then** the prompt guides:
  - Prefer `sandbox: twin` when the probe mutates host state (systemd
    units, running services, port bindings, filesystem outside the
    project working dir)
  - Prefer `sandbox: host` only when the probe is strictly read-only
    from the host's perspective (linting a file, parsing config,
    asserting a command exists) OR when the host context is explicitly
    what the story needs to verify
  - When uncertain, `sandbox: twin` is the safer default

### AC3: Guidance on probe granularity
**Given** a story with multiple runtime concerns (install + start +
connect)
**When** the agent drafts probes
**Then** the prompt guides toward separate named probes per concern
rather than one monolithic probe, so finding messages are addressable
and retries can focus on the specific failure
**And** each probe's `name` should be a hyphen-separated identifier
(not a free-form sentence)

### AC4: Guidance on when NOT to declare probes
**Given** a story whose output is purely static (type definitions, pure
refactor, documentation, build config that only affects compilation)
**When** the agent decides about probes
**Then** the prompt explicitly states that no `## Runtime Probes`
section is required for static-output stories, and doing so produces a
`pass` (skip) on the check with no benefit — omitting the section is
correct for these cases

### AC5: No probe declaration for the most common Substrate story class
**Given** the `create-story` agent dispatches against an existing
substrate story whose output is TypeScript code changes + tests (the
default case for substrate's own self-development)
**When** the agent renders a story
**Then** no `## Runtime Probes` section is added
**So that** adoption is gradual — probes appear where they help, not
everywhere

### AC6: Backward compatibility
**Given** an existing story that does not have a `## Runtime Probes`
section
**When** the pipeline runs
**Then** behavior is unchanged from Epic 56 Phase 2 — the probe check
emits `pass` with a skip note, no new failure mode surfaces
**So that** this story's prompt changes never cause a silent regression
on stories authored before the update

### AC7: Prompt-template regression tests pass
**Given** the updated `create-story.md` template
**When** existing `create-story` unit / integration tests run
**Then** all existing assertions continue to pass
**And** at least one new test exercises a story class known to warrant
a probe (e.g., a systemd unit spec) and asserts the rendered prompt
contains the probe-drafting guidance

### AC8: Cross-project validation
**Given** a story authored post-update against a runtime-dependent
artifact class (simulate the strata Story 1-4 case: Dolt install under
Podman Quadlet)
**When** `create-story` is invoked
**Then** the resulting story markdown includes a `## Runtime Probes`
section with at least one probe whose `command` would plausibly catch
the class of bug that shipped in the original strata Story 1-4

## Out of Scope

- Changing the pipeline's probe execution behavior.
- Adding new probe finding categories.
- Retrofitting probes onto previously-shipped stories (separate
  dogfood story).
- Convincing authors to adopt probes retroactively — the change is
  prospective only.

## Key File Paths

### Files to Modify
- `packs/bmad/prompts/create-story.md` — main prompt update
- `src/modules/compiled-workflows/create-story.ts` — if any assembled
  context bindings need to reference new sections (likely not — the
  template is self-contained)

### Test Files to Modify or Create
- `src/modules/compiled-workflows/__tests__/create-story.test.ts` —
  assert the new prompt section is included for runtime-dependent
  story classes

## Dependencies

- Blocked by Epic 56 Sprint 1 (Phase 2 MVP) — satisfied as of v0.20.5.
  The pipeline must actually execute probes before asking authors to
  declare them.

## Verification

- `npm run build` / `test:fast` clean
- Manual: dispatch `create-story` against a runtime-dependent story
  fixture; confirm the output markdown contains a well-formed
  `## Runtime Probes` section with author-sensible probes

## Design notes

- Teaching the agent to propose probes is necessary but not sufficient
  — probes are most valuable when authors review them and refine
  commands / timeouts. The prompt should frame probes as drafts the
  human author refines, not as finished verification. That framing is
  especially important since the probe is about to actually execute
  on the host or in a twin.
