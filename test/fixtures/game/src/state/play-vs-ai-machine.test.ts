/**
 * Story 7.1 Task 7: XState Machine Unit Tests
 * Tests for play-vs-ai-machine.ts (AC11, AC12, AC7, AC8, AC9, AC10)
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { playVsAiMachine, type PlayVsAiContext } from './play-vs-ai-machine.js';

describe('PlayVsAiMachine', () => {
  let actor: ReturnType<typeof playVsAiMachine.createActor>;

  beforeEach(() => {
    // Clean up global mock state before each test
    delete (globalThis as any).__mockTilePool;

    actor = playVsAiMachine.createActor();
    actor.start();
  });

  afterEach(() => {
    // Clean up global mock state after each test
    delete (globalThis as any).__mockTilePool;
  });

  // AC11: State structure
  describe('State Structure (AC11)', () => {
    it('starts in modeSelection state', () => {
      const snapshot = actor.getSnapshot();
      expect(snapshot.matches('modeSelection')).toBe(true);
    });

    it('transitions from modeSelection to gameSetup on SELECT_PLAY_VS_AI', () => {
      actor.send({ type: 'SELECT_PLAY_VS_AI' });
      const snapshot = actor.getSnapshot();
      expect(snapshot.matches('gameSetup')).toBe(true);
    });

    it('transitions from modeSelection to advisorFlow on SELECT_ADVISOR', () => {
      actor.send({ type: 'SELECT_ADVISOR' });
      const snapshot = actor.getSnapshot();
      expect(snapshot.matches('advisorFlow')).toBe(true);
    });

    it('transitions from gameSetup to setupPhase on START_GAME', () => {
      actor.send({ type: 'SELECT_PLAY_VS_AI' });
      actor.send({ type: 'START_GAME' });
      const snapshot = actor.getSnapshot();
      expect(snapshot.value).toContain('setupPhase');
    });

    it('transitions from setupPhase to playing on SETUP_COMPLETE', () => {
      actor.send({ type: 'SELECT_PLAY_VS_AI' });
      actor.send({ type: 'START_GAME' });
      actor.send({ type: 'SETUP_COMPLETE' });
      const snapshot = actor.getSnapshot();
      expect(snapshot.matches('playing')).toBe(true);
    });
  });

  // AC12: Context defaults
  describe('Context Defaults (AC12)', () => {
    it('initializes with correct default context values', () => {
      const snapshot = actor.getSnapshot();
      const context: PlayVsAiContext = snapshot.context;

      expect(context.variant).toBe('easy');
      expect(context.playerCount).toBe(2);
      expect(context.currentPlayer).toBe(0);
      expect(context.aiPlayerIndex).toBe(0);
      expect(context.turnCount).toBe(0);
      expect(context.winner).toBe(null);
      expect(context.gameSummary).toBe(null);
    });
  });

  // AC4: Game configuration
  describe('Game Configuration (AC4)', () => {
    it('updates variant to easy on CONFIGURE_GAME', () => {
      actor.send({ type: 'SELECT_PLAY_VS_AI' });
      actor.send({ type: 'CONFIGURE_GAME', variant: 'easy' });
      const snapshot = actor.getSnapshot();
      expect(snapshot.context.variant).toBe('easy');
    });

    it('updates variant to michaels on CONFIGURE_GAME', () => {
      actor.send({ type: 'SELECT_PLAY_VS_AI' });
      actor.send({ type: 'CONFIGURE_GAME', variant: 'michaels' });
      const snapshot = actor.getSnapshot();
      expect(snapshot.context.variant).toBe('michaels');
    });

    it('updates variant to brunos on CONFIGURE_GAME', () => {
      actor.send({ type: 'SELECT_PLAY_VS_AI' });
      actor.send({ type: 'CONFIGURE_GAME', variant: 'brunos' });
      const snapshot = actor.getSnapshot();
      expect(snapshot.context.variant).toBe('brunos');
    });
  });

  // AC5: Opponent count configuration
  describe('Opponent Count Configuration (AC5, AC13)', () => {
    it('updates playerCount to 3 when opponentCount is 2', () => {
      actor.send({ type: 'SELECT_PLAY_VS_AI' });
      actor.send({ type: 'CONFIGURE_GAME', playerCount: 3 });
      const snapshot = actor.getSnapshot();
      expect(snapshot.context.playerCount).toBe(3);
    });

    it('updates playerCount to 4 when opponentCount is 3', () => {
      actor.send({ type: 'SELECT_PLAY_VS_AI' });
      actor.send({ type: 'CONFIGURE_GAME', playerCount: 4 });
      const snapshot = actor.getSnapshot();
      expect(snapshot.context.playerCount).toBe(4);
    });

    it('supports playerCount 2 (NFR-022)', () => {
      actor.send({ type: 'SELECT_PLAY_VS_AI' });
      actor.send({ type: 'CONFIGURE_GAME', playerCount: 2 });
      const snapshot = actor.getSnapshot();
      expect(snapshot.context.playerCount).toBe(2);
    });

    it('supports playerCount 3 (NFR-022)', () => {
      actor.send({ type: 'SELECT_PLAY_VS_AI' });
      actor.send({ type: 'CONFIGURE_GAME', playerCount: 3 });
      const snapshot = actor.getSnapshot();
      expect(snapshot.context.playerCount).toBe(3);
    });

    it('supports playerCount 4 (NFR-022)', () => {
      actor.send({ type: 'SELECT_PLAY_VS_AI' });
      actor.send({ type: 'CONFIGURE_GAME', playerCount: 4 });
      const snapshot = actor.getSnapshot();
      expect(snapshot.context.playerCount).toBe(4);
    });
  });

  // AC7: Tile pool initialization
  describe('Tile Pool Initialization (AC7)', () => {
    it('initializes pool with 40 tiles for playerCount 2', () => {
      actor.send({ type: 'SELECT_PLAY_VS_AI' });
      actor.send({ type: 'CONFIGURE_GAME', playerCount: 2 });
      actor.send({ type: 'START_GAME' });

      const pool = (globalThis as any).__mockTilePool;
      expect(pool).toBeDefined();
      expect(pool.length).toBe(40);

      // Verify 2 copies of each value 1-20
      for (let value = 1; value <= 20; value++) {
        const count = pool.filter((tile: number) => tile === value).length;
        expect(count).toBe(2);
      }
    });

    it('initializes pool with 60 tiles for playerCount 3', () => {
      actor.send({ type: 'SELECT_PLAY_VS_AI' });
      actor.send({ type: 'CONFIGURE_GAME', playerCount: 3 });
      actor.send({ type: 'START_GAME' });

      const pool = (globalThis as any).__mockTilePool;
      expect(pool).toBeDefined();
      expect(pool.length).toBe(60);

      // Verify 3 copies of each value 1-20
      for (let value = 1; value <= 20; value++) {
        const count = pool.filter((tile: number) => tile === value).length;
        expect(count).toBe(3);
      }
    });

    it('initializes pool with 80 tiles for playerCount 4', () => {
      actor.send({ type: 'SELECT_PLAY_VS_AI' });
      actor.send({ type: 'CONFIGURE_GAME', playerCount: 4 });
      actor.send({ type: 'START_GAME' });

      const pool = (globalThis as any).__mockTilePool;
      expect(pool).toBeDefined();
      expect(pool.length).toBe(80);

      // Verify 4 copies of each value 1-20
      for (let value = 1; value <= 20; value++) {
        const count = pool.filter((tile: number) => tile === value).length;
        expect(count).toBe(4);
      }
    });
  });

  // AC8: Player order assignment
  describe('Player Order Assignment (AC8)', () => {
    it('assigns human player to index 0', () => {
      const snapshot = actor.getSnapshot();
      // Human is always currentPlayer 0 at start
      expect(snapshot.context.currentPlayer).toBe(0);
    });
  });

  // AC9: Easy setup execution
  describe('Easy Setup Execution (AC9)', () => {
    it('completes Easy setup and fires SETUP_COMPLETE within 200ms', async () => {
      actor.send({ type: 'SELECT_PLAY_VS_AI' });
      actor.send({ type: 'CONFIGURE_GAME', variant: 'easy', playerCount: 2 });

      const startTime = performance.now();
      actor.send({ type: 'START_GAME' });

      // Wait for SETUP_COMPLETE
      await new Promise<void>((resolve) => {
        const unsub = actor.subscribe((snapshot) => {
          if (snapshot.value === 'playing') {
            unsub.unsubscribe();
            resolve();
          }
        });
      });

      const elapsed = performance.now() - startTime;
      expect(elapsed).toBeLessThan(200);

      const snapshot = actor.getSnapshot();
      expect(snapshot.matches('playing')).toBe(true);
    });

    it('transitions to playing state after Easy setup', async () => {
      actor.send({ type: 'SELECT_PLAY_VS_AI' });
      actor.send({ type: 'CONFIGURE_GAME', variant: 'easy' });
      actor.send({ type: 'START_GAME' });

      await new Promise<void>((resolve) => {
        const unsub = actor.subscribe((snapshot) => {
          if (snapshot.value === 'playing') {
            unsub.unsubscribe();
            resolve();
          }
        });
      });

      const snapshot = actor.getSnapshot();
      expect(snapshot.matches('playing')).toBe(true);
    });

    it('auto-places 4 ascending diagonal tiles for all players', async () => {
      actor.send({ type: 'SELECT_PLAY_VS_AI' });
      actor.send({ type: 'CONFIGURE_GAME', variant: 'easy', playerCount: 2 });
      actor.send({ type: 'START_GAME' });

      // Wait for setup to complete
      await new Promise<void>((resolve) => {
        const unsub = actor.subscribe((snapshot) => {
          if (snapshot.value === 'playing') {
            unsub.unsubscribe();
            resolve();
          }
        });
      });

      const snapshot = actor.getSnapshot();
      const boards = snapshot.context.playerBoards;

      // Should have boards for all players
      expect(boards).toBeDefined();
      expect(boards?.length).toBe(2);

      // Each player should have 4 diagonal tiles
      for (const board of boards!) {
        expect(board.diagonal.length).toBe(4);

        // Tiles should be sorted in non-decreasing order (ascending, allowing duplicates)
        const diagonal = board.diagonal;
        for (let i = 1; i < diagonal.length; i++) {
          expect(diagonal[i]).toBeGreaterThanOrEqual(diagonal[i - 1]);
        }
      }
    });
  });

  // AC10: Michael's Setup execution
  describe("Michael's Setup Execution (AC10)", () => {
    it('draws 4 diagonal tiles for human player', () => {
      actor.send({ type: 'SELECT_PLAY_VS_AI' });
      actor.send({ type: 'CONFIGURE_GAME', variant: 'michaels', playerCount: 2 });
      actor.send({ type: 'START_GAME' });

      const snapshot = actor.getSnapshot();
      expect(snapshot.context.pendingDiagonalTiles).toBeDefined();
      expect(snapshot.context.pendingDiagonalTiles?.length).toBe(4);
    });

    it('does not send SETUP_COMPLETE until 4 PLACE_DIAGONAL_TILE events', async () => {
      actor.send({ type: 'SELECT_PLAY_VS_AI' });
      actor.send({ type: 'CONFIGURE_GAME', variant: 'michaels', playerCount: 2 });
      actor.send({ type: 'START_GAME' });

      // Place first 3 tiles
      actor.send({ type: 'PLACE_DIAGONAL_TILE', tileValue: 5, position: 0 });
      actor.send({ type: 'PLACE_DIAGONAL_TILE', tileValue: 7, position: 1 });
      actor.send({ type: 'PLACE_DIAGONAL_TILE', tileValue: 3, position: 2 });

      let snapshot = actor.getSnapshot();
      expect(snapshot.matches('playing')).toBe(false);

      // Place 4th tile - should trigger SETUP_COMPLETE
      actor.send({ type: 'PLACE_DIAGONAL_TILE', tileValue: 9, position: 3 });

      // Wait for async SETUP_COMPLETE
      await new Promise<void>((resolve) => {
        const unsub = actor.subscribe((snapshot) => {
          if (snapshot.value === 'playing') {
            unsub.unsubscribe();
            resolve();
          }
        });
      });

      snapshot = actor.getSnapshot();
      expect(snapshot.matches('playing')).toBe(true);
    });

    it('tracks placed diagonal count correctly', () => {
      actor.send({ type: 'SELECT_PLAY_VS_AI' });
      actor.send({ type: 'CONFIGURE_GAME', variant: 'michaels' });
      actor.send({ type: 'START_GAME' });

      actor.send({ type: 'PLACE_DIAGONAL_TILE', tileValue: 5, position: 0 });
      let snapshot = actor.getSnapshot();
      expect(snapshot.context.placedDiagonalCount).toBe(1);

      actor.send({ type: 'PLACE_DIAGONAL_TILE', tileValue: 7, position: 1 });
      snapshot = actor.getSnapshot();
      expect(snapshot.context.placedDiagonalCount).toBe(2);
    });

    it('prevents placing on already occupied diagonal position', () => {
      actor.send({ type: 'SELECT_PLAY_VS_AI' });
      actor.send({ type: 'CONFIGURE_GAME', variant: 'michaels' });
      actor.send({ type: 'START_GAME' });

      actor.send({ type: 'PLACE_DIAGONAL_TILE', tileValue: 5, position: 0 });
      actor.send({ type: 'PLACE_DIAGONAL_TILE', tileValue: 7, position: 0 }); // Same position

      const snapshot = actor.getSnapshot();
      // Should still be 1, not 2
      expect(snapshot.context.placedDiagonalCount).toBe(1);
    });
  });

  // Bruno's variant uses same setup as Michael's (AC10 note)
  describe("Bruno's Variant Setup", () => {
    it('uses same setup as Michael\'s variant', () => {
      actor.send({ type: 'SELECT_PLAY_VS_AI' });
      actor.send({ type: 'CONFIGURE_GAME', variant: 'brunos' });
      actor.send({ type: 'START_GAME' });

      const snapshot = actor.getSnapshot();
      expect(snapshot.context.pendingDiagonalTiles).toBeDefined();
      expect(snapshot.context.pendingDiagonalTiles?.length).toBe(4);
    });
  });
});
