# Probe-Author Defect Corpus

**Version**: v1 (2026-04-27)
**Substrate version when corpus authored**: v0.20.35
**Source**: strata `_observations-pending-cpo.md` defects through Sprint 17

## Purpose

This corpus is the ORACLE for the probe-author A/B validation harness
(Story 60-14d, `scripts/eval-probe-author.mjs`). Each entry documents a
historically-shipped defect that strata's e2e smoke pass caught AFTER
substrate's gates passed. The expected behaviour: when probe-author is
dispatched against the entry's source AC, it MUST produce a probe whose
shape matches the `expected_probe_signature`. A probe that matches is
counted as "caught"; one that doesn't is "missed".

The eval script's overall catch rate determines the Phase 2 go/no-go
decision per `probe-author-validation-protocol.md`:

| Catch rate | Phase 2 decision |
|---|---|
| ≥ 50% | GREEN — proceed to 60-15 (telemetry) and 60-16 (heuristic flip) |
| 30-50% | YELLOW — iterate on probe-author prompt, re-run eval |
| < 30% | RED — Phase 2 aborted; substrate considers Phase 3 alternatives |

## Corpus entries

Each entry uses the schema:

- **story_key**: substrate-canonical hyphen form
- **original_run_id**: the run where the defect shipped (or "manual" when
  the defect was caught before substrate dispatch)
- **defect_description**: paraphrase of what strata smoke caught
- **source_ac_excerpt**: the verbatim source-AC text the probe-author
  would receive as input (extracted from the strata epic doc)
- **expected_probe_signature**: deterministic, machine-checkable
  predicate the authored probe MUST satisfy. Each predicate is an array
  of constraints; ALL must hold for the probe to count as "caught". The
  eval script applies each predicate to the full probe set; a match
  anywhere counts.

---

### Entry 1: obs_011 — under-delivery on tool count (strata 1-10, Run 11)

| Field | Value |
|---|---|
| story_key | `1-10` |
| original_run_id | `<run-11-id>` (substrate v0.20.21) |
| defect_description | dev shipped only 2 of 4 source-AC-required MCP tools (`strata_semantic_search`, `strata_get_related`); `strata_hybrid_search` and `strata_reindex` missing entirely. Probes asserted "tools/list returns OK" without checking count. |

**source_ac_excerpt**:

```text
**Acceptance Criteria** (Story 1.10): Memory MCP Server advertises
**exactly four tools** via MCP `tools/list`: `strata_semantic_search`,
`strata_get_related`, `strata_hybrid_search`, `strata_reindex`.
```

**expected_probe_signature** (any probe in the authored set must satisfy ALL of):

- `command` includes `tools/list` (calls the MCP listing endpoint)
- `expect_stdout_regex` includes a pattern matching the tool count of 4
  (e.g., `\b4\b` near `tools` OR an `expect_stdout_regex` entry per
  named tool)

---

### Entry 2: obs_012 — probes accept error-envelope responses (strata 1-10b/1-10c, Run 12)

| Field | Value |
|---|---|
| story_key | `1-10b` |
| original_run_id | `<run-12-id>` (substrate v0.20.23) |
| defect_description | All 4 advertised MCP tools returned `{"isError": true, "text": "Error executing tool: ..."}` due to backend Python bugs. Probe asserted presence-of-response without checking shape; ship'd SHIP_IT despite tools being non-functional. |

**source_ac_excerpt**:

```text
**Acceptance Criteria** (Story 1.10b): `strata_semantic_search` returns
an array of search results with `file_path`, `snippet`, and
`similarity_score` for each result.
```

**expected_probe_signature** (any probe in the authored set must satisfy ALL of):

- `command` includes `mcp-client call strata_semantic_search` OR
  equivalent invocation of the production tool entry point
- `expect_stdout_no_regex` includes a pattern matching the
  error-envelope shape: `"isError"\\s*:\\s*true` OR
  `"status"\\s*:\\s*"error"`

(NOTE: the executor-side defense-in-depth check from Story 63-2 catches
this even when probes don't assert it. But this corpus tests probe
QUALITY — a high-quality probe-author should add the explicit assertion
rather than rely on the safety net.)

---

### Entry 3: obs_014 — probes invoke implementation directly bypassing production trigger (strata 1-12, Run 13)

| Field | Value |
|---|---|
| story_key | `1-12` |
| original_run_id | `<run-13-id>` (substrate v0.20.27) |
| defect_description | Vault conflict hook shipped SHIP_IT non-functional. Dev's probe ran the resolver script directly with conflict-marker fixtures: `bash .git/hooks/post-merge`. Real `git merge` under conflict doesn't fire post-merge per `githooks(5)` — so the hook never ran in production. |

**source_ac_excerpt**:

```text
**Acceptance Criteria** (Story 1.12): Post-pull Obsidian vault conflict
hook auto-resolves human-vs-Jarvis conflicts on `git pull` / `git merge`.
Hook is installed, executable, and **fires on every merge completion**.
```

