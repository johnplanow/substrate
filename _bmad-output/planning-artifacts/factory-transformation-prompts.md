# Substrate Software Factory — Phase Prompts

**Created:** 2026-03-21
**Purpose:** Context-rich prompts for each BMAD phase. Each prompt provides situational context and open questions — the agent's elicitation process drives the decisions.
**Sequence:** Technical Research → Product Brief → PRD → Architecture → Epics & Stories → Sprint Planning → Execute

## Primary Reference Documents

These specs are the implementation targets. All phases should read them directly:

- `docs/reference/attractor-spec.md` — Attractor pipeline runner spec (2,090 lines). Defines the graph-structured pipeline model: DOT syntax, node types, edge selection algorithm, goal gates, checkpointing, model stylesheet, validation/linting rules.
- `docs/reference/coding-agent-loop-spec.md` — Coding agent loop spec (1,467 lines). Defines how each pipeline node executes: agentic reasoning loop, tool dispatch, output truncation, fidelity modes, loop detection, mid-task control (steer/follow_up), subagent spawning.
- `docs/reference/unified-llm-spec.md` — Unified LLM client spec (2,169 lines). Defines the provider abstraction: 4-layer architecture, provider adapters, error handling, cost optimization, tool calling, model catalog.
- `docs/strongdm-software-factory-report.md` — Research report on StrongDM's factory methodology, techniques, and the broader ecosystem (community implementations, CXDB, weather report).

---

## Phase 0: Technical Research

**Command:** `/bmad-bmm-technical-research`

**Prompt:**

Create a technical research report on implementing a Software Factory based on the Attractor specification and StrongDM's factory methodology.

PRIMARY SOURCES (read these in full — they are in the repo):
- docs/reference/attractor-spec.md — the Attractor pipeline runner specification
- docs/reference/coding-agent-loop-spec.md — the coding agent loop specification
- docs/reference/unified-llm-spec.md — the unified LLM client specification
- docs/strongdm-software-factory-report.md — research report on StrongDM's factory, techniques, community implementations

WHAT SUBSTRATE IS TODAY:
Substrate is an AI agent orchestration CLI (v0.8.6, TypeScript, 39 epics shipped, 5944 tests). Read the existing codebase to understand its architecture: multi-provider routing, telemetry, cost tracking, checkpoint/resume, supervisor, event bus, dispatcher, compiled workflows for SDLC phases.

RESEARCH QUESTIONS:

1. ATTRACTOR SPEC DEEP DIVE
   - What are the exact semantics of each node type (start, exit, codergen, conditional, parallel, parallel.fan_in, tool, wait.human, stack.manager_loop)? What behaviors must an implementation support?
   - How does the 5-step edge selection algorithm work in practice? What are the failure modes?
   - What exactly does goal gate enforcement require? How does retry_target routing interact with convergence budgets?
   - What does the DOT graph validation/linting surface cover? What are errors vs. warnings?
   - How does the model stylesheet (CSS-like specificity) work? What are the resolution rules?
   - What's the checkpointing contract? What state must be serialized per node?

2. CODING AGENT LOOP DEEP DIVE
   - How does the agentic reasoning loop work step by step? What are the termination conditions?
   - How does loop detection work (last N tool call signatures)? What's the steering injection mechanism?
   - What are the fidelity modes (full, truncate, compact, summary) and when is each appropriate?
   - How do subagents work? What's shared (filesystem) vs. independent (conversation history)? What's the depth limit?
   - How does mid-task control (steer, follow_up) integrate with the tool dispatch cycle?
   - What are the output truncation strategies and why are there two phases (character then line)?

3. UNIFIED LLM CLIENT DEEP DIVE
   - What does the 4-layer architecture look like concretely? How does application code remain provider-agnostic?
   - What are the provider-specific tool conventions (Anthropic edit_file, OpenAI apply_patch, Gemini conventions)?
   - How does prompt caching work across providers? What's the automatic vs. explicit annotation difference?
   - What's the error taxonomy and retry strategy?

4. SUBSTRATE GAP ANALYSIS
   For each Attractor capability, map it to what substrate already has, what's partially there, and what's missing entirely. Be specific — reference actual source files and modules. The goal is to know exactly what we're building vs. reusing.

5. COMMUNITY IMPLEMENTATION LESSONS
   The StrongDM report mentions 16+ community implementations. Based on the report's descriptions: what patterns emerge? What did multiple implementations get wrong? What design decisions were controversial? Arc (TypeScript/Effect.ts), Fabro (Rust), and Kilroy (Go) are the most mature — what can we learn from their approaches?

6. FACTORY METHODOLOGY
   Beyond the Attractor spec (which is the pipeline runner), the factory methodology includes: scenarios vs. tests, digital twin universe, gene transfusion, shift work, semport, pyramid summaries. How do these techniques map to substrate's existing patterns? Which ones are essential for a v1 factory vs. nice-to-have?

OUTPUT:
A structured research report that subsequent phases (product brief, PRD, architecture) can reference. Focus on implementation-relevant findings — not summaries of what each spec says, but analysis of what they mean for substrate specifically.

