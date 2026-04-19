#!/usr/bin/env node
// Sync workspace package versions to the root package.json version, and pin
// any internal @substrate-ai/* dependencies to the same version. Run before
// publishing so workspace tarballs declare a resolvable internal dep graph
// instead of the "*" placeholder used during local development.
//
// Workspace discovery is automatic: every packages/*/package.json whose
// "name" begins with "@substrate-ai/" is synced. Adding a new workspace
// package requires no changes to this script.

import { readFileSync, readdirSync, writeFileSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = join(here, '..')
const packagesDir = join(repoRoot, 'packages')

const rootPkgPath = join(repoRoot, 'package.json')
const rootPkg = JSON.parse(readFileSync(rootPkgPath, 'utf8'))
const version = rootPkg.version

if (!version || typeof version !== 'string') {
  throw new Error(`Root package.json is missing a valid "version" field (got ${JSON.stringify(version)})`)
}

const SCOPE_PREFIX = '@substrate-ai/'
const depSections = ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies']

// Discover every packages/<dir>/package.json scoped under @substrate-ai/*.
const workspaces = readdirSync(packagesDir)
  .map((entry) => {
    const pkgJsonPath = join(packagesDir, entry, 'package.json')
    let stat
    try {
      stat = statSync(pkgJsonPath)
    } catch {
      return null
    }
    if (!stat.isFile()) return null
    const pkg = JSON.parse(readFileSync(pkgJsonPath, 'utf8'))
    if (typeof pkg.name !== 'string' || !pkg.name.startsWith(SCOPE_PREFIX)) return null
    return { dir: entry, pkgJsonPath, pkg }
  })
  .filter(Boolean)

if (workspaces.length === 0) {
  throw new Error(`No workspace packages found under ${packagesDir} with name starting "${SCOPE_PREFIX}"`)
}

const internalDepNames = new Set(workspaces.map((w) => w.pkg.name))

for (const { dir, pkgJsonPath, pkg } of workspaces) {
  pkg.version = version

  for (const section of depSections) {
    const deps = pkg[section]
    if (!deps) continue
    for (const dep of Object.keys(deps)) {
      if (internalDepNames.has(dep)) {
        deps[dep] = version
      }
    }
  }

  writeFileSync(pkgJsonPath, JSON.stringify(pkg, null, 2) + '\n')
  console.log(`synced packages/${dir} (${pkg.name}) -> ${version}`)
}
