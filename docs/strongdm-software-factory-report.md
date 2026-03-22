# 🏭 StrongDM Software Factory — Comprehensive Research Report

*Purpose: Understand the system well enough to build one with AI agents*
*Date: March 21, 2026*

---

## 1. WHAT IT IS

The StrongDM Software Factory is an **autonomous AI-driven software development system** — a "dark factory" where code is written, tested, iterated, and converged on without human code review. Founded July 14, 2025 by Justin McCarthy (CTO), Jay Taylor, and Navan Chauhan.

**Three founding laws:**
1. Code **must not** be written by humans
2. Code **must not** be reviewed by humans
3. Teams should spend **at least $1,000/day on tokens per engineer**

The key enabling event was Claude 3.5's October 2024 revision, which made "long-horizon agentic coding workflows" compound *correctly* rather than accumulate errors — the inflection point that made all of this viable.

---

## 2. CORE PRINCIPLES (The Loop)

### The Factory Loop
```
Seed → Validation Harness → Feedback Loop
```

**Seed:** Starting input. Can be a few sentences, a screenshot, or an existing codebase — the human's job is to define *intent*.

**Validation Harness:** End-to-end, as close to the real environment as possible. Must cover customers, integrations, economics.

**Feedback Loop:** Runs until holdout scenarios pass and *stay* passing. The constraint: *"For every obstacle, ask: how can we convert this problem into a representation the model can understand?"*

### Scenarios, Not Tests
The biggest conceptual innovation. Instead of unit/integration tests (which agents can "cheat" by writing tests that match their own bad implementations), StrongDM uses **scenarios**: end-to-end user stories stored *outside* the codebase as holdout sets. Agents never see them directly; they only learn whether the scenarios passed.

**Satisfaction metric:** Not boolean pass/fail. Instead: *"What fraction of observed trajectories through all scenarios likely satisfy the user?"* — a probabilistic score.

---

## 3. THE DIGITAL TWIN UNIVERSE (DTU)

The most technically ambitious component. The DTU consists of **behavioral clones of third-party services**: Okta, Jira, Slack, Google Docs/Drive/Sheets, and others.

**How it's built:** Feed public API documentation to agents → agents produce self-contained binaries that imitate the services.

**What this enables:**
- Validate at **volumes far exceeding production limits** (thousands of scenarios/hour)
- Test **dangerous failure modes** safely (what happens if Okta is down, Slack rate-limits, etc.)
- **Deterministic, replayable** test conditions (no flakiness from external services)
- Previously economically infeasible infrastructure is now routine

This is the leverage point that makes the whole system scale.

---

## 4. TECHNIQUES (The Toolkit)

Seven named techniques, each a reusable pattern:

| Technique | What It Is |
|---|---|
| **Digital Twin Universe** | Behavioral clones of third-party deps for high-volume testing |
| **Gene Transfusion** | Move working patterns between codebases by pointing agents at exemplars — a solution + a good reference = reproducible in new contexts |
| **The Filesystem** | Use directories, indexes, and on-disk state as a practical memory substrate. Models navigate repos and adjust their own context by reading/writing files |
| **Shift Work** | Separate interactive work from fully-specified work. When intent is complete (specs, tests, existing apps), agents run end-to-end without back-and-forth |
| **Semport** | Semantically-aware automated ports (one-time or ongoing). Move code between languages/frameworks while preserving intent |
| **Pyramid Summaries** | Reversible summarization at multiple zoom levels. Compress context without losing the ability to expand back to full detail |

---

## 5. ATTRACTOR — THE CODING AGENT

**Attractor** is StrongDM's open-source implementation of a non-interactive coding agent, released under Apache 2.0 at [github.com/strongdm/attractor](https://github.com/strongdm/attractor) (974 stars, 159 forks).

### Architecture: Graph-Structured Pipeline
Attractor represents the SDLC as a **directed graph defined in Graphviz DOT syntax**. Each node = a phase of work with a core LLM prompt. Edges = transitions, expressed in natural language and **evaluated by the LLM itself**.

**Example pipeline:**
```
Start → Implement → Optimize → Validate → Complete
         ↑__________________________|  (loop on failure)
```

### Node Types

