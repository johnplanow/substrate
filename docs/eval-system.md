# Eval System

The eval system evaluates the quality of LLM outputs produced by the substrate pipeline. It's invoked on-demand via `substrate eval` to answer the question: **did the LLM actually do what we asked it to, and does it hold up against our standards?**

This is not unit testing. The pipeline's existing tests mock the dispatch layer and never evaluate real LLM output. The eval system complements them by running LLM-as-judge assertions against captured pipeline artifacts.

## What It Catches

Three failure modes that the pipeline cannot detect about itself:

1. **Semantic quality regression** — outputs parse fine (Zod validates them) but the content is shallow, misses key details, or ignores parts of the input concept
2. **Prompt assembly bugs** — context injection breaks, placeholders don't get replaced, token budget truncation removes important sections
3. **Cross-phase coherence loss** — each phase's output looks fine individually, but planning ignores what analysis produced, or stories don't reflect the architecture

## Quick Start

Evaluate the most recent pipeline run at standard depth:

```bash
substrate eval
```

Evaluate with the full deep tier (golden examples, cross-phase coherence, rubric scoring):

```bash
substrate eval --depth deep --concept cli-task-tracker
```

Evaluate only specific phases:

```bash
substrate eval --phase analysis,planning
```

Output as JSON for CI or dashboards:

```bash
substrate eval --report json
```

Evaluate a specific historical run:

```bash
substrate eval --run-id <uuid>
```

## CLI Reference

```
substrate eval [options]

Options:
  --depth <depth>         Eval depth: standard or deep (default: standard)
  --phase <phases>        Comma-separated phases (default: all four)
  --run-id <id>           Pipeline run ID (defaults to latest)
  --concept <name>        Canonical test concept for golden comparison (deep tier only)
  --report <format>       Output format: table, json, or markdown (default: table)
  --project-root <path>   Project root directory
```

Exit code: `0` if overall pass, `1` if any phase scored below the threshold or an error occurred.

Results are saved to `.substrate/evals/<run-id>.json` for trend tracking.

## Tiers

| Tier | Layers run | Cost per run | Wall-clock |
|---|---|---|---|
| `standard` (default) | Prompt compliance + implementation verifier | ~$0.50–2 | ~2–5 min |
| `deep` | Standard + golden comparison + cross-phase coherence + rubric scoring | ~$5–10 | ~10–15 min |

Each tier is additive. `deep` runs everything `standard` runs.

**When to use each:**

- Use `standard` for every run you want to sanity-check — it catches prompt-compliance issues and impl-phase correctness for a modest cost.
- Use `deep` when tuning prompts, changing phase logic, or validating a canonical test concept. The golden-example anchor and rubric scoring give you much stronger signal but cost significantly more.

## How It Works

### High-level flow

```
substrate eval --run-id <id>
    │
    ├─ load pipeline run from decision store
    ├─ reconstruct phase outputs from stored decisions
    ├─ load prompt templates from the methodology pack
    ├─ (deep tier) load golden examples and rubrics from fixtures
    │
    ├─ for each phase:
    │     ├─ build EvalAssertion[] via each applicable layer
    │     ├─ pass assertions to the PromptfooAdapter
    │     └─ collect LayerResult with per-assertion scores
    │
    ├─ aggregate into EvalReport
    ├─ write to .substrate/evals/<run-id>.json
    └─ format and print via EvalReporter
```

### Core components

| Component | File | Responsibility |
|---|---|---|
| `EvalEngine` | `src/modules/eval/eval-engine.ts` | Orchestrates layers based on depth tier, aggregates scores |
| `PromptfooAdapter` | `src/modules/eval/adapter.ts` | Wraps `promptfoo.evaluate()` behind an `EvalAdapter` interface |
| `EvalReporter` | `src/modules/eval/reporter.ts` | Formats `EvalReport` as table, JSON, or markdown |
| Layers | `src/modules/eval/layers/*.ts` | Pure builders that produce `EvalAssertion[]` from their inputs |
| Fixtures | `src/modules/eval/fixtures/` | Canonical concepts, golden examples, rubrics |
| CLI command | `src/cli/commands/eval.ts` | Loads artifacts from decision store, wires layers to the engine |

### The layer pattern

Every evaluator follows a consistent shape:

```typescript
class SomeLayer {
  buildAssertions(...): EvalAssertion[] {
    if (/* no useful data */) return []
    return [
      { type: 'llm-rubric', value: 'rubric text...', label: 'check-name' },
      // ...
    ]
  }
}
```

