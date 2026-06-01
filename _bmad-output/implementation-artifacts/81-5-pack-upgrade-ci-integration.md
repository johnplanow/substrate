# Story 81-5: Pack-upgrade CI integration + PR-comment poster

> **DISPATCH ELIGIBILITY: OPERATOR-BUILT — do NOT dispatch.**
> This story touches `.github/workflows/*` and uses GitHub authentication, which
> are operator/CI surfaces substrate does not modify via autonomous dispatch
> (mirrors the 77-3 convention for the every-ship regression gate). Each AC
> below is operator-implementable; substrate auto-dispatch would be inappropriate
> because it lacks GitHub token scope and cannot validate CI workflow behavior
> end-to-end without an operator-driven PR.

## Story

As a substrate eval-framework operator,
I want a GitHub Actions workflow that triggers on PRs touching `packs/bmad/**`, runs 81-4's CLI to evaluate the candidate pack against the base-branch pack, and posts the markdown report as a PR comment,
so that every BMad pack change in a PR gets an automatic four-axis quality report before merge.

This story is the operator-facing integration layer. Report-only initially; promotes to a blocking gate after 2–3 calibration runs.

## Acceptance Criteria

1. **Workflow file**: `.github/workflows/eval-pack-upgrade.yml`
   - Triggers on `pull_request` events with `paths: ['packs/bmad/**']`
   - Permissions: `pull-requests: write` (for PR-comment posting), `contents: read`
   - Runs on `ubuntu-latest`
   - Timeout: `1440` minutes (24 hours) to accommodate the full 35-pair A/B run (10–20 compute-hours typical)

2. **Workflow steps**:
   - Checkout the PR head into the default path (this gives the workflow access to the candidate pack at `packs/bmad`)
   - Checkout the base branch's `packs/bmad` directory into a separate path (e.g., `base-pack/`) using a sparse checkout or `git worktree`
   - Install Node, install deps (`npm ci`)
   - Build (`npm run build`)
   - Run the CLI:
     ```bash
     node scripts/eval-pack-upgrade.mjs \
       --pack-current base-pack/bmad \
       --pack-candidate packs/bmad \
       --format markdown \
       --output pack-upgrade-report.md \
       --threshold code-quality:0.05,cost-turns:0.10,verdict-tv:0.10,recovery-tv:0.10
     ```
   - Post the markdown report as a PR comment via `actions/github-script` (AC4)
   - Upload the JSON report as a workflow artifact for audit trail

3. **Authentication for downstream model dispatches.** The workflow needs whatever auth substrate's dispatch path requires (Claude Code OAuth session OR API key, per Substrate dispatch disciplines). Use GitHub secrets to inject `ANTHROPIC_API_KEY` (or equivalent) into the workflow env. Document the required secrets in `docs/eval-pack-upgrade-ci-setup.md`.

4. **PR comment posting** with update-in-place behavior:
   - On first workflow run: post a new comment whose body starts with `<!-- pack-upgrade-report -->` as a marker
   - On subsequent runs (PR updated, workflow re-runs): find the existing comment by marker and EDIT it rather than posting a new one
   - Use `actions/github-script` with the `octokit/rest` API to issue `issues.listComments` + `issues.updateComment` / `issues.createComment` accordingly

5. **Report-only mode (initial)**: workflow ALWAYS exits 0 regardless of the CLI exit code. The CLI's exit code is captured in the workflow log + the JSON artifact + the PR comment's verdict line, but does NOT fail the workflow. Document the flip-to-blocking date in the workflow file as a comment with the operator's decision rationale.

6. **Pollution + safety guards**:
   - Workflow only triggers on `pull_request` events from the same repo (not from forks) — avoids leaking secrets to fork-PR runs. Document the safety boundary; reconsider for fork-PR support in a follow-up.
   - Workflow skips itself when the PR's `packs/bmad/**` changes are documentation-only (e.g., README or docs/ subdirectories within the pack) — uses a path-filter override or an early-exit check.
   - Workflow caches `node_modules` between runs to keep startup cost down.

7. **Documentation**: `docs/eval-pack-upgrade-ci-setup.md` explains:
   - How the workflow triggers
   - Required GitHub secrets (auth for substrate dispatch)
   - How to read the PR comment report
   - How to promote from report-only to blocking gate
   - Expected runtime + cost ceiling per PR

