# RP6 leg 1 (preparatory) — derive recall vs the income-sources founding journeys (2026-07-10)

*Live `substrate acceptance derive` (v0.21.19) against the full income-sources
post-fix PRD, UNHINTED (no registry present), measured against the A3.2
reference registry `retrofit/journeys.yaml`. This is the meatiest RP6 leg;
run early as preparatory evidence. Formal RP6 close still awaits RP5.3
(operator `/code-review ultra`).*

## Result: 7 journeys, all 3 reference founding journeys recovered + 4 the hand-authored registry had missed

Derived (no operator hint, no registry to anchor on):

| id | title | criticality | maps to |
|---|---|---|---|
| UJ-1 | John reviews the dislocation audit and ratifies the Gate verdict | critical | PRD UJ-1 — **missing from the reference registry** (RP3.3 finding) |
| UJ-2 | John clears the Sunday Packet and records decisions and grades | **critical** | **reference UJ-2** (the founding miss — taps + conviction fields + grade loop) |
| UJ-3 | John handles a mid-week Pre-Claim interrupt with a single tap | standard | **reference UJ-3** (Tuesday Pre-Claim) |
| UJ-4 | John returns from a declared absence and finds the system held position cleanly | standard | **reference UJ-4** (declared absence) |
| UJ-5 | John receives a same-day alert when a feed heartbeat fails | standard | PRD UJ-5 — **missing from the reference registry** (RP3.3 finding) |
| UJ-6 | John ratifies proposed outcome labels in the monthly Packet section | standard | bulk-ratify — **missing from the reference registry** |
| UJ-7 | John resumes normal operation after an Overload Protocol freeze | standard | Overload resume — **missing from the reference registry** |

## Assessment

- **Founding-journey recall: 3/3.** UJ-2/UJ-3/UJ-4 (the reference registry's
  entire content, encoding all 5 founding end-state misses) were all
  surfaced, with UJ-2 — the founding never-wired journey — correctly marked
  `critical`. Titles differ in wording (substantive match, not lexical),
  surfaces correct.
- **The founding premise, demonstrated end-to-end:** derive recovered the
  3 reference journeys AND the 4 journeys the *carefully hand-authored*
  reference registry silently dropped (two of which the PRD literally numbers
  UJ-1 and UJ-5). "Derive, don't transcribe" is not a hypothesis anymore —
  on this corpus the machine's unhinted derivation is strictly more complete
  than the human's careful transcription.
- Retro-fit integrity: derive ran against the untouched PRD with no registry
  and no hint; the reference registry was used only as the post-hoc scoring
  key, never shown to the agent.

## RP6 leg status (preparatory, pre-RP5.3)

| Leg | Evidence | State |
|---|---|---|
| 1. derive surfaces founding journeys unhinted | this doc — 3/3, UJ-2 critical | GREEN |
| 2. planted UJ-2 omission → journey-undispositioned + span | RP3.3 harness leg 2 (real dispatch) | GREEN |
| 3. planted PRD mutation → registry-stale + diff | Ship 3/4 live smokes | GREEN |
| 4. 0-noise floor on post-fix corpus | RP3.3 harness leg 1 | GREEN |
| 5. live pipeline run produces a candidate | Ship 6 DoD (wordbank) | GREEN |

All five legs have GREEN evidence. **RP6 formal close is gated only on RP5.3
(operator `/code-review ultra`)** — findings from that pass become new rows,
then RP6 is declared and the program closes.