Layers are **pure builders**. They never call LLMs directly. They produce `EvalAssertion[]` that the engine passes to the adapter, which then runs them through promptfoo. This makes layers trivially testable — each layer has a `.test.ts` file that asserts "given X, produce assertions that contain Y" with no LLM calls involved.

### promptfoo isolation

The `PromptfooAdapter` is the only production file that imports promptfoo. The rest of the module only knows about the `EvalAdapter` interface. If promptfoo needs to be replaced (e.g., due to license change or API drift), only `adapter.ts` changes.

## Extending the System

### Adding a new evaluator layer

Say you want to add a "consistency check" layer that flags when a phase output contradicts itself.

**1. Create the layer file** — `src/modules/eval/layers/consistency-check.ts`:

```typescript
import type { EvalAssertion } from '../types.js'

export class ConsistencyCheckLayer {
  buildAssertions(output: string): EvalAssertion[] {
    if (!output.trim()) return []

    return [
      {
        type: 'llm-rubric',
        value: [
          'Evaluate whether this output contradicts itself.',
          'Look for statements that cannot both be true, or claims that',
          'are undermined by later statements in the same output.',
          '',
          'Score 1.0 if internally consistent, lower for contradictions.',
        ].join('\n'),
        label: 'internal-consistency',
      },
    ]
  }
}
```

**2. Add a test** — `src/modules/eval/__tests__/consistency-check.test.ts`:

```typescript
import { describe, it, expect } from 'vitest'
import { ConsistencyCheckLayer } from '../layers/consistency-check.js'

describe('ConsistencyCheckLayer', () => {
  it('builds a consistency assertion for non-empty output', () => {
    const layer = new ConsistencyCheckLayer()
    const assertions = layer.buildAssertions('some output')
    expect(assertions).toHaveLength(1)
    expect(assertions[0].label).toBe('internal-consistency')
  })

  it('returns empty for empty output', () => {
    const layer = new ConsistencyCheckLayer()
    expect(layer.buildAssertions('')).toEqual([])
  })
})
```

**3. Wire it into the engine** — edit `src/modules/eval/eval-engine.ts`:

```typescript
import { ConsistencyCheckLayer } from './layers/consistency-check.js'

export class EvalEngine {
  // ...
  private consistencyCheck = new ConsistencyCheckLayer()

  async evaluatePhase(phaseData: PhaseData, depth: EvalDepth) {
    // ... existing layers ...

    // New layer — runs in both tiers
    const consistencyAssertions = this.consistencyCheck.buildAssertions(phaseData.output)
    if (consistencyAssertions.length > 0) {
      const result = await this.adapter.runAssertions(
        phaseData.output,
        consistencyAssertions,
        'consistency-check',
      )
      layers.push(result)
    }

    // ... aggregate ...
  }
}
```

**4. Export from the barrel file** — edit `src/modules/eval/index.ts`:

```typescript
export { ConsistencyCheckLayer } from './layers/consistency-check.js'
```

**5. Decide the tier** — if the new layer should only run in `deep` mode, wrap the engine call with `if (depth === 'deep' && ...)`.

### Adding a new canonical test concept

Canonical concepts are reference inputs you can run the pipeline against and compare. They enable golden-example comparison in deep tier.

**1. Define the concept** — `src/modules/eval/fixtures/concepts/<name>.yaml`:

```yaml
name: markdown-blog-generator
description: A static site generator that converts markdown files to a blog
concept: |
  Build a static site generator that takes a directory of markdown files
  and produces an HTML blog. Support front-matter for title, date, tags.
  Generate an index page, per-post pages, and a tag-filtered archive.
  No database, no dynamic server — output is plain HTML that can be
  served by any static host.
```

**2. Run the pipeline against it** (to produce a reference output to curate):

```bash
# Run pipeline with your new concept
substrate run --events  # provide the concept when prompted
```

**3. Curate the golden example** — after the run, inspect the outputs and save ones you consider high-quality references to `src/modules/eval/fixtures/golden/<concept-name>/<phase>.yaml`. For example, `src/modules/eval/fixtures/golden/markdown-blog-generator/analysis.yaml`.

Golden examples are **anchors, not templates**. Different valid outputs should still score well — the LLM judge compares on completeness, depth, and accuracy, not exact match.

### Adding or updating a rubric

Rubrics define the scoring dimensions for a phase in deep tier. Each dimension becomes a separate LLM-as-judge assertion, and the weights are applied by the engine to compute a weighted phase score.

