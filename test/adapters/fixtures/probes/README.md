# Adapter CLI Output Probes

Captured 2026-02-21 — CLI versions:
(Use `node --trace-deprecation ...` to show where the warning was created)
0.26.0
codex-cli 0.101.0

## Findings
- gemini -p <prompt>: plain JSON stdout ✓
- gemini <prompt> --output-format json: wraps in {session_id,response,stats} envelope ✗
- codex exec <prompt> (plain): plain JSON stdout ✓
- codex exec --json: JSONL event stream ✗
