#!/usr/bin/env node

import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { existsSync } from 'node:fs'

const MEMORY_BLOCK_START = '<!-- codex-memory:start -->'
const MEMORY_BLOCK_END = '<!-- codex-memory:end -->'

function usage() {
  console.error(`Usage:
  node scripts/bootstrap-agent-memory.mjs --repo /absolute/path/to/repo [options]

Options:
  --repo <path>             Target repository path
  --memory-name <name>      Name for ~/.codex/memories/<name>.md
  --claude-project <path>   Explicit ~/.claude/projects/<slug> path
  --force-docs              Overwrite docs/agent-memory.md if it already exists
  --dry-run                 Print intended actions without writing files
  --help                    Show this help
`)
}

function parseArgs(argv) {
  const options = {
    repo: '',
    memoryName: '',
    claudeProject: '',
    forceDocs: false,
    dryRun: false,
    help: false,
  }

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]

    if (arg === '--repo') {
      options.repo = argv[++i] ?? ''
    } else if (arg === '--memory-name') {
      options.memoryName = argv[++i] ?? ''
    } else if (arg === '--claude-project') {
      options.claudeProject = argv[++i] ?? ''
    } else if (arg === '--force-docs') {
      options.forceDocs = true
    } else if (arg === '--dry-run') {
      options.dryRun = true
    } else if (arg === '--help' || arg === '-h') {
      options.help = true
    } else {
      throw new Error(`Unknown argument: ${arg}`)
    }
  }

  return options
}

function sanitizeMemoryName(name) {
  const normalized = name.trim().toLowerCase().replace(/\s+/g, '-')
  const safe = normalized.replace(/[^a-z0-9._-]/g, '-').replace(/-+/g, '-')
  return safe || 'project'
}

function deriveClaudeProjectPath(repoPath, explicitPath) {
  if (explicitPath) {
    return explicitPath
  }

  const slug = repoPath.replace(/[^A-Za-z0-9]+/g, '-')
  return path.join(os.homedir(), '.claude', 'projects', slug)
}

