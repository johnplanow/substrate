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
      const fileList = storySpec.files.map((f) => `\`${f}\``).join(', ')
      assertions.push({
        type: 'llm-rubric',
        value: [
          'Check whether the implementation output references creating or modifying the expected files.',
          '',
          `Expected files: ${fileList}`,
          '',
          'Score on a 0-1 scale:',
          '- 1.0: Output explicitly mentions all expected files as created or modified',
          '- 0.7: Most expected files are referenced; a few minor ones missing',
          '- 0.4: Only some expected files are mentioned',
          '- 0.0: Output does not reference any of the expected files',
        ].join('\n'),
        label: 'file-coverage',
      })
    }

    if (storySpec.files.some((f) => f.endsWith('.ts') || f.endsWith('.tsx'))) {
      assertions.push({
        type: 'llm-rubric',
        value: [
          'Check whether the implementation output indicates successful compilation or build.',
          '',
          'Score on a 0-1 scale:',
          '- 1.0: Output explicitly reports successful build/compilation with no errors',
          '- 0.7: Output mentions build success but with minor warnings',
          '- 0.4: Output does not mention build status at all',
          '- 0.0: Output reports build or compilation failures',
        ].join('\n'),
        label: 'build-evidence',
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
