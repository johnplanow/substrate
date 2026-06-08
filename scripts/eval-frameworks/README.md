# Framework-eval scaffolding (Phase 1)

Fairness substrate for comparing software-building agentic frameworks (BMad-via-substrate,
Ralph loops, Lattice, GSD, Claude-Code-native) on the same tasks, the same axes. See
`_bmad-output/planning-artifacts/framework-eval-strategy.md` for the full strategy.

Phase 1 builds the **framework-neutral inputs** to the existing Epic 81 graders — it does
**not** run any framework live (that's the Phase 2 Ralph spike). Everything here is pure +
injectable I/O, unit-tested, no model calls.

## Pieces

| File | Role | Strategy dimension |
|---|---|---|
| `runner.mjs` | `FrameworkRunner` interface + registry + `fromDispatchEnvelope` adapter (proves substrate's existing dispatch path fits the neutral interface) + `validateRunResult` | 3 (execution-shape normalization) |
| `neutral-outcome.mjs` | `computeNeutralOutcome` — framework-agnostic success oracle: build + tests + ground-truth file-overlap. No framework self-report consulted. | 4 (outcome normalization) |
| `../../_bmad-output/eval-results/corpus/neutral-task-corpus.yaml` | plain-prose task specs (no framework idiom) + real ground-truth commits | 1 (corpus neutrality, partial) |

## The contract

A framework runner implements:

```js
/** @type {FrameworkRunner} */
async function run(task, worktree, opts) { /* drive the framework to completion */ return result }
```

returning a `FrameworkRunResult` — the neutral envelope (`diff`, `total_turns`, `total_tokens`,
`cost_usd`, `duration_seconds`, `run_outcome`) with any framework-specific signals quarantined
under `framework_specific` (the neutral graders ignore that field). `validateRunResult()` fails
loudly on a malformed envelope.

The three already-neutral Epic 81 grader axes (code-quality, cost, work-quality) consume
`FrameworkRunResult.diff` / `.total_turns` / `.total_tokens` directly. The neutral outcome oracle
replaces the BMad-coupled verdict/recovery axes for non-BMad frameworks.

## What's deliberately NOT here yet

- **Live runners** (Ralph loop, Claude-native, Lattice driver) — Phase 2+. Each is an injectable
  implementation of the interface; the Ralph black-box spike is the first.
- **Domain-diverse tasks** — the neutral corpus seed is still substrate-self by domain (the Epic 81
  archetype-monotone ceiling). Truly diverse tasks need hand-authoring against a non-substrate repo.
- **Interaction normalization** (headless-driving of human-gated frameworks like Lattice) — designed
  per-framework when that runner is built.
