import { ReactEcsRenderer } from '@dcl/sdk/react-ecs'
// Side-effect imports: register the client-side systems on module load.
import './gameState'
import './pizza/pizzaSync'
import './pizza/pizzaVisual'
import { OrdersUi } from './orders/orderUi'
import { registerDeliveryServeListener } from './stations/delivery'
import { setupHornoStation } from './stations/horno'
import { setupMasaStation } from './stations/masa'
import { setupToppingsStation } from './stations/toppings'

// Client bootstrap — Hito 4 Option A.
//
// Almost nothing happens on the client other than setting up the HUD, the
// ingredient boxes, and the oven ambience watcher. The authoritative
// kitchen lives on the server (`src/server/kitchen.ts`); the client's
// reconciler (`pizza/pizzaSync.ts`) turns synced pizzas into rendered,
// clickable entities that emit Cmd* messages.

export function initClient() {
  console.log('[CLIENT] Mamma Mia\'s Pizzeria — booting Hito 4 (server-owned kitchen)')

  ReactEcsRenderer.setUiRenderer(OrdersUi, { virtualWidth: 1920, virtualHeight: 1080 })
  registerDeliveryServeListener()

  setupMasaStation()
  setupToppingsStation()
  setupHornoStation()
}
