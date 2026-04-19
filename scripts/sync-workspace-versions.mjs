#!/usr/bin/env node
// Sync workspace package versions to the root package.json version, and pin
// any internal @substrate-ai/* dependencies to the same version. Run before
// publishing so workspace tarballs declare a resolvable internal dep graph
// instead of the "*" placeholder used during local development.

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..');

const rootPkgPath = join(repoRoot, 'package.json');
const rootPkg = JSON.parse(readFileSync(rootPkgPath, 'utf8'));
const version = rootPkg.version;

if (!version || typeof version !== 'string') {
  throw new Error(`Root package.json is missing a valid "version" field (got ${JSON.stringify(version)})`);
}

const workspaceDirs = ['core', 'sdlc', 'factory'];
const internalDepNames = new Set(workspaceDirs.map((name) => `@substrate-ai/${name}`));
const depSections = ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies'];

for (const name of workspaceDirs) {
  const pkgPath = join(repoRoot, 'packages', name, 'package.json');
  const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));

  pkg.version = version;

  for (const section of depSections) {
    const deps = pkg[section];
    if (!deps) continue;
    for (const dep of Object.keys(deps)) {
      if (internalDepNames.has(dep)) {
        deps[dep] = version;
      }
    }
  }

  writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n');
  console.log(`synced packages/${name} -> ${version}`);
}
