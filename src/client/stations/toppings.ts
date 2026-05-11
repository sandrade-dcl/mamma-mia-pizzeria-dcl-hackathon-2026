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
import { FEEDBACK_COLOR_PENALTY, showFloatingText } from '../feedback'
import { onInteract } from '../interaction'
import { PizzaState, PizzaStep, Topping } from '../pizza/pizzaTypes'
import { despawnPizza, discardPizzaWithAnimation, spawnTopping } from '../pizza/pizzaVisual'
import { addPoints, penaltyForDiscard } from '../scoring'
import { getSlotPosition } from '../slots'

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

type ToppingsHandlers = {
  onSendToHorno: (pizza: Entity) => boolean
}

let currentPizza: Entity | null = null
let pendingIncoming = false
let handlers: ToppingsHandlers | null = null

// True while a pizza is sitting on the table OR while one is travelling on
// the belt towards us. Used by the upstream station to decide whether it can
// send another pizza yet.
export function isOccupied(): boolean {
  return currentPizza !== null || pendingIncoming
}

// Reserve the slot so further sends are rejected until the conveyor delivers
// the pizza (at which point `receivePizza` clears the flag).
export function notifyIncoming() {
  pendingIncoming = true
}

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
  pendingIncoming = false
  Transform.getMutable(pizza).position = getSlotPosition(EntityNames.Slot_Toppings)
  refreshHandler(pizza)
}

// Wipe the station between rounds.
export function resetToppingsStation(): void {
  if (currentPizza !== null) {
    discardPizzaWithAnimation(currentPizza)
    currentPizza = null
  }
  pendingIncoming = false
}

// Discard the pizza currently sitting on the toppings table, if any.
export function discardActivePizza(): boolean {
  if (!currentPizza) return false
  const state = PizzaState.getOrNull(currentPizza)
  const penalty = state ? penaltyForDiscard(state.step, state.toppings.length) : 0
  if (penalty !== 0) {
    addPoints(penalty)
    showFloatingText(currentPizza, `${penalty}`, 1.2, 1.0, FEEDBACK_COLOR_PENALTY)
  }
  discardPizzaWithAnimation(currentPizza)
  currentPizza = null
  console.log(`[Toppings] pizza discarded (${penalty})`)
  return true
}

// Wires the pizza's click handlers based on its current step. Called when the
// pizza arrives, and again when its step changes (FlatDough → Topped).
function refreshHandler(pizza: Entity) {
  const state = PizzaState.getOrNull(pizza)
  if (!state) return

  const discardSecondary = {
    hoverText: 'Throw away',
    callback: () => discardActivePizza()
  }

  if (state.step === PizzaStep.FlatDough) {
    // No primary action — the pizza isn't sendable yet, only F to discard.
    onInteract(pizza, { secondary: discardSecondary })
  } else if (state.step === PizzaStep.Topped) {
    onInteract(
      pizza,
      { hoverText: 'Send to Oven', maxDistance: 6, secondary: discardSecondary },
      () => onSendClick(pizza)
    )
  }
}

function onSendClick(pizza: Entity) {
  if (currentPizza !== pizza) return
  const state = PizzaState.getOrNull(pizza)
  if (!state || state.step !== PizzaStep.Topped) return

  const sent = handlers?.onSendToHorno(pizza) ?? false
  if (sent) {
    currentPizza = null
  } else {
    showFloatingText(pizza, 'Oven busy!')
    console.log('[Toppings] horno is busy — wait until it is free')
  }
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

  const wasFlatDough = state.step === PizzaStep.FlatDough
  const slotIndex = state.toppings.length
  spawnTopping(currentPizza, type, slotIndex)
  state.toppings = [...state.toppings, type as number]
  state.step = PizzaStep.Topped

  // Going from FlatDough → Topped enables the "Send to Oven" primary action.
  if (wasFlatDough) {
    refreshHandler(currentPizza)
  }

  console.log(`[Toppings] added ${Topping[type]} (${state.toppings.length} total)`)
}
