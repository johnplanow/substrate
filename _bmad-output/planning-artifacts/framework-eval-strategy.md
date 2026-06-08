# Strategy: evaluating (and maybe incorporating) other agentic frameworks

**Date:** 2026-06-07
**Status:** STRATEGY / epic-seed — thinking artifact, no code yet. Decision: **evaluate-first**; incorporation deferred and conditional on eval results.
**Parent thread:** the methodology-swap question parked by the 2026-05-31 pack-abstraction audit (see `backlog-pack-methodology-abstraction.md` and Epic 81's "distinct from the methodology-swap question" principle). This generalizes Epic 81 from *pack-version* A/B to *framework-level* A/B.

## The goal

Use substrate's eval substrate (Epic 77/81) to **comparatively measure** other software-building agentic frameworks — Ralph loops, GSD (open-gsd/gsd-core), Lattice (techygarg/lattice), and BMad — on the same tasks, the same axes. Evaluate first; only consider *incorporating* a framework as a production backend if the eval says it's worth it.

## The shape spectrum (grounded, 2026-06-07)

Two of the three named alternatives turn out to be the **same execution shape as BMad**:

| Framework | Shape | Distance from substrate's model |
|---|---|---|
| **BMad** (substrate today) | phased pipeline: analysis→planning→solutioning→implementation→review | native |
| **Lattice** (techygarg/lattice) | phased pipeline: requirement-forge→design-blueprint→code-forge→review; Atoms/Molecules/Refiners; Claude Code slash commands; human-gated | **same family** — differs in methodology *content* + interaction model, not shape |
| **GSD** (open-gsd/gsd-core) | methodology-as-code, spec→plan→build (phase-shaped) | **same family** (to confirm in discovery) |
| **Ralph loops** | single agent in `while(true)` with a fixed prompt grinding a task list — no phases, no stories, no per-step gates | **outlier** — a different execution *primitive*, not a pack |
| **Claude Code native** | plan mode (planning phase) + skills (methodology prompts) + subagents/Workflow tool (multi-agent orchestration) + `/goal` (autonomous completion loop) | **the baseline** — see below; it already ships most of the pieces |

**Implication:** "incorporate a framework" is two different problems. GSD/Lattice are the *pack-generalization* problem (they'd plug into substrate's existing phased orchestrator once the pack abstraction is generalized — the methodology-abstraction backlog). Ralph is the *new-execution-mode* problem. But for **evaluation**, this distinction mostly dissolves — see the equalizer.

## The equalizer: they all ultimately drive Claude Code

The single most important insight for *fair* evaluation: **every one of these frameworks bottoms out in driving an LLM (Claude Code) to edit a repo.**
- BMad-via-substrate: substrate dispatches `claude-code` under the BMad pack.
- Lattice: Claude Code runs lattice slash commands.
- Ralph: a loop calls `claude` with a fixed prompt.
- GSD: invokes its runner, which calls a model.

So a framework is, for eval purposes, **an orchestration wrapper around a fixed model.** Hold the model constant (all on `claude-haiku/sonnet/opus`), vary the wrapper, and the measured delta is attributable to the *framework/methodology* — not to model differences. That is the fairest comparison achievable, and it's mechanically reachable because they're all Claude-Code-drivable. This is the conceptual backbone of the whole effort.

## The baseline nobody named: Claude-Code-native orchestration

Claude Code increasingly ships the *primitives* these external frameworks provide:
- **plan mode** ≈ a planning phase
- **skills** ≈ methodology-prompt loading (substrate's "packs" / lattice's "molecules")
- **subagents + the Workflow tool** ≈ multi-agent orchestration (substrate's fan-out/parallel dispatch)
- **`/goal`** ≈ an autonomous completion loop — *structurally Ralph-shaped* (keep going until a condition holds). Claude Code already ships a Ralph.

So the native harness already covers planning, methodology-prompts, multi-agent orchestration, and an autonomous loop — most of what BMad / Lattice / substrate add as external scaffolding. That makes **"Claude Code native" the control arm**, and reframes the entire effort:

> The question is not "which external framework wins?" It is **"does ANY external framework (or substrate's own orchestration) beat the Claude-Code-native baseline at fixed budget?"**

Every A/B in this strategy should include native as the control. If an external framework can't beat plan-mode + skills + subagents + `/goal` on the neutral axes at equal cost, the honest conclusion is "use native, drop the scaffolding."

### The recursive edge (name it explicitly)

Substrate is itself *external orchestration on top of Claude Code.* As native orchestration catches up (subagents, `/goal`, Workflow), substrate's own value-add over native is no longer self-evident — it has to be *measured*. The same harness that evaluates BMad/Ralph/GSD/Lattice can, and should, measure **substrate-vs-native** on identical tasks. That is an existential self-assessment for the project, and it's better to run it deliberately than to discover the answer by attrition. Substrate's defensible niche may narrow to what native *doesn't* do well (durable multi-day pipelines, Dolt-versioned state, cross-session recovery, cost-ceiling governance, the eval substrate itself) — and the eval will say which parts of that still hold.

## The asset we already have

Three of the five Epic 81 grader axes are **already framework-neutral** — they grade the *artifact*, not the process:
- **code-quality** (file-set Jaccard vs ground-truth diff)
- **cost** (turns/tokens — real since 81-9)
- **work-quality** (test-share — since 81-10)

The two BMad-coupled axes — **verdict** (reads substrate's SHIP_IT vocabulary) and **recovery** (reads substrate's Tier-A/B/C taxonomy) — are exactly the coupling that `backlog-pack-methodology-abstraction.md` items B (verdict→model routing extraction) and C (recovery-taxonomy extraction) were filed to remove. **Framework eval and that backlog are the same work from two angles.** For a first pass, the three neutral axes suffice; the coupled axes are N/A for non-BMad frameworks until extracted.

## The crux: a *fair-comparison* harness (the operator's flagged gap)

"We still have work to do to make a fair corpus" — correct, and it's bigger than corpus *content*. A fair cross-framework harness must normalize **five** dimensions:

1. **Corpus neutrality.** Task specs must not be authored in any one framework's idiom; the ground-truth must not favor a particular decomposition. (Today's corpus is substrate-self, BMad-idiom, archetype-monotone — see the Epic 81 diversity-ceiling finding. This is the hardest part.)
2. **Interaction normalization.** Lattice and GSD are *human-in-the-loop by design* (they prompt on "genuine decisions"). Running them headless in an A/B requires auto-advancing their decision gates — which may itself be *unfair* to a framework built around human judgment. Need an explicit, documented headless-driving policy per framework, and an honest note that headless mode may not reflect the framework's intended use.
3. **Execution-shape normalization.** A common runner interface — `run(framework, task, worktree, budget) → envelope` — that works for both a phased pipeline and a `while(true)` loop. This is the "framework-as-dispatch-backend" adapter, one level above substrate's existing CLI-agent adapters (claude/codex/gemini).
4. **Outcome normalization.** "Did it succeed" is SHIP_IT (BMad) vs loop-halt (Ralph) vs human-approval (Lattice). Need a framework-neutral success definition — e.g. *build passes + tests pass + ground-truth-diff overlap ≥ threshold* — computed from the artifact, not the framework's self-report.
5. **Cost/effort normalization.** Ralph runs for hours; a BMad dispatch is ~30 min. Compare at **fixed budget** ("best result each produces for $B") or **cost-per-quality**, never absolute cost.

The deterministic graders (axes 1–3 above) already handle the *scoring*; dimensions 1–5 are about making the *inputs* to those graders fair.

## Proposed roadmap (eval-first)

- **Phase 0 — this doc.** Frame + shape spectrum + the equalizer.
- **Phase 1 — fairness scaffolding (the real work).**
  - (a) the `FrameworkRunner` interface (`run(framework, task, worktree, budget) → envelope`);
  - (b) a neutral outcome definition (build+test+overlap), implemented as a grader input;
  - (c) a small *neutral* task corpus — specs written framework-agnostically, with ground-truth that isn't BMad-decomposition-shaped. (May require authoring fresh tasks rather than harvesting substrate-self history, given the diversity ceiling.)
- **Phase 2 — Ralph black-box spike.** The maximally-contrasting probe: a ~30-line Ralph runner (loop `claude` on a neutral spec in an isolated worktree, budget-capped), graded against BMad-via-substrate on the same task, neutral axes only. Cheap (~$10–30). Purpose: surface the fairness failure modes *concretely* and prove the runner interface holds across shapes.
- **Phase 3 — first three-way A/B with the native control.** BMad-via-substrate vs Lattice vs **Claude-Code-native** (plan mode + skills + subagents + `/goal`) on the same task, model held constant. The native arm is the most decision-relevant: it answers "does the external scaffolding earn its keep?" Requires solving Lattice's headless-driving (dimension 2).
- **Phase 3.5 — substrate-vs-native self-assessment.** The recursive edge: run substrate's full pipeline against Claude-Code-native (`/goal` + subagents) on identical tasks. Honest measurement of where substrate's orchestration still beats native and where it no longer does.
- **Phase 4 — incorporation decision.** Only if eval shows a framework meaningfully beats the native baseline AND substrate on the neutral axes at fixed budget. Then: GSD/Lattice via pack-generalization; Ralph via a new execution mode. Gated on the methodology-abstraction backlog.

## Honest risks / open questions

- **The "fair fight" epistemics.** Headless-driving an interactive framework, or feeding a framework a spec in a foreign idiom, can produce a comparison that's *precise but not valid*. We must be willing to conclude "this comparison isn't fair enough to act on" — same discipline as the Epic 81 "report-only, human reads it" posture.
- **Corpus is the long pole.** Neutral, diverse, ground-truthed tasks don't exist yet and can't be fully harvested from substrate-self history (archetype-monotone). Phase 1(c) may need hand-authored tasks — real effort.
- **Cost.** Multi-framework runs at fixed budget across a corpus are expensive; start with N=1 task, 2 frameworks.
- **Maintenance.** Each framework is a moving target (their own version churn) — the same version-skew discipline that bit the Codex/Claude adapters applies to framework runners.

## Relationship to existing artifacts

- `backlog-pack-methodology-abstraction.md` — the coupling-extraction prerequisites for *incorporation* (Phase 4) and for the verdict/recovery axes.
- Epic 81 (`epic-81-pack-upgrade-ab-validation.md`) — the harness this generalizes; its corpus-diversity ceiling and report-only posture carry over directly.
- `docs/2026-05-31-epic-81-first-calibration.md` — the sensitivity/specificity validation that makes the neutral axes trustworthy enough to point at foreign frameworks.
