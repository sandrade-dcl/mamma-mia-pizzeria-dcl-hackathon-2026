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
import { EntityNames } from '../../../assets/scene/entity-names'
import { onInteract } from '../interaction'
import { PizzaState, PizzaStep, Topping } from '../pizza/pizzaTypes'
import { despawnPizza, spawnTopping } from '../pizza/pizzaVisual'
import { getSlotPosition } from '../slots'

type IngredientDef = {
  type: Topping
  label: string
  color: Color4
  offsetX: number
}

const INGREDIENTS: IngredientDef[] = [
  { type: Topping.Tomato, label: 'Tomate', color: Color4.create(0.85, 0.15, 0.1, 1), offsetX: -1.2 },
  { type: Topping.Mozzarella, label: 'Mozzarella', color: Color4.create(0.95, 0.92, 0.85, 1), offsetX: -0.4 },
  { type: Topping.Salami, label: 'Salami', color: Color4.create(0.55, 0.1, 0.1, 1), offsetX: 0.4 },
  { type: Topping.Mushroom, label: 'Champiñón', color: Color4.create(0.65, 0.55, 0.45, 1), offsetX: 1.2 }
]

const STATION_CENTER_X = 16
const BOX_Y = 1.2
const BOX_Z = 26.7

type ToppingsHandlers = {
  onSendToHorno: (pizza: Entity) => void
}

let currentPizza: Entity | null = null
let handlers: ToppingsHandlers | null = null

export function setupToppingsStation(h: ToppingsHandlers) {
  handlers = h
  // No pre-stock — the toppings station starts empty and waits for the first
  // flat dough to arrive from masa. Only the ingredient boxes are visible up front.
  for (const ingredient of INGREDIENTS) {
    createIngredientBox(ingredient)
  }
}

// Called by the conveyor when a pizza arrives from masa. Replaces the current
// (pre-stock or stale) pizza in this station's slot.
export function receivePizza(pizza: Entity) {
  if (currentPizza !== null) {
    despawnPizza(currentPizza)
  }
  currentPizza = pizza
  Transform.getMutable(pizza).position = getSlotPosition(EntityNames.Slot_Toppings)
  attachPizzaHandler(pizza)
}

// Discard the pizza currently sitting on the toppings table, if any.
export function discardActivePizza(): boolean {
  if (!currentPizza) return false
  despawnPizza(currentPizza)
  currentPizza = null
  console.log('[Toppings] pizza discarded')
  return true
}

function attachPizzaHandler(pizza: Entity) {
  onInteract(
    pizza,
    {
      hoverText: 'Pizza',
      maxDistance: 6,
      secondary: {
        hoverText: 'Tirar a la basura',
        callback: () => discardActivePizza()
      }
    },
    () => {
      const state = PizzaState.getMutableOrNull(pizza)
      if (!state) return
      // Only allow sending after at least one topping has been added.
      if (state.step !== PizzaStep.Topped) return

      if (currentPizza === pizza) currentPizza = null
      handlers?.onSendToHorno(pizza)
    }
  )
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

  onInteract(box, { hoverText: ingredient.label, maxDistance: 6 }, () =>
    addToppingToActivePizza(ingredient.type)
  )
}

function addToppingToActivePizza(type: Topping) {
  if (!currentPizza) return
  const state = PizzaState.getMutableOrNull(currentPizza)
  if (!state) return
  if (state.step !== PizzaStep.FlatDough && state.step !== PizzaStep.Topped) return

  const slotIndex = state.toppings.length
  spawnTopping(currentPizza, type, slotIndex)
  state.toppings = [...state.toppings, type as number]
  state.step = PizzaStep.Topped

  console.log(`[Toppings] added ${Topping[type]} (${state.toppings.length} total)`)
}
