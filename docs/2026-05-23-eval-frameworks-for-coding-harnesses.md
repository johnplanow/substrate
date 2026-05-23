# Eval Frameworks for Coding Harnesses: How to Build, What Exists, and What Works

## Executive Summary

Evaluating coding agents is fundamentally harder than evaluating LLMs. A standard LLM eval tests a function (input → output → grade). An agent eval tests a *system* with emergent behavior — multi-step trajectories where temperature and randomness compound across dozens of tool calls, file reads, and decisions [1]. Two agents producing identical final code may differ dramatically in cost, latency, and reliability — one reading 3 files, the other reading 30 [1].

The field has matured rapidly in 2025-2026. Anthropic published the definitive conceptual guide ("Demystifying Evals for AI Agents" [2]), while practitioners like Hamel Husain built practical tooling (eval skills for coding agents [3]) and Addy Osmani codified the iterative "hill climbing" workflow [4]. Martin Fowler's team published the authoritative guide on harness engineering [5], establishing the vocabulary of *guides* (feedforward controls) and *sensors* (feedback controls) that now frames the discipline.

Three findings stand out:

1. **The harness matters more than the model.** LangChain's coding agent jumped from #30 to #5 on Terminal Bench 2.0 (52.8% → 66.5%) by changing *only* the harness — system prompts, tools, and middleware — while keeping the model constant [6]. OpenAI found that improving infrastructure around agents mattered more than model improvements [3]. This means evals should measure harness+model as a system, not the model in isolation.

2. **Start with 20-50 real failure cases, not synthetic benchmarks.** Anthropic's guidance is explicit: draw eval tasks from actual production failures, not toy problems [2]. Real failures make better evals than synthetic scenarios. Early in development, large effect sizes mean small samples suffice — you don't need hundreds of test cases to start.

3. **SWE-bench is unreliable as a primary eval.** OpenAI themselves stated that SWE-bench improvements "no longer reflect meaningful improvements in models' real-world software development abilities" [7]. 59% of its problems have flawed test cases, 87% are simple bug fixes, and models achieve 80% on SWE-bench Verified but only 23% on the harder SWE-bench Pro [7][8]. Use it as one signal among many, not as your north star.

The practical recommendation: use Promptfoo or Inspect AI as your eval harness, Anthropic's three-grader framework (code-based + model-based + human) as your methodology, and invest most effort in curating real failure cases from your own codebase rather than chasing benchmark numbers.

## The Conceptual Framework: What to Evaluate

### Agent Evals vs. LLM Evals

Standard LLM evals test input → output. Agent evals must account for [1][2]:

- **Non-determinism compounds**: Random variance cascades through multiple tool calls and decisions, creating run-to-run variance
- **Intermediate steps matter**: The *path* to the answer affects cost, latency, reliability, and maintainability
- **Capability depends on architecture**: A plain LLM can't read files — the agent harness determines what's possible. Evaluating the model alone misses the point

Key terminology from Anthropic's framework [2]:
- **Task**: A single test with defined inputs and success criteria
- **Trial**: One attempt at a task (multiple trials needed due to variance)
- **Grader**: Logic scoring agent performance; tasks can have multiple graders
- **Transcript**: Complete record of a trial (outputs, tool calls, reasoning)
- **Outcome**: Final environmental state after the trial
- **Evaluation harness**: End-to-end infrastructure managing tasks, recording steps, grading, and aggregating results

### What to Measure

**Capability vs. Regression evals** [2]:
- *Capability evals*: Start at low pass rates. Target tasks the agent struggles with. Answer: "What can this do?"
- *Regression evals*: Maintain near 100% pass rates. Protect against backsliding. Answer: "Can it still do this reliably?"

**pass@k vs. pass^k** [2]:
- *pass@k*: Probability of at least one correct solution in k attempts. Use for R&D to assess ceiling capability.
- *pass^k*: Probability that *all* k trials succeed. Use for production to assess reliability. A 90% pass@1 agent fails 1 in 10 — unacceptable for production workflows.

