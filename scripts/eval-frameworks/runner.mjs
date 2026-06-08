// ---------------------------------------------------------------------------
// FrameworkRunner — the framework-as-dispatch-backend abstraction
// (Phase 1 fairness scaffolding for framework-eval-strategy.md)
//
// A "framework" (BMad-via-substrate, Ralph loop, Lattice, GSD, Claude-Code-native)
// is, for eval purposes, an orchestration wrapper around a fixed model. This module
// defines the COMMON interface every framework runner implements so the existing
// framework-neutral graders (code-quality, cost, work-quality) and the neutral
// outcome oracle can consume any framework's output identically.
//
// Design: pure interface + registry + a pure adapter from substrate's existing
// dispatch envelope. NO live model calls here — runners that spawn processes
// (Ralph, native) live behind injectable I/O and are exercised in the live spike
// (Phase 2), not in this unit-tested core.
// ---------------------------------------------------------------------------

/**
 * @typedef {Object} FrameworkTask
 * @property {string} task_id          stable id for the task
 * @property {string} spec             framework-AGNOSTIC prose spec (no BMad/Lattice idiom)
 * @property {string} repo             absolute path to the source repo
 * @property {string} parent_sha       commit to start from (worktree is detached here)
 * @property {string} [ground_truth_sha]  the reference commit whose diff defines "what good looks like"
 */

/**
 * @typedef {Object} FrameworkRunResult
 * The framework-neutral envelope. A SUPERSET of substrate's dispatch envelope:
 * the neutral fields are mandatory; framework-specific signals (substrate's
 * verdict/recovery vocabulary) are quarantined under `framework_specific`.
 * @property {string} framework                       runner identity (e.g. 'bmad-substrate', 'ralph', 'claude-native')
 * @property {string} task_id
 * @property {string|string[]|null} diff              the produced change (unified-diff string or path array)
 * @property {number|null} total_turns                agentic turns, or null when unavailable
 * @property {{input:number, output:number}|null} total_tokens
 * @property {number} cost_usd
 * @property {number} duration_seconds
 * @property {'completed'|'failed'|'budget-exceeded'|'error'} run_outcome
 * @property {object} [framework_specific]            opaque per-framework extras (NOT read by neutral graders)
 */

/**
 * @callback FrameworkRunner
 * @param {FrameworkTask} task
 * @param {string} worktree                           absolute path to the isolated worktree at parent_sha
 * @param {object} [opts]
 * @param {number} [opts.budgetUsd]                   per-task cost ceiling
 * @returns {Promise<FrameworkRunResult>}
 */

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

const _registry = new Map()

/**
 * Register a framework runner under a stable name.
 * @param {string} name
 * @param {FrameworkRunner} runner
 */
export function registerFrameworkRunner(name, runner) {
  if (!name || typeof name !== 'string') throw new Error('registerFrameworkRunner: name must be a non-empty string')
  if (typeof runner !== 'function') throw new Error(`registerFrameworkRunner: runner for "${name}" must be a function`)
  _registry.set(name, runner)
}

/**
 * Look up a registered runner.
 * @param {string} name
 * @returns {FrameworkRunner}
 * @throws if no runner is registered under `name`
 */
export function getFrameworkRunner(name) {
  const runner = _registry.get(name)
  if (!runner) {
    const known = [..._registry.keys()].join(', ') || '(none)'
    throw new Error(`getFrameworkRunner: no runner registered for "${name}". Registered: ${known}`)
  }
  return runner
}

/** @returns {string[]} names of all registered runners */
export function listFrameworkRunners() {
  return [..._registry.keys()]
}

/** Test-only: clear the registry. */
export function _resetFrameworkRunners() {
  _registry.clear()
}

// ---------------------------------------------------------------------------
// Envelope adapter — proves substrate's existing dispatch path fits the interface
// ---------------------------------------------------------------------------

/**
 * Convert a substrate dispatch envelope (the shape from
 * `eval-pack-upgrade/lib.mjs:normalizeDispatchEnvelope`) into a framework-neutral
 * FrameworkRunResult. This is how the EXISTING BMad-via-substrate path participates
 * in framework-level eval without re-implementing anything: the substrate runner
 * dispatches as it does today, then maps its envelope through here.
 *
 * BMad-specific fields (verdict, recovery_history, escalation_reason, pack) are
 * preserved under `framework_specific` — the neutral graders ignore them.
 *
 * @param {object} envelope    a normalizeDispatchEnvelope() result
 * @param {string} taskId
 * @param {string} [framework='bmad-substrate']
 * @returns {FrameworkRunResult}
 */
export function fromDispatchEnvelope(envelope, taskId, framework = 'bmad-substrate') {
  const e = envelope ?? {}
  // Map dispatch_outcome → neutral run_outcome (the substrate vocabulary collapses
  // 'escalated' into 'failed' for neutral purposes: an escalation means the framework
  // did not autonomously complete, which is what 'failed' means framework-neutrally).
  let run_outcome
  switch (e.dispatch_outcome) {
    case 'completed':
      run_outcome = 'completed'
      break
    case 'budget-exceeded':
      run_outcome = 'budget-exceeded'
      break
    case 'escalated':
    case 'failed':
      run_outcome = 'failed'
      break
    default:
      run_outcome = 'error'
      break
  }

  return {
    framework,
    task_id: taskId,
    diff: e.diff ?? null,
    total_turns: e.total_turns ?? null,
    total_tokens: e.total_tokens ?? null,
    cost_usd: e.cost_usd ?? 0,
    duration_seconds: e.duration_seconds ?? 0,
    run_outcome,
    framework_specific: {
      pack: e.pack ?? null,
      verdict: e.verdict ?? null,
      recovery_history: e.recovery_history ?? [],
      escalation_reason: e.escalation_reason ?? null,
    },
  }
}

/**
 * Validate that an object satisfies the FrameworkRunResult contract well enough
 * for the neutral graders + outcome oracle to consume it. Returns an array of
 * problem strings (empty = valid). Used by runners and tests to fail loudly when
 * a new framework adapter returns a malformed envelope.
 * @param {any} result
 * @returns {string[]}
 */
export function validateRunResult(result) {
  const problems = []
  if (!result || typeof result !== 'object') return ['result is not an object']
  if (typeof result.framework !== 'string' || !result.framework) problems.push('framework missing')
  if (typeof result.task_id !== 'string' || !result.task_id) problems.push('task_id missing')
  if (!('diff' in result)) problems.push('diff field absent (null is allowed, absence is not)')
  if (!['completed', 'failed', 'budget-exceeded', 'error'].includes(result.run_outcome)) {
    problems.push(`run_outcome invalid: ${JSON.stringify(result.run_outcome)}`)
  }
  if (result.total_tokens != null) {
    if (typeof result.total_tokens.input !== 'number' || typeof result.total_tokens.output !== 'number') {
      problems.push('total_tokens present but missing numeric input/output')
    }
  }
  if (typeof result.cost_usd !== 'number') problems.push('cost_usd must be a number')
  return problems
}
