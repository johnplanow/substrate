# Constraint Adherence Fix — Technology Preferences Lost in Pipeline

## Problem

When a user specifies technology constraints in the concept prompt (e.g., "GCP is the preferred cloud platform", "Backend: Kotlin/JVM, Node.js excluded"), these constraints are structurally dropped during the analysis phase and never reach the planning phase's tech stack selection.

**Result:** The pipeline silently overrides explicit user technology preferences. Observed in both v0.1.19 (original nextgen-ticketing run) and v0.1.23 (post-Epic 16 run). The user had to manually correct the tech stack both times.

## Root Cause — Three-Stage Information Loss

### Stage 1: `analysis-step-1-vision.md` actively discards technology

Line 23 instructs: *"Ground it in user pain, not technology"*

Output schema only has `problem_statement` and `target_users` — no field for technology preferences. Technology mentions in the concept are filtered out by design.

### Stage 2: `analysis-step-2-scope.md` biases constraints toward business/regulatory

The prompt asks for constraints with examples like "regulatory requirements, budget boundaries, platform restrictions." While "technical limitations" is mentioned, the examples and the residual instruction from Step 1 bias the model toward business constraints. The output `constraints` array captures PCI-DSS, ADA, marketplace APIs — but zero technology preferences.

**Evidence from v0.1.23 run:** 9 constraints produced, all business/regulatory. GCP and Kotlin/JVM not present despite being in a clearly labeled "Technology Constraints" section of the concept.

### Stage 3: `planning-step-3-nfrs.md` makes tech choices in a vacuum

Line 32 says: *"Choices should align with the product brief constraints"*

But the product brief constraints no longer mention GCP or Kotlin — they were dropped in Stage 2. The model picks TypeScript/NestJS/AWS based on its own judgment, following instructions correctly against the constraints it can see.

## Evidence

### Concept prompt (input) — technology constraints clearly stated:
```
## Technology Constraints
- **GCP is the preferred cloud platform** (Cloud Run, GKE, Cloud SQL, Memorystore, Pub/Sub, BigQuery)
- **Backend: Kotlin/JVM** — Node.js/JavaScript explicitly excluded for backend services.
```

### Analysis output (product brief) — technology constraints absent:
9 constraints, all business/regulatory. No mention of GCP, Kotlin, or any technology preference.

### Planning output (tech stack) — model's own choices:
```json
{
  "language": "TypeScript 5",
  "backend_framework": "NestJS on Node.js 20 LTS",
  "infrastructure": "AWS (EKS, Aurora, ElastiCache, MSK, S3, CloudFront)"
}
```

Both GCP and Kotlin/JVM were overridden. Node.js was used despite being "explicitly excluded."

### Old run (v0.1.19) — same behavior:
The original pipeline run also defaulted to AWS/TypeScript until the user manually injected corrections mid-run. This is a structural issue, not a model fluke.

## Fix Plan

### Fix 1: `packs/bmad/prompts/analysis-step-1-vision.md`

**Change line 23 from:**
```
   - Ground it in user pain, not technology
```
**To:**
```
   - Ground the problem statement in user pain, not technology choices
```

Minor wording fix — the instruction should scope to the problem statement, not the entire analysis.

### Fix 2: `packs/bmad/prompts/analysis-step-2-scope.md`

**Add `technology_constraints` to the instructions (after the constraints section, ~line 32):**

```markdown
4. **Identify technology constraints:**
   - Explicit technology preferences or restrictions stated in the concept
   - Cloud platform, programming language, framework, or infrastructure choices
   - Include ONLY preferences explicitly stated by the user — do not infer or add your own
   - If none are stated in the concept, emit an empty array
```

**Add `technology_constraints` to the output schema:**

```yaml
result: success
core_features:
  - "CLI command to register, check-off, and view daily habits"
success_metrics:
  - "Daily active usage rate >60% among onboarded users"
constraints:
  - "CLI-only interface limits audience to terminal-comfortable users"
technology_constraints:
  - "Must work offline with local storage, no cloud dependency"
```

### Fix 3: `packs/bmad/prompts/planning-step-3-nfrs.md`

**Add technology constraints to the context section (after `{{functional_requirements}}`):**

```markdown
### Technology Constraints (from Analysis Phase)
{{technology_constraints}}
```

**Add instruction to honor them (in the tech stack section, ~line 30):**

```markdown
2. **Specify the tech stack:**
   - Key-value pairs mapping technology concerns to specific choices
   - Use real, current technologies — do not fabricate frameworks
   - Cover at minimum: language, framework, database, testing
   - **MUST honor stated technology constraints** — if the analysis specifies a cloud platform, language, or framework preference, use it. Do not substitute alternatives unless the constraint is technically impossible for the requirements.
   - If you must deviate from a stated constraint, explicitly note the deviation and rationale
```

### Fix 4: `packs/bmad/prompts/readiness-check.md`

**Add a constraint-adherence check to the readiness validation criteria.** After the existing FR coverage check, add:

```markdown
4. **Constraint adherence:**
   - Does the architecture honor all technology constraints from the product brief?
   - If any technology constraint was overridden, is there an explicit rationale?
   - Flag any silent deviations as NEEDS_WORK findings
```

### Fix 5: Schema update — `src/modules/phase-orchestrator/phases/schemas.ts`

Add `technology_constraints` to the analysis step 2 output schema (the Zod schema that validates the YAML output):

```typescript
// In the analysis step 2 scope schema:
technology_constraints: z.array(z.string()).optional().default([])
```

### Fix 6: Decision store threading

In `src/modules/phase-orchestrator/step-runner.ts` (or the context assembly logic), ensure `technology_constraints` decisions from the analysis phase are injected into the planning step 3 template as `{{technology_constraints}}`.

## Files to Modify

1. `packs/bmad/prompts/analysis-step-1-vision.md` — line 23 wording fix
2. `packs/bmad/prompts/analysis-step-2-scope.md` — add technology_constraints field + instructions
3. `packs/bmad/prompts/planning-step-3-nfrs.md` — add context injection + honor instruction
4. `packs/bmad/prompts/readiness-check.md` — add constraint-adherence check
5. `src/modules/phase-orchestrator/phases/schemas.ts` — add technology_constraints to Zod schema
6. `src/modules/phase-orchestrator/step-runner.ts` — thread technology_constraints into planning context

## Verification

After implementing, re-run the nextgen-ticketing pipeline with the same concept.md and verify:
1. Analysis step 2 outputs `technology_constraints: ["GCP...", "Kotlin/JVM..."]`
2. Planning step 3 receives those constraints and picks GCP + Kotlin/JVM
3. Architecture decisions use GCP services (GKE, Cloud SQL, Memorystore) not AWS
4. Readiness check validates constraint adherence

## Notes

- The enriched concept prompt is at `/Users/John.Planow/code/ticketing-platform/nextgen-ticketing/concept.md`
- The v0.1.23 pipeline run (with the bug) is run ID `8d1a572f-ec45-48ee-a223-c49220dd5626`
- The old v0.1.19 run (same bug) is run ID `b9d39c0f-deff-43b6-ac30-54bc353208d7`
- This fix should be implemented as a patch release (v0.1.24) and re-validated against the ticketing platform concept