function renderTemplate(template, values) {
  return template.replace(/{{([A-Z_]+)}}/g, (_, key) => values[key] ?? '')
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function upsertManagedBlock(content, block) {
  const blockPattern = new RegExp(
    `${escapeRegExp(MEMORY_BLOCK_START)}[\\s\\S]*?${escapeRegExp(MEMORY_BLOCK_END)}\\n?`,
    'm',
  )

  if (blockPattern.test(content)) {
    return content.replace(blockPattern, `${block}\n`)
  }

  const landingPlaneMatch = /^## Landing the Plane\b/m.exec(content)

  if (landingPlaneMatch) {
    return `${content.slice(0, landingPlaneMatch.index)}${block}\n\n${content.slice(landingPlaneMatch.index)}`
  }

  const trimmed = content.trimEnd()
  return trimmed ? `${trimmed}\n\n${block}\n` : `${block}\n`
}

async function readIfExists(filePath) {
  if (!existsSync(filePath)) {
    return null
  }

  return fs.readFile(filePath, 'utf8')
}

async function listMarkdownFiles(dirPath) {
  if (!existsSync(dirPath)) {
    return []
  }

  const entries = await fs.readdir(dirPath, { withFileTypes: true })
  return entries
    .filter((entry) => entry.isFile() && entry.name.endsWith('.md'))
    .map((entry) => path.join(dirPath, entry.name))
    .sort((a, b) => a.localeCompare(b))
}

async function ensureDir(dirPath, dryRun) {
  if (existsSync(dirPath)) {
    return
  }

  if (dryRun) {
    return
  }

  await fs.mkdir(dirPath, { recursive: true })
}

async function writeFileIfChanged(filePath, content, dryRun) {
  const existing = await readIfExists(filePath)

  if (existing === content) {
    return 'unchanged'
  }

  if (dryRun) {
    return existing === null ? 'create' : 'update'
  }

  await fs.writeFile(filePath, content, 'utf8')
  return existing === null ? 'created' : 'updated'
}

function makeSourceList(repoPath, paths) {
  const bullets = []

  bullets.push(`- Repo instructions: \`${path.join(repoPath, 'AGENTS.md')}\``)

  if (paths.hasClaudeRepoFile) {
    bullets.push(`- Repo Claude instructions: \`${path.join(repoPath, 'CLAUDE.md')}\``)
  }

  if (paths.claudeMemoryFiles.length > 0) {
    bullets.push(`- Claude project memory directory: \`${paths.claudeMemoryDir}\``)
    for (const filePath of paths.claudeMemoryFiles) {
      bullets.push(`- Claude memory file: \`${filePath}\``)
    }
  } else if (paths.hasClaudeProjectDir) {
    bullets.push(`- Claude project directory found, but no memory markdown files were detected: \`${paths.claudeProjectDir}\``)
  } else {
    bullets.push(`- No Claude project memory directory detected at: \`${paths.claudeProjectDir}\``)
  }

  bullets.push('- Recent session transcripts only if a durable rule is missing from the markdown sources')

  return bullets.join('\n')
}

function buildAgentsBlock() {
  return `${MEMORY_BLOCK_START}
## Persistent Agent Memory

This repo carries forward durable agent memory in [\`docs/agent-memory.md\`](docs/agent-memory.md).

- Treat \`AGENTS.md\` as the primary Codex instruction surface
- Use \`docs/agent-memory.md\` for distilled project memory and validation lessons
- If historical memory conflicts with current code, docs, or tests, current repo state wins
${MEMORY_BLOCK_END}`
}

function buildPointerContent(repoPath) {
  return `# ${path.basename(repoPath)}

Repository: \`${repoPath}\`

For any Codex session in this repo, start with:

- \`${path.join(repoPath, 'AGENTS.md')}\`
- \`${path.join(repoPath, 'docs', 'agent-memory.md')}\`

If historical memory conflicts with the current repository state, current code, docs, and tests win.
`
}

async function main() {
  const options = parseArgs(process.argv.slice(2))

  if (options.help) {
    usage()
    return
  }

  if (!options.repo) {
    usage()
    process.exitCode = 1
    return
  }

  const repoPath = await fs.realpath(path.resolve(options.repo))
  const repoName = path.basename(repoPath)
  const memoryName = sanitizeMemoryName(options.memoryName || repoName)
  const agentsPath = path.join(repoPath, 'AGENTS.md')
  const claudeRepoFilePath = path.join(repoPath, 'CLAUDE.md')
  const docsDir = path.join(repoPath, 'docs')
  const agentMemoryPath = path.join(docsDir, 'agent-memory.md')
  const pointerPath = path.join(os.homedir(), '.codex', 'memories', `${memoryName}.md`)
  const claudeProjectDir = deriveClaudeProjectPath(repoPath, options.claudeProject)
  const claudeMemoryDir = path.join(claudeProjectDir, 'memory')
  const claudeMemoryFiles = await listMarkdownFiles(claudeMemoryDir)
  const hasClaudeProjectDir = existsSync(claudeProjectDir)
  const hasClaudeRepoFile = existsSync(claudeRepoFilePath)
  const scriptDir = path.dirname(fileURLToPath(import.meta.url))
  const templatePath = path.join(scriptDir, '..', 'docs', 'templates', 'agent-memory.template.md')
  const template = await fs.readFile(templatePath, 'utf8')

  const docsContent = renderTemplate(template, {
    DATE: new Date().toISOString().slice(0, 10),
    SOURCE_LIST: makeSourceList(repoPath, {
      claudeProjectDir,
      claudeMemoryDir,
      claudeMemoryFiles,
      hasClaudeProjectDir,
      hasClaudeRepoFile,
    }),
  })

  const existingAgents = (await readIfExists(agentsPath)) ?? '# Agent Instructions\n'
  const updatedAgents = upsertManagedBlock(existingAgents, buildAgentsBlock())

  await ensureDir(docsDir, options.dryRun)
  await ensureDir(path.dirname(pointerPath), options.dryRun)

  const docsExists = existsSync(agentMemoryPath)
  const docsAction = docsExists && !options.forceDocs
    ? 'preserved'
    : await writeFileIfChanged(agentMemoryPath, docsContent, options.dryRun)
  const agentsAction = await writeFileIfChanged(agentsPath, updatedAgents, options.dryRun)
  const pointerAction = await writeFileIfChanged(pointerPath, buildPointerContent(repoPath), options.dryRun)

  console.log(`Repository: ${repoPath}`)
  console.log(`AGENTS.md: ${agentsAction}`)
  console.log(`docs/agent-memory.md: ${docsAction}`)
  console.log(`Global pointer: ${pointerAction} (${pointerPath})`)
  console.log(`Claude project dir: ${hasClaudeProjectDir ? claudeProjectDir : 'not found'}`)
  console.log(`Claude memory markdown files: ${claudeMemoryFiles.length}`)

  if (docsExists && !options.forceDocs) {
    console.log('docs/agent-memory.md already existed and was left unchanged. Use --force-docs to overwrite it with the scaffold.')
  }

  if (claudeMemoryFiles.length > 0) {
    console.log('Discovered Claude memory files:')
    for (const filePath of claudeMemoryFiles) {
      console.log(`- ${filePath}`)
    }
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error))
  process.exitCode = 1
})