**Beyond accuracy** — the 12-metric reliability framework from recent academic work [9]:
- **Consistency**: Same input → same quality across runs
- **Robustness**: Performance under perturbation (slightly different prompts, varied file structures)
- **Predictability**: Failure modes are bounded and expected
- **Safety**: Error severity is constrained

**Operational metrics** [1][4]:
- Latency per task
- Token usage / cost per task
- Number of turns and tool calls
- Error rates and retry patterns
- First-pass acceptance rate (does the human accept the output without modification?)

### The SWE-bench Problem

SWE-bench is the most cited coding agent benchmark, but practitioners should understand its limitations [7][8]:

| Issue | Detail |
|-------|--------|
| Gaming | OpenAI: improvements "no longer reflect meaningful improvements in real-world abilities" |
| Flawed tests | 59% of problems have flawed test cases |
| Narrow scope | 87% are simple bug fixes; multi-file changes rare |
| Data contamination | Models may have seen solutions in training data |
| Verified vs. Pro gap | 80% on Verified, 23% on Pro — massive gap |

SWE-bench is useful as *one signal* for comparing models, but building your own eval suite from real tasks is far more valuable for production decisions.

## The Three Grader Types

Anthropic's framework identifies three grader types, each with distinct tradeoffs [2]:

### 1. Code-Based Graders (Deterministic)
- String matching, binary pass/fail, static analysis, unit test execution, tool call verification
- **Strengths**: Fast, cheap, objective, reproducible, easy to debug
- **Weaknesses**: Brittle to valid variations, lacks nuance, limited for subjective tasks
- **Best for**: Coding agents — does the code run? Do tests pass? Does it use parameterized queries?

### 2. Model-Based Graders (LLM-as-Judge)
- Rubric-based scoring, natural language assertions, pairwise comparison, multi-judge consensus
- **Strengths**: Flexible, scalable, captures nuance, handles open-ended tasks
- **Weaknesses**: Non-deterministic, expensive (~$0.30 per 10-step trace [10]), requires calibration
- **Best for**: Code quality, style, "did it use the right abstraction?", security review

### 3. Human Graders
- SME review, crowdsourced judgment, spot-check sampling
- **Strengths**: Gold standard quality
- **Weaknesses**: Expensive, slow, requires expert access
- **Best for**: Calibrating model-based graders, edge cases, high-stakes decisions

**The practical recommendation**: Use deterministic graders as the primary signal (tests pass, linter clean, no secrets). Layer model-based graders for quality assessment. Export ambiguous cases (scores 0.4-0.6) to a human review queue [11].

## How to Build Your Own Eval Framework

### Step 1: Start with Real Failures (20-50 Tasks)

Anthropic's strongest recommendation: begin with tasks drawn from actual production failures [2]. Not synthetic problems, not algorithm challenges — real bugs, real PRs, real incidents.

For each task, define:
- **Input**: The prompt, codebase state, and context the agent receives
- **Success criteria**: Unambiguous — two domain experts should independently reach the same pass/fail verdict
- **Reference solution**: Proving the task is solvable (a 0% pass rate across many trials = broken task, not incapable agent)

Sources for tasks:
- Recent bug-fix PRs
- Incidents and postmortems
- Code review feedback that recurred
- Security vulnerabilities found in production
- Refactoring that took multiple attempts

### Step 2: Choose Your Eval Harness

The harness orchestrates task execution, recording, and grading. Options from simplest to most sophisticated:

**DIY (shell scripts + tests)**
- Run agent in Docker container, execute tests, check exit code
- Cheapest, most control, least infrastructure
- Good for: teams with <50 eval tasks, single agent

**Promptfoo** (MIT, open-source) [1]
- YAML config, supports Codex SDK + Claude Agent SDK + OpenCode SDK
- Structured output validation, cost/latency thresholds, trace assertions, LLM-as-judge
- `npm install -g promptfoo` — runs locally, config + results stay on your machine
- Good for: teams wanting CI integration, multi-agent comparison

