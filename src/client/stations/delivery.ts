import { Entity, Transform, Tween } from '@dcl/sdk/ecs'
import { Vector3 } from '@dcl/sdk/math'
import { EntityNames } from '../../../assets/scene/entity-names'
import { onInteract } from '../interaction'
import { despawnPizza, discardPizzaWithAnimation } from '../pizza/pizzaVisual'
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

  // No primary action yet — Hito 3 will add click → serve. The F key still
  // discards the specific pizza the cursor is on.
  onInteract(pizza, {
    secondary: {
      hoverText: 'Throw away',
      callback: () => discardPizza(pizza)
    }
  })

  const occupied = slotPizzas.filter((p) => p !== null).length
  console.log(`[Delivery] pizza arrived in slot ${slotIndex} (${occupied}/${MAX_SLOTS})`)
}

// Discard the specific pizza referenced. Each pizza's F handler calls this
// with its own entity so there's no ambiguity about which pizza leaves.
export function discardPizza(pizza: Entity): boolean {
  const slotIndex = slotPizzas.indexOf(pizza)
  if (slotIndex < 0) return false
  slotPizzas[slotIndex] = null
  discardPizzaWithAnimation(pizza)
  console.log(`[Delivery] pizza discarded from slot ${slotIndex}`)
  return true
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
