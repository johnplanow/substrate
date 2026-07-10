# RP3.3 — completeness checker vs the income-sources corpus (2026-07-09)

*Live results, real checker dispatches (v0.21.17 tree). Corpus: income-sources
post-fix PRD (`prd-income-sources-2026-07-04/prd.md`, 29KB) + the A3.2
reference registry (`_planning/acceptance-gate/retrofit/journeys.yaml` —
UJ-2/UJ-3/UJ-4, deliberately scoped to the five founding misses).*

## Leg 1 — floor run (reference registry as-is)

`substrate acceptance validate --against-prd docs/prd.md` →
**8 journey-shaped claims: 3 registered, 0 excluded, 5 undispositioned.**

- **Mapping recall 3/3**: UJ-2 (Sunday Packet), UJ-3 (Pre-Claim), UJ-4
  (declared absence) all correctly mapped `registered`, with accurate
  substantive matching (claim phrasing differed from registry titles).
- **The 5 undispositioned findings — ALL adjudicated TRUE POSITIVES:**
  1. *Dislocation-audit ratification* — the PRD's own **UJ-1** (§ line 35).
  2. *Overload Protocol trigger on unexplained missed Packet* (lines 64/192).
  3. *Feed-parser same-day alert* — the PRD's own **UJ-5** (line 39).
  4. *Monthly bulk-ratification of outcome labels* (line 201).
  5. *Explicit resume after Overload Protocol*.
  The reference registry never covered these — it was authored to encode the
  founding misses, not the full vision. The checker's first real run
  demonstrated the program's founding claim on real data: **a carefully
  hand-authored registry had silently dropped PRD journeys (including two
  the PRD literally numbers UJ-1 and UJ-5), and the machine caught it.**
- **Noise floor: 0** — zero false positives. (DoD leg reads "zero
  undispositioned findings or each finding operator-adjudicated as genuine";
  all findings are genuine registry gaps, adjudication recorded here.
  Session-adjudicated; flagged for operator review — the natural follow-up
  is re-deriving the income-sources registry for real.)
- Run-to-run variance: an independent harness re-run enumerated 6
  undispositioned (the fuzzy tail varies ±1); mapping recall and
  zero-false-positive held on both runs.

## Leg 2 — planted omission (UJ-2 deleted)

UJ-2 removed from a registry copy → re-run →
**9 claims: 2 registered, 7 undispositioned**, including:

> journey-undispositioned: "Operator clears the weekly Sunday Packet in 40
> minutes — reads up to three Dossiers, records yes/no/defer decisions and a
> Grade for each…"
> PRD span: "Sunday 7am, phone, inbox. One email titled with the week number
> holds three Dossiers… He taps Yes; the machine acknowledges…"

The founding journey cannot silently vanish from the registry: its omission
is flagged, span-cited, on the first check.

## Regression harness

`scripts/registry-provenance-retrofit/run.mjs` (ship.md Step 4.9, enforcing,
conditional on completeness-checker changes): leg 1 asserts mapping recall
3/3 + zero undispositioned overlap with registered topics (fingerprints, not
phrasing — robust to enumeration variance); leg 2 asserts the deleted
founding journey is caught. GREEN at authoring time on a fresh independent
run. Retro-fit integrity: prompt iteration legal; corpus edits are
training-on-the-test and are not.
