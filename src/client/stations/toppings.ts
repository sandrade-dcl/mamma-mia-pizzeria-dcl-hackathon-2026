import {
  ColliderLayer,
  Entity,
  Material,
  MeshCollider,
  MeshRenderer,
  Transform,
  engine
} from '@dcl/sdk/ecs'
import { Color4, Quaternion, Vector3 } from '@dcl/sdk/math'
import { room } from '../../shared/messages'
import { onInteract } from '../interaction'
import { Topping } from '../pizza/pizzaTypes'
import { predictAddTopping } from '../pizza/pizzaSync'

// Hito 4 — Option A: only the ingredient boxes live on the client. Each
// click sends CmdAddTopping to the server; the server picks "the pizza
// currently at the toppings station" and appends to its toppings array,
// which clients then observe via PizzaState sync.

type IngredientDef = {
  type: Topping
  label: string
  color: Color4
  offsetX: number
}

const INGREDIENTS: IngredientDef[] = [
  { type: Topping.Tomato, label: 'Tomato', color: Color4.create(0.85, 0.15, 0.1, 1), offsetX: -1.2 },
  { type: Topping.Mozzarella, label: 'Mozzarella', color: Color4.create(0.95, 0.92, 0.85, 1), offsetX: -0.4 },
  { type: Topping.Salami, label: 'Salami', color: Color4.create(0.55, 0.1, 0.1, 1), offsetX: 0.4 },
  { type: Topping.Mushroom, label: 'Mushroom', color: Color4.create(0.65, 0.55, 0.45, 1), offsetX: 1.2 }
]

const STATION_CENTER_X = 16
const BOX_Y = 1.2
const BOX_Z = 26.7

export function setupToppingsStation(): void {
  for (const ingredient of INGREDIENTS) {
    createIngredientBox(ingredient)
  }
}

export function resetToppingsStation(): void {
  // Server-owned — nothing for the client to reset.
}

function createIngredientBox(ingredient: IngredientDef) {
  const box = engine.addEntity()
  Transform.create(box, {
    position: Vector3.create(STATION_CENTER_X + ingredient.offsetX, BOX_Y, BOX_Z),
    scale: Vector3.create(0.5, 0.4, 0.5),
    rotation: Quaternion.Identity()
  })
  MeshRenderer.setBox(box)
  MeshCollider.setBox(box, ColliderLayer.CL_POINTER)
  Material.setPbrMaterial(box, { albedoColor: ingredient.color })
  onInteract(
    box as Entity,
    { hoverText: ingredient.label, maxDistance: 6 },
    () => {
      // Optimistic: append the topping locally so the cube pops onto the
      // pizza at click-time, then let the server confirm. Server-side
      // validation may still reject (e.g. wrong station/step); the
      // EvtActionRejected listener in delivery.ts rolls back.
      predictAddTopping(ingredient.type)
      room.send('CmdAddTopping', { topping: ingredient.type as number })
    }
  )
}
