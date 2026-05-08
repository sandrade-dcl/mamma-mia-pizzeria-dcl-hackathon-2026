import { Entity, Transform } from '@dcl/sdk/ecs'
import { EntityNames } from '../../../assets/scene/entity-names'
import { onInteract } from '../interaction'
import { despawnPizza } from '../pizza/pizzaVisual'
import { getSlotPosition } from '../slots'

let currentPizza: Entity | null = null

// In Hito 2 the delivery slot is just the final resting place. Hito 3 will
// add the click-to-serve interaction that matches the pizza against an open
// ticket and grants score.
export function receivePizza(pizza: Entity) {
  if (currentPizza !== null) {
    despawnPizza(currentPizza)
  }
  currentPizza = pizza
  Transform.getMutable(pizza).position = getSlotPosition(EntityNames.Slot_Delivery)
  // No primary action yet — Hito 3 will add click → serve. The F key still
  // discards if the player wants to clear the slot.
  onInteract(pizza, {
    secondary: {
      hoverText: 'Tirar a la basura',
      callback: () => discardActivePizza()
    }
  })
  console.log('[Delivery] pizza arrived — ready to serve!')
}

export function discardActivePizza(): boolean {
  if (!currentPizza) return false
  despawnPizza(currentPizza)
  currentPizza = null
  console.log('[Delivery] pizza discarded')
  return true
}
