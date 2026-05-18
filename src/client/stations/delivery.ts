import { engine } from '@dcl/sdk/ecs'
import { room } from '../../shared/messages'
import { CurrentStation } from '../../shared/syncedState'
import { FEEDBACK_COLOR_PENALTY, FEEDBACK_COLOR_REWARD, showFloatingText } from '../feedback'
import { PizzaState, PizzaStep, Topping } from '../pizza/pizzaTypes'
import { rollbackPrediction } from '../pizza/pizzaSync'

// Hito 4 — Option A: delivery is server-owned (slot allocation, serve
// validation, score). The client only reacts to two server messages:
//   • EvtServeResult — show "+N" on the served pizza, or "No order
//     matches" if the server rejected the attempt.
//   • EvtActionRejected — show the reason as floating text on the pizza
//     the player tried to act on (e.g. "Oven busy!").
//
// `getReadyPizzaToppings` powers the HUD's "ticket is ready to serve"
// flash by enumerating every Perfect pizza currently sitting on the
// counter, no matter which client originally produced it.

let listenersRegistered = false

export function registerDeliveryServeListener() {
  if (listenersRegistered) return
  listenersRegistered = true
  room.onMessage('EvtServeResult', (data) => {
    const pizza = findPizzaBySyncId(data.pizzaSyncId)
    if (data.ok) {
      if (pizza) showFloatingText(pizza, `+${data.scoreDelta}`, 1.5, 1.0, FEEDBACK_COLOR_REWARD)
    } else {
      // Server didn't match an order. Roll back the optimistic serve
      // prediction so the local animation aborts (serveAnimationSystem
      // notices state.disposing is back to None) and the pizza pops
      // back onto the counter at its delivery slot.
      rollbackPrediction(data.pizzaSyncId)
      if (pizza) showFloatingText(pizza, 'No order matches')
    }
  })
  room.onMessage('EvtActionRejected', (data) => {
    // Undo any optimistic prediction the local player applied before
    // sending the rejected Cmd, then show the reason on the pizza.
    rollbackPrediction(data.pizzaSyncId)
    const pizza = findPizzaBySyncId(data.pizzaSyncId)
    if (!pizza) return
    showFloatingText(pizza, data.reason, 1.2, 1.0, FEEDBACK_COLOR_PENALTY)
  })
}

function findPizzaBySyncId(syncId: number) {
  for (const [entity, state] of engine.getEntitiesWith(PizzaState)) {
    if (state.syncId === syncId) return entity
  }
  return null
}

// HUD reads this every frame to flag tickets whose matching pizza is
// already cooked and waiting on the counter (any client's pizza counts).
export function getReadyPizzaToppings(): Topping[][] {
  const out: Topping[][] = []
  for (const [, state] of engine.getEntitiesWith(PizzaState)) {
    if (state.currentStation !== CurrentStation.Delivery) continue
    if (state.step !== PizzaStep.Perfect) continue
    out.push([...state.toppings] as Topping[])
  }
  return out
}

export function resetDeliveryStation(): void {
  // Server-owned — nothing for the client to reset.
}
