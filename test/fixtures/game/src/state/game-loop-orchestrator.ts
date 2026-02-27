/**
 * Story 7.1: Game Loop Orchestrator Scaffold
 *
 * This module coordinates between the XState machine, Zustand data store,
 * and Web Worker AI calls. It will be extended by Story 7-3 (AI Opponent Turn).
 *
 * @module GameLoopOrchestrator
 * @story 7.1
 * @extends Story 7-3 will add AI turn sequencing logic
 */

export interface GameLoopOrchestrator {
  /**
   * Initiates an AI turn for the specified player index.
   * To be implemented in Story 7-3.
   *
   * @param playerIndex - The AI player index (1-3)
   * @story 7-3
   */
  startAiTurn(playerIndex: number): Promise<void>;

  /**
   * Callback invoked when an AI turn completes.
   * To be implemented in Story 7-3.
   *
   * @story 7-3
   */
  onAiTurnComplete(): void;
}

/**
 * Creates a GameLoopOrchestrator instance.
 * Current implementation is a stub for Story 7.1.
 * Story 7-3 will add full AI turn sequencing with Web Worker integration.
 *
 * @returns GameLoopOrchestrator instance
 * @story 7.1
 */
export function createGameLoopOrchestrator(): GameLoopOrchestrator {
  return {
    async startAiTurn(playerIndex: number): Promise<void> {
      // Stub implementation - to be filled by Story 7-3
      console.log(`[Stub] Starting AI turn for player ${playerIndex}`);
      return Promise.resolve();
    },

    onAiTurnComplete(): void {
      // Stub implementation - to be filled by Story 7-3
      console.log('[Stub] AI turn complete');
    },
  };
}
