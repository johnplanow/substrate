/**
 * Story 7.1: XState v5 Play vs AI Machine
 *
 * This is a fixture implementation for BMAD workflow testing.
 * In a real implementation, this would import from 'xstate'.
 */

// Type-only imports to avoid runtime dependency
type Variant = 'easy' | 'michaels' | 'brunos';
type PlayerCount = 2 | 3 | 4;

export interface GameSummary {
  winner: number;
  turnCount: number;
  finalScores: number[];
}

export interface PlayVsAiContext {
  variant: Variant;
  playerCount: PlayerCount;
  currentPlayer: number;
  aiPlayerIndex: number;
  turnCount: number;
  winner: number | null;
  gameSummary: GameSummary | null;
  pendingDiagonalTiles?: number[];
  placedDiagonalCount?: number;
  occupiedDiagonalPositions?: Set<number>;
  // Mock board state for testing (diagonal positions only)
  playerBoards?: Array<{ diagonal: number[] }>;
}

export type PlayVsAiEvent =
  | { type: 'SELECT_PLAY_VS_AI' }
  | { type: 'SELECT_ADVISOR' }
  | { type: 'CONFIGURE_GAME'; variant?: Variant; playerCount?: PlayerCount }
  | { type: 'START_GAME' }
  | { type: 'SETUP_COMPLETE' }
  | { type: 'PLACE_DIAGONAL_TILE'; tileValue: number; position: number }
  | { type: 'DRAW_FROM_POOL' }
  | { type: 'TAKE_FROM_DISCARD' }
  | { type: 'PLACE_TILE'; row: number; col: number }
  | { type: 'SWAP_TILE'; row: number; col: number }
  | { type: 'DISCARD_TILE' }
  | { type: 'AI_TURN_COMPLETE' }
  | { type: 'GAME_OVER_ACKNOWLEDGED' }
  | { type: 'PLAY_AGAIN_SAME' }
  | { type: 'CHANGE_SETTINGS' }
  | { type: 'NEW_GAME' };

// Mock XState setup/createMachine pattern
interface MachineConfig {
  id: string;
  initial: string;
  context: PlayVsAiContext;
  states: Record<string, any>;
}

interface ActorRef {
  send: (event: PlayVsAiEvent) => void;
  getSnapshot: () => { value: string; context: PlayVsAiContext; matches: (state: string | object) => boolean };
  start: () => ActorRef;
  stop: () => void;
  subscribe: (callback: (snapshot: any) => void) => { unsubscribe: () => void };
}

// Fisher-Yates shuffle
function shuffle<T>(array: T[]): T[] {
  const result = [...array];
  for (let i = result.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [result[i], result[j]] = [result[j], result[i]];
  }
  return result;
}

// Initialize tile pool based on player count
function initializeTilePool(playerCount: PlayerCount): number[] {
  const tiles: number[] = [];
  for (let value = 1; value <= 20; value++) {
    for (let copy = 0; copy < playerCount; copy++) {
      tiles.push(value);
    }
  }
  return shuffle(tiles);
}

// Mock machine implementation (would use real XState in production)
class MockMachine {
  private currentState: string = 'modeSelection';
  private context: PlayVsAiContext;
  private config: MachineConfig;
  private listeners: Set<(snapshot: any) => void> = new Set();

  constructor(config: MachineConfig) {
    this.config = config;
    this.context = { ...config.context };
  }

  createActor(): ActorRef {
    const self = this;
    return {
      send: (event: PlayVsAiEvent) => self.handleEvent(event),
      getSnapshot: () => ({
        value: self.currentState,
        context: { ...self.context },
        matches: (state: string | object) => {
          if (typeof state === 'string') {
            return self.currentState === state;
          }
          // Handle nested state matching like { setupPhase: 'executingSetup' }
          const key = Object.keys(state)[0];
          const value = (state as any)[key];
          return self.currentState.startsWith(key) && self.currentState.includes(value);
        },
      }),
      start: () => self.createActor(),
      stop: () => {},
      subscribe: (callback: (snapshot: any) => void) => {
        self.listeners.add(callback);
        return { unsubscribe: () => self.listeners.delete(callback) };
      },
    };
  }

  private handleEvent(event: PlayVsAiEvent) {
    switch (event.type) {
      case 'SELECT_PLAY_VS_AI':
        this.currentState = 'gameSetup';
        break;
      case 'SELECT_ADVISOR':
        this.currentState = 'advisorFlow';
        break;
      case 'CONFIGURE_GAME':
        if (event.variant) this.context.variant = event.variant;
        if (event.playerCount) this.context.playerCount = event.playerCount;
        break;
      case 'START_GAME':
        this.initializePool();
        this.executeVariantSetup();
        this.currentState = 'setupPhase.executingSetup';
        break;
      case 'SETUP_COMPLETE':
        this.currentState = 'playing';
        break;
      case 'PLACE_DIAGONAL_TILE':
        this.handleDiagonalTilePlacement(event.tileValue, event.position);
        break;
    }
    this.notifyListeners();
  }

