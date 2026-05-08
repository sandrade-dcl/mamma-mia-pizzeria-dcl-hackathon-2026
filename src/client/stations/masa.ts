import { Entity } from '@dcl/sdk/ecs'
import { EntityNames } from '../../../assets/scene/entity-names'
import { onInteract } from '../interaction'
import { MASA_CLICKS_REQUIRED, PizzaState, PizzaStep } from '../pizza/pizzaTypes'
import { applyDoughClickVisual, despawnPizza, spawnPizza } from '../pizza/pizzaVisual'
import { getSlotPosition } from '../slots'

type MasaHandlers = {
  onSendToToppings: (pizza: Entity) => void
}

let currentPizza: Entity | null = null
let handlers: MasaHandlers | null = null

export function setupMasaStation(h: MasaHandlers) {
  handlers = h
  spawnFreshDough()
}

function spawnFreshDough() {
  const slotPos = getSlotPosition(EntityNames.Slot_Masa)
  currentPizza = spawnPizza(slotPos, PizzaStep.RawDough)
  attachHandler(currentPizza)
}

// Drop the current dough and spawn a fresh ball. Always succeeds because
// masa auto-respawns.
export function discardActivePizza(): boolean {
  if (!currentPizza) return false
  despawnPizza(currentPizza)
  currentPizza = null
  spawnFreshDough()
  console.log('[Masa] dough discarded — fresh ball ready')
  return true
}

function attachHandler(pizza: Entity) {
  // No discard option here — there's nothing the player can mess up while
  // shaping raw dough, so the F-key shortcut would only add noise.
  onInteract(pizza, { hoverText: 'Masa', maxDistance: 6 }, () => {
    const state = PizzaState.getMutableOrNull(pizza)
    if (!state) return

    if (state.step === PizzaStep.RawDough) {
      state.doughClicks += 1
      applyDoughClickVisual(pizza, state.doughClicks)
      if (state.doughClicks >= MASA_CLICKS_REQUIRED) {
        console.log('[Masa] dough flattened — click again to send to toppings')
      }
    } else if (state.step === PizzaStep.FlatDough) {
      // Send the flat dough to toppings and spawn a fresh ball for the next pizza.
      if (currentPizza === pizza) currentPizza = null
      handlers?.onSendToToppings(pizza)
      spawnFreshDough()
    }
  })
}