---

## Phase 1: Product Brief

**Command:** `/bmad-bmm-create-product-brief`

**Prompt:**

I want to create a product brief for transforming Substrate into a Software Factory.

WHAT SUBSTRATE IS TODAY:
Substrate is an AI agent orchestration CLI (v0.8.6, TypeScript, 39 epics shipped, 5944 tests). It orchestrates multi-agent SDLC pipelines: analysis → planning → solutioning → implementation, dispatching work to Claude, Codex, and Gemini CLI agents. It has multi-provider routing with auto-tuning, telemetry-driven optimization, cost tracking, checkpoint/resume, and a supervisor with stall detection and auto-recovery. It's been cross-project validated on a TypeScript/SvelteKit app and a Go/Next.js/Node.js Turborepo monorepo.

THE VISION:
Transform substrate into an autonomous software factory — a system where humans define intent (seeds + scenarios) and agents iteratively implement, validate, and converge until the software satisfies the scenarios. Implementing the Attractor specification as the pipeline engine, built on substrate's existing strengths.

CONTEXT DOCUMENTS (read all of these):
- Read the Phase 0 technical research report we just completed — it contains the gap analysis, spec deep dives, and implementation-relevant findings
- Read docs/reference/attractor-spec.md — the primary spec we're implementing
- Read docs/reference/coding-agent-loop-spec.md — the agent execution model
- Read docs/reference/unified-llm-spec.md — the provider abstraction
- Read docs/strongdm-software-factory-report.md — factory methodology and community ecosystem
- Read the existing codebase to understand what substrate already has

KEY AREAS TO EXPLORE (these are open questions, not conclusions):
- Where is the boundary between substrate's existing SDLC pipeline and the new factory capabilities? Should they be the same product, separate products sharing a core library, or something else?
- How does the pipeline execution model need to evolve? Substrate's current model is a fixed linear phase sequence. The factory model implies loops, branching, and convergence. What's the right generalization?
- How should quality be measured? Substrate uses code-review verdicts. The factory model uses external holdout scenarios with probabilistic satisfaction scoring. What's the migration path between these?
- What role do digital twins play, and when do they become necessary vs. nice-to-have?
- How does context management need to change for longer autonomous sessions?
- Substrate has planned but unbuilt Epics 32 (Core Extraction), 33 (Validation Harness), 34 (Autonomous Execution). How do these relate to the factory vision? Are they subsumed, evolved, or independent?

HARD CONSTRAINTS:
- Backward compatibility: existing `substrate run` behavior must keep working
- All 5944 existing tests must remain green at every stage
- Multi-provider support (Claude, Codex, Gemini) preserved
- Language-agnostic: must work on any project stack
- CLI tool / local daemon — not a hosted service

Challenge me on scope, priorities, and assumptions. I want this brief to be thorough enough that the PRD phase has no ambiguity about what we're building and why.

---

## Phase 2: PRD

**Command:** `/bmad-bmm-create-prd`

**Prompt:**

Create a PRD from the product brief we just completed for the Substrate Software Factory transformation.

CONTEXT:
Reference the product brief we just created and the Phase 0 technical research report. Also read the primary Attractor specs directly (docs/reference/attractor-spec.md, coding-agent-loop-spec.md, unified-llm-spec.md) and docs/strongdm-software-factory-report.md for factory methodology. Read the existing codebase for substrate's current capabilities.

