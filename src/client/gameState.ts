import { engine } from '@dcl/sdk/ecs'
import { startOrderGeneration, stopOrderGeneration } from './orders/orderManager'
import { finalizeRound, resetScore } from './scoring'
import { resetDeliveryStation } from './stations/delivery'
import { resetHornoStation } from './stations/horno'
import { resetMasaStation } from './stations/masa'
import { resetToppingsStation } from './stations/toppings'

// Top-level game state machine for the round flow:
//   idle    – before "Start Game" is pressed, or after a round ends and
//             the player closes the end screen.
//   playing – the round is in progress (tickets generating, timer running).
//   end     – the round just finished; shows the score summary until the
//             player clicks "Play Again".

export type GameState = 'idle' | 'playing' | 'end'

export const ROUND_DURATION_MS = 4 * 60 * 1000

let currentState: GameState = 'idle'
let roundEndsAt = 0

export function getGameState(): GameState {
  return currentState
}

export function isPlaying(): boolean {
  return currentState === 'playing'
}

export function getRoundRemainingMs(): number {
  if (currentState !== 'playing') return 0
  return Math.max(0, roundEndsAt - Date.now())
}

export function startRound(): void {
  resetScore()
  resetMasaStation()
  resetToppingsStation()
  resetHornoStation()
  resetDeliveryStation()
  startOrderGeneration()
  roundEndsAt = Date.now() + ROUND_DURATION_MS
  currentState = 'playing'
  console.log('[Game] round started')
}

export function endRound(): void {
  if (currentState !== 'playing') return
  stopOrderGeneration()
  finalizeRound()
  currentState = 'end'
  console.log('[Game] round ended')
}

// Triggered by the EndScreen "Play Again" button.
export function backToIdle(): void {
  currentState = 'idle'
}

function gameLoopSystem(_dt: number) {
  if (currentState !== 'playing') return
  if (Date.now() >= roundEndsAt) endRound()
}

engine.addSystem(gameLoopSystem)
