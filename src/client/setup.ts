import { ReactEcsRenderer } from '@dcl/sdk/react-ecs'
import { EntityNames } from '../../assets/scene/entity-names'
import { sendPizzaAlongPath } from './conveyor'
// Side-effect import: registers the game-state system at module load.
import './gameState'
import { OrdersUi } from './orders/orderUi'
import {
  isOccupied as deliveryIsOccupied,
  notifyIncoming as deliveryNotifyIncoming,
  receivePizza as deliveryReceive
} from './stations/delivery'
import {
  isOccupied as hornoIsOccupied,
  notifyIncoming as hornoNotifyIncoming,
  receivePizza as hornoReceive,
  setupHornoStation
} from './stations/horno'
import { setupMasaStation } from './stations/masa'
import {
  isOccupied as toppingsIsOccupied,
  notifyIncoming as toppingsNotifyIncoming,
  receivePizza as toppingsReceive,
  setupToppingsStation
} from './stations/toppings'

// Client-side entry point. Wires up every station's interactivity and the
// shared systems. Stations don't import each other — they receive their
// "send to next" handlers here, which call the conveyor and then the
// destination station's `receivePizza`.
//
// Each handler returns `false` if the destination is already busy (a pizza
// is on its slot or one is travelling there), so the upstream station can
// keep its current pizza and let the player retry later.

export function initClient() {
  console.log('[CLIENT] Mamma Mia\'s Pizzeria — booting Hito 3 mechanics')

  // The HUD owns the Start/End screens — order generation is gated by the
  // "Start Game" button now.
  ReactEcsRenderer.setUiRenderer(OrdersUi, { virtualWidth: 1920, virtualHeight: 1080 })

  setupMasaStation({
    onSendToToppings: (pizza) => {
      if (toppingsIsOccupied()) return false
      toppingsNotifyIncoming()
      sendPizzaAlongPath(
        pizza,
        // Drop onto the belt, slide along its two waypoints, lift to the toppings slot.
        [
          EntityNames.Slot_Masa,
          EntityNames.Slot_Masa_To_Toppings_Conveyor_1,
          EntityNames.Slot_Masa_To_Toppings_Conveyor_2,
          EntityNames.Slot_Toppings
        ],
        () => toppingsReceive(pizza)
      )
      return true
    }
  })

  setupToppingsStation({
    // Pizza rides the belt all the way to the oven's mouth (Conveyor_2) and
    // waits there for the player to insert it. The oven owns the mouth → inside tween.
    onSendToHorno: (pizza) => {
      if (hornoIsOccupied()) return false
      hornoNotifyIncoming()
      sendPizzaAlongPath(
        pizza,
        [
          EntityNames.Slot_Toppings,
          EntityNames.Slot_Toppings_To_Horno_Conveyor_1,
          EntityNames.Slot_Toppings_To_Horno_Conveyor_2
        ],
        () => hornoReceive(pizza)
      )
      return true
    }
  })

  setupHornoStation({
    onSendToDelivery: (pizza) => {
      if (deliveryIsOccupied()) return false
      deliveryNotifyIncoming()
      sendPizzaAlongPath(
        pizza,
        [
          EntityNames.Slot_Horno,
          EntityNames.Slot_Horno_To_Delivery_Conveyor_1,
          EntityNames.Slot_Delivery
        ],
        () => deliveryReceive(pizza)
      )
      return true
    }
  })
}
