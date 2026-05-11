import { engine } from '@dcl/sdk/ecs'
import { Topping } from '../pizza/pizzaTypes'
import { SCORE_EXPIRED_TICKET, addPoints } from '../scoring'
import {
  EXPIRED_DISPLAY_MS,
  FINAL_GENERATION_INTERVAL_MS,
  GENERATION_RAMP_DURATION_MS,
  INITIAL_GENERATION_INTERVAL_MS,
  MAX_ACTIVE_ORDERS,
  Order,
  RECIPES,
  TICKET_LIFETIME_MS
} from './orderTypes'

// Fixed-slot order list. Each of the MAX_ACTIVE_ORDERS slots either holds an
// active Order or is null ("waiting for order"). New orders land in the first
// empty slot; an expired/served order leaves its slot empty until refilled.
// The 2D HUD reads `getOrderSlots()` every frame and renders one card per
// slot, so the UI never visually shuffles when orders come and go.

let nextOrderId = 1
let slotAssignments: (Order | null)[] = Array.from({ length: MAX_ACTIVE_ORDERS }, () => null)
let generationActive = false
let generationStartedAt = 0
let lastGenerationAt = 0

export function startOrderGeneration() {
  generationActive = true
  generationStartedAt = Date.now()
  // Force the first order shortly after start (lastGenerationAt in the past).
  lastGenerationAt = Date.now() - INITIAL_GENERATION_INTERVAL_MS + 1500
  slotAssignments = Array.from({ length: MAX_ACTIVE_ORDERS }, () => null)
  nextOrderId = 1
  console.log('[Orders] generation started')
}

export function stopOrderGeneration() {
  generationActive = false
  slotAssignments = Array.from({ length: MAX_ACTIVE_ORDERS }, () => null)
  console.log('[Orders] generation stopped')
}

// Snapshot of every slot (active order or null). The HUD renders one card per
// slot, drawing a placeholder for the null entries.
export function getOrderSlots(): readonly (Order | null)[] {
  return slotAssignments
}

// Just the active orders, in slot order. Used by gameplay code that doesn't
// care about empty slots.
export function getActiveOrders(): Order[] {
  return slotAssignments.filter((o): o is Order => o !== null)
}

// Exact-set match: same multiset of toppings (no extras, no missing).
export function toppingsMatch(a: Topping[], b: Topping[]): boolean {
  if (a.length !== b.length) return false
  const sortedA = [...a].sort((x, y) => x - y)
  const sortedB = [...b].sort((x, y) => x - y)
  return sortedA.every((t, i) => t === sortedB[i])
}

// Returns the first open order whose recipe matches the supplied toppings, or
// null. Expired tickets (lingering in red) are ignored so the player can't
// rescue them by serving last-second.
export function findMatchingOrder(toppings: Topping[]): Order | null {
  for (const order of slotAssignments) {
    if (
      order &&
      order.expiredSince === undefined &&
      toppingsMatch(toppings, order.recipe.toppings)
    )
      return order
  }
  return null
}

// Remove an order because it was served successfully (Hito 3.2/3.3).
export function completeOrder(order: Order): void {
  const idx = slotAssignments.indexOf(order)
  if (idx >= 0) slotAssignments[idx] = null
}

function currentGenerationInterval(): number {
  const elapsed = Date.now() - generationStartedAt
  const ramp = Math.min(1, elapsed / GENERATION_RAMP_DURATION_MS)
  return (
    INITIAL_GENERATION_INTERVAL_MS +
    (FINAL_GENERATION_INTERVAL_MS - INITIAL_GENERATION_INTERVAL_MS) * ramp
  )
}

function generateOrder() {
  const slot = slotAssignments.indexOf(null)
  if (slot < 0) return // every slot taken
  const recipe = RECIPES[Math.floor(Math.random() * RECIPES.length)]
  const now = Date.now()
  slotAssignments[slot] = {
    id: nextOrderId++,
    recipe,
    createdAt: now,
    expiresAt: now + TICKET_LIFETIME_MS
  }
  console.log(`[Orders] new order in slot ${slot}: ${recipe.displayName}`)
}

function orderManagerSystem(_dt: number) {
  if (!generationActive) return
  const now = Date.now()

  // Two-phase expiry: mark the order as expired (apply penalty, freeze the
  // card in red) and only clear the slot after EXPIRED_DISPLAY_MS so the
  // player can see what happened.
  for (let i = 0; i < slotAssignments.length; i++) {
    const order = slotAssignments[i]
    if (!order) continue
    if (order.expiredSince !== undefined) {
      if (now - order.expiredSince >= EXPIRED_DISPLAY_MS) {
        slotAssignments[i] = null
      }
      continue
    }
    if (order.expiresAt <= now) {
      addPoints(SCORE_EXPIRED_TICKET)
      order.expiredSince = now
      console.log(`[Orders] order expired: ${order.recipe.displayName} (${SCORE_EXPIRED_TICKET})`)
    }
  }

  // Generate new orders at the current cadence.
  const hasEmptySlot = slotAssignments.indexOf(null) >= 0
  if (hasEmptySlot && now - lastGenerationAt >= currentGenerationInterval()) {
    generateOrder()
    lastGenerationAt = now
  }
}

engine.addSystem(orderManagerSystem)
