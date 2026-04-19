# Epic 31: Dolt Work Graph — Stories as First-Class Entities

**Status: PLANNED**
**Sequencing: After Epic 29 (Dolt migration complete), before Epic 30 (Telemetry Optimization)**

## Vision

Make Dolt the single source of truth for the pipeline's work graph — stories, their statuses, and their dependencies. Replace the current split-brain architecture (epic docs, story spec frontmatter, Dolt state store, MEMORY.md) with one authoritative store that the orchestrator reads, writes, and queries for all dispatch decisions.

The end state: **stories are rows, dependencies are rows, status is a column, and `ready_stories` is a SQL view.**

## Rationale

### The split-brain problem

Story status currently lives in four places that don't sync:

| Source | Who writes | Who reads | Authoritative? |
|--------|-----------|-----------|---------------|
| Epic doc (`planning-artifacts/`) | Human / planning agent | Pipeline (prompt assembly), human | No — goes stale |
| Story spec (`implementation-artifacts/`) | create-story agent, dev agent | Pipeline (dispatch), human | Partially — `Status:` field sometimes updated |
| Dolt state store (`pipeline_stories`) | Orchestrator | `substrate status`, health, metrics | For runtime state only |
| MEMORY.md | Human + Claude, manually | Future conversations | No — manual summary |

Result: Epic 29 had stories marked `PLANNED` in the epic doc that were already `COMPLETE` in reality. The pipeline dispatched 29-8 before 29-6 because nothing enforced the documented dependency chain.

### The dependency enforcement gap

The old task-graph system (deleted in commit c939a6b, 2026-03-01) had full DAG scheduling with a `task_dependencies` table, `ready_tasks` view, and cycle detection. When the implementation-orchestrator replaced it, dependency enforcement was not carried forward. Contract-aware ordering (Story 25-5) provides semantic ordering but is not explicit dependency enforcement.

### Why Dolt is the right home

- Epic 29 established Dolt as the single database engine — no more SQLite
- Dolt provides versioned history of the work graph (git-for-data)
- SQL views (`ready_stories`) make dispatch decisions a single query
- Branch/merge semantics could enable speculative story execution in future

## Schema Design

```sql
-- Stories as first-class entities
CREATE TABLE stories (
  key           VARCHAR(20) PRIMARY KEY,   -- '29-6'
  epic          VARCHAR(20) NOT NULL,       -- '29'
  title         VARCHAR(255),
  status        ENUM('planned','ready','in_progress','complete','escalated','blocked'),
  spec_path     VARCHAR(500),               -- path to implementation artifact
  created_at    TIMESTAMP,
  updated_at    TIMESTAMP,
  completed_at  TIMESTAMP
);

-- Dependency graph
CREATE TABLE story_dependencies (
  story_key     VARCHAR(20),
  depends_on    VARCHAR(20),
  dep_type      ENUM('blocks','informs'),   -- hard vs soft dependency
  source        ENUM('explicit','contract','inferred'),
  created_at    TIMESTAMP,
  PRIMARY KEY (story_key, depends_on),
  FOREIGN KEY (story_key) REFERENCES stories(key),
  FOREIGN KEY (depends_on) REFERENCES stories(key)
);

-- Dispatch queue: only stories with all hard deps satisfied
CREATE VIEW ready_stories AS
  SELECT s.* FROM stories s
  WHERE s.status IN ('planned', 'ready')
  AND NOT EXISTS (
    SELECT 1 FROM story_dependencies d
    JOIN stories dep ON dep.key = d.depends_on
    WHERE d.story_key = s.key
    AND d.dep_type = 'blocks'
    AND dep.status NOT IN ('complete')
  );
```

## Architecture

```
Planning phase:                    Runtime:

Epic doc ──→ Ingest ──→ stories table ──→ ready_stories view ──→ dispatch
  (input)      │         (Dolt, authoritative)                      │
               │                                                     │
Story specs ──→│         story_dependencies ◄── contract detector    │
  (input)      │         (Dolt, authoritative)                       │
               │                                                     ▼
               └── cycle detection                           status updates
                   (reject bad graphs)                      (Dolt writes)
                                                                     │
                                                                     ▼
                                                            substrate status
                                                            (reads Dolt)
```

### Key principles

1. **Epic docs are planning input, not runtime state.** The orchestrator ingests them once during story discovery. After that, Dolt is authoritative.
2. **Story specs are implementation context, not status trackers.** The `Status:` field in story spec frontmatter is either deprecated or read-only (generated from Dolt).
3. **One write path for status.** Only the orchestrator writes to `stories.status`. Everything else reads.
4. **Dependencies are data, not documentation.** Stored as rows in `story_dependencies`, queryable, with cycle detection at ingest time.
5. **Three dependency sources.** `explicit` (human-declared), `contract` (interface analysis), `inferred` (file overlap / import analysis).

## Story Map (Draft)

```
Sprint 1 — Foundation:
  31-1: Create stories + story_dependencies tables, ready_stories view (P0, S)
  31-2: Epic doc ingestion — parse story entries + dependency chains into Dolt (P0, M)
  31-3: Dispatch gating — orchestrator queries ready_stories instead of flat discovery (P0, M)

Sprint 2 — Integration:
  31-4: Status lifecycle — orchestrator writes all transitions to stories table (P0, M)
  31-5: substrate status reads from Dolt work graph — show blocked stories + why (P0, S)
  31-6: Contract detector writes to story_dependencies (source='contract') (P1, M)
  31-7: Cycle detection at ingest time (P1, S)

Sprint 3 — Cleanup:
  31-8: Deprecate Status field in story spec frontmatter (P1, S)
  31-9: substrate epic-status command — generated view of epic from Dolt (P2, S)
```

### Dependency chain

```
31-1 → 31-2 → 31-3 → 31-4 → 31-5
                 │
                 └→ 31-6, 31-7 (parallel)
                          │
                          └→ 31-8, 31-9 (parallel, cleanup)
```

## Success Metrics

- Story 29-8 scenario impossible: orchestrator refuses to dispatch a story with unsatisfied hard dependencies
- `substrate status` shows blocked stories and what they're waiting on
- Zero manual status updates needed in epic docs — Dolt is authoritative
- Epic doc story statuses never go stale (they're either not tracked there, or generated from Dolt)
- Contract-aware ordering (25-5) feeds into the same dependency table

## Risk Assessment

| Risk | Mitigation |
|------|-----------|
| Ingestion parser too fragile for varied epic doc formats | Standardize on a parseable format; validate at ingest time |
| Migration disrupts active pipeline runs | Stories table is additive; old dispatch path remains as fallback until 31-3 |
| Dependency graph too rigid — blocks stories that could proceed | `informs` (soft) vs `blocks` (hard) distinction; only hard deps gate dispatch |
| Cycle in dependency graph hangs dispatch | 31-7 detects cycles at ingest; reject bad graphs before they reach dispatch |

## Related

- **Epic 29**: Dolt as single database engine (prerequisite — must complete first)
- **Epic 30**: Telemetry-Driven Optimization (first epic to validate 31's dispatch enforcement)
- **Story 25-5**: Contract-aware ordering (feeds into `story_dependencies` with `source='contract'`)
- **Backlog**: Zero-diff escalation bug (separate fix, same orchestrator area)
- **Backlog**: Status write-back to epic doc (superseded by this epic — Dolt becomes authoritative instead)
