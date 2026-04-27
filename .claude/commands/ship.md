# Ship

Run the substrate CI pipeline locally, fix issues, commit, and push.

Matches the GitHub Actions CI pipeline: build → circular dep check → typecheck:gate → test:fast → push.

## Procedure

Execute these steps sequentially. If a step fails and you cannot fix it after two attempts, stop and report the issue to the user. Do NOT skip steps.

### Step 1: Build

```bash
npm run build 2>&1
```

Build MUST come first — `tsc --build` outputs are required for subsequent steps. If build fails:
1. Read each TypeScript error carefully
2. Fix the type issues in source files
3. Re-run `npm run build` to confirm clean

### Step 2: Circular dependency check

```bash
npm run check:circular 2>&1
```

If circular dependencies are found, trace the import cycle and break it. This is a hard gate in CI.

### Step 3: Type check (gate)

```bash
npm run typecheck:gate 2>&1
```

This is the strict typecheck (`tsc --noEmit -p tsconfig.typecheck.json`). If it fails:
1. Read the type errors
2. Fix them — this gate uses a stricter config than the build
3. Re-run to confirm clean

### Step 4: Tests

**IMPORTANT**: Before running, verify no other vitest instance is running:
```bash
pgrep -f vitest
```
If anything is returned, wait or kill it first.

Run unit tests (fast suite — excludes e2e/integration):
```bash
npm run test:fast 2>&1
```

**CRITICAL**: Use `timeout: 300000` (5 min). Do NOT pipe output through tail/head/grep. Do NOT run in background. Confirm results by checking for "Test Files" in output.

If tests fail:
1. Read the failure output
2. Determine if the test is wrong or the code is wrong
3. Fix the root cause
4. Re-run to confirm all pass
5. Report the test count

### Step 5: Commit

Only if there are changes to commit:

1. `git status` — review what changed
2. `git diff` — review the actual changes
3. Stage the relevant files (do NOT use `git add -A` — be specific about files)
4. Commit with a descriptive message summarizing what was fixed
5. Include `Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>`

If no changes, skip to Step 6.

### Step 6: Version bump, tag, and push

1. Read the current version from `package.json`
2. Bump the patch version (e.g., 0.19.27 → 0.19.28). Update ALL FOUR workspace package.json files (root + packages/core + packages/sdlc + packages/factory) — they must match.
3. **Run `npm run version:sync`** — aligns cross-package `dependencies` references in `packages/factory/package.json` and `packages/sdlc/package.json` to point at the new `@substrate-ai/core` version. Without this, the workspace tarballs have a broken internal dep graph.
4. **Run `npm install --package-lock-only --no-audit --no-fund`** — regenerates `package-lock.json` from the synced package.json files. Without this, `npm ci` in CI/publish workflows fails with EUSAGE / "Missing: @substrate-ai/core@<old> from lock file" and the tag is burned.
5. Commit the version bump with a message summarizing what's in the release:
   ```
   chore: bump version to v{VERSION} — {brief summary}
   ```
   Stage: package.json, package-lock.json, packages/*/package.json. All five must be in the same commit so the lockfile and package.json files stay in sync at every commit boundary.
6. Tag the commit: `git tag v{VERSION}`
7. Push commit and tag:
   ```bash
   git push && git push --tags
   ```

The tag push triggers the GitHub Actions npm publish workflow.

If push fails due to remote changes, `git pull --rebase` and re-run from Step 1.

**Burned-tags recovery**: if a publish workflow run fails at install with EUSAGE, the version is burned (per memory's published-version-immutability rule — `npm publish` rejects re-publishing the same version even after the failed attempt is deleted). Bump to the next version, fix the lockfile, ship that. Delete the burned tag with `git push --delete origin v{VERSION}`.

### Step 7: Verify CI

```bash
sleep 15 && gh run list --limit 1
```

Report the CI run status. If still in progress, tell the user and offer to check back.

## Summary

After all steps, report concisely:
- What was fixed (if anything)
- Test count and result
- Version and tag
- Commit hash
- CI run status
