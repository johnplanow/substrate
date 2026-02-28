import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '../persistence/migrations/index.js';
import { createContextCompiler } from '../modules/context-compiler/index.js';
import { createDecision } from '../persistence/queries/decisions.js';
import { createGate } from '../modules/quality-gates/gate-registry.js';
import { createDebatePanel } from '../modules/debate-panel/index.js';
import { createPackLoader } from '../modules/methodology-pack/index.js';
import { existsSync, unlinkSync } from 'fs';
import { join, resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const DB_PATH = '/tmp/smoke-epic9.db';
const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
let db: ReturnType<typeof Database>;

beforeAll(() => {
  db = new Database(DB_PATH);
  runMigrations(db);
});

afterAll(() => {
  db.close();
  if (existsSync(DB_PATH)) unlinkSync(DB_PATH);
});

// Item 4: Context compiler
describe('Item 4: Context Compiler', () => {
  it('compiles context from decision store without errors', async () => {
    createDecision(db, { phase: 'planning', category: 'architecture', key: 'db-choice', value: 'SQLite', rationale: 'lightweight' });
    createDecision(db, { phase: 'planning', category: 'architecture', key: 'lang', value: 'TypeScript', rationale: 'type safety' });

    const compiler = createContextCompiler({ db });

    // Register a simple template for 'dev-story'
    compiler.registerTemplate({
      taskType: 'dev-story',
      sections: [
        {
          name: 'Architecture Decisions',
          priority: 'required',
          query: { table: 'decisions', filters: { phase: 'planning' } },
          format: (items: unknown[]) => items.map((r: any) => `- ${r.key}: ${r.value}`).join('\n'),
        },
      ],
    });

    const result = await compiler.compile({
      taskType: 'dev-story',
      pipelineRunId: 'smoke-test-run',
      tokenBudget: 2000,
    });

    expect(result).toBeDefined();
    expect(typeof result.prompt).toBe('string');
    expect(result.prompt.length).toBeGreaterThan(0);
    expect(result.tokenCount).toBeLessThanOrEqual(2000);
    // No unfilled {{variable}} placeholders
    expect(result.prompt).not.toMatch(/\{\{[^}]+\}\}/);
    // Should contain our decision data
    expect(result.prompt).toContain('SQLite');
  });
});

// Item 5: Methodology pack
describe('Item 5: Methodology Pack', () => {
  it('discovers the bmad pack', async () => {
    const loader = createPackLoader();
    const packs = await loader.discover(PROJECT_ROOT);
    const bmad = packs.find(p => p.name === 'bmad');
    expect(bmad, 'bmad pack not found').toBeDefined();
    expect(bmad!.path).toBeTruthy();
  });

  it('getPrompt(dev-story) returns coherent text with expected compiled-workflow placeholders', async () => {
    const loader = createPackLoader();
    const packs = await loader.discover(PROJECT_ROOT);
    const bmad = packs.find(p => p.name === 'bmad')!;
    expect(bmad).toBeDefined();
    const pack = await loader.load(bmad.path);
    const prompt = await pack.getPrompt('dev-story');
    expect(typeof prompt).toBe('string');
    expect(prompt.length).toBeGreaterThan(50);
    // Compiled workflow prompts use {{placeholder}} syntax filled by assemblePrompt at runtime.
    // Verify the expected placeholders are present in the template.
    expect(prompt).toMatch(/\{\{story_content\}\}/);
    // arch_constraints removed from dev-story (redundant with story Dev Notes)
    expect(prompt).not.toMatch(/\{\{arch_constraints\}\}/);
  });
});

// Item 6: Debate panel DB write
describe('Item 6: Debate Panel DB write', () => {
  it('persists routine decision rationale as valid JSON', async () => {
    // Use a mock perspectiveGenerator to avoid needing a real dispatcher
    const mockGenerator = async (viewpoint: string, question: string) => ({
      viewpoint,
      recommendation: 'proceed',
      confidence: 0.9,
      risks: [] as string[],
    });

    // Create a minimal mock dispatcher (required by interface but overridden by perspectiveGenerator)
    const mockDispatcher = {
      dispatch: () => { throw new Error('should not be called'); },
      shutdown: async () => {},
      getPending: () => 0,
      getRunning: () => 0,
    } as any;

    const panel = createDebatePanel({ dispatcher: mockDispatcher, db, perspectiveGenerator: mockGenerator });

    await panel.decide({
      key: 'smoke-db-decision',
      phase: 'planning',
      category: 'architecture',
      question: 'Should we use SQLite?',
      tier: 'routine',
    });

    // Verify the rationale stored in DB is valid JSON
    const row = db.prepare("SELECT rationale FROM decisions WHERE key = 'smoke-db-decision'").get() as any;
    expect(row, 'decision not persisted to DB').toBeDefined();
    expect(() => JSON.parse(row.rationale)).not.toThrow();
    const parsed = JSON.parse(row.rationale);
    expect(parsed).toHaveProperty('tier');
    expect(parsed).toHaveProperty('perspectives');
  });
});

// Item 7: Quality gate retry logic
describe('Item 7: Quality Gate retry logic', () => {
  it('transitions retry → retry → warn on 3 consecutive failures', () => {
    const gate = createGate('code-review-verdict', { maxRetries: 2 });

    const r1 = gate.evaluate({ verdict: 'REWORK' });
    const r2 = gate.evaluate({ verdict: 'REWORK' });
    const r3 = gate.evaluate({ verdict: 'REWORK' });

    expect(r1.action).toBe('retry');
    expect(r2.action).toBe('retry');
    expect(r3.action).toBe('warn');
  });

  it('reset() restores retry count', () => {
    const gate = createGate('code-review-verdict', { maxRetries: 1 });

    gate.evaluate({ verdict: 'REWORK' }); // retry
    gate.evaluate({ verdict: 'REWORK' }); // warn

    (gate as any).reset();

    const r = gate.evaluate({ verdict: 'REWORK' });
    expect(r.action).toBe('retry'); // back to first retry after reset
  });
});
