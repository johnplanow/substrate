# Eval System Architecture

How substrate evaluates pipeline output quality — from post-run scoring to inline self-eval at phase transitions.

---

## 1. System Overview

The eval system sits alongside the pipeline, not inside it. It reads phase outputs from the decision store, scores them through layered evaluators, and writes results to both JSON files and a queryable database.

```mermaid
graph TB
    subgraph Pipeline["Substrate Pipeline"]
        A[Analysis] --> P[Planning]
        P --> S[Solutioning]
        S --> I[Implementation]
    end

    subgraph Storage["Decision Store"]
        PO[(phase_outputs)]
        D[(decisions)]
        ER[(eval_results)]
    end

    subgraph Eval["Eval Engine"]
        direction TB
        subgraph LLM_Layers["LLM-as-Judge Layers"]
            PC["Prompt Compliance"]
            CPS["Cross-Phase Coherence"]
            GC["Golden Comparator"]
            RS["Rubric Scorer"]
        end
        IV["Impl Verifier<br/><small>deterministic, no LLM</small>"]
        LLM_Layers -->|"assertions"| ADAPTER["PromptfooAdapter"]
        ADAPTER -->|"llm-rubric calls"| JUDGE["Judge LLM"]
    end

    subgraph Output["Results"]
        JSON[".substrate/evals/run-id.json"]
        DB[(eval_results table)]
        RPT["substrate eval --report"]
        CMP["substrate eval --compare"]
    end

    Pipeline -->|"writes raw output"| PO
    Pipeline -->|"writes parsed fields"| D

    PO -->|"loads phase text"| Eval
    D -->|"loads upstream context"| Eval

    Eval -->|"scores + feedback"| JSON
    Eval -->|"persists"| DB
    JSON --> RPT
    DB --> CMP
```

The eval layers don't call the LLM directly. Each layer builds **assertions** (rubric questions with scoring criteria), and the `PromptfooAdapter` translates them into LLM judge calls. The adapter is a seam — swap it to change the judge model or replace promptfoo entirely without touching any layer code.

---

## 2. Evaluation Tiers

Two depth tiers, each additive. Standard runs fast and cheap. Deep adds reference comparisons and multi-dimension rubrics.

```mermaid
graph LR
    subgraph Standard["Standard Tier (~$0.50–2, 2–5 min)"]
        PC2["Prompt Compliance<br/><i>weight: 0.3</i><br/>LLM judge"]
        IV2["Impl Verifier<br/><i>weight: 0.3</i><br/>deterministic"]
        CPC["Cross-Phase Coherence<br/><i>weight: 0.15</i><br/>LLM judge<br/><small>reference-coverage only</small>"]
    end

    subgraph Deep["Deep Tier (~$5–10, 10–15 min)"]
        PC3["Prompt Compliance<br/><i>weight: 0.3</i><br/>LLM judge"]
        IV3["Impl Verifier<br/><i>weight: 0.3</i><br/>deterministic"]
        CPD["Cross-Phase Coherence<br/><i>weight: 0.1</i><br/>LLM judge<br/><small>all 3 dimensions</small>"]
        GC2["Golden Comparator<br/><i>weight: 0.2</i><br/>LLM judge"]
        RS2["Rubric Scorer<br/><i>weight: 0.4</i><br/>LLM judge"]
    end

    Standard -.->|"deep = standard + more"| Deep
```

### Layer Details

| Layer | Tier | Weight | What It Checks |
|-------|------|--------|----------------|
| **Prompt Compliance** | Standard | 0.30 | Did the output follow the prompt's instructions, mission, and quality bar? |
| **Impl Verifier** | Standard | 0.30 | Compile check, file existence, acceptance criteria (impl phase only) |
| **Cross-Phase Coherence (Standard)** | Standard | 0.15 | Does downstream reference upstream? (reference-coverage dimension only) |
| **Golden Comparator** | Deep | 0.20 | How does the output compare to a curated golden example? |
| **Cross-Phase Coherence (Deep)** | Deep | 0.10 | Reference coverage + contradiction detection + information loss |
| **Rubric Scorer** | Deep | 0.40 | Per-dimension scoring against phase-specific YAML rubrics |