**expected_probe_signature** (any probe in the authored set must satisfy ALL of):

- `command` matches `git\s+merge` (invokes the production trigger)
- `command` does NOT match `bash\s+.*post-merge` (does NOT directly
  invoke the hook script — that's the wrong shape)

---

### Entry 4: obs_014 sibling — systemd-timer-fires (synthetic, anchors trigger pattern)

| Field | Value |
|---|---|
| story_key | `synthetic-1` |
| original_run_id | `manual` (no real story; documents the trigger pattern) |
| defect_description | A synthetic case anchoring the systemd-timer trigger pattern: probes for stories with timer-based ACs MUST invoke `systemctl --user start <unit>.timer` rather than directly calling the binary the unit invokes. |

**source_ac_excerpt**:

```text
**Acceptance Criteria** (Synthetic Story Z): a `strata-refresh.timer`
systemd unit fires every 10 minutes and invokes `strata-refresh.service`
which calls the refresh CLI.
```

**expected_probe_signature** (any probe in the authored set must satisfy ALL of):

- `command` matches `systemctl\s+(?:--user\s+)?start\s+\S+\.timer` OR
  `systemctl\s+(?:--user\s+)?start\s+\S+\.service`
- (informational — not enforced) `expect_stdout_regex` or follow-up
  command asserts the service ran (e.g., `is-active`)

---

### Entry 5: obs_015 — code-review YAML parse on shell snippets (strata 1-14, Run 14) — NOT applicable to probe-author

| Field | Value |
|---|---|
| story_key | `1-14` |
| original_run_id | `<run-14-id>` (substrate v0.20.28) |
| defect_description | Code-review agent's YAML output broke on a finding-description containing an unescaped colon in a shell snippet. This is a code-review-output defect, NOT a probe defect. Excluded from probe-author corpus; closed by Epic 62 instead. |

**Excluded from catch-rate calculation** — out of scope for probe-author
quality measurement. Listed for completeness so the corpus is a complete
audit of historical defects through Sprint 17.

---

## Catch rate calculation

The eval script (`scripts/eval-probe-author.mjs`) applies each entry's
`expected_probe_signature` to the probe-author-authored probe set for
that entry's source AC. An entry is "caught" when at least one authored
probe satisfies all signature constraints.

```
catch_rate = caught_entries / applicable_entries
```

Where `applicable_entries` excludes entries marked "Excluded from
catch-rate calculation".

**Current corpus**: 4 applicable entries (1, 2, 3, 4); 1 excluded (5).

## Versioning

This corpus is version-controlled and peer-reviewable. Adding a new
entry requires:

1. Reference to the original observation in `_observations-pending-cpo.md`
2. Verbatim source AC excerpt (the input probe-author would receive)
3. Machine-checkable `expected_probe_signature` (no prose-only
   predicates)
4. Entry numbered sequentially, appended to the end

Removing an entry requires:

1. Justification in this doc + the entry's status_history in obs file
2. Re-run of the eval script to confirm catch-rate impact

---

## Machine corpus (eval input — Story 60-14d)

The eval script (`scripts/eval-probe-author.mjs`) reads the YAML block
below as its structured input. Each entry maps to one of the prose
entries above; the `signature` block is a list of
`probe_serialized_regex` constraints. An entry is "caught" when at
least one authored probe's serialized JSON form matches ALL of its
signature regex constraints.

```yaml
applicable_entries:
  - id: entry-1-obs_011-tool-count
    story_key: '1-10'
    source_ac: |
      Memory MCP Server advertises **exactly four tools** via MCP
      `tools/list`: `strata_semantic_search`, `strata_get_related`,
      `strata_hybrid_search`, `strata_reindex`.
    signature:
      - 'tools/list'
      - 'strata_(semantic_search|get_related|hybrid_search|reindex).*strata_(semantic_search|get_related|hybrid_search|reindex)'

  - id: entry-2-obs_012-error-envelope
    story_key: '1-10b'
    source_ac: |
      `strata_semantic_search` returns an array of search results with
      `file_path`, `snippet`, and `similarity_score` for each result.
    signature:
      - 'strata_semantic_search'
      - 'isError|"status".*error'

  - id: entry-3-obs_014-production-trigger
    story_key: '1-12'
    source_ac: |
      Post-pull Obsidian vault conflict hook auto-resolves
      human-vs-Jarvis conflicts on `git pull` / `git merge`. Hook is
      installed, executable, and **fires on every merge completion**.
    signature:
      - 'git\s+merge'

  - id: entry-4-synthetic-systemd-trigger
    story_key: 'synthetic-1'
    source_ac: |
      A `strata-refresh.timer` systemd unit fires every 10 minutes and
      invokes `strata-refresh.service` which calls the refresh CLI.
    signature:
      - 'systemctl\s+(?:--user\s+)?start\s+\S+\.(?:timer|service)'

excluded_entries:
  - id: entry-5-obs_015
    reason: 'code-review YAML defect, not a probe defect — closed by Epic 62'
```

