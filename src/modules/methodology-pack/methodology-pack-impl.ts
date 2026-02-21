/**
 * MethodologyPack implementation.
 *
 * Provides lazy-loaded, cached access to pack content files.
 * Variable interpolation replaces {{varName}} with manifest-provided values.
 */

import { readFile } from 'fs/promises'
import { join } from 'path'
import yaml from 'js-yaml'
import { ConstraintFileSchema } from './schemas.js'
import type { MethodologyPack, PackManifest, PhaseDefinition, ConstraintRule } from './types.js'

// ---------------------------------------------------------------------------
// Variable interpolation
// ---------------------------------------------------------------------------

/**
 * Replace {{varName}} tokens in a string with values from the given map.
 * Unknown variables are left unchanged.
 */
function interpolate(template: string, vars: Record<string, string>): string {
  return template.replace(/\{\{(\w+)\}\}/g, (match, key: string) => {
    return Object.prototype.hasOwnProperty.call(vars, key) ? (vars[key] ?? match) : match
  })
}

// ---------------------------------------------------------------------------
// MethodologyPackImpl
// ---------------------------------------------------------------------------

export class MethodologyPackImpl implements MethodologyPack {
  readonly manifest: PackManifest
  private readonly _packPath: string

  // Cache maps: key → loaded content
  private readonly _promptCache = new Map<string, string>()
  private readonly _constraintCache = new Map<string, ConstraintRule[]>()
  private readonly _templateCache = new Map<string, string>()

  constructor(manifest: PackManifest, packPath: string) {
    this.manifest = manifest
    this._packPath = packPath
  }

  getPhases(): PhaseDefinition[] {
    return this.manifest.phases
  }

  async getPrompt(taskType: string): Promise<string> {
    if (this._promptCache.has(taskType)) {
      return this._promptCache.get(taskType)!
    }

    const relativePath = this.manifest.prompts[taskType]
    if (relativePath === undefined) {
      throw new Error(
        `Methodology pack "${this.manifest.name}" has no prompt for task type "${taskType}". ` +
          `Available: ${Object.keys(this.manifest.prompts).join(', ')}`
      )
    }

    const filePath = join(this._packPath, relativePath)
    let content: string
    try {
      content = await readFile(filePath, 'utf-8')
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      throw new Error(
        `Failed to read prompt file for task type "${taskType}" at "${filePath}": ${msg}`
      )
    }

    // Build interpolation variables from manifest metadata
    const vars: Record<string, string> = {
      methodology: this.manifest.name,
      phase: taskType,
    }
    const interpolated = interpolate(content, vars)
    this._promptCache.set(taskType, interpolated)
    return interpolated
  }

  async getConstraints(phase: string): Promise<ConstraintRule[]> {
    if (this._constraintCache.has(phase)) {
      return this._constraintCache.get(phase)!
    }

    const relativePath = this.manifest.constraints[phase]
    if (relativePath === undefined) {
      throw new Error(
        `Methodology pack "${this.manifest.name}" has no constraints for phase "${phase}". ` +
          `Available: ${Object.keys(this.manifest.constraints).join(', ')}`
      )
    }

    const filePath = join(this._packPath, relativePath)
    let raw: string
    try {
      raw = await readFile(filePath, 'utf-8')
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      throw new Error(
        `Failed to read constraints file for phase "${phase}" at "${filePath}": ${msg}`
      )
    }

    const parsed = yaml.load(raw)
    const result = ConstraintFileSchema.safeParse(parsed)
    if (!result.success) {
      const issues = result.error.issues
        .map((i) => `  • ${i.path.join('.')}: ${i.message}`)
        .join('\n')
      throw new Error(
        `Invalid constraint file for phase "${phase}" at "${filePath}":\n${issues}`
      )
    }

    this._constraintCache.set(phase, result.data)
    return result.data
  }

  async getTemplate(name: string): Promise<string> {
    if (this._templateCache.has(name)) {
      return this._templateCache.get(name)!
    }

    const relativePath = this.manifest.templates[name]
    if (relativePath === undefined) {
      throw new Error(
        `Methodology pack "${this.manifest.name}" has no template named "${name}". ` +
          `Available: ${Object.keys(this.manifest.templates).join(', ')}`
      )
    }

    const filePath = join(this._packPath, relativePath)
    let content: string
    try {
      content = await readFile(filePath, 'utf-8')
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      throw new Error(
        `Failed to read template "${name}" at "${filePath}": ${msg}`
      )
    }

    this._templateCache.set(name, content)
    return content
  }
}