Phase score = weighted mean across layers that ran: `sum(weight * score) / sum(weight)`

---

## 3. Self-Eval at Phase Transitions

When enabled, the step runner evaluates each phase's output before advancing. Low scores trigger a retry with diagnostic feedback injected into the prompt.

```mermaid
flowchart TD
    START([Phase Steps Complete]) --> ZOD{Zod Validation}
    ZOD -->|fail| ABORT([Step Failed])
    ZOD -->|pass| CRITIQUE{Critique Loop?}
    CRITIQUE -->|yes| RUN_CRITIQUE[Run Critique Loop]
    CRITIQUE -->|no| CAPTURE
    RUN_CRITIQUE --> CAPTURE[Capture to phase_outputs]

    CAPTURE --> SE_CHECK{Self-Eval<br/>Enabled?}
    SE_CHECK -->|no| DONE([Advance to Next Phase])
    SE_CHECK -->|yes| EVAL["EvalEngine.evaluatePhase()<br/><small>standard depth</small>"]

    EVAL --> SCORE{Score >= Threshold?}
    SCORE -->|yes| DONE
    SCORE -->|no| RETRY_CHECK{Retries Left?}

    RETRY_CHECK -->|yes| INJECT["Inject Feedback:<br/><b>## Previous Output Quality Feedback</b><br/><i>'user_specificity scored 0.45 —<br/>use concrete segments,<br/>not generic personas'</i>"]
    INJECT --> REDISPATCH[Re-run Phase Steps<br/>with Enriched Context]
    REDISPATCH --> EVAL

    RETRY_CHECK -->|no| ON_FAIL{on_fail Config}
    ON_FAIL -->|escalate| ESC([Flag + Continue<br/>with Warning])
    ON_FAIL -->|block| BLOCK([Halt Pipeline])

    style EVAL fill:#e1f0ff,stroke:#4a90d9
    style INJECT fill:#fff3cd,stroke:#d4a017
    style ESC fill:#fde8e8,stroke:#d93025
    style BLOCK fill:#fde8e8,stroke:#d93025
```

### Configuration (thresholds.yaml)

```yaml
self_eval:
  analysis:
    enabled: true
    threshold: 0.65
    max_retries: 1
    on_fail: escalate
  planning:
    enabled: true
    threshold: 0.65
    on_fail: escalate
```

Self-eval is **opt-in per phase** — disabled when not configured. Retries count against the run's cost ceiling. Use `--skip-self-eval` to disable globally.

---

## 4. Run-to-Run Comparison

`substrate eval --compare <runA>,<runB>` loads eval reports from DB (with JSON file fallback), computes per-phase deltas, and flags regressions.

```mermaid
flowchart LR
    subgraph Load["Load Reports"]
        direction TB
        A_DB[(eval_results DB)] -->|"getLatestEvalForRun(runA)"| RA[Report A]
        B_DB[(eval_results DB)] -->|"getLatestEvalForRun(runB)"| RB[Report B]
        A_JSON[".substrate/evals/runA.json"] -.->|"fallback"| RA
        B_JSON[".substrate/evals/runB.json"] -.->|"fallback"| RB
    end

    subgraph Compare["EvalComparer"]
        direction TB
        DELTA["Per-Phase Delta<br/>scoreB - scoreA"]
        META["Metadata Diff<br/><small>git SHA, rubric hashes,<br/>judge model</small>"]
        FLAG{"delta < -threshold?"}
        FLAG -->|yes| REG["REGRESSION"]
        FLAG -->|no & delta > threshold| IMP["Improved"]
        FLAG -->|within threshold| UNC["Unchanged"]
    end

    subgraph Output["Report"]
        TABLE["Table / JSON / Markdown"]
        EXIT["Exit Code<br/>0 = no regression<br/>1 = regression found"]
    end

    RA --> DELTA
    RB --> DELTA
    RA --> META
    RB --> META
    DELTA --> FLAG
    Compare --> TABLE
    Compare --> EXIT

    style REG fill:#fde8e8,stroke:#d93025
    style IMP fill:#e6f4ea,stroke:#1e8e3e
```

### Metadata Awareness

Each eval report includes versioning metadata (V1b-1):

