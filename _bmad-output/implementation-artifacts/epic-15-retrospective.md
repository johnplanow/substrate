# Epic 15 Retrospective: Pipeline Observability & Agent Integration

**Period:** Completion of stories 15-1, 15-2, 15-3, 15-4, 15-5
**Date:** 2026-02-27

## Executive Summary

Epic 15 successfully delivered a complete event-driven architecture for substrate's auto-run pipeline, enabling both human-readable progress output and AI agent integration. All 5 stories shipped with minimal friction (1 review cycle each), despite parallel execution challenges. The epic resulted in +335 new tests across 11 new test files, increasing total test coverage from 4054 to 4389 tests across 182 files.

---

## What Went Well

### 1. **Minimal Review Friction — Consistent 1-Cycle Shipping**
All 5 stories shipped on their first review cycle (15-1 through 15-5: 1 review cycle each). Post-ship fixes were minor and isolated (test additions, flag misconfigurations, stdout handling). The event protocol design from 15-1 provided a stable contract that downstream stories (15-2 through 15-4) could depend on with high confidence. No architectural rework was required across the epic.

### 2. **Strong Separation of Concerns**
The decision to keep the event emitter (--events flag) orthogonal to the default human-readable renderer and TUI paid off. Each story could be developed, tested, and shipped independently. The shared `PipelineEvent` type acted as a clean boundary — new consumers (progress renderer, TUI, help-agent docs) could be added without touching the event emission logic.

### 3. **Comprehensive Test Coverage Added Post-Ship**
While dev agents initially didn't write tests, the review process caught gaps and all missing tests were added before final ship. Result: +335 tests (+11 test files) covering edge cases in TTY detection, ANSI handling, event sequencing, and TUI component rendering. This "test-after-review" pattern, while not ideal, was systematic enough to maintain high confidence in the implementation.

---

## What Didn't Go Well

### 1. **Parallel Execution Caused Git Stash Interference**
Parallel development of 15-2, 15-3, 15-4 in separate agents (same working tree) caused unintended git stash conflicts. One agent's `git stash` was run in the same tree where another agent was actively staging changes, resulting in stashed work that had to be manually recovered. This violated the assumption that separate Claude sessions could safely parallelize within a single working tree without explicit synchronization.

**Impact:** Debugging overhead, manual recovery needed. Lessons learned should be applied to Epic 16 and beyond.

### 2. **Dev Agents Skipped Test Writing — Systematic Gap**
All 5 dev agents completed implementation but did not write tests, despite AC criteria that could be verified by tests (e.g., 15-1 AC1-AC9, 15-2 AC1-AC5, etc.). The review cycle caught this gap and stories were shipped with minimal tests, forcing test additions before final delivery. This is a known pattern from the memory (dev-story sub-agents often exhaust turns before test output), but it remained unaddressed in Epic 15's process.

**Impact:** Extra review cycle overhead (post-ship fixes), but mitigated by strong code review. Recommended fix: explicitly task dev agents to "write tests first, implementation second" and enforce a turn budget.

### 3. **Stdout Corruption in 15-5 TUI — Hardcoded process.stdout**
The TUI story shipped with hardcoded `process.stdout` references, causing test isolation failures when multiple tests tried to render components simultaneously. Additionally, the progress renderer's stdout handling was not thoroughly tested for edge cases (piping, redirection). Minor fixes were required post-review to add proper stream abstraction and test mocks.

**Impact:** 1 non-blocking issue on 15-5; resolved with export additions and stream abstraction. Highlighted the need for stream-agnostic I/O design patterns from the start.

---

## Actionable Process Improvement for Next Epic

### **Recommendation: Pre-Dev Task Checkpoints for Test Infrastructure**

For Epic 16 and beyond, add a **"Test Infrastructure" checkpoint** to the dev-story story definition before writing implementation:

1. **At story creation**: define 3-5 core test cases that must pass (listed in AC or Dev Notes)
2. **Before dev-story agent runs**: explicitly include in the prompt: "Tasks section includes test file creation. Write tests for AC1, AC3, AC5 (pick 3 critical ones). Test files go in parallel with implementation files."
3. **Review gate**: code review checks test file count and asserts coverage for critical ACs. If tests are missing, the story is marked "NEEDS_TESTS" and sent back to dev agent with specific test requirements.

This trades off slightly longer dev cycles for zero post-ship test gaps. Early feedback loops on test-writing (vs. discovery during review) will reduce total turnaround.

**Expected benefit:** Eliminate the "test-after-review" pattern observed in Epic 15, keeping review cycles focused on implementation correctness rather than coverage gaps.

---

## Epic Metrics

| Metric | Value |
|--------|-------|
| **Stories Analyzed** | 5 |
| **Total Review Cycles** | 5 |
| **First-Pass Ships (1 review)** | 5 |
| **Needed Post-Ship Fixes** | 5 |
| **Test Files Added** | 11 |
| **New Tests Added** | 335 |
| **Total Test Files (End of Epic)** | 182 |
| **Total Tests (End of Epic)** | 4389 |
| **Escalations** | 0 |
| **Critical Blockers** | 0 |

### Breakdown by Story

| Story | Review Cycles | Status | Notes |
|-------|---------------|--------|-------|
| 15-1  | 1 | SHIP_IT | Event protocol foundation; test fix post-review |
| 15-2  | 1 | SHIP_IT | --verbose flag missing, progress-renderer tests added post-review |
| 15-3  | 1 | SHIP_IT | 1 minor non-blocking issue; help-agent generation verified |
| 15-4  | 1 | SHIP_IT | Clean ship; CLAUDE.md idempotency tests added post-review |
| 15-5  | 1 | SHIP_IT | stdout corruption with TUI, missing exports, hardcoded process.stdout fixes |

---

## Lessons Learned & Follow-Up

1. **Parallel execution requires explicit synchronization** — reserve a single working tree for serial story execution, or use git worktrees with strict naming conventions.
2. **Test-writing discipline must start earlier** — integrate test infrastructure checks into the dev-story prompt, not post-review discovery.
3. **Stream abstraction patterns** — establish a reusable interface for I/O (stdout, stderr, custom streams) to avoid hardcoding in tests and downstream consumers.
4. **Event protocol stability** — the decision to define `PipelineEvent` as a discriminated union and export it as public API was sound. Third-party consumers can now depend on this contract with high confidence.

---

## Conclusion

Epic 15 delivered on its vision: substrate's auto-run pipeline is now observable, agent-friendly, and human-readable by default. The 5-story MVP (15-1 through 15-4) achieves full Layer 1 & 2 agent integration. Story 15-5 (TUI) adds a bonus rich monitoring layer. Despite process friction (parallel execution, test gaps), the architecture is solid and extensible. Ready for Epic 16 with improved dev-task discipline and synchronization practices.
