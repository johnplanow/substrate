import { describe, it, expect } from 'vitest'
import { join, isAbsolute } from 'node:path'
import {
  buildEpicsFileCandidates,
  buildPlanningDirs,
  DEFAULT_EPICS_FILES,
  DEFAULT_PLANNING_DIRS,
} from '../epic-paths.js'

const ROOT = '/proj'

describe('buildEpicsFileCandidates', () => {
  it('includes docs/planning/epics.md among the defaults (the reported gap)', () => {
    const candidates = buildEpicsFileCandidates(ROOT)
    expect(candidates).toContain(join(ROOT, 'docs/planning/epics.md'))
    expect(candidates).toContain(join(ROOT, '_bmad-output/planning-artifacts/epics.md'))
    expect(candidates).toContain(join(ROOT, '_bmad-output/epics.md'))
  })

  it('puts a relative override first, resolved against the project root', () => {
    const candidates = buildEpicsFileCandidates(ROOT, 'custom/epics.md')
    expect(candidates[0]).toBe(join(ROOT, 'custom/epics.md'))
    // defaults still present after the override
    expect(candidates).toContain(join(ROOT, 'docs/planning/epics.md'))
  })

  it('honors an absolute override path verbatim', () => {
    const candidates = buildEpicsFileCandidates(ROOT, '/abs/path/epics.md')
    expect(candidates[0]).toBe('/abs/path/epics.md')
    expect(isAbsolute(candidates[0]!)).toBe(true)
  })

  it('ignores a blank/whitespace override', () => {
    expect(buildEpicsFileCandidates(ROOT, '   ')).toEqual(buildEpicsFileCandidates(ROOT))
    expect(buildEpicsFileCandidates(ROOT, '')).toEqual(buildEpicsFileCandidates(ROOT))
  })

  it('preserves the documented default ordering', () => {
    const candidates = buildEpicsFileCandidates(ROOT)
    expect(candidates).toEqual(DEFAULT_EPICS_FILES.map((r) => join(ROOT, r)))
  })
})

describe('buildPlanningDirs', () => {
  it('includes docs/planning among the default scan dirs', () => {
    const dirs = buildPlanningDirs(ROOT)
    expect(dirs).toEqual(DEFAULT_PLANNING_DIRS.map((r) => join(ROOT, r)))
    expect(dirs).toContain(join(ROOT, 'docs/planning'))
  })

  it('searches the override file’s parent directory first', () => {
    const dirs = buildPlanningDirs(ROOT, 'plans/epics.md')
    expect(dirs[0]).toBe(join(ROOT, 'plans'))
  })
})