| Handler | Shape | Purpose |
|---|---|---|
| `start` | Mdiamond | Entry point (no-op) |
| `exit` | Msquare | Exit with goal gate enforcement |
| `codergen` | box | Default LLM task node |
| `wait.human` | hexagon | Human-in-the-loop approval gate |
| `conditional` | diamond | Routing/branching |
| `parallel` | component | Concurrent branch execution |
| `parallel.fan_in` | tripleoctagon | Merge parallel results |
| `tool` | parallelogram | External command/API execution |
| `stack.manager_loop` | house | Supervisor loop for child pipelines |

### Edge Selection (5-step priority algorithm)
1. Condition-matched edges
2. Preferred label match
3. Suggested next IDs from last outcome
4. Highest weight
5. Lexical tiebreak on target node ID

### Key Properties
- **Deterministic** given same inputs
- **Observable** at every node transition (full event stream)
- **Resumable** from any checkpoint (serializable state after each node)
- **Composable** — graphs can contain subgraphs

### Model Stylesheet (CSS-Like Routing)
```css
* { llm_model: claude-sonnet-4-5; }
.code { llm_model: claude-opus-4-6; reasoning_effort: high; }
#critical { llm_model: gpt-5.2; }
```
Specificity: universal < shape < class < ID. Lets you route different nodes to different models.

### Goal Gates
Nodes marked `goal_gate=true` must reach SUCCESS before exit. On failure they route to a `retry_target`. If none exists, pipeline fails. This is how the feedback loop enforces convergence.

### State & Checkpointing
```
{logs_root}/
    checkpoint.json         # Full run state
    manifest.json           # Metadata
    {node_id}/
        status.json         # Outcome, routing hint
        prompt.md           # Rendered prompt
        response.md         # LLM response
    artifacts/
        {artifact_id}.json  # Large file artifacts (>100KB)
```

### DOT Graph Attributes
- **Graph-level:** `goal`, `label`, `model_stylesheet`, `default_max_retries`
- **Node-level:** `prompt`, `max_retries`, `goal_gate`, `fidelity`, `thread_id`, `class`, `timeout`
- **Edge-level:** `label`, `condition`, `weight`, `fidelity`, `loop_restart`

### Validation / Linting Rules
**Errors (fail execution):**
- Exactly one start node
- Exactly one exit node
- All nodes reachable from start
- Edge targets must exist
- Start has no incoming edges; exit has no outgoing edges

**Warnings (execution allowed):**
- Unrecognized node types
- Invalid fidelity modes
- Goal gate nodes without retry targets
- Missing prompts on LLM nodes

---

## 6. THE CODING AGENT LOOP (How Each Node Runs)

Each `codergen` node runs an **agentic reasoning loop**:

```
Build request → Call LLM → Dispatch tools → Execute → Truncate output →
Append to history → Loop until text-only response
```

### Tool Design: Provider-Aligned
Rather than a universal toolset, tools match what each LLM was trained on:
- **Anthropic:** `edit_file` (old_string/new_string)
- **OpenAI:** `apply_patch` (v4a format)
- **Gemini:** gemini-cli conventions
- **All providers:** `read_file`, `shell`, `grep`, `glob`

### Termination Conditions
- Model returns text-only (task complete)
- Turn limit exceeded
- Abort signal
- Unrecoverable error (auth failure)

### Loop Detection
Tracks last N tool call signatures (default: 10). If a repeating pattern is detected, injects a warning steering message redirecting the model. Prevents infinite cycles.

### Mid-Task Control
- **`steer()`** — inject messages after current tool round (real-time redirection)
- **`follow_up()`** — queue messages for after current input finishes

### Output Truncation Strategy
Two-phase: character-based first (handles pathological cases like 10MB single-line files), then line-based. Truncation inserts visible markers. Full untruncated output always reaches the event stream for logging/UI.

### Context/Fidelity Modes

| Mode | Behavior |
|---|---|
| `full` | Reused session thread |
| `truncate` | Fresh session, raw truncation |
| `compact` | Fresh session, compact context |
| `summary:low/medium/high` | Fresh session, LLM-summarized context |

### System Prompt Layering
Provider-specific base → environment context (platform, git state, cwd) → tool descriptions → project docs (AGENTS.md, CLAUDE.md) → user overrides

### Subagents
Agents can spawn child sessions for scoped parallel tasks. Subagents share the parent's execution environment (same filesystem) but maintain independent conversation history. Depth is limited to prevent recursive spawning.

### Session Configuration
- `max_turns` and `max_tool_rounds_per_input` — iteration bounds
- `default_command_timeout_ms` — default 10 seconds
- `tool_output_limits` / `tool_line_limits` — truncation thresholds
- `reasoning_effort` — "low", "medium", "high"