Edit `src/modules/eval/fixtures/rubrics/<phase>.yaml`:

```yaml
dimensions:
  - name: problem_clarity
    weight: 0.3
    prompt: "Is the problem statement specific, falsifiable, and grounded in real user pain?"
  - name: user_specificity
    weight: 0.3
    prompt: "Are target users described as concrete segments, not generic personas?"
  # ... more dimensions
```

**Rules:**
- Weights must sum to 1.0 (the engine normalizes but clean weights are easier to reason about)
- Dimension names must be valid identifiers (no spaces, used as assertion labels)
- The `prompt` field is sent to the judge LLM — write it as a yes/no question or a clear scoring instruction

**When to tune a rubric:**
- If `deep` scores seem systematically too high or too low across runs, a dimension's prompt may be too easy or too strict
- If you discover a new quality aspect you want to track, add a dimension (and rebalance the weights)
- If a dimension consistently produces unclear reasoning in the output, rewrite the prompt to be more specific

### Adding a new phase

The eval system currently supports the four pipeline phases: `analysis`, `planning`, `solutioning`, `implementation`. If a new phase is added to the pipeline, the eval system needs matching updates:

**1. Add the phase to the `EvalPhase` type** — `src/modules/eval/types.ts`:
```typescript
export type EvalPhase = 'analysis' | 'planning' | 'solutioning' | 'implementation' | 'new-phase'
```

**2. Add the prompt key mapping** — `src/cli/commands/eval.ts`:
```typescript
const PHASE_TO_PROMPT_KEY: Record<EvalPhase, string> = {
  analysis: 'analysis',
  planning: 'planning',
  solutioning: 'architecture',
  implementation: 'dev-story',
  'new-phase': 'new-phase',  // whatever the pack manifest uses
}
```

**3. Add the phase to `EVAL_PHASES`** — `src/cli/commands/eval.ts`:
```typescript
const EVAL_PHASES: EvalPhase[] = ['analysis', 'planning', 'solutioning', 'implementation', 'new-phase']
```

**4. Add a rubric** — `src/modules/eval/fixtures/rubrics/new-phase.yaml`

**5. Consider the cross-phase ordering** — `EVAL_PHASES` order determines which phase is the upstream for cross-phase coherence analysis.

## Testing the Eval System

The eval system has two test styles:

### Unit tests (no LLM calls)

Every layer, the adapter, the engine, and the reporter have focused unit tests that mock promptfoo. They run as part of `npm run test:fast`:

```bash
npx vitest run src/modules/eval/
```

These tests verify that:
- Each layer produces the correct assertions for given inputs
- The adapter correctly translates our format to promptfoo's format
- The engine correctly orchestrates layers by tier
- The reporter produces well-formed output in all three formats
- Rubric weights are correctly applied

### Meta-eval tests (LLM calls, on-demand)

The meta-eval suite answers the only question the rest of the test suite can't: **does the LLM judge actually distinguish good phase output from bad?** It loads hand-built good/bad fixture pairs for each pipeline phase, runs both through the real `PromptfooAdapter` + `RubricScorer`, and asserts `score(good) - score(bad) >= MARGIN_THRESHOLD` (currently 0.15) per phase.

Real LLM calls cost money, so the suite is gated two ways:

1. Filename pattern `**/*meta-eval*` is excluded from `npm test`, `npm run test:fast`, and `npm run test:changed` — vitest never discovers it in normal runs.
2. The test file's `describe` block is wrapped in `process.env.META_EVAL === '1' ? describe : describe.skip` — if someone runs `vitest` directly with an explicit `--include`, the block still short-circuits unless the env var is set.

**Running it:**

```bash
# Requires an API key in env for promptfoo's default llm-rubric grader
export OPENAI_API_KEY=sk-...
# or
export ANTHROPIC_API_KEY=sk-ant-...

npm run test:meta-eval
```

Four tests run (one per phase). Each prints a margin line whose shape looks like this (values shown are **illustrative** — your real margins will differ, and calibrating them is the point):

```
[meta-eval] analysis: good=<w1>, bad=<w2>, margin=<w1-w2>
[meta-eval] planning: good=<w1>, bad=<w2>, margin=<w1-w2>
[meta-eval] solutioning: good=<w1>, bad=<w2>, margin=<w1-w2>
[meta-eval] implementation: good=<w1>, bad=<w2>, margin=<w1-w2>
```