**Inspect AI** (UK AISI, open-source) [12]
- Python framework, 200+ pre-built evaluations, Docker sandboxing built-in
- Supports coding agents via SWE package (Claude Code, Codex CLI)
- Built-in ReAct Agent + Deep Agent for long-horizon tasks
- VS Code log viewer + web-based Inspect View
- Good for: teams wanting a comprehensive, government-backed framework

**TribeAI claude-evals** (open-source) [11]
- Purpose-built for Claude Agent SDK workflows
- 50-case golden dataset, three grader types, regression detection (CRITICAL/HIGH/MEDIUM/LOW)
- Cost guardrails ($0.50/task default), CI exit codes
- Good for: Claude-specific teams, enterprise regression testing

**CodeBuff Evals** [13]
- Agents reconstruct actual git commits through interactive multi-turn process
- AI judge scores on completionScore, efficiencyScore, codeQualityScore, overallScore (0-10)
- Supports multiple agent runners (CodeBuff, Claude Code)
- Good for: measuring how well agents reproduce real engineering work

**Strands Evals** (AWS, Apache 2.0) [14]
- Part of AWS Strands Agents SDK
- Trajectory evaluation, automated experiment generation, failure detection with root cause analysis
- Good for: AWS/Bedrock teams

### Step 3: Design Graders Thoughtfully

For coding agents specifically, Anthropic recommends this grader stack [2]:

```
Primary: Unit tests (deterministic — does the code work?)
Secondary: Static analysis — ruff, mypy, bandit (deterministic — is it clean/secure?)
Tertiary: LLM rubric (model-based — is it well-designed?)
Quaternary: State checks (deterministic — did it modify the right files?)
```

Critical anti-pattern: **don't grade the path too rigidly**. Agents regularly find valid approaches designers didn't anticipate. Grade the *outcome*, not the exact sequence of tool calls [2].

Use partial credit for multi-component tasks. A solution that fixes 3 of 4 bugs is more valuable than one rated as a binary failure.

### Step 4: Run Multiple Trials

Due to non-determinism, a single trial per task is insufficient. Promptfoo recommends `--repeat 3` minimum for development [1]. For production decisions, 5-10 trials per task gives meaningful statistical signal.

Track both pass@k (ceiling capability) and pass^k (reliability):
- pass@3 tells you "can it solve this at all?"
- pass^3 tells you "can you trust it to solve this consistently?"

### Step 5: Build the Feedback Loop

The eval isn't the end — it's the beginning of an improvement cycle. Addy Osmani's "hill climbing" workflow [4]:

1. **Baseline**: Run full eval suite. Document pass rates by category.
2. **Analyze failures**: Treat each failure like a bug report. Why did the agent struggle?
3. **Targeted improvement**: Adjust system prompts, tools, harness middleware, or context. LangChain's experience [6] shows harness changes alone can yield 13.7-point improvements.
4. **Re-evaluate**: Run evals again. Did the intervention help? Did it break anything else?
5. **Iterate**: Repeat continuously. As the agent improves, add harder tasks to prevent eval saturation.

### Step 6: Integrate into CI/CD

Eval results should gate deployments, not just inform dashboards:
- Run regression evals on every harness change (system prompt, CLAUDE.md/AGENTS.md, tool config)
- Fail the build if regression evals drop below threshold
- Run capability evals on a schedule (weekly) to track improvement
- Export results as structured data for trend analysis

## The Harness Engineering Connection

Martin Fowler's team established that the harness — "everything in an AI agent except the model itself" — is the primary optimization surface [5]. This has direct implications for eval design:

### Guides (Feedforward Controls) — Eval What You Steer

Guides shape agent behavior *before* it acts:
- Architectural documentation, coding conventions, bootstrap instructions
- CLAUDE.md / AGENTS.md specifications
- System prompts and context engineering

Eval these by measuring first-pass acceptance rate: does the agent get it right on the first attempt? If not, which guide is missing or unclear?

### Sensors (Feedback Controls) — Eval What You Detect

Sensors catch issues *after* agent output:
- Computational: Tests, type checkers, linters (fast, deterministic, cheap)
- Inferential: LLM-as-judge, code review agents (slower, non-deterministic, richer)