---

## 7. UNIFIED LLM CLIENT (The Provider Abstraction)

Four-layer architecture:
1. **Provider Specification** — interface contracts and shared types
2. **Provider Utilities** — HTTP, SSE parsing, retry logic
3. **Core Client** — request routing + middleware orchestration
4. **High-Level API** — `generate()`, `stream()`, `generate_object()`

**Key design:** Application code has zero provider-specific logic. Switch providers by changing a model string.

**Supported providers:** Anthropic (Claude), OpenAI (GPT-5 series via Responses API), Google (Gemini 3.x)

**Each adapter must use the provider's native API** — not compatibility layers — to access advanced features like reasoning tokens and prompt caching.

### Error Handling
- `ProviderError` (with `retryable` flag)
- `AuthenticationError`, `RateLimitError`, `ContentFilterError`
- Exponential backoff with jitter; respects `Retry-After` headers
- Only retryable (transient) errors trigger auto-retry; client mistakes (401, 400) do not

### Cost Optimization
Prompt caching reduces costs 50–90% for repeated contexts. OpenAI and Gemini cache automatically. Anthropic requires explicit `cache_control` annotations (injected automatically by the adapter).

### Tool Calling
- Tools defined with name, description, JSON Schema parameters
- Multiple tool calls executed **concurrently**; all results sent in a single continuation
- `max_tool_rounds` limits loops

### Model Catalog
Ships with known models, capabilities, and pricing — helps agents reliably select valid identifiers without hallucinating model names.

---

## 8. CXDB — THE CONTEXT STORE

Open-source context database for AI agents. Stores conversation histories as **immutable DAGs**.

**Why not logs:** LLM conversations are append-mostly, branching, typed, and long-lived — flat logs don't model this.

**Key features:**
- **Turn DAG:** Branches share history up to fork point. Forking is O(1) (new head pointer).
- **Blob CAS:** Content-addressable storage for deduplication
- **Dynamic type system**
- **Self-hosted:** You own your data
- **Visual debugger** included

**Scale:** 16,000 lines Rust + 9,500 lines Go + 6,700 lines TypeScript

**Use case example:**
```
Turn 1 → Turn 2 → Turn 3 → Turn 4a (approach A fails) → Turn 5a
                          ↘ Turn 4b (fork: try B)      → Turn 5b (succeeds)
Both branches share turns 1–3. Forking is O(1).
```

---

## 9. THE WEATHER REPORT (Model Routing in Practice)

StrongDM publishes a live internal model routing guide, updated frequently. As of March 2026:

| Task | Model | Reasoning Level |
|---|---|---|
| Implementation (default) | gpt-5.3-codex | Default |
| Architectural critique | gpt-5.4 | Extra High |
| Sprint planning | opus-4.6 + gpt-5.4 consensus | High / Extra High |
| Frontend aesthetics | opus-4.6 | Default |
| Frontend architecture | gpt-5.3-codex | Default |
| DevOps/QA | opus-4.6 | Default |
| Security review | gpt-5.3-codex | High |
| Image comprehension | gemini-3-flash-preview | Default |
| UX ideation | gemini-3-pro-image-preview | Default |
| Agentic dialogues | gemini-3-flash-preview | Default |
| Voice (interactive) | gpt-realtime-1.5 | Default (internal only) |
| Bulk tasks | Any | Scaled by need |

**Takeaway:** No single model dominates. Match model to cognitive task type.

---

## 10. COMMUNITY IMPLEMENTATIONS OF ATTRACTOR

The Attractor spec is open — 16+ community implementations exist:

| Project | Language | Standout Feature |
|---|---|---|
| **Fabro** (Bryan Helmkamp) | Rust | Graphviz DOT graphs, CSS-like model routing, Daytona VM sandboxing, git checkpointing |
| **Kilroy** (Dan Shapiro) | Go | CLI that converts English requirements → Attractor pipelines, isolated git worktrees |
| **Forge** (Luke Buehler) | Rust | Layered crates, deterministic conformance testing across providers |
| **samueljklee's** | Python | 100% spec coverage, HTTP server + SSE streaming, goal-gate circuit breaker |
| **coreydaley's** | Java | 37-endpoint REST API, SQLite/MySQL/Postgres checkpointing, web dashboard |
| **F#kYeah** | F# | .NET 10, 317 tests, CSS-like model routing, full checkpoint/resume |
| **Arc** (Point Labs) | TypeScript | Effect.ts, fresh context windows per attempt, persistent learnings from failures, web dashboard |
| **amolstrongdm's** | Python | Multi-agent factory with probabilistic satisfaction scoring, DTU support |
| **attractor-software-factory** | Python | 5 ready-to-run DOT blueprints (login, REST API, CLI, landing page, data pipeline) |
| **Dark Factory** (DeepCreative) | Python | Kubernetes-native, Judge-01 Scenario Eval, trained D3N models |
| **attractor-c** | C | Pure C11, hand-written DOT parser, self-referential validation |
| **attractor-rb** | Ruby | 13 built-in linting rules, parallel fan-out/fan-in |

