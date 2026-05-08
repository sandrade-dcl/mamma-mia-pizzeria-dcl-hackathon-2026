import { EntityNames } from '../../assets/scene/entity-names'
import { sendPizzaAlongPath } from './conveyor'
import { receivePizza as deliveryReceive } from './stations/delivery'
import { receivePizza as hornoReceive, setupHornoStation } from './stations/horno'
import { setupMasaStation } from './stations/masa'
import { receivePizza as toppingsReceive, setupToppingsStation } from './stations/toppings'

// Client-side entry point. Wires up every station's interactivity and the
// shared systems. Stations don't import each other — they receive their
// "send to next" handlers here, which call the conveyor and then the
// destination station's `receivePizza`.
//
// Discarding pizzas is now a per-pizza secondary action (F key) handled by
// each station, so the trash bin is decoration only.

export function initClient() {
  console.log('[CLIENT] Mamma Mia\'s Pizzeria — booting Hito 2 mechanics')

  setupMasaStation({
    onSendToToppings: (pizza) =>
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
  })

  setupToppingsStation({
    // Pizza rides the belt all the way to the oven's mouth (Conveyor_2) and
    // waits there for the player to insert it. The oven owns the mouth → inside tween.
    onSendToHorno: (pizza) =>
      sendPizzaAlongPath(
        pizza,
        [
          EntityNames.Slot_Toppings,
          EntityNames.Slot_Toppings_To_Horno_Conveyor_1,
          EntityNames.Slot_Toppings_To_Horno_Conveyor_2
        ],
        () => hornoReceive(pizza)
      )
  })

  setupHornoStation({
    onSendToDelivery: (pizza) =>
      sendPizzaAlongPath(
        pizza,
        [
          EntityNames.Slot_Horno,
          EntityNames.Slot_Horno_To_Delivery_Conveyor_1,
          EntityNames.Slot_Delivery
        ],
        () => deliveryReceive(pizza)
      )
  })
}