Exit code 0 iff every phase meets the margin threshold.

**Triaging a margin failure.** When a phase fails, work through the hypotheses in order:

1. **Fixture too subtle.** Re-read the good and bad YAML in `src/modules/eval/fixtures/meta-eval/<phase>/`. If the bad variant isn't obviously worse on the rubric's dimensions, rewrite it to be more degraded. Target: good above ~0.75, bad below ~0.5 on every dimension.
2. **Rubric too loose or too strict.** If the judge's scores are reasonable but both variants cluster near the same value, the rubric dimensions may not be discriminating. Tune the prompts in `src/modules/eval/fixtures/rubrics/<phase>.yaml`, and double-check the dimension `weight` values — a high-impact dimension with a small weight can flatten the signal.
3. **Judge drift.** If fixtures and rubric look fine but the score has collapsed over time, the upstream grader model may have changed. See the [promptfoo model-graded metrics docs](https://www.promptfoo.dev/docs/configuration/expected-outputs/model-graded/) for how to override the grader provider and model.

**Adding a new fixture pair.** To add a pair for a new concept or to catch a specific regression:

1. Create `src/modules/eval/fixtures/meta-eval/<phase>/<good|bad>.yaml` with fields `name`, `description`, `phase`, `output`, and optional `notes`. The `output` field must be a multi-line string shaped as reconstructed `key: value\n` phase output (see caveat below).
2. The `phase` field must match the directory name.
3. Each variant should exercise every dimension in that phase's rubric. Review `fixtures/rubrics/<phase>.yaml` and make sure the good output clearly satisfies each dimension; make sure the bad output clearly fails each dimension.
4. Re-run `npm run test:meta-eval` and check the margin.

Currently the test file covers one fixture pair per phase. To run multiple pairs, parametrize the `for` loop in `src/modules/eval/__tests__/meta-eval.test.ts` over `(phase, fixturePairName)` tuples.

**Reconstructed-output caveat.** Today the eval harness scores a `key: value\n`-joined synthesis of decision rows rather than the raw LLM output the pipeline produced (see `src/cli/commands/eval.ts:133`). The meta-eval fixtures are shaped to match this synthesis because it's what the judge actually sees in production. When the output-fidelity fix ships (tracked as G2 in deferred work), existing fixtures will need to be regenerated against the new real-output format. Update this note when that lands.

## Iterating Over Time

### Adding captured fixtures

As the pipeline runs in production, capture interesting outputs as test fixtures:

```bash
# Take the most recent run's analysis output and save it as a reference
# (this is a manual process for now — automate later)
cp .substrate/evals/<run-id>.json src/modules/eval/fixtures/captured/<name>.json
```

Tag captured outputs as `good`, `bad`, or `degraded` with notes on what's wrong. These serve as:
1. **Regression fixtures** — run unit tests against known-bad output to verify the eval system catches known issues
2. **Candidate golden examples** — promote high-quality captures to `fixtures/golden/`
3. **Meta-eval anchors** — verify the LLM judge ranks them correctly (good > bad)

### Calibrating the pass threshold

The default threshold is `0.7` (see `DEFAULT_PASS_THRESHOLD` in `src/modules/eval/types.ts`). This is a reasonable starting point but may need tuning:

- If too many valid runs fail, lower it to `0.65` or `0.6`
- If low-quality runs sneak through, raise it to `0.75` or `0.8`
- Consider per-phase thresholds if the phases have systematically different baseline scores

### Calibrating the judge

The LLM doing the scoring (configured in promptfoo) may drift over time as models update. To detect drift:

1. Keep a small set of "canary" fixture pairs tagged `good` and `bad`
2. Periodically run an eval against the canaries and verify `good > bad`
3. If the ordering inverts on a canary pair, either the judge model has drifted or the canary pair needs revision

## Architecture Decisions

### Why promptfoo?

We considered three options for the scoring engine:

| Option | Verdict |
|---|---|
| **promptfoo** | Chosen — TypeScript-native, CLI-first, embeddable via `evaluate()`, huge assertion library including `llm-rubric`, `javascript`, `similar` |
| **Braintrust AutoEvals** | Great scoring primitives but no runner — would have meant building everything around it |
| **Evalite** | Cleanest DX but pre-1.0 and designed as a test runner (not an embeddable library) |

The dependency is isolated behind `adapter.ts` so it's replaceable. promptfoo's [acquisition by OpenAI in March 2026](https://openai.com/index/openai-to-acquire-promptfoo/) makes the long-term direction uncertain — pinning the version and maintaining the adapter seam is deliberate risk mitigation.

### Why no quick tier?

The spec originally planned three tiers (quick/standard/deep), where `quick` would run deterministic checks like YAML parsing, Zod validation, and placeholder verification.

We dropped it because those checks are **already covered by the pipeline itself**:
- Zod validation runs at dispatch time — malformed outputs never make it to the decision store
- The prompt assembler has unit tests for placeholder replacement
- Failed YAML parsing fails the pipeline, not just an eval

The net-new value starts at the semantic layer — so `standard` is now the baseline.

### Why rubrics in YAML instead of code?

Rubric dimensions are prompt text aimed at LLMs, not code logic. YAML:
- Keeps them editable without touching TypeScript
- Makes them diffable in version control
- Separates "what to evaluate" (rubric) from "how to run evaluations" (engine)

### Why history as JSON files, not the decision store?

Each eval run writes to `.substrate/evals/<run-id>.json`. This is:
- Simple (no schema migrations)
- Git-friendly (users can commit baseline evals if they want)
- Sufficient for current needs

If trend analysis becomes important, upgrading to SQLite or the decision store is straightforward — the `EvalReport` type is the stable shape.

## Future Work

These were explicitly deferred from v1 but have hooks ready:

### Self-eval at phase transitions

The eventual goal is for the pipeline to evaluate its own output at each phase transition and retry with feedback if the score is low:

```
Step completes → Zod validation (existing)
               → Critique loop (existing)
               → Self-eval (new — standard tier only)
               → Gate decision: proceed / retry / escalate
```

What's ready for this:
- The `EvalEngine.evaluatePhase()` method can run on a single phase
- `PhaseEvalResult.feedback` contains a human-readable summary of what scored low, suitable for injecting into a retry prompt
- Configuration hooks can go in the methodology pack manifest

What's not built:
- Step runner integration
- Retry-with-feedback dispatch logic
- Manifest parsing for self-eval config

### Historical trend tracking

`substrate eval --compare <run-a> <run-b>` is on the roadmap. The JSON history files already contain everything needed.

### Story-spec loading for the implementation verifier

The `ImplVerifier` layer is wired into the engine but currently unreachable from the CLI because `storySpec` is never constructed. Loading story specs from the decision store and wiring them into `PhaseData.storySpec` would enable compile-check and acceptance-criteria evaluation during implementation phase.

### Smoke-test for compile-check assertion

The `ImplVerifier`'s compile-check produces a JavaScript assertion that calls `execSync('npx tsc --noEmit')`. Nothing currently verifies this actually works inside promptfoo's JS sandbox. A one-time smoke test would validate the assumption.

## File Reference

```
src/modules/eval/
├── types.ts                              # EvalDepth, EvalAssertion, LayerResult, EvalReport, etc.
├── adapter.ts                            # PromptfooAdapter + EvalAdapter interface
├── eval-engine.ts                        # EvalEngine orchestrator + PhaseData type
├── reporter.ts                           # EvalReporter (table/json/markdown)
├── index.ts                              # Public API barrel file
├── layers/
│   ├── prompt-compliance.ts              # Standard tier: LLM-as-judge against prompt instructions
│   ├── impl-verifier.ts                  # Standard tier: compile check, file existence, acceptance criteria
│   ├── golden-comparator.ts              # Deep tier: compare against reference outputs
│   ├── cross-phase-analyzer.ts           # Deep tier: upstream → downstream coherence
│   └── rubric-scorer.ts                  # Deep tier: multi-dimension weighted scoring
├── fixtures/
│   ├── concepts/                         # Canonical test concepts
│   │   └── cli-task-tracker.yaml
│   ├── golden/                           # Reference outputs per concept per phase
│   │   └── cli-task-tracker/
│   │       └── analysis.yaml
│   └── rubrics/                          # Scoring dimensions per phase
│       ├── analysis.yaml
│       ├── planning.yaml
│       ├── solutioning.yaml
│       └── implementation.yaml
└── __tests__/
    ├── types.test.ts
    ├── adapter.test.ts
    ├── eval-engine.test.ts
    ├── reporter.test.ts
    ├── prompt-compliance.test.ts
    ├── impl-verifier.test.ts
    ├── golden-comparator.test.ts
    ├── cross-phase-analyzer.test.ts
    └── rubric-scorer.test.ts

src/cli/commands/eval.ts                  # CLI command, loads artifacts from decision store
```
