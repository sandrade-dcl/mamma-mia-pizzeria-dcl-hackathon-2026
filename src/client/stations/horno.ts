import { Entity, Transform, engine } from '@dcl/sdk/ecs'
import { EntityNames } from '../../../assets/scene/entity-names'
import { sendPizzaAlongPath } from '../conveyor'
import { onInteract } from '../interaction'
import { BAKE_TIME_BURNT, BAKE_TIME_PERFECT, PizzaState, PizzaStep } from '../pizza/pizzaTypes'
import { despawnPizza, updatePizzaStep } from '../pizza/pizzaVisual'
import { getSlotPosition } from '../slots'

type HornoHandlers = {
  onSendToDelivery: (pizza: Entity) => void
}

// The oven owns two slots:
//   • Conveyor_2 — end of the toppings-to-horno belt; pizza waits here for
//     the player to insert it.
//   • Slot_Horno — inside the oven, baking.
const FRONT_SLOT = EntityNames.Slot_Toppings_To_Horno_Conveyor_2
const INSIDE_SLOT = EntityNames.Slot_Horno

let currentPizza: Entity | null = null
let handlers: HornoHandlers | null = null

export function setupHornoStation(h: HornoHandlers) {
  handlers = h
  // No pre-stock — the oven starts empty and waits for the first topped pizza
  // to arrive from the toppings station.
  engine.addSystem(bakingTimerSystem)
}

// Called by the conveyor when a pizza arrives from toppings. Replaces the
// current (pre-stock or stale) pizza waiting in front of the oven.
export function receivePizza(pizza: Entity) {
  if (currentPizza !== null) {
    despawnPizza(currentPizza)
  }
  currentPizza = pizza
  Transform.getMutable(pizza).position = getSlotPosition(FRONT_SLOT)
  attachHandler(pizza)
}

// Discard the pizza currently in the oven (front or inside), if any.
export function discardActivePizza(): boolean {
  if (!currentPizza) return false
  despawnPizza(currentPizza)
  currentPizza = null
  console.log('[Horno] pizza discarded')
  return true
}

function attachHandler(pizza: Entity) {
  onInteract(
    pizza,
    {
      hoverText: 'Horno',
      maxDistance: 6,
      secondary: {
        hoverText: 'Tirar a la basura',
        callback: () => discardActivePizza()
      }
    },
    () => {
      const state = PizzaState.getMutableOrNull(pizza)
      if (!state) return

      if (state.step === PizzaStep.Topped) {
        // Slide pizza from in-front-of-oven to inside-the-oven, then start baking.
        sendPizzaAlongPath(pizza, [FRONT_SLOT, INSIDE_SLOT], () => {
          const s = PizzaState.getMutableOrNull(pizza)
          if (!s) return
          s.bakeStartTime = Date.now() / 1000
          updatePizzaStep(pizza, PizzaStep.Baking)
          console.log('[Horno] pizza in the oven — baking…')
        })
      } else if (state.step === PizzaStep.Perfect) {
        if (currentPizza === pizza) currentPizza = null
        handlers?.onSendToDelivery(pizza)
      }
    }
  )
}

function bakingTimerSystem(_dt: number) {
  if (!currentPizza) return
  const state = PizzaState.getMutableOrNull(currentPizza)
  if (!state) return
  if (state.step !== PizzaStep.Baking && state.step !== PizzaStep.Perfect) return

  const elapsed = Date.now() / 1000 - state.bakeStartTime

  if (state.step === PizzaStep.Baking && elapsed >= BAKE_TIME_PERFECT) {
    updatePizzaStep(currentPizza, PizzaStep.Perfect)
    console.log('[Horno] pizza is perfect — take it out before it burns!')
  } else if (state.step === PizzaStep.Perfect && elapsed >= BAKE_TIME_BURNT) {
    updatePizzaStep(currentPizza, PizzaStep.Burnt)
    console.log('[Horno] pizza burnt!')
  }
}
