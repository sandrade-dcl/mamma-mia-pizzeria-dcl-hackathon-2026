import { Entity, LightSource, Transform, engine } from '@dcl/sdk/ecs'
import { Color3 } from '@dcl/sdk/math'
import { EntityNames } from '../../../assets/scene/entity-names'
import { sendPizzaAlongPath } from '../conveyor'
import { showFloatingText } from '../feedback'
import { onInteract } from '../interaction'
import { BAKE_TIME_BURNT, BAKE_TIME_PERFECT, PizzaState, PizzaStep } from '../pizza/pizzaTypes'
import { despawnPizza, discardPizzaWithAnimation, updatePizzaStep } from '../pizza/pizzaVisual'
import { getEntityByName, getSlotPosition } from '../slots'

type HornoHandlers = {
  onSendToDelivery: (pizza: Entity) => boolean
}

// The oven owns two slots:
//   • Conveyor_2 — end of the toppings-to-horno belt; pizza waits here for
//     the player to insert it.
//   • Slot_Horno — inside the oven, baking.
const FRONT_SLOT = EntityNames.Slot_Toppings_To_Horno_Conveyor_2
const INSIDE_SLOT = EntityNames.Slot_Horno

let currentPizza: Entity | null = null
let pendingIncoming = false
let handlers: HornoHandlers | null = null
// Tracks pizzas currently sliding from FRONT_SLOT to INSIDE_SLOT — used to
// block double-click during the insert tween, since `currentPizza` doesn't
// change in that flow.
const insertingPizzas = new Set<Entity>()

// True while a pizza is in front of/inside the oven OR while one is
// travelling on the belt towards us.
export function isOccupied(): boolean {
  return currentPizza !== null || pendingIncoming
}

export function notifyIncoming() {
  pendingIncoming = true
}

export function setupHornoStation(h: HornoHandlers) {
  handlers = h
  // No pre-stock — the oven starts empty and waits for the first topped pizza
  // to arrive from the toppings station.
  setOvenLight('off')
  engine.addSystem(bakingTimerSystem)
}

// The light hanging inside Station_Horno reflects what's going on with the
// pizza: warm orange while it bakes normally, red when it has burnt, and off
// whenever the oven is empty.
type OvenLightState = 'off' | 'fire' | 'burnt'

const FIRE_COLOR = Color3.create(1, 0.647, 0)
const BURNT_COLOR = Color3.create(1, 0.1, 0.1)

function setOvenLight(state: OvenLightState) {
  const light = getEntityByName(EntityNames.Horno_Light)
  const ls = LightSource.getMutableOrNull(light)
  if (!ls) return
  if (state === 'off') {
    ls.active = false
    return
  }
  ls.active = true
  ls.color = state === 'burnt' ? BURNT_COLOR : FIRE_COLOR
}

// Called by the conveyor when a pizza arrives from toppings. Replaces the
// current (pre-stock or stale) pizza waiting in front of the oven.
export function receivePizza(pizza: Entity) {
  if (currentPizza !== null) {
    despawnPizza(currentPizza)
  }
  currentPizza = pizza
  pendingIncoming = false
  Transform.getMutable(pizza).position = getSlotPosition(FRONT_SLOT)
  refreshHandler(pizza)
}

// Discard the pizza currently in the oven (front or inside), if any.
export function discardActivePizza(): boolean {
  if (!currentPizza) return false
  discardPizzaWithAnimation(currentPizza)
  currentPizza = null
  setOvenLight('off')
  console.log('[Horno] pizza discarded')
  return true
}

// Wires the pizza's click handlers based on its current step. Called when
// the pizza arrives, after the insert tween, and on every step change in
// the bake timer.
function refreshHandler(pizza: Entity) {
  const state = PizzaState.getOrNull(pizza)
  if (!state) return

  const discardSecondary = {
    hoverText: 'Throw away',
    callback: () => discardActivePizza()
  }

  if (state.step === PizzaStep.Topped) {
    onInteract(
      pizza,
      { hoverText: 'Insert into oven', maxDistance: 6, secondary: discardSecondary },
      () => onInsertClick(pizza)
    )
  } else if (state.step === PizzaStep.Perfect) {
    onInteract(
      pizza,
      { hoverText: 'Send to Delivery', maxDistance: 6, secondary: discardSecondary },
      () => onSendToDeliveryClick(pizza)
    )
  } else {
    // Baking, Burnt, or any other intermediate state — no primary action.
    onInteract(pizza, { secondary: discardSecondary })
  }
}

function onInsertClick(pizza: Entity) {
  if (currentPizza !== pizza) return
  if (insertingPizzas.has(pizza)) return
  const state = PizzaState.getOrNull(pizza)
  if (!state || state.step !== PizzaStep.Topped) return

  insertingPizzas.add(pizza)
  sendPizzaAlongPath(pizza, [FRONT_SLOT, INSIDE_SLOT], () => {
    insertingPizzas.delete(pizza)
    const s = PizzaState.getMutableOrNull(pizza)
    if (!s) return
    s.bakeStartTime = Date.now() / 1000
    updatePizzaStep(pizza, PizzaStep.Baking)
    setOvenLight('fire')
    refreshHandler(pizza)
    console.log('[Horno] pizza in the oven — baking…')
  })
}

function onSendToDeliveryClick(pizza: Entity) {
  if (currentPizza !== pizza) return
  const state = PizzaState.getOrNull(pizza)
  if (!state || state.step !== PizzaStep.Perfect) return

  const sent = handlers?.onSendToDelivery(pizza) ?? false
  if (sent) {
    currentPizza = null
    setOvenLight('off')
  } else {
    showFloatingText(pizza, 'Delivery busy!')
    console.log('[Horno] delivery is busy — wait until it is free')
  }
}

function bakingTimerSystem(_dt: number) {
  if (!currentPizza) return
  const state = PizzaState.getMutableOrNull(currentPizza)
  if (!state) return
  if (state.step !== PizzaStep.Baking && state.step !== PizzaStep.Perfect) return

  const elapsed = Date.now() / 1000 - state.bakeStartTime

  if (state.step === PizzaStep.Baking && elapsed >= BAKE_TIME_PERFECT) {
    updatePizzaStep(currentPizza, PizzaStep.Perfect)
    refreshHandler(currentPizza)
    console.log('[Horno] pizza is perfect — take it out before it burns!')
  } else if (state.step === PizzaStep.Perfect && elapsed >= BAKE_TIME_BURNT) {
    updatePizzaStep(currentPizza, PizzaStep.Burnt)
    setOvenLight('burnt')
    refreshHandler(currentPizza)
    console.log('[Horno] pizza burnt!')
  }
}
