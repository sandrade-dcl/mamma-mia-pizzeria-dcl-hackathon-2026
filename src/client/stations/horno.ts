import {
  Entity,
  LightSource,
  PBParticleSystem_BlendMode,
  PBParticleSystem_PlaybackState,
  ParticleSystem,
  Transform,
  engine
} from '@dcl/sdk/ecs'
import { Color3, Color4, Vector3 } from '@dcl/sdk/math'
import { EntityNames } from '../../../assets/scene/entity-names'
import { sendPizzaAlongPath } from '../conveyor'
import { FEEDBACK_COLOR_PENALTY, showFloatingText } from '../feedback'
import { onInteract } from '../interaction'
import { BAKE_TIME_BURNT, BAKE_TIME_PERFECT, PizzaState, PizzaStep } from '../pizza/pizzaTypes'
import { despawnPizza, discardPizzaWithAnimation, updatePizzaStep } from '../pizza/pizzaVisual'
import { addPoints, penaltyForDiscard } from '../scoring'
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
  initSmokeEmitter()
  setOvenAmbience('off')
  engine.addSystem(bakingTimerSystem)
}

// Both the light hanging inside Station_Horno and the smoke wisp above it
// reflect what's happening to the pizza: warm orange + light grey smoke
// while baking normally, red light + dark dense smoke once it's burnt, and
// off whenever the oven is empty.
type OvenState = 'off' | 'fire' | 'burnt'

const FIRE_LIGHT_COLOR = Color3.create(1, 0.647, 0)
const BURNT_LIGHT_COLOR = Color3.create(1, 0.1, 0.1)

const SMOKE_FIRE_START = Color4.create(0.6, 0.6, 0.6, 0.5)
const SMOKE_FIRE_END = Color4.create(0.4, 0.4, 0.4, 0)
const SMOKE_BURNT_START = Color4.create(0.15, 0.15, 0.15, 0.7)
const SMOKE_BURNT_END = Color4.create(0.05, 0.05, 0.05, 0)

const SMOKE_RATE_NORMAL = 20
const SMOKE_RATE_BURNT = SMOKE_RATE_NORMAL * 2

// Attach the ParticleSystem to the SmokeEmitter child entity (which lives in
// the composite under Station_Horno). Called once at setup so we just mutate
// the component afterwards. The emitter starts stopped — setOvenAmbience
// turns it on/off as pizzas come and go.
function initSmokeEmitter() {
  const smoke = getEntityByName(EntityNames.SmokeEmitter)
  ParticleSystem.createOrReplace(smoke, {
    rate: SMOKE_RATE_NORMAL,
    lifetime: 2.5,
    maxParticles: 150,
    initialSize: { start: 0.15, end: 0.3 },
    sizeOverTime: { start: 1.0, end: 2.5 },
    initialColor: { start: SMOKE_FIRE_START, end: SMOKE_FIRE_START },
    colorOverTime: { start: SMOKE_FIRE_START, end: SMOKE_FIRE_END },
    initialVelocitySpeed: { start: 0.3, end: 0.6 },
    gravity: -0.15,
    blendMode: PBParticleSystem_BlendMode.PSB_ALPHA,
    shape: ParticleSystem.Shape.Cone({ angle: 15, radius: 0.15 }),
    loop: true,
    playbackState: PBParticleSystem_PlaybackState.PS_STOPPED
  })
}

// "About to explode" pulse on Station_Horno while a burnt pizza is sitting
// inside. The original Transform.scale is captured the first time we run and
// the system writes scale = original + sin-based pulse each frame. Toggle
// off restores the captured scale exactly.
const BURNT_PULSE_FREQ_RAD_S = 18
const BURNT_PULSE_AMPLITUDE = 0.005
let hornoOriginalScale: { x: number; y: number; z: number } | null = null
let burntPulseActive = false

function ensureHornoOriginalScale() {
  if (hornoOriginalScale !== null) return
  const transform = Transform.getOrNull(getEntityByName(EntityNames.Station_Horno))
  if (!transform) return
  hornoOriginalScale = {
    x: transform.scale.x,
    y: transform.scale.y,
    z: transform.scale.z
  }
}

function setHornoBurntPulse(active: boolean) {
  ensureHornoOriginalScale()
  burntPulseActive = active
  if (!active && hornoOriginalScale) {
    const transform = Transform.getMutableOrNull(getEntityByName(EntityNames.Station_Horno))
    if (transform) {
      transform.scale = Vector3.create(
        hornoOriginalScale.x,
        hornoOriginalScale.y,
        hornoOriginalScale.z
      )
    }
  }
}

function burntPulseSystem(_dt: number) {
  if (!burntPulseActive || !hornoOriginalScale) return
  const transform = Transform.getMutableOrNull(getEntityByName(EntityNames.Station_Horno))
  if (!transform) return
  const t = Date.now() / 1000
  const pulse = ((Math.sin(t * BURNT_PULSE_FREQ_RAD_S) + 1) / 2) * BURNT_PULSE_AMPLITUDE
  transform.scale = Vector3.create(
    hornoOriginalScale.x + pulse,
    hornoOriginalScale.y + pulse,
    hornoOriginalScale.z + pulse
  )
}

engine.addSystem(burntPulseSystem)

function setOvenAmbience(state: OvenState) {
  // Burnt pulse on the station mesh — only while a burnt pizza is inside.
  setHornoBurntPulse(state === 'burnt')

  // Light
  const light = getEntityByName(EntityNames.Horno_Light)
  const ls = LightSource.getMutableOrNull(light)
  if (ls) {
    if (state === 'off') {
      ls.active = false
    } else {
      ls.active = true
      ls.color = state === 'burnt' ? BURNT_LIGHT_COLOR : FIRE_LIGHT_COLOR
    }
  }

  // Smoke
  const smoke = getEntityByName(EntityNames.SmokeEmitter)
  const ps = ParticleSystem.getMutableOrNull(smoke)
  if (ps) {
    if (state === 'off') {
      ps.playbackState = PBParticleSystem_PlaybackState.PS_STOPPED
    } else {
      ps.playbackState = PBParticleSystem_PlaybackState.PS_PLAYING
      const burnt = state === 'burnt'
      ps.rate = burnt ? SMOKE_RATE_BURNT : SMOKE_RATE_NORMAL
      const startC = burnt ? SMOKE_BURNT_START : SMOKE_FIRE_START
      const endC = burnt ? SMOKE_BURNT_END : SMOKE_FIRE_END
      ps.initialColor = { start: startC, end: startC }
      ps.colorOverTime = { start: startC, end: endC }
    }
  }
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

// Wipe the station between rounds, including any in-flight insert tween
// and the oven ambience.
export function resetHornoStation(): void {
  if (currentPizza !== null) {
    discardPizzaWithAnimation(currentPizza)
    currentPizza = null
  }
  pendingIncoming = false
  insertingPizzas.clear()
  setOvenAmbience('off')
}

// Discard the pizza currently in the oven (front or inside), if any.
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
  setOvenAmbience('off')
  console.log(`[Horno] pizza discarded (${penalty})`)
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
    setOvenAmbience('fire')
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
    setOvenAmbience('off')
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
    setOvenAmbience('burnt')
    refreshHandler(currentPizza)
    console.log('[Horno] pizza burnt!')
  }
}
