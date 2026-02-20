# Substrate

Multi-agent orchestration daemon for AI coding agents. Substrate coordinates multiple CLI-based AI agents (Claude Code, Codex, Gemini CLI) to work on complex software tasks in parallel using git worktrees.

## Prerequisites

- **Node.js** 18.0.0 or later
- **git** 2.20 or later
- At least one supported AI CLI agent installed (Claude Code, Codex CLI, or Gemini CLI)

## Setup

```bash
# Install dependencies
npm install

# Build the project
npm run build

# Run the CLI
npx tsx src/cli/index.ts --version
```

## Development

```bash
# Start development mode (watches for changes)
npm run dev

# Run tests
npm test

# Run tests in watch mode
npm run test:watch

# Run tests with UI
npm run test:ui

# Type check
npm run typecheck

# Lint
npm run lint

# Lint and fix
npm run lint:fix

# Format code
npm run format

# Check formatting
npm run format:check

# Clean build output
npm run clean
```

## Project Structure

```
substrate/
├── src/
│   ├── cli/              # CLI commands (Commander.js)
│   │   ├── index.ts      # Main entry point
│   │   ├── commands/     # Command handlers
│   │   └── middleware/   # CLI middleware
│   ├── core/             # Core engine
│   │   ├── errors.ts     # Error definitions
│   │   └── types.ts      # TypeScript interfaces
│   ├── adapters/         # Worker adapter interface
│   ├── engine/           # Specialized subsystems
│   └── utils/            # Shared utilities
│       ├── logger.ts     # pino-based logging
│       └── helpers.ts    # General utilities
├── test/                 # Test files (vitest)
├── dist/                 # Build output (generated)
├── docs/                 # Documentation
├── config/               # Default configurations
├── .github/workflows/    # CI/CD pipelines
├── package.json
├── tsconfig.json
├── vitest.config.ts
└── eslint.config.js
```

## Architecture

Substrate follows a **modular monolith** pattern running as a single Node.js process with clearly separated internal modules. The orchestrator itself never calls LLMs directly; all intelligent work is delegated to CLI agents.

## License

MIT