8. **First calibration run**: after merging this story, the operator opens at least one trivial pack-touching PR to validate the workflow end-to-end. Documents observations in the workflow file or a follow-up note (e.g., `docs/2026-MM-DD-pack-upgrade-first-calibration.md`).

9. **Promotion-to-gate criteria documented**: the workflow file includes a header comment listing the criteria that must be met before the operator flips the workflow from report-only to blocking:
   - At least 3 calibration runs observed
   - Threshold distributions checked against the operator's quality bar
   - At least one INTENTIONAL regression (e.g., a deliberately-degraded prompt) tested through the gate to confirm RED → blocking behavior

10. **No behavior change to substrate**: this story adds CI yaml and docs only. Substrate source code is unchanged. Full eval-outcomes gate and Epic 77 + 81 tests must remain GREEN.

## Tasks / Subtasks

- [ ] **Task 1 — Author `.github/workflows/eval-pack-upgrade.yml`** (AC1, AC2, AC6)
  - [ ] Set up the trigger + permissions + timeout per AC1
  - [ ] Step: checkout PR head
  - [ ] Step: checkout base branch's `packs/bmad` into `base-pack/bmad` (use sparse-checkout or `actions/checkout` with `ref: ${{ github.base_ref }}` into a separate path)
  - [ ] Step: setup Node + npm ci
  - [ ] Step: `npm run build`
  - [ ] Step: invoke the CLI per AC2 with the default thresholds (AC2's command)
  - [ ] Step: capture CLI exit code into a workflow output variable
  - [ ] Step: upload `pack-upgrade-report.md` + JSON as workflow artifacts
  - [ ] Path-filter and same-repo safety per AC6

- [ ] **Task 2 — Auth setup** (AC3)
  - [ ] Identify the dispatch auth substrate currently requires (consult [[feedback_substrate_dispatch_disciplines]] memory)
  - [ ] Add the secret(s) to the workflow env block (e.g., `ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}`)
  - [ ] Document required secrets in `docs/eval-pack-upgrade-ci-setup.md` (Task 4)
  - [ ] If Claude Code OAuth session is required (rather than API key), document the operator-side process for caching the OAuth session in CI (this may not be feasible in GHA — surface the constraint and consider whether the workflow needs an API-key fallback for CI runs)

- [ ] **Task 3 — PR-comment poster** (AC4)
  - [ ] Use `actions/github-script@v7` with `octokit/rest`
  - [ ] Implement the find-or-create comment logic per AC4:
    ```javascript
    const marker = '<!-- pack-upgrade-report -->';
    const comments = await github.rest.issues.listComments({ owner, repo, issue_number });
    const existing = comments.data.find(c => c.body.startsWith(marker));
    const body = marker + '\n' + reportContent;
    if (existing) {
      await github.rest.issues.updateComment({ owner, repo, comment_id: existing.id, body });
    } else {
      await github.rest.issues.createComment({ owner, repo, issue_number, body });
    }
    ```
  - [ ] Read the report from `pack-upgrade-report.md`; include the CLI exit code as a header line in the comment body

- [ ] **Task 4 — Documentation** (AC7, AC9)
  - [ ] Create `docs/eval-pack-upgrade-ci-setup.md` covering AC7 bullets
  - [ ] Include the promotion-to-gate criteria from AC9
  - [ ] Reference the cost ceiling (~$70/pack-upgrade-PR at $2/case × 35 cases × 2 packs)
  - [ ] Reference the workflow timeout (24 hours)

- [ ] **Task 5 — Calibration run + sign-off** (AC8, AC10)
  - [ ] Open a trivial pack-touching PR (e.g., docstring update inside a prompt file) to validate the workflow
  - [ ] Confirm the workflow runs to completion, posts a PR comment, uploads artifacts
  - [ ] Run the existing `npm run test:fast` and `node scripts/eval-outcomes.mjs --threshold 0.95` on the main branch to confirm AC10
  - [ ] Document observations in the calibration note

## Dev Notes

### Why OPERATOR-BUILT (not dispatchable)

Three reasons substrate cannot dispatch this story:

1. **GitHub Actions workflow files** are CI infrastructure. Substrate operates within a single repo at dispatch time; it cannot validate that a workflow runs correctly in GHA without an operator opening a real PR.
2. **Secrets management.** Adding GitHub secrets, configuring workflow auth, and validating that secret-scoped runs work end-to-end requires operator-side org/repo settings access.
3. **Convention precedent: Story 77-3.** Epic 77's CI integration story explicitly carries the OPERATOR-BUILT marker for these same reasons. Story 81-5 inherits the convention.

### Cost ceiling math

- Full corpus: 35 pairs
- Per-pair: 2 dispatches (one per pack)
- Per-dispatch budget cap: $2.00 (configurable via `--budget-per-case-usd`)
- Worst-case total: 35 × 2 × $2.00 = $140 per pack-upgrade PR
- Typical case (most dispatches cost well under cap): probably $30–$70 per pack-upgrade PR

Pack-upgrade PRs are rare (1–5 per quarter historically); this is acceptable spend for a calibrated regression detector.

### Promotion-to-gate operator workflow

After the workflow ships in report-only mode:

1. **Calibration phase (runs 1–3):** observe real signal distributions for actual pack upgrades. Tune thresholds in `.github/workflows/eval-pack-upgrade.yml` to match the operator's quality bar.
2. **Validation phase:** deliberately ship a pack change known to degrade quality (e.g., a stripped-down dev-story prompt). Confirm the workflow surfaces RED on the right axes.
3. **Promotion:** edit `.github/workflows/eval-pack-upgrade.yml` to fail the workflow on CLI exit code ≥ 2. Document the flip date + rationale in a header comment.

The CLI itself is unchanged through this lifecycle; only the workflow's interpretation of exit codes changes.

### Auth fallback consideration

[[feedback_substrate_dispatch_disciplines]] notes that substrate's primary dispatch auth is the Claude Code OAuth session, NOT an API key. In CI, the OAuth session is unavailable — the workflow must use an API key. This is acceptable as long as substrate's adapters support API-key auth (which the existing `--api-key` / `apiKey` paths in the adapter layer do).

If a future substrate version removes API-key auth from any adapter, this workflow breaks. Surface that risk in the auth setup doc.

### Why upload the JSON artifact even though the markdown is posted

- Audit trail: PR comments can be edited or deleted; workflow artifacts have retention policy guarantees
- Programmatic consumption: future tooling (e.g., a "pack-upgrade history" page) can read the JSON artifacts across PRs
- Debugging: when the markdown PR comment looks wrong, the JSON is the source of truth

### Canonical Import Paths

| Helper | Import path |
|---|---|
| `actions/checkout@v4` | GitHub Actions marketplace |
| `actions/setup-node@v4` | GitHub Actions marketplace |
| `actions/github-script@v7` | GitHub Actions marketplace |
| `actions/upload-artifact@v4` | GitHub Actions marketplace |
| `scripts/eval-pack-upgrade.mjs` | The CLI from Story 81-4 |

### Reference Files (do NOT modify)

| File | Purpose |
|---|---|
| `scripts/eval-pack-upgrade.mjs` | The CLI this workflow invokes (Story 81-4) |
| `.github/workflows/` | Existing workflow patterns (CI, publish, etc.) |

### Existing workflow conventions

Look at existing substrate workflows for patterns:
- Node setup version + cache key conventions
- Secret naming
- Artifact naming conventions
- Timeout and retry conventions

Match those conventions where possible. Don't introduce divergent patterns just for this workflow.

### Key Files

| File | Purpose |
|---|---|
| `.github/workflows/eval-pack-upgrade.yml` | The workflow itself (Task 1) |
| `docs/eval-pack-upgrade-ci-setup.md` | Operator documentation (Task 4) |
| `docs/2026-MM-DD-pack-upgrade-first-calibration.md` | First calibration run observations (Task 5, optional) |

## Interface Contracts

- **Input**: PR-touching diff under `packs/bmad/**`.
- **Output**: PR comment (markdown) + workflow artifact (JSON).
- **Reuses**: 81-4's CLI; the markdown + JSON output formats are contracted there.
- **Auth**: relies on substrate's adapter API-key auth path; document the dependency.

## Runtime Probes

Not applicable — this story is YAML + documentation. Validation is via operator-driven calibration runs (Task 5), not runtime probes.

## Dev Agent Record

### Agent Model Used
N/A — operator-built

### Completion Notes List
<to be filled in by operator>

### File List
<to be filled in by operator>

## Change Log
