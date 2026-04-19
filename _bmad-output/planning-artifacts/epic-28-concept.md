# Epic 28: Context Engineering — Repo-Map + Model Routing

## Vision

Close the feedback loop between observability (Epic 27) and agent behavior. Build a persistent, tree-sitter-based repo-map that gives agents structural knowledge of the codebase without re-exploring it every turn. Implement model routing so exploration tokens go to cheap models and expensive models are reserved for code generation. Use telemetry data to measure savings and optimize routing.

## In Scope

- Tree-sitter-based repo-map: parse codebase into structural skeleton (classes, functions, exports, imports, types) stored in Dolt
- Incremental repo-map updates: after each story, update only changed files via git diff
- Repo-map query interface: agents request relevant structure by topic/file/symbol
- Model routing configuration: per-task-type model selection (exploration vs generation vs review)
- Model routing in dispatch: dispatcher selects model based on task phase
- Routing telemetry: measure token savings using Epic 27's efficiency data
- Repo-map injection into prompts: include relevant repo-map context in story agent prompts
- CLI: `substrate repo-map --show`, `--update`, `--query <symbol>`

## Out of Scope

- Semantic analysis beyond tree-sitter (type inference, flow analysis)
- Automatic prompt rewriting based on telemetry
- Multi-repo repo-map
- Fine-tuning or custom model training
- Third-party model providers beyond Claude and OpenAI

## Sprint Structure

Sprint 1 (P0): Tree-sitter integration, Dolt storage + incremental updates, query interface
Sprint 2 (P0/P1): Model routing config, model-routed dispatch, routing telemetry
Sprint 3 (P1): Repo-map prompt injection, telemetry-driven tuning, CLI commands
