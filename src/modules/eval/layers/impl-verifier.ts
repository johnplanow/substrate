// src/modules/eval/layers/impl-verifier.ts
import type { EvalAssertion } from '../types.js'

export interface StorySpec {
  files: string[]
  acceptanceCriteria: string[]
}

export class ImplVerifier {
  buildAssertions(storySpec: StorySpec): EvalAssertion[] {
    if (storySpec.files.length === 0 && storySpec.acceptanceCriteria.length === 0) {
      return []
    }

    const assertions: EvalAssertion[] = []

    if (storySpec.files.length > 0) {
      const fileList = storySpec.files.map((f) => `"${f}"`).join(', ')
      assertions.push({
        type: 'javascript',
        value: [
          `// Check that expected files exist`,
          `const fs = require('fs')`,
          `const files = [${fileList}]`,
          `const missing = files.filter(f => !fs.existsSync(f))`,
          `if (missing.length > 0) return { pass: false, score: 0, reason: 'Missing files: ' + missing.join(', ') }`,
          `return { pass: true, score: 1.0, reason: 'All expected files exist' }`,
        ].join('\n'),
        label: 'file-existence',
      })
    }

    if (storySpec.files.some((f) => f.endsWith('.ts') || f.endsWith('.tsx'))) {
      assertions.push({
        type: 'javascript',
        value: [
          `const { execSync } = require('child_process')`,
          `try {`,
          `  execSync('npx tsc --noEmit', { encoding: 'utf-8', timeout: 30000 })`,
          `  return { pass: true, score: 1.0, reason: 'TypeScript compilation succeeds' }`,
          `} catch (err) {`,
          `  return { pass: false, score: 0, reason: 'Compilation failed: ' + err.stdout?.slice(0, 500) }`,
          `}`,
        ].join('\n'),
        label: 'compile-check',
      })
    }

    if (storySpec.acceptanceCriteria.length > 0) {
      const acList = storySpec.acceptanceCriteria
        .map((ac, i) => `${i + 1}. ${ac}`)
        .join('\n')

      assertions.push({
        type: 'llm-rubric',
        value: [
          'Evaluate whether the code changes satisfy these acceptance criteria:',
          '',
          acList,
          '',
          'Score on a 0-1 scale:',
          '- 1.0: All acceptance criteria are clearly satisfied',
          '- 0.7: Most criteria satisfied, minor gaps',
          '- 0.4: Some criteria met but significant gaps',
          '- 0.0: Acceptance criteria are not addressed',
        ].join('\n'),
        label: 'acceptance-criteria',
      })
    }

    return assertions
  }
}
