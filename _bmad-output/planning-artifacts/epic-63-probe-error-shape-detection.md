# Epic 63: Probe Error-Shape Auto-Detection

## Vision

Close the structural under-test gap surfaced by strata Run 12 / obs_012
(REOPENED, 2026-04-26): four broken MCP tools shipped under SHIP_IT
because dev-authored probes asserted *presence-of-response* (count of
advertised tools, presence of any payload) instead of *success-shape*
(assertion that the response payload itself signals success, not error).

Author-side guidance for success-shape assertions already shipped via
Story 60-12 in v0.20.31: both `create-story.md` and `probe-author.md`
contain a "Asserting success-shape on structured-output probes"
section that instructs agents to use
`expect_stdout_no_regex: ['"isError"\s*:\s*true']` for MCP/REST/JSON-RPC
probes. The guidance is correct and present.

The remaining gap is enforcement: the agent must REMEMBER to add the
assertion. Stories where the agent forgets — or where the prompt
preceded an LLM that read the AC and decided "it doesn't say anything
about error envelopes" — still ship broken tools as SHIP_IT.

This epic closes the gap with a defense-in-depth check: the runtime
probe executor now ALWAYS scans probe stdout for the canonical error
envelope shapes (`"isError": true`, `"status": "error"`), regardless
of whether the author declared an assertion. If detected, the probe
fails with a distinct `runtime-probe-error-response` category.

## Root cause

Strata Run 12 (substrate v0.20.23) shipped:

- `strata_semantic_search` (Story 1-10) returning
  `{"isError": true, "text": "Error executing tool: 'str' object has
  no attribute 'get'"}` — real Python TypeError in `searcher.py:97`
  (line_range stored as JSON string, treated as dict)
- `strata_hybrid_search` (Story 1-10b) returning the same TypeError
- `strata_reindex` (Story 1-10b) returning
  `{"status": "error", "message": "strata-memory binary not found"}`
- A2A `semantic-search` and `hybrid-search` (Story 1-10c) routing
  through the same broken backend

The probes for these stories asserted:
- `tools/list` advertised the expected 4 tools (count + names) ✓
- Each tool returned *some* response (any JSON, exit 0) ✓

No probe asserted that the response payload didn't contain
`isError: true` or `status: error`. The runtime-probe-check passed
all probes; verification SHIP_IT'd the stories; the strata e2e smoke
pass caught the breakage post-ship.

The prompt-side fix (Story 60-12) addresses author awareness, but
relies on agent compliance. A defense-in-depth executor check
catches the under-test class structurally.

## Story Map

- **63-2**: probe executor detects error-shape responses in stdout (P0, Small)

(Story 63-1 — author-side guidance — was already shipped via Story
60-12 in v0.20.31. Sprint 16 ships only the executor-side
defense-in-depth.)

## Story 63-2: probe executor auto-detects error-shape responses

**Priority**: must

**Description**: After the existing exit-code check and 60-4
`expect_stdout_*` assertion evaluation, the host executor scans the
captured stdout for canonical error-envelope JSON patterns. If any
match, the probe outcome flips to `fail` and a distinct
`errorShapeIndicators: string[]` field on `ProbeResult` carries the
detected patterns. `RuntimeProbeCheck` routes such failures to a new
`runtime-probe-error-response` finding category.

Detected patterns (case-sensitive, JSON-shape):
- `"isError"\s*:\s*true` — MCP / Anthropic tool error envelope
- `"status"\s*:\s*"error"` — REST / RPC error envelope

**Acceptance Criteria**:

- A probe whose stdout contains `{"isError": true, ...}` fails with
  `runtime-probe-error-response`, even if the command exits 0 and no
  author assertions tripped.
- A probe whose stdout contains `"status": "error"` fails with the
  same category.
- A probe whose stdout contains neither pattern (clean success
  payload, e.g., `{"isError": false, "content": [...]}`) passes
  unchanged.
- An author-declared assertion failure (60-4 `expect_stdout_*`)
  takes precedence over auto-detection in finding category — if both
  trigger, the finding category is `runtime-probe-assertion-fail`
  (already covered by 60-4) since the author was specific.
- Detection runs against the FULL captured stdout (not the tailed
  excerpt), so error envelopes deeper than `PROBE_TAIL_BYTES` aren't
  missed.
- Detection skips when exit code is non-zero (the existing
  `runtime-probe-fail` finding is more informative; we don't want a
  follow-on error-response finding for the same broken response).

**Key File Paths**:
- `packages/sdlc/src/verification/probes/types.ts`
- `packages/sdlc/src/verification/probes/executor.ts`
- `packages/sdlc/src/verification/checks/runtime-probe-check.ts`
- `packages/sdlc/src/__tests__/verification/runtime-probe-check.test.ts`

## Status of obs_002 (SIGTERM cleanup)

**Already resolved.** Story 58-7 shipped in v0.20.13 (commit
`71603c6`) installs `process.on('SIGTERM'/'SIGINT')` handlers,
`shutdownGracefully` writes `pipeline_runs.status = 'stopped'` +
transitions active `wg_stories` to `'cancelled'`. Tests in
`src/modules/implementation-orchestrator/__tests__/sigterm-shutdown.test.ts`
cover AC2/AC6/AC7. Strata-side observation status field is stale
(2026-04-21) and didn't reflect the v0.20.13 fix; should be marked
resolved. No new substrate code needed.

## Empirical validation

Closes the obs_012 (REOPENED) under-test class structurally. Validation
lives in the next strata MCP-tool-bearing dispatch — any probe whose
implementation returns an error envelope (deliberately or due to a
bug) now produces a `runtime-probe-error-response` finding instead of
shipping SHIP_IT.

## Versions

- v0.20.33 (2026-04-27, current) — Epic 62 (code-review output recovery)
- v0.20.34 (target) — Epic 63 (this epic)
