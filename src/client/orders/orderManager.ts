import { engine } from '@dcl/sdk/ecs'
import { OrderSlot } from '../../shared/syncedState'
import { Topping } from '../pizza/pizzaTypes'
import {
  MAX_ACTIVE_ORDERS,
  Order,
  RECIPES
} from './orderTypes'

// Hito 4 moved order generation, expiry and completion to the auth server.
// This module is now a read-through adapter that turns the synced OrderSlot
// entities into the legacy `Order` shape the HUD already knows how to
// render — no behaviour change for orderUi.tsx beyond switching the data
// source.

let slotBuffer: (Order | null)[] = Array.from({ length: MAX_ACTIVE_ORDERS }, () => null)

function rebuildSlotBuffer() {
  const out: (Order | null)[] = Array.from({ length: MAX_ACTIVE_ORDERS }, () => null)
  for (const [entity, slot] of engine.getEntitiesWith(OrderSlot)) {
    void entity
    if (slot.slotIndex < 0 || slot.slotIndex >= MAX_ACTIVE_ORDERS) continue
    if (!slot.active) continue
    const recipe = RECIPES[slot.recipeIndex] ?? RECIPES[0]
    out[slot.slotIndex] = {
      id: slot.id,
      recipe,
      createdAt: Number(slot.createdAt),
      expiresAt: Number(slot.expiresAt),
      expiredSince: slot.expiredSince > 0 ? Number(slot.expiredSince) : undefined
    }
  }
  slotBuffer = out
}

// Read every frame from the HUD — refresh from the synced state on demand.
export function getOrderSlots(): readonly (Order | null)[] {
  rebuildSlotBuffer()
  return slotBuffer
}

export function getActiveOrders(): Order[] {
  rebuildSlotBuffer()
  return slotBuffer.filter((o): o is Order => o !== null)
}

export function toppingsMatch(a: Topping[], b: Topping[]): boolean {
  if (a.length !== b.length) return false
  const sortedA = [...a].sort((x, y) => x - y)
  const sortedB = [...b].sort((x, y) => x - y)
  return sortedA.every((t, i) => t === sortedB[i])
}

// Local prediction only — used by the HUD's "Ready to serve!" flash. The
// authoritative match happens server-side when delivery.ts sends a
// CmdAttemptServe.
export function findMatchingOrder(toppings: Topping[]): Order | null {
  rebuildSlotBuffer()
  for (const order of slotBuffer) {
    if (
      order &&
      order.expiredSince === undefined &&
      toppingsMatch(toppings, order.recipe.toppings)
    )
      return order
  }
  return null
}

// Kept as no-ops for backwards compatibility — server clears its slots on
// successful serve / expiry. Visual completion (animation) is still
// triggered locally by delivery.ts when the server confirms a serve.
export function completeOrder(_order: Order): void {
  /* server-authoritative now */
}

export function startOrderGeneration(): void {
  /* server runs the generator on CmdStartRound */
}

export function stopOrderGeneration(): void {
  /* server clears slots on round end */
}