Eval these by measuring false negative rate: what issues slip past your sensors?

### The Harness Optimization Insight

LangChain's Terminal Bench results [6] proved that harness changes alone — without model changes — can produce dramatic improvements. Their methodology is worth replicating:

1. Run evals, collect traces
2. Feed failure traces to an automated error-analysis agent
3. Synthesize findings into targeted harness changes
4. Re-run evals, measure improvement

They implemented three key middleware components:
- **PreCompletionChecklistMiddleware**: Forces verification passes before agent exit
- **LocalContextMiddleware**: Injects directory structures and available tools on startup
- **LoopDetectionMiddleware**: Tracks file edits, suggests reconsidering approach after N iterations

## Existing Platforms Compared

| Platform | License | Best For | Agent-Aware? | Cost |
|----------|---------|----------|-------------|------|
| **Promptfoo** | MIT | CI-integrated eval, multi-agent comparison | Yes — Codex, Claude, OpenCode SDKs | Free (OSS) |
| **Inspect AI** | MIT | Comprehensive eval, government/safety contexts | Yes — SWE package for coding agents | Free (OSS) |
| **Braintrust** | Closed | Quality management, trace-to-test pipelines | Yes — trajectory tracking | Free tier + paid |
| **LangSmith** | Closed | LangChain/LangGraph ecosystem teams | Yes — native trajectory semantics | Free tier + paid |
| **Arize Phoenix** | Elastic 2.0 | Mixed ML + LLM orgs, OpenTelemetry-native | Yes — multi-step trajectory analysis | Free (OSS) |
| **DeepEval** | Apache 2.0 | pytest-style assertions, CI-focused | Limited | Free (OSS) |
| **TribeAI claude-evals** | Open source | Claude Agent SDK specifically | Yes — SDK lifecycle hooks | Free (OSS) |
| **CodeBuff Evals** | Open source | Git-commit-reconstruction eval methodology | Yes — multi-agent runners | Free (OSS) |
| **Strands Evals** | Apache 2.0 | AWS/Bedrock teams | Yes — trajectory + interaction eval | Free (OSS) |

## Recommendations

### If you're starting from zero:

**High confidence**: Start with Anthropic's "Demystifying Evals" guide [2] as your conceptual framework. Use Promptfoo [1] as your harness — it's MIT-licensed, supports multiple agent SDKs, runs locally, and integrates with CI. Invest your first 2 weeks in curating 20-50 real failure cases from your codebase, not in benchmark chasing.

**High confidence**: Measure pass^k, not pass@k, for production decisions. A 90% pass@1 means 1 in 10 tasks fails — and failures compound in agentic workflows.

**High confidence**: Separate capability evals (hard, currently-failing tasks) from regression evals (should-always-pass tasks). Run regressions on every change; run capabilities weekly.

### If you have an existing eval setup:

**Medium confidence**: Add trace-level assertions to your evals. Outcome-only grading misses critical differences in agent behavior — cost, latency, tool call patterns, and failure modes. Promptfoo's trajectory assertions and LangSmith's trace analysis both support this.

**Medium confidence**: Consider the CodeBuff methodology — evaluating agents by having them reconstruct real git commits. It's the closest available proxy to "can this agent do the work a developer actually did?"

### If you're evaluating which agent/harness to adopt:

**High confidence**: Don't rely on SWE-bench scores. Run your own eval suite on your own codebase with your own failure cases. The harness matters more than the model — a well-configured agent with a weaker model can outperform a poorly-configured agent with a stronger one [6].

**Medium confidence**: Use Hamel Husain's eval-audit skill [3] as a diagnostic first step. It inspects your current setup and produces prioritized recommendations across six areas.

## Coverage Gaps & Limitations

