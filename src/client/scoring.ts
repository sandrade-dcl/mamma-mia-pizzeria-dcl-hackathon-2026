// Single source of truth for the round's score. Game events (serve, expire,
// discard) call `addPoints` with the amount; the HUD reads `getScore()`
// every frame. Negative totals are allowed — design choice, see GAME_DESIGN.

let currentScore = 0
let bestScore = 0

export const SCORE_SERVE_BASE = 100
export const SCORE_SERVE_BONUS_MAX = 50
export const SCORE_EXPIRED_TICKET = -100
export const SCORE_DISCARD_WITH_TOPPINGS = -25
export const SCORE_DISCARD_BURNT = -50

export function getScore(): number {
  return currentScore
}

export function getBestScore(): number {
  return bestScore
}

export function addPoints(delta: number): void {
  currentScore += delta
}

// Bonus scales linearly with how much time was left on the ticket: serving
// the moment the ticket appears = max bonus, serving when it's about to
// expire = 0 bonus. `remainingProgress` is the timer bar fill ratio (0..1).
export function serveBonusFor(remainingProgress: number): number {
  const clamped = Math.max(0, Math.min(1, remainingProgress))
  return Math.round(SCORE_SERVE_BONUS_MAX * clamped)
}

// Penalty for discarding a pizza based on what it was. Returns a negative
// number ready to be passed to addPoints — no penalty for empty dough.
export function penaltyForDiscard(step: number, toppingCount: number): number {
  if (step === 5 /* PizzaStep.Burnt */) return SCORE_DISCARD_BURNT
  if (toppingCount === 0) return 0
  return SCORE_DISCARD_WITH_TOPPINGS
}

// Called at the start of every round (Hito 3.4 will hook this to the
// "Start Game" button).
export function resetScore(): void {
  currentScore = 0
}

// Called at the end of a round to update the all-time best.
export function finalizeRound(): void {
  if (currentScore > bestScore) bestScore = currentScore
}
