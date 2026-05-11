import { Entity, Transform, Tween } from '@dcl/sdk/ecs'
import { Vector3 } from '@dcl/sdk/math'
import { EntityNames } from '../../../assets/scene/entity-names'
import { FEEDBACK_COLOR_PENALTY, FEEDBACK_COLOR_REWARD, showFloatingText } from '../feedback'
import { onInteract } from '../interaction'
import { completeOrder, findMatchingOrder } from '../orders/orderManager'
import { TICKET_LIFETIME_MS } from '../orders/orderTypes'
import { PizzaState, Topping } from '../pizza/pizzaTypes'
import { despawnPizza, discardPizzaWithAnimation, serveAnimationOnPizza } from '../pizza/pizzaVisual'
import {
  SCORE_SERVE_BASE,
  addPoints,
  penaltyForDiscard,
  serveBonusFor
} from '../scoring'
import { getSlotPosition } from '../slots'

const MAX_SLOTS = 4
const SLOT_SPACING_M = 1.2

// Four fixed slots centred on Slot_Delivery: -1.8, -0.6, +0.6, +1.8 m.
// Pizzas land in the first empty slot and stay there until served/discarded;
// removing one from the middle leaves a visible gap (no shuffling).
const SLOT_OFFSETS_X: number[] = Array.from(
  { length: MAX_SLOTS },
  (_, i) => (i - (MAX_SLOTS - 1) / 2) * SLOT_SPACING_M
)

const slotPizzas: (Entity | null)[] = Array.from({ length: MAX_SLOTS }, () => null)
let pendingIncoming = 0

// True while delivery is effectively full: pizzas already on the counter plus
// pizzas currently travelling on the belt cover every slot.
export function isOccupied(): boolean {
  const free = slotPizzas.filter((p) => p === null).length
  return free <= pendingIncoming
}

export function notifyIncoming() {
  pendingIncoming += 1
}

// Called by the conveyor when a pizza arrives from the oven.
export function receivePizza(pizza: Entity) {
  pendingIncoming = Math.max(0, pendingIncoming - 1)

  const slotIndex = slotPizzas.indexOf(null)
  if (slotIndex < 0) {
    // Should never happen — setup checks isOccupied before sending. Safety net.
    console.error('[Delivery] no empty slot for incoming pizza — discarding')
    despawnPizza(pizza)
    return
  }
  slotPizzas[slotIndex] = pizza

  // The conveyor's Tween still pins the pizza to Slot_Delivery's centre. Drop
  // it before applying the slot offset so our manual position sticks.
  Tween.deleteFrom(pizza)

  const basePos = getSlotPosition(EntityNames.Slot_Delivery)
  Transform.getMutable(pizza).position = Vector3.create(
    basePos.x + SLOT_OFFSETS_X[slotIndex],
    basePos.y,
    basePos.z
  )

  // Primary click = serve (if a matching order is open). Secondary (F) =
  // throw the specific pizza away with no scoring effect.
  onInteract(
    pizza,
    {
      hoverText: 'Serve',
      maxDistance: 6,
      secondary: {
        hoverText: 'Throw away',
        callback: () => discardPizza(pizza)
      }
    },
    () => tryServePizza(pizza)
  )

  const occupied = slotPizzas.filter((p) => p !== null).length
  console.log(`[Delivery] pizza arrived in slot ${slotIndex} (${occupied}/${MAX_SLOTS})`)
}

// Attempt to fulfil an open order with this pizza. If an order's recipe
// matches the pizza's toppings exactly, the order is closed and the pizza
// is removed with its discard animation. Otherwise the player is told that
// no order matches; the pizza stays put.
function tryServePizza(pizza: Entity): void {
  const slotIndex = slotPizzas.indexOf(pizza)
  if (slotIndex < 0) return

  const state = PizzaState.getOrNull(pizza)
  if (!state) return

  const order = findMatchingOrder([...state.toppings] as Topping[])
  if (!order) {
    showFloatingText(pizza, 'No order matches')
    return
  }

  const remainingProgress = (order.expiresAt - Date.now()) / TICKET_LIFETIME_MS
  const bonus = serveBonusFor(remainingProgress)
  const total = SCORE_SERVE_BASE + bonus
  addPoints(total)
  showFloatingText(pizza, `+${total}`, 1.5, 1.0, FEEDBACK_COLOR_REWARD)

  completeOrder(order)
  slotPizzas[slotIndex] = null
  serveAnimationOnPizza(pizza)
  console.log(`[Delivery] served ${order.recipe.displayName} (+${total})`)
}

// Discard the specific pizza referenced. Each pizza's F handler calls this
// with its own entity so there's no ambiguity about which pizza leaves.
export function discardPizza(pizza: Entity): boolean {
  const slotIndex = slotPizzas.indexOf(pizza)
  if (slotIndex < 0) return false
  const state = PizzaState.getOrNull(pizza)
  const penalty = state ? penaltyForDiscard(state.step, state.toppings.length) : 0
  if (penalty !== 0) {
    addPoints(penalty)
    showFloatingText(pizza, `${penalty}`, 1.2, 1.0, FEEDBACK_COLOR_PENALTY)
  }
  slotPizzas[slotIndex] = null
  discardPizzaWithAnimation(pizza)
  console.log(`[Delivery] pizza discarded from slot ${slotIndex} (${penalty})`)
  return true
}

// Wipe the counter between rounds.
export function resetDeliveryStation(): void {
  for (let i = 0; i < slotPizzas.length; i++) {
    const pizza = slotPizzas[i]
    if (pizza !== null) {
      discardPizzaWithAnimation(pizza)
      slotPizzas[i] = null
    }
  }
  pendingIncoming = 0
}

// Snapshot of every ready pizza's topping list, used by the HUD to flag
// tickets whose order is already sitting on the counter.
export function getReadyPizzaToppings(): Topping[][] {
  const result: Topping[][] = []
  for (const pizza of slotPizzas) {
    if (pizza === null) continue
    const state = PizzaState.getOrNull(pizza)
    if (!state) continue
    result.push([...state.toppings] as Topping[])
  }
  return result
}

// Legacy "discard one" helper for code paths that don't know which specific
// pizza to remove. Drops the highest-index occupied slot (the most recent).
export function discardActivePizza(): boolean {
  for (let i = slotPizzas.length - 1; i >= 0; i--) {
    const pizza = slotPizzas[i]
    if (pizza !== null) return discardPizza(pizza)
  }
  return false
}
