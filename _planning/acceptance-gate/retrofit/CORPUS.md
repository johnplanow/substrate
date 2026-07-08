# Retro-fit corpus — income-sources product-acceptance episode (A3.1)

*Pinned 2026-07-08 from `~/code/jplanow/income-sources` (branch `main`, clean tree).
Tooling: uv (`uv.lock`, python ≥3.14) + pytest. Entry point: `machine` (= `machine.cli:main`).
This corpus is the acceptance gate's own definition of done (A3.2): pointed at the
pre-fix pins the gate must detect **5/5 known misses**; pointed at the post-fix pin,
**0 false FAILs**. Wrong SHAs poison the corpus — every pin below was verified against
git history by direct inspection.*

## Source documents (in the income-sources repo)

- **The review**: `_bmad-output/implementation-artifacts/product-acceptance-review.md`
  (2026-07-06, verdict FAITHFUL-WITH-GAPS). Thesis: *"the gaps cluster in one place:
  the last inch, where the machine meets the operator's thumb."* Findings enumerated
  in §F "Gaps Ranked by Vision Impact"; per-journey narrative in §B.
- **PRD journeys**: `_bmad-output/planning-artifacts/prds/prd-income-sources-2026-07-04/prd.md`
  §2.3 "Key User Journeys" — UJ-1 (census, non-software), UJ-2 (Sunday Packet, 3 Dossiers,
  yes/no/defer taps), UJ-3 (Tuesday Pre-Claim, one paragraph + fit score + Hold/Release tap),
  UJ-4 (declared absence: nothing sends; first Packet back explains releases), UJ-5 (feed
  heartbeat alert).
- **Golden render snapshots** (produced by the review itself, running the REAL compose paths):
  `_bmad-output/implementation-artifacts/acceptance-renders/` (pre-fix) and
  `acceptance-renders/v2/` (post-fix, added by the fix commit).

## The pins — TWO episodes (no single SHA has all five misses)

**Episode 1 — UJ-2 decision taps (miss 1).** Fixed the morning BEFORE the review:

| Pin | SHA | Subject | Date |
|---|---|---|---|
| pre-fix (taps absent) | `ef1c0c8` | E2E-REPORT: defects #1-4… | 2026-07-06 (am) |
| fix | `689b83e` | fix(packet,mailer): wire UJ-2 decision links into Dossier (D3) + BCC Ingestion Inbox (D2) | 2026-07-06 08:39 |

**Episode 2 — the four review-found misses (misses 2–5).** The review commit is the pre-fix state:

| Pin | SHA | Subject | Date |
|---|---|---|---|
| **PRE-FIX** | `a6ff1ca9a78bc9963f815bdffb71e65053b09a2b` | Product acceptance review: FAITHFUL-WITH-GAPS + rendered artifacts | 2026-07-06 20:19 |
| fix | `8d115d7c47e7ae7c2122ef3f5d3e4cb5c50b7761` | fix: close PRD-unambiguous product gaps from 2026-07-06 acceptance review (29 files, +2125/−57) | 2026-07-06 20:40 |
| **POST-FIX** | `82f4fe7426dabc7bc44dca6e875502fab9981d70` | Merge product-acceptance fixes (tree ≡ 8d115d7) | 2026-07-06 20:41 |

Note: at `a6ff1ca` the UJ-2 taps are ALREADY PRESENT (review line 50: "D3 fix confirmed
live in the render") — a gate run at `a6ff1ca` must detect misses 2–5 and must NOT flag
the taps. Miss 1 detection uses the Episode-1 pre-fix pin `ef1c0c8`.

## The five misses (detection targets — end-states must be authored from the PRD, not from these)

1. **UJ-2 taps never minted** (`packet/dossier_renderer.py`, `packet/compose.py`; fixed 689b83e):
   a composed Packet at `ef1c0c8` contains no yes/no/defer action links; `handle_decision`
   existed but was unreachable from the email. PRD observable: "taps Yes/No(+Grade)/Defer".
2. **Dossier renders 7 of 13 conviction fields** (`packet/dossier_renderer.py`; fixed 8d115d7):
   fit score, upside ceiling + triggers, P&L comparables, effort audit, builder crowding,
   kill criteria, red-team verdict, signal history all absent from the render while validated
   in the record. PRD observable: Dossier "opens with thesis, fit score…".
3. **Grade loop unreachable** (`ledger/grade_governance.py`, `packet/governance.py`; fixed
   8d115d7 via `_grade_links()`): `handle_grade` existed; no surface minted grade 1–5 tokens.
   PRD observable: "No(+Grade)" — five tappable grade links in the Packet's grade section.
4. **Pre-Claim inert** (`ops/pre_claim.py` ~219–234; fixed 8d115d7): raw ULID only — no
   summary paragraph, no fit score, no Hold/Release links (`handle_hold_release` unreachable).
   PRD observable (UJ-3): "one short email — one paragraph, fit score, one tap: Hold for
   Sunday / Release".
5. **Absence half-wired, both halves** (`packet/compose.py` no guard; `packet/return_summary.py`
   never imported by production; fixed 8d115d7): Packets sent during declared absences; return
   summary never composed. PRD observable (UJ-4): "sends nothing; first Packet back says what
   was released and why".

(8d115d7 also landed FR-20 default flip, the confirm interstitial, and the monthly chain —
NOT part of the five; a gate flagging their absence at pre-fix would be measuring scope creep,
not detection.)

## Render surfaces (→ the retro-fit acceptance contract)

- Weekly Packet (UJ-2 surface): `machine packet compose` (systemd: `deploy/packet-weekly.*`)
- Pre-Claim email (UJ-3): `machine pre-claim --run-once`
- Actions endpoint (receives taps): `machine actions` (FastAPI)
- Monthly digest: `machine digest-monthly`

Renders need a seeded scratch ledger. **Cheapest A3.2 path**: the review's own golden
snapshots (`acceptance-renders/` pre vs `acceptance-renders/v2/` post) are REAL rendered
artifacts from the real compose paths at exactly the two pins — judge those directly first
(file-surface contract pointing at the snapshot dirs), then graduate to live renders in a
scratch clone with fixture data if snapshot-judging proves insufficient.

## A3.2 protocol (the gate's own DoD)

1. Author `retrofit/journeys.yaml` for UJ-2/UJ-3/UJ-4 **from PRD §2.3 language only**
   (retro-fit integrity: iterating the judge prompt to reach 5/5 is legal; tuning
   end-states to the known bug locations is training-on-the-test — every end-state must
   cite its PRD sentence).
2. Scratch clone at each pin; contract = file surface over the golden snapshot dirs
   (or live `machine packet compose` render against a seeded ledger).
3. Run render→judge per journey. Required: **5/5 misses detected at the pre-fix pins**
   (miss 1 at `ef1c0c8`; misses 2–5 at `a6ff1ca`) with correct verdicts (never-wired →
   UNREACHABLE) and cited evidence; **0 false FAILs at `82f4fe7`**.
4. Write the run up as a dated evidence doc here; encode as eval regression entries (A3.3).
   Until step 3 passes, `acceptance.mode` blocking default stays pinned advisory.