  private initializePool() {
    // In real implementation, this would call Zustand store
    const pool = initializeTilePool(this.context.playerCount);
    // Store pool in Zustand (simulated here)
    (globalThis as any).__mockTilePool = pool;
  }

  private executeVariantSetup() {
    if (this.context.variant === 'easy') {
      // Easy setup: auto-place 4 ascending diagonal tiles for all players
      // AC9: Draw 4 tiles per player, sort ascending, place on diagonal
      const pool = (globalThis as any).__mockTilePool || [];
      this.context.playerBoards = [];

      let poolIndex = 0;
      for (let playerIndex = 0; playerIndex < this.context.playerCount; playerIndex++) {
        // Draw 4 tiles for this player
        const tiles = pool.slice(poolIndex, poolIndex + 4);
        poolIndex += 4;

        // Sort ascending
        const sortedTiles = [...tiles].sort((a, b) => a - b);

        // Place on diagonal (positions 0, 1, 2, 3)
        this.context.playerBoards.push({
          diagonal: sortedTiles,
        });
      }

      // Complete within 200ms
      setTimeout(() => {
        this.handleEvent({ type: 'SETUP_COMPLETE' });
      }, 10); // Much less than 200ms
    } else if (this.context.variant === 'michaels' || this.context.variant === 'brunos') {
      // Michael's/Bruno's setup: draw 4 tiles for human, wait for placement
      const pool = (globalThis as any).__mockTilePool || [];
      this.context.pendingDiagonalTiles = pool.slice(0, 4);
      this.context.placedDiagonalCount = 0;
      this.context.occupiedDiagonalPositions = new Set();
      this.context.playerBoards = [];
    }
  }

  private handleDiagonalTilePlacement(tileValue: number, position: number) {
    if (!this.context.occupiedDiagonalPositions) {
      this.context.occupiedDiagonalPositions = new Set();
    }

    // Validate position not already occupied
    if (this.context.occupiedDiagonalPositions.has(position)) {
      console.warn(`Position ${position} already occupied`);
      return;
    }

    this.context.occupiedDiagonalPositions.add(position);
    this.context.placedDiagonalCount = (this.context.placedDiagonalCount || 0) + 1;

    // Initialize human board if needed
    if (!this.context.playerBoards || this.context.playerBoards.length === 0) {
      this.context.playerBoards = [{ diagonal: [] }];
    }

    // Place tile on human's diagonal
    this.context.playerBoards[0].diagonal[position] = tileValue;

    // After 4 placements, auto-resolve AI diagonals and complete setup
    if (this.context.placedDiagonalCount === 4) {
      // Auto-resolve AI diagonals: draw 4 tiles per AI, sort, place
      const pool = (globalThis as any).__mockTilePool || [];
      let poolIndex = 4; // Human took first 4

      for (let playerIndex = 1; playerIndex < this.context.playerCount; playerIndex++) {
        const tiles = pool.slice(poolIndex, poolIndex + 4);
        poolIndex += 4;
        const sortedTiles = [...tiles].sort((a, b) => a - b);
        this.context.playerBoards.push({ diagonal: sortedTiles });
      }

      setTimeout(() => {
        this.handleEvent({ type: 'SETUP_COMPLETE' });
      }, 10);
    }
  }

  private notifyListeners() {
    const snapshot = {
      value: this.currentState,
      context: { ...this.context },
    };
    this.listeners.forEach(cb => cb(snapshot));
  }
}

// Export mock machine
export const playVsAiMachine = new MockMachine({
  id: 'playVsAi',
  initial: 'modeSelection',
  context: {
    variant: 'easy',
    playerCount: 2,
    currentPlayer: 0,
    aiPlayerIndex: 0,
    turnCount: 0,
    winner: null,
    gameSummary: null,
  },
  states: {
    modeSelection: {},
    gameSetup: {},
    setupPhase: {
      initial: 'executingSetup',
      states: {
        executingSetup: {},
      },
    },
    playing: {},
    gameOver: {},
  },
});

// Mock React hook (would use real useMachine from XState in production)
export function usePlayVsAiMachine() {
  const actor = playVsAiMachine.createActor();
  actor.start();

  return {
    state: actor.getSnapshot(),
    send: actor.send.bind(actor),
  };
}
