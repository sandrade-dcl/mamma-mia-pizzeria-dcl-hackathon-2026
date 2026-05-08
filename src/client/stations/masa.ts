import { Entity } from '@dcl/sdk/ecs'
import { EntityNames } from '../../../assets/scene/entity-names'
import { showFloatingText } from '../feedback'
import { onInteract } from '../interaction'
import { MASA_CLICKS_REQUIRED, PizzaState, PizzaStep } from '../pizza/pizzaTypes'
import { applyDoughClickVisual, discardPizzaWithAnimation, spawnPizza } from '../pizza/pizzaVisual'
import { getSlotPosition } from '../slots'

type MasaHandlers = {
  onSendToToppings: (pizza: Entity) => boolean
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
  refreshHandler(currentPizza)
}

// Drop the current dough and spawn a fresh ball. Always succeeds because
// masa auto-respawns.
export function discardActivePizza(): boolean {
  if (!currentPizza) return false
  discardPizzaWithAnimation(currentPizza)
  currentPizza = null
  spawnFreshDough()
  console.log('[Masa] dough discarded — fresh ball ready')
  return true
}

// Wires the click callback that fits the pizza's current step. Called once
// at spawn and again when the step changes (RawDough → FlatDough).
function refreshHandler(pizza: Entity) {
  const state = PizzaState.getOrNull(pizza)
  if (!state) return

  if (state.step === PizzaStep.RawDough) {
    onInteract(pizza, { hoverText: 'Knead', maxDistance: 6 }, () => onKnead(pizza))
  } else if (state.step === PizzaStep.FlatDough) {
    onInteract(pizza, { hoverText: 'Send to Toppings', maxDistance: 6 }, () => onSendClick(pizza))
  }
}

function onKnead(pizza: Entity) {
  if (currentPizza !== pizza) return
  const state = PizzaState.getMutableOrNull(pizza)
  if (!state || state.step !== PizzaStep.RawDough) return

  state.doughClicks += 1
  applyDoughClickVisual(pizza, state.doughClicks)
  if (state.doughClicks >= MASA_CLICKS_REQUIRED) {
    // applyDoughClickVisual already flipped step to FlatDough; rewire the
    // handler so the next click sends the pizza to toppings.
    refreshHandler(pizza)
    console.log('[Masa] dough flattened — click again to send to toppings')
  }
}

function onSendClick(pizza: Entity) {
  if (currentPizza !== pizza) return
  const state = PizzaState.getOrNull(pizza)
  if (!state || state.step !== PizzaStep.FlatDough) return

  const sent = handlers?.onSendToToppings(pizza) ?? false
  if (sent) {
    currentPizza = null
    spawnFreshDough()
  } else {
    showFloatingText(pizza, 'Toppings busy!')
    console.log('[Masa] toppings is busy — wait until it is free')
  }
}