---

## 11. HOW TO BUILD ONE — BLUEPRINT

### Phase 1: Seed + Validation Harness
1. Define your target software domain
2. Write **scenarios** (end-to-end user stories) — store them *outside* the codebase as holdout sets
3. Define your **satisfaction metric** (probabilistic score, not boolean pass/fail)
4. Build or adopt a **Digital Twin** for each critical external dependency

### Phase 2: The Coding Agent (Attractor)
- **Fastest path:** Supply `https://github.com/strongdm/attractor` to Claude Code and say *"Implement Attractor as described"*
- Or pick a community implementation in your language of choice
- Design your **DOT pipeline graph** (Seed → Implement → Validate loop with goal gate)
- Configure **model routing** via stylesheet

### Phase 3: Infrastructure
- **CXDB** (or equivalent) for conversation history / context storage
- **Checkpoint storage** for run resumability and crash recovery
- **DTU** for each external service dependency
- **Event stream** for observability (every node transition emits events)

### Phase 4: The Loop
- Run Attractor against your scenario holdout set
- Measure satisfaction score
- Iterate until convergence (scenarios pass and stay passing)

### Quickstart (Minimal Viable Factory)
```
1. Pick an Attractor implementation (Python samueljklee's or TypeScript Arc are well-documented)
2. Write 3–5 scenarios for your target feature
3. Define a simple DOT graph: start → implement → validate → exit
4. Run Attractor with your scenarios as the validation harness
5. Iterate
```

---

## 12. KEY INSIGHTS FOR BUILDERS

1. **Scenarios > Tests.** Tests written by agents can be gamed. External holdout scenarios cannot.
2. **DTU is the unlock.** Without behavioral clones of dependencies, you can't run at scale or test failure modes safely.
3. **Validation replaces code review.** Quality comes from continuous real-world validation, not human gates.
4. **The filesystem is memory.** Don't fight context limits — use the filesystem as a memory substrate (Pyramid Summaries, indexed docs).
5. **Model routing matters.** Different tasks need different models. Treat model selection like CSS specificity — route by node type, not one-size-fits-all.
6. **Shift Work.** Separate interactive (human back-and-forth) from specified (fully autonomous) work. Only send fully-specified work to the factory.
7. **Spend aggressively on tokens.** The $1,000/engineer/day guideline is meant to force you to actually run the loop at meaningful scale.
8. **Resumability is non-negotiable.** Long-running agent pipelines will crash. Design for checkpoint/resume from day one.
9. **Probabilistic satisfaction beats binary pass/fail.** Measure the fraction of trajectories that satisfy users — more robust and honest than boolean test suites.
10. **Human gates are opt-in, not default.** Use `wait.human` nodes surgically (approvals, exceptions) — not as a replacement for the validation harness.

---

## 13. SOURCES

- [StrongDM Blog: The StrongDM Software Factory](https://www.strongdm.com/blog/the-strongdm-software-factory-building-software-with-ai)
- [Simon Willison: Software Factory](https://simonwillison.net/2026/Feb/7/software-factory/)
- [GitHub: strongdm/attractor](https://github.com/strongdm/attractor)
- [factory.strongdm.ai](https://factory.strongdm.ai) — Story, Principles, Techniques, Products, Weather Report pages
- [Attractor Spec](https://raw.githubusercontent.com/strongdm/attractor/refs/heads/main/attractor-spec.md)
- [Coding Agent Loop Spec](https://raw.githubusercontent.com/strongdm/attractor/refs/heads/main/coding-agent-loop-spec.md)
- [Unified LLM Client Spec](https://raw.githubusercontent.com/strongdm/attractor/refs/heads/main/unified-llm-spec.md)
