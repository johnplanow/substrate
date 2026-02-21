/**
 * DebatePanel interface definition.
 *
 * A debate panel evaluates decisions by soliciting multiple perspectives
 * and applying weighted voting to select the best recommendation.
 */

import type { DecisionRequest, DebateResult } from './types.js'

/**
 * A debate panel that generates structured multi-perspective decisions.
 */
export interface DebatePanel {
  /**
   * Make a decision by soliciting perspectives and applying weighted voting.
   *
   * - Routine: single perspective, auto-approved
   * - Significant: N perspectives (default 3), weighted vote, tie-break if margin < 10%
   * - Architectural: 5 specialized perspectives, >60% supermajority required
   */
  decide(request: DecisionRequest): Promise<DebateResult>
}