AREAS THE PRD MUST ADDRESS (dig deep on each — don't accept surface-level answers):

1. MIGRATION STRATEGY
   The existing SDLC pipeline has 39 epics of battle-tested logic. How do we evolve it without breaking it? What's the compatibility contract? Can users opt into factory features incrementally, or is there a switchover point?

2. THE BOOTSTRAP PROBLEM
   The factory validates software through holdout scenarios. But the factory itself is software. How does it validate itself? This recursion needs an explicit answer — not a hand-wave. We've done cross-project validation runs on ynab and nextgen-ticketing — does that pattern scale to self-validation?

3. ACCEPTANCE CRITERIA
   Each major capability needs crisp, testable acceptance criteria. Push for specifics: what does "done" look like for the graph engine? For scenario validation? For the convergence loop? For core extraction? Vague ACs produce vague implementations.

4. QUALITY MODEL TRANSITION
   Today: code-review verdicts (SHIP_IT / NEEDS_MINOR_FIXES / escalate). Factory: probabilistic satisfaction scoring from holdout scenarios. These are fundamentally different quality philosophies. How do we transition? Run both in parallel? Phase one out? Keep both for different contexts?

5. RISK REGISTER
   What can go wrong, and what's the mitigation? Think about: graph engine complexity, DTU fidelity, satisfaction scoring calibration, core extraction destabilizing the existing pipeline, performance regression, scope creep.

6. WHAT'S OUT OF SCOPE
   This is as important as what's in scope. Push me to cut things that don't belong in the first version.

Challenge every assumption. If something in the product brief is vague or hand-wavy, call it out and force a decision.

---

## Phase 3: Architecture

**Command:** `/bmad-bmm-create-architecture`

**Prompt:**

Create a technical architecture for the Substrate Software Factory based on the PRD we just completed.

CONTEXT:
Reference the PRD for requirements and acceptance criteria, and the Phase 0 technical research report for the gap analysis and spec deep dives. Read the Attractor specs directly — the architecture must implement the spec's semantics:
- docs/reference/attractor-spec.md — graph model, node types, edge selection, goal gates, checkpointing, model stylesheet
- docs/reference/coding-agent-loop-spec.md — agent execution model, tool dispatch, fidelity modes, subagents
- docs/reference/unified-llm-spec.md — provider abstraction layers
- docs/strongdm-software-factory-report.md — factory methodology
Read the existing codebase to understand current module boundaries, interfaces, and patterns.

OPEN ARCHITECTURAL QUESTIONS (these need decisions, not assumptions):

1. THE EXTRACTION BOUNDARY
   What goes into substrate-core vs. stays in the SDLC consumer vs. is new for the factory? This is the most consequential decision. Read the actual module code — don't guess from names. Some modules that seem general-purpose may have SDLC-specific assumptions baked in. Some SDLC modules may have general-purpose cores worth extracting.

2. GRAPH ENGINE
   Pipeline definition format, node type system, edge evaluation strategy, state serialization, and how the existing ImplementationOrchestrator maps to graph semantics. Read the orchestrator code — it's ~2700 lines of battle-tested logic. The graph engine needs to preserve that value, not discard it.

3. SCENARIO VALIDATION
   Where scenarios live, their format, how they're executed, how results feed into satisfaction scoring, and how the graph engine's goal gates consume scores. The key design tension: scenarios must be invisible to dev agents but accessible to the validation infrastructure.

4. PERSISTENCE EVOLUTION
   Substrate currently uses Dolt + SQLite via DatabaseAdapter. The factory adds new state: graph execution state, scenario results, conversation DAGs. Where does each live? Is the current DatabaseAdapter sufficient or does it need evolution?

5. INTEGRATION CONTRACTS
   The interfaces between substrate-core, the SDLC consumer, and the factory consumer. These contracts determine whether the extraction succeeds or creates a maintenance nightmare. Define them as TypeScript interfaces with clear ownership rules.

6. CLI SURFACE
   How does the user interact with factory capabilities? New commands? Extensions to existing commands? How do they define, validate, and run pipeline graphs?

Read the code before making decisions. Propose, then challenge your own proposals. I want an architecture that's grounded in what actually exists, not what we imagine exists.

---

## Phase 4: Epics & Stories

**Command:** `/bmad-bmm-create-epics-and-stories`

**Prompt:**

Create epics and stories from the architecture document we just completed for the Substrate Software Factory.

CONTEXT:
Reference the architecture document for component boundaries, integration contracts, and technical decisions. Reference the PRD for acceptance criteria. Reference the Phase 0 technical research report for spec-level details — stories that implement Attractor node types, edge selection, or goal gates should trace back to specific sections in docs/reference/attractor-spec.md. Read the existing codebase to understand current test patterns and story sizing conventions — look at `_bmad-output/implementation-artifacts/` for examples of well-scoped stories from previous epics.

SEQUENCING CONSTRAINTS:
- Each epic must be independently shippable and testable
- The existing SDLC pipeline (`substrate run`) must remain functional at every stage — no big-bang migration
- Early epics should produce visible, usable improvements — not just plumbing
- The dependency chain from the architecture must be respected
- Each major epic boundary is a validation checkpoint

STORY QUALITY REQUIREMENTS:
- Each story must have clear, testable acceptance criteria (look at existing stories in _bmad-output/implementation-artifacts/ for the expected level of specificity)
- Stories should be sized for single-agent implementation (1-3 files, well-bounded scope)
- Include integration test stories at the end of each epic to verify cross-module wiring
- Include a cross-project validation story for each major epic (run against a reference project to verify real-world behavior)
- Stories that touch the extraction boundary need explicit "existing tests still pass" acceptance criteria

WHAT TO AVOID:
- Stories that are too large (touching 10+ files across multiple modules)
- Stories that require decisions the architecture didn't make
- Stories with vague ACs like "it should work" or "it should be fast"
- Epics that can't be shipped independently

Push back if the architecture has gaps that make story decomposition impossible. Better to surface those gaps now than discover them during implementation.

---

## Phase 5: Sprint Planning & Execution

**Command:** `/bmad-bmm-sprint-planning`

Then execute:

```bash
substrate run --events --stories <first-sprint-story-keys>
```

EXECUTION STRATEGY:
- Start with the first epic (likely Core Extraction). Run it through substrate's pipeline, validate cross-project, and confirm all existing tests pass before proceeding.
- Each major epic boundary is a checkpoint. Do not proceed to the next epic until the current one is validated.
- If the pipeline escalates stories, read the escalation context and fix substrate bugs in substrate (per existing feedback: never work around substrate bugs in target projects).
- Attach the supervisor for long-running sprints: `substrate supervisor --output-format json`
