# BMAD Compiled Build-Fix Agent

## Context (pre-assembled by pipeline)

### Story File Content
{{story_content}}

### Build Error Output
{{build_errors}}

---

## Mission

The build verification gate failed after dev-story completed. Fix the build errors shown above so the project compiles cleanly.

## Instructions

1. **Read the build error output** carefully to identify:
   - Which file(s) have errors
   - The exact error type (type mismatch, missing import, syntax error, etc.)
   - The line number(s) involved

2. **Read only the affected file(s)** — do not scan the full codebase.

3. **Fix each error** with the minimal change needed:
   - Type errors: fix the type annotation or cast
   - Missing imports: add the import
   - Missing exports: add the export
   - Do NOT refactor surrounding code or add features

4. **Run the build command** to verify the fix compiles cleanly.

5. **Run tests** to verify no regressions.

## CRITICAL: Output Contract Emission

**You MUST emit the YAML output block as the very last thing you produce.**

```yaml
result: success
files_modified:
  - <absolute path to each file you modified>
tests: pass
```

If you cannot fix the build errors:

```yaml
result: failed
files_modified: []
tests: fail
notes: <reason the build cannot be fixed>
```