| Field | Purpose |
|-------|---------|
| `schemaVersion` | Detect incompatible report shapes |
| `gitSha` | Know what code produced the scores |
| `rubricHashes` | SHA-256 per rubric file — detect rubric changes |
| `judgeModel` | Which LLM judged the output |

If rubric hashes or judge model differ between runs, the comparison report emits a warning — score differences may reflect config changes, not quality changes.

---

## 5. Data Flow

End-to-end path from pipeline execution through eval to persistent results.

```mermaid
flowchart TD
    subgraph Pipeline["Pipeline Execution"]
        DISPATCH["Agent Dispatch<br/><small>step-runner.ts</small>"] -->|"raw LLM text"| PO_WRITE["upsertPhaseOutput()"]
        DISPATCH -->|"parsed fields"| DEC_WRITE["upsertDecision()"]
    end

    subgraph Store["Persistence Layer"]
        PO_WRITE --> PO_TABLE[(phase_outputs<br/><small>raw text per step</small>)]
        DEC_WRITE --> DEC_TABLE[(decisions<br/><small>parsed key-value</small>)]
    end

    subgraph EvalLoad["Eval: Load Artifacts"]
        PO_TABLE -->|"preferred"| RAW["Raw Output<br/><small>joined with<br/>step-boundary</small>"]
        DEC_TABLE -->|"fallback<br/><small>legacy runs</small>"| SYNTH["key: value<br/>synthesis"]
        RAW --> PHASE_DATA["PhaseData"]
        SYNTH -.-> PHASE_DATA
        PACK["Methodology Pack"] -->|"prompt template"| PHASE_DATA
        UPSTREAM["Upstream Phase Output"] -->|"context"| PHASE_DATA
    end

    subgraph EvalRun["Eval: Score"]
        PHASE_DATA --> ENGINE["EvalEngine.evaluatePhase()"]
        RUBRICS["fixtures/rubrics/*.yaml"] --> ENGINE
        GOLDEN["fixtures/golden/**"] -->|"deep only"| ENGINE
        THRESHOLDS["fixtures/thresholds.yaml"] --> ENGINE
        ENGINE --> RESULT["PhaseEvalResult<br/><small>score, pass, layers,<br/>issues, feedback</small>"]
    end

    subgraph Persist["Eval: Persist Results"]
        RESULT --> REPORT["EvalReport<br/><small>+ metadata</small>"]
        REPORT --> JSON_FILE[".substrate/evals/run-id.json"]
        REPORT --> EVAL_DB[(eval_results table)]
        REPORT --> MANIFEST["RunManifest<br/>self_eval_history<br/><small>Epic 55 only</small>"]
    end

    subgraph Consume["Consumers"]
        JSON_FILE --> CLI_REPORT["substrate eval --report"]
        EVAL_DB --> CLI_COMPARE["substrate eval --compare"]
        MANIFEST --> CLI_STATUS["substrate status"]
    end

    style ENGINE fill:#e1f0ff,stroke:#4a90d9
    style REPORT fill:#e1f0ff,stroke:#4a90d9
```

### Key Design Decisions

- **Raw output preferred over decision synthesis** — eval judges the actual LLM text, not a reconstructed version (G2)
- **Promptfoo behind adapter seam** — `PromptfooAdapter` isolates the dependency; replaceable without touching layers
- **Rubrics in YAML, not code** — editable by anyone who understands the pipeline, not just TypeScript developers
- **Per-phase thresholds** — implementation naturally scores lower (0.685) than analysis (0.775); one threshold doesn't fit all
- **Self-eval reuses the same engine** — no separate judge; `evaluatePhase()` works for both post-run and inline eval

### Viewing Results in promptfoo's Web UI

To persist eval results to promptfoo's cache for visual exploration:

```bash
substrate eval --promptfoo-ui          # run eval + persist to promptfoo cache
npx promptfoo view                     # launch the web UI at localhost:15500
```

The `--promptfoo-ui` flag tells the adapter to write results to promptfoo's output database after each evaluation. This is fire-and-forget — if the write fails, the eval still succeeds and results are still saved to `.substrate/evals/` and the `eval_results` table as usual.
