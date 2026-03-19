/**
 * Resolves the install command for adding new dependencies based on the project profile.
 *
 * Reads the project-profile.yaml written by `substrate init` to determine the
 * correct package install command for the detected language/build tool.
 * Falls back to a generic instruction if the profile is unavailable.
 *
 * This keeps language-specific install commands in the detection layer
 * (project-profile/detect.ts) rather than hardcoding them in prompts.
 */

import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Returns the install command string for the current project.
 * Used as a template variable ({{install_command}}) in the dev-story prompt.
 */
export function resolveInstallCommand(projectRoot?: string): string {
  if (!projectRoot) {
    return 'the appropriate package install command for this project'
  }

  const profilePath = join(projectRoot, '.substrate', 'project-profile.yaml')
  if (!existsSync(profilePath)) {
    return 'the appropriate package install command for this project'
  }

  try {
    const content = readFileSync(profilePath, 'utf-8')

    // Extract installCommand from YAML (simple line-based parsing to avoid yaml dependency)
    const match = content.match(/^\s*installCommand:\s*['"]?(.+?)['"]?\s*$/m)
    if (match?.[1]) {
      return match[1]
    }

    // Fallback: infer from buildTool
    const toolMatch = content.match(/^\s*buildTool:\s*['"]?(\w+)['"]?\s*$/m)
    if (toolMatch?.[1]) {
      const tool = toolMatch[1]
      const commands: Record<string, string> = {
        npm: 'npm install <package>',
        pnpm: 'pnpm add <package>',
        yarn: 'yarn add <package>',
        bun: 'bun add <package>',
        go: 'go get <package>',
        cargo: 'cargo add <package>',
        pip: 'pip install <package>',
        poetry: 'poetry add <package>',
        gradle: 'add dependency to build.gradle',
        maven: 'add dependency to pom.xml',
      }
      return commands[tool] ?? 'the appropriate package install command for this project'
    }
  } catch {
    // Profile unreadable — fall through to generic
  }

  return 'the appropriate package install command for this project'
}