### Well-Covered
- Conceptual frameworks for agent evaluation (Anthropic's guide is comprehensive)
- Open-source harness tooling (Promptfoo, Inspect AI, DeepEval — strong ecosystem)
- Benchmark landscape and limitations (SWE-bench critique well-documented)
- Harness engineering methodology (Fowler's guide is authoritative)

### Thinly Covered
- **Cost modeling**: How to budget for eval infrastructure. Model-based graders cost ~$0.30 per 10-step trace — running 50 tasks × 5 trials × 3 graders adds up. No guide addresses eval cost optimization.
- **Team workflow integration**: How to get developers to actually write and maintain eval tasks. Cultural adoption patterns are absent from the technical guides.
- **Multi-agent eval**: Evaluating orchestrated multi-agent systems (e.g., coding + review agents) is acknowledged as hard but poorly tooled.

### Not Found
- **Enterprise case studies**: No published account of "we built an eval framework for our coding agents and here's what happened to our defect rates." The tooling exists; evidence of outcomes doesn't.
- **Eval-to-harness improvement automation**: LangChain's trace analyzer skill [6] is the closest example, but it's not a general framework. Automated "eval → diagnose → improve harness → re-eval" pipelines are conceptual, not productized.
- **Long-term eval maintenance**: What happens to eval suites after 6 months? Do they drift? Saturate? No longitudinal evidence exists.

## Open Questions

How should eval tasks weight first-pass success vs. self-correction? An agent that fails initially but self-corrects after running tests is arguably more production-ready than one that succeeds on the first attempt but can't recover from failure. Current frameworks don't distinguish these patterns well.

The "harnessability" concept from Fowler's guide [5] raises an unanswered question: should eval difficulty scale with codebase complexity? A task that's trivial in a greenfield TypeScript project may be impossible in a legacy Java monolith — but current benchmarks don't account for this.

Finally, as harness engineering matures, the boundary between "harness" and "eval" blurs. A pre-completion verification middleware is simultaneously a production guardrail and an eval sensor. Should we be building unified systems that serve both purposes?

## Sources

[1] Promptfoo. "Evaluate Coding Agents." https://www.promptfoo.dev/docs/guides/evaluate-coding-agents/

[2] Anthropic. "Demystifying Evals for AI Agents." https://www.anthropic.com/engineering/demystifying-evals-for-ai-agents

[3] Hamel Husain. "Evals Skills for Coding Agents." https://hamel.dev/blog/posts/evals-skills/

[4] Addy Osmani. "An Engineer's Guide to AI Code Model Evals." https://addyosmani.com/blog/ai-evals/

[5] Martin Fowler / ThoughtWorks. "Harness Engineering for Coding Agent Users." https://martinfowler.com/articles/harness-engineering.html

[6] LangChain. "Improving Deep Agents with Harness Engineering." https://www.langchain.com/blog/improving-deep-agents-with-harness-engineering

[7] TianPan. "Agentic Coding in Production: What SWE-bench Scores Don't Tell You." https://tianpan.co/blog/2026-04-09-agentic-coding-production-swebench-gap

[8] SWE-bench. https://www.swebench.com

[9] "Towards a Science of AI Agent Reliability." arXiv:2602.16666. https://arxiv.org/abs/2602.16666

[10] FutureAGI. "Agent Evaluation Frameworks in 2026: 7 Tools Compared." https://futureagi.com/blog/agent-evaluation-frameworks-2026

[11] TribeAI. "claude-evals: Production Eval Framework for Claude Agent SDK." https://github.com/TribeAI/claude-evals

[12] UK AI Security Institute. "Inspect AI." https://inspect.aisi.org.uk/

[13] CodeBuff. "Evals." https://github.com/CodebuffAI/codebuff/tree/main/evals

[14] AWS. "Strands Agents Evals." https://github.com/strands-agents/evals

[15] ai-boost. "Awesome Harness Engineering." https://github.com/ai-boost/awesome-harness-engineering

[16] Hamel Husain. "AI Evals for Engineers & PMs." https://maven.com/parlance-labs/evals

[17] "Beyond pass@1: A Reliability Science Framework for Long-Horizon LLM Agents." arXiv:2603.29231. https://arxiv.org/abs/2603.29231

[18] "TRAJEVAL: Decomposing Code Agent Trajectories for Fine-Grained Diagnosis." arXiv:2603.24631. https://arxiv.org/abs/2603.24631
