import { engine } from '@dcl/sdk/ecs'
import { RoundState } from '../shared/syncedState'

// Hito 4 — Option A: scoring lives entirely on the server. This module
// exposes the read-side helpers used by the HUD and the discard-penalty
// constants the server applies; clients no longer report deltas (the
// server already knows step + toppings of every pizza, so it computes the
// authoritative penalty itself when handling CmdDiscard).

export const SCORE_SERVE_BASE = 100
export const SCORE_SERVE_BONUS_MAX = 50
export const SCORE_EXPIRED_TICKET = -100
export const SCORE_DISCARD_WITH_TOPPINGS = -25
export const SCORE_DISCARD_BURNT = -50

function findRoundEntity() {
  for (const [entity] of engine.getEntitiesWith(RoundState)) {
    return entity
  }
  return null
}

export function getScore(): number {
  const e = findRoundEntity()
  if (e === null) return 0
  return RoundState.getOrNull(e)?.score ?? 0
}

export function getBestScore(): number {
  const e = findRoundEntity()
  if (e === null) return 0
  return RoundState.getOrNull(e)?.bestScore ?? 0
}

// Bonus scales linearly with how much time was left on the ticket: serving
// the moment the ticket appears = max bonus, serving when it's about to
// expire = 0. The server uses this same function when handling
// CmdAttemptServe; the HUD's "Ready to serve!" hint reads it for the
// estimated bonus.
export function serveBonusFor(remainingProgress: number): number {
  const clamped = Math.max(0, Math.min(1, remainingProgress))
  return Math.round(SCORE_SERVE_BONUS_MAX * clamped)
}

// Discard penalty by pizza step + topping count. The server is the only
// caller in Hito 4 (CmdDiscard handler) but the constants are colocated
// with the HUD-side reads to keep the scoring surface in one place.
export function penaltyForDiscard(step: number, toppingCount: number): number {
  if (step === 5 /* PizzaStep.Burnt */) return SCORE_DISCARD_BURNT
  if (toppingCount === 0) return 0
  return SCORE_DISCARD_WITH_TOPPINGS
}
