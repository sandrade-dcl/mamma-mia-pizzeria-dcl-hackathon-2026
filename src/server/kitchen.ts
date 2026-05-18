import { Entity, Transform, engine } from '@dcl/sdk/ecs'
import { Quaternion, Vector3 } from '@dcl/sdk/math'
import { AUTH_SERVER_PEER_ID } from '@dcl/sdk/network/message-bus-sync'
import { syncEntity } from '@dcl/sdk/network'
import { EntityNames } from '../../assets/scene/entity-names'
import {
  BAKE_TIME_BURNT,
  BAKE_TIME_PERFECT,
  MASA_CLICKS_REQUIRED,
  PizzaState,
  PizzaStep,
  Topping
} from '../client/pizza/pizzaTypes'
import {
  discardPizzaWithAnimation,
  serveAnimationOnPizza
} from '../client/pizza/pizzaVisual'
import { getSlotPosition } from '../client/slots'
import {
  SCORE_DISCARD_BURNT,
  SCORE_DISCARD_WITH_TOPPINGS,
  SCORE_SERVE_BASE,
  SCORE_SERVE_BONUS_MAX,
  serveBonusFor
} from '../client/scoring'
import { room } from '../shared/messages'
import {
  CurrentStation,
  DisposingState,
  OrderSlot,
  RoundPhase,
  RoundState
} from '../shared/syncedState'

// ------------------------------------------------------------------------
// Authoritative kitchen state machine (Hito 4 Option A — fluid version).
//
// The server is the single source of truth for every piece of pizza state,
// but it does NOT sync Transform. Each client computes Transform.position
// and Transform.scale per frame from PizzaState (`currentStation` +
// `stationStartTime` + `doughClicks` + `step`) against a shared waypoint
// table — that way the conveyor animates locally at the renderer's full
// 60 Hz instead of the CRDT throttle rate. State transitions (station
// flips, knead counter increments, step changes, disposing flag) are
// what cross the wire.
// ------------------------------------------------------------------------

const CONVEYOR_SPEED_M_S = 5
const MASA_RESPAWN_DELAY_MS = 1000
const DELIVERY_SLOT_COUNT = 4

let nextPizzaSyncId = 200
const pizzaBySyncId = new Map<number, Entity>()

let masaPizza: Entity | null = null
let toppingsPizza: Entity | null = null
let hornoFrontPizza: Entity | null = null
let hornoInsidePizza: Entity | null = null
const deliveryPizzas: (Entity | null)[] = Array.from(
  { length: DELIVERY_SLOT_COUNT },
  () => null
)

// Time-based queue: at `at` (ms timestamp), fire `cb`. Used to flip a
// pizza's station after its conveyor segment finishes, to respawn the
// masa dough 1 s after a send, and to clean up server-local stations
// once a pizza despawns.
type PendingTask = { at: number; cb: () => void }
const pendingTasks: PendingTask[] = []
let masaRespawnAt = 0

export function initKitchen() {
  engine.addSystem(pendingTaskSystem)
  engine.addSystem(bakingTimerSystem)
  engine.addSystem(masaRespawnSystem)
  engine.addSystem(pizzaBySyncIdCleanupSystem)
}

// ------------------------------------------------------------------------
// Lifecycle
// ------------------------------------------------------------------------

export function onRoundStart() {
  resetKitchen()
  spawnFreshMasa()
}

export function onRoundEnd() {
  resetKitchen()
}

function resetKitchen() {
  for (const [, e] of pizzaBySyncId) {
    engine.removeEntityWithChildren(e)
  }
  pizzaBySyncId.clear()
  masaPizza = null
  toppingsPizza = null
  hornoFrontPizza = null
  hornoInsidePizza = null
  for (let i = 0; i < deliveryPizzas.length; i++) deliveryPizzas[i] = null
  pendingTasks.length = 0
  masaRespawnAt = 0
}

// ------------------------------------------------------------------------
// Spawn / despawn helpers
// ------------------------------------------------------------------------

function spawnPizzaAt(slotName: EntityNames, station: CurrentStation): Entity {
  const pizza = engine.addEntity()
  const slotPos = getSlotPosition(slotName)

  Transform.create(pizza, {
    position: slotPos,
    scale: Vector3.create(0.7, 0.7, 0.7),
    rotation: Quaternion.Identity()
  })

  const syncId = nextPizzaSyncId++
  PizzaState.create(pizza, {
    step: PizzaStep.RawDough,
    toppings: [],
    bakeStartTime: 0,
    doughClicks: 0,
    currentStation: station,
    stationStartTime: Date.now(),
    deliverySlotIdx: 0,
    disposing: DisposingState.None,
    syncId
  })
  // Only PizzaState is synced — clients derive Transform locally. This is
  // the key to fluid animation: no CRDT throttle on the position stream.
  syncEntity(pizza, [PizzaState.componentId], syncId)
  pizzaBySyncId.set(syncId, pizza)
  return pizza
}

function spawnFreshMasa() {
  masaPizza = spawnPizzaAt(EntityNames.Slot_Masa, CurrentStation.Masa)
  console.log(`[KITCHEN] fresh masa spawned (syncId=${PizzaState.get(masaPizza).syncId})`)
}

// ------------------------------------------------------------------------
// Path definitions — must stay byte-identical to the client side in
// pizzaSync.ts so server scheduling and client interpolation agree on
// when each segment ends.
// ------------------------------------------------------------------------

const PATH_WAYPOINTS: Partial<Record<CurrentStation, EntityNames[]>> = {
  [CurrentStation.MasaToToppings]: [
    EntityNames.Slot_Masa,
    EntityNames.Slot_Masa_To_Toppings_Conveyor_1,
    EntityNames.Slot_Masa_To_Toppings_Conveyor_2,
    EntityNames.Slot_Toppings
  ],
  [CurrentStation.ToppingsToHorno]: [
    EntityNames.Slot_Toppings,
    EntityNames.Slot_Toppings_To_Horno_Conveyor_1,
    EntityNames.Slot_Toppings_To_Horno_Conveyor_2
  ],
  [CurrentStation.HornoFrontToHorno]: [
    EntityNames.Slot_Toppings_To_Horno_Conveyor_2,
    EntityNames.Slot_Horno
  ],
  [CurrentStation.HornoToDelivery]: [
    EntityNames.Slot_Horno,
    EntityNames.Slot_Horno_To_Delivery_Conveyor_1,
    EntityNames.Slot_Delivery
  ]
}

function pathDurationMs(transit: CurrentStation): number {
  const waypoints = PATH_WAYPOINTS[transit]
  if (!waypoints) return 0
  let total = 0
  for (let i = 0; i < waypoints.length - 1; i++) {
    const a = getSlotPosition(waypoints[i])
    const b = getSlotPosition(waypoints[i + 1])
    total += (Vector3.distance(a, b) / CONVEYOR_SPEED_M_S) * 1000
  }
  return total
}

function scheduleTask(delayMs: number, cb: () => void) {
  pendingTasks.push({ at: Date.now() + delayMs, cb })
}

function pendingTaskSystem(_dt: number) {
  if (pendingTasks.length === 0) return
  const now = Date.now()
  for (let i = pendingTasks.length - 1; i >= 0; i--) {
    if (pendingTasks[i].at <= now) {
      const cb = pendingTasks[i].cb
      pendingTasks.splice(i, 1)
      try {
        cb()
      } catch (err) {
        // Don't let a bad task tear down the system — every subsequent
        // task on the queue would silently never fire.
        console.log(`[KITCHEN] pending task threw: ${String(err)}`)
      }
    }
  }
}

// ------------------------------------------------------------------------
// Cmd handlers
// ------------------------------------------------------------------------

function rejectAction(pizzaSyncId: number, reason: string, to: string | undefined) {
  if (!to) return
  room.send('EvtActionRejected', { reason, pizzaSyncId }, { to: [to] })
}

function setStation(pizza: Entity, station: CurrentStation) {
  const s = PizzaState.getMutableOrNull(pizza)
  if (!s) return
  s.currentStation = station
  s.stationStartTime = Date.now()
}

export function handleKnead(pizzaSyncId: number, _from: string | undefined) {
  console.log(`[KITCHEN] CmdKnead syncId=${pizzaSyncId}`)
  const pizza = pizzaBySyncId.get(pizzaSyncId)
  if (!pizza || pizza !== masaPizza) {
    console.log(`[KITCHEN]   rejected: pizza missing or not masaPizza`)
    return
  }
  const state = PizzaState.getMutableOrNull(pizza)
  if (!state || state.step !== PizzaStep.RawDough) {
    console.log(`[KITCHEN]   rejected: step=${state?.step}`)
    return
  }
  state.doughClicks += 1
  if (state.doughClicks >= MASA_CLICKS_REQUIRED) state.step = PizzaStep.FlatDough
}

export function handleSendToToppings(pizzaSyncId: number, from: string | undefined) {
  console.log(
    `[KITCHEN] CmdSendToToppings syncId=${pizzaSyncId} masaPizza=${masaPizza} toppingsPizza=${toppingsPizza}`
  )
  const pizza = pizzaBySyncId.get(pizzaSyncId)
  if (!pizza || pizza !== masaPizza) {
    console.log(`[KITCHEN]   rejected: pizza missing or not masaPizza`)
    return
  }
  const state = PizzaState.getOrNull(pizza)
  if (!state || state.step !== PizzaStep.FlatDough) {
    console.log(`[KITCHEN]   rejected: step=${state?.step}`)
    return
  }
  if (toppingsPizza !== null) {
    console.log(`[KITCHEN]   rejected: toppingsPizza already set`)
    rejectAction(pizzaSyncId, 'Toppings busy!', from)
    return
  }
  toppingsPizza = pizza
  masaPizza = null
  setStation(pizza, CurrentStation.MasaToToppings)
  console.log(`[KITCHEN]   accepted: pizza ${pizzaSyncId} → MasaToToppings`)
  scheduleTask(pathDurationMs(CurrentStation.MasaToToppings), () => {
    const s = PizzaState.getOrNull(pizza)
    // Only complete the move if the pizza is still mid-transit on this
    // path. The player may have already discarded or chained into another
    // action (e.g. fast-clicked the destination); rewriting the station
    // here would clobber that newer state.
    if (s && s.currentStation === CurrentStation.MasaToToppings) {
      setStation(pizza, CurrentStation.Toppings)
    }
    masaRespawnAt = Date.now() + MASA_RESPAWN_DELAY_MS
  })
}

export function handleAddTopping(topping: number, _from: string | undefined) {
  console.log(`[KITCHEN] CmdAddTopping topping=${topping} toppingsPizza=${toppingsPizza}`)
  const pizza = toppingsPizza
  if (!pizza) {
    console.log(`[KITCHEN]   rejected: no pizza at toppings station`)
    return
  }
  const state = PizzaState.getMutableOrNull(pizza)
  if (!state) {
    console.log(`[KITCHEN]   rejected: no PizzaState`)
    return
  }
  if (state.currentStation !== CurrentStation.Toppings) {
    console.log(`[KITCHEN]   rejected: currentStation=${state.currentStation} (expected Toppings)`)
    return
  }
  if (state.step !== PizzaStep.FlatDough && state.step !== PizzaStep.Topped) {
    console.log(`[KITCHEN]   rejected: step=${state.step}`)
    return
  }
  state.toppings = [...state.toppings, topping as Topping]
  if (state.step === PizzaStep.FlatDough) state.step = PizzaStep.Topped
  console.log(`[KITCHEN]   added topping (total=${state.toppings.length})`)
}

export function handleSendToHorno(pizzaSyncId: number, from: string | undefined) {
  console.log(
    `[KITCHEN] CmdSendToHorno syncId=${pizzaSyncId} toppingsPizza=${toppingsPizza} hornoFront=${hornoFrontPizza} hornoInside=${hornoInsidePizza}`
  )
  const pizza = pizzaBySyncId.get(pizzaSyncId)
  if (!pizza || pizza !== toppingsPizza) {
    console.log(`[KITCHEN]   rejected: pizza missing or not toppingsPizza`)
    return
  }
  const state = PizzaState.getOrNull(pizza)
  if (!state || state.step !== PizzaStep.Topped) {
    console.log(`[KITCHEN]   rejected: step=${state?.step}`)
    return
  }
  if (hornoFrontPizza !== null || hornoInsidePizza !== null) {
    console.log(`[KITCHEN]   rejected: oven already busy`)
    rejectAction(pizzaSyncId, 'Oven busy!', from)
    return
  }
  hornoFrontPizza = pizza
  toppingsPizza = null
  setStation(pizza, CurrentStation.ToppingsToHorno)
  console.log(`[KITCHEN]   accepted: pizza ${pizzaSyncId} → ToppingsToHorno`)
  scheduleTask(pathDurationMs(CurrentStation.ToppingsToHorno), () => {
    const s = PizzaState.getOrNull(pizza)
    if (s && s.currentStation === CurrentStation.ToppingsToHorno) {
      setStation(pizza, CurrentStation.HornoFront)
    }
  })
}

export function handleInsertHorno(pizzaSyncId: number, _from: string | undefined) {
  const pizza = pizzaBySyncId.get(pizzaSyncId)
  if (!pizza || pizza !== hornoFrontPizza) return
  const state = PizzaState.getOrNull(pizza)
  if (!state || state.step !== PizzaStep.Topped) return
  hornoInsidePizza = pizza
  hornoFrontPizza = null
  setStation(pizza, CurrentStation.HornoFrontToHorno)
  scheduleTask(pathDurationMs(CurrentStation.HornoFrontToHorno), () => {
    const s = PizzaState.getMutableOrNull(pizza)
    if (!s) return
    if (s.currentStation !== CurrentStation.HornoFrontToHorno) return
    s.currentStation = CurrentStation.Horno
    s.stationStartTime = Date.now()
    s.step = PizzaStep.Baking
    s.bakeStartTime = Date.now()
  })
}

export function handleSendToDelivery(pizzaSyncId: number, from: string | undefined) {
  const occupancy = deliveryPizzas.map((p) => (p === null ? 'null' : String(p))).join(',')
  console.log(
    `[KITCHEN] CmdSendToDelivery syncId=${pizzaSyncId} hornoInside=${hornoInsidePizza} deliveryPizzas=[${occupancy}]`
  )
  const pizza = pizzaBySyncId.get(pizzaSyncId)
  if (!pizza || pizza !== hornoInsidePizza) {
    console.log(`[KITCHEN]   rejected: pizza missing or not hornoInsidePizza`)
    return
  }
  const state = PizzaState.getMutableOrNull(pizza)
  if (!state || state.step !== PizzaStep.Perfect) {
    console.log(`[KITCHEN]   rejected: step=${state?.step}`)
    return
  }
  const slot = deliveryPizzas.indexOf(null)
  if (slot < 0) {
    console.log(`[KITCHEN]   rejected: delivery full`)
    rejectAction(pizzaSyncId, 'Delivery busy!', from)
    return
  }
  console.log(`[KITCHEN]   accepted: pizza ${pizzaSyncId} → HornoToDelivery slot=${slot}`)
  deliveryPizzas[slot] = pizza
  hornoInsidePizza = null
  state.deliverySlotIdx = slot
  setStation(pizza, CurrentStation.HornoToDelivery)
  scheduleTask(pathDurationMs(CurrentStation.HornoToDelivery), () => {
    const s = PizzaState.getOrNull(pizza)
    if (s && s.currentStation === CurrentStation.HornoToDelivery) {
      setStation(pizza, CurrentStation.Delivery)
    }
  })
}

export function handleAttemptServe(pizzaSyncId: number, from: string | undefined) {
  console.log(`[KITCHEN] CmdAttemptServe syncId=${pizzaSyncId}`)
  const pizza = pizzaBySyncId.get(pizzaSyncId)
  if (!pizza) {
    console.log(`[KITCHEN]   rejected: pizza missing in pizzaBySyncId`)
    if (from) sendServeResult(from, false, 0, pizzaSyncId)
    return
  }
  const slotIdx = deliveryPizzas.indexOf(pizza)
  const state = PizzaState.getMutableOrNull(pizza)
  if (slotIdx < 0 || !state || state.step !== PizzaStep.Perfect) {
    console.log(`[KITCHEN]   rejected: slotIdx=${slotIdx} step=${state?.step} station=${state?.currentStation}`)
    if (from) sendServeResult(from, false, 0, pizzaSyncId)
    return
  }

  for (const [orderEntity] of engine.getEntitiesWith(OrderSlot)) {
    const slot = OrderSlot.getOrNull(orderEntity)
    if (!slot || !slot.active || slot.expiredSince !== 0) continue
    const matched = toppingsMatchOrderRecipe([...state.toppings], slot.recipeIndex)
    if (!matched) continue

    const lifetime = Number(slot.expiresAt) - Number(slot.createdAt)
    const remaining = Math.max(0, Number(slot.expiresAt) - Date.now())
    const ratio = lifetime > 0 ? remaining / lifetime : 0
    const bonus = serveBonusFor(ratio)
    const delta = SCORE_SERVE_BASE + bonus
    const round = roundStateMut()
    if (round) round.score += delta

    const mutSlot = OrderSlot.getMutable(orderEntity)
    mutSlot.active = false
    mutSlot.id = 0
    mutSlot.recipeIndex = 0
    mutSlot.createdAt = 0
    mutSlot.expiresAt = 0
    mutSlot.expiredSince = 0

    deliveryPizzas[slotIdx] = null
    startDisposing(pizza, DisposingState.Serve)
    if (from) sendServeResult(from, true, delta, pizzaSyncId)
    return
  }
  if (from) sendServeResult(from, false, 0, pizzaSyncId)
}

export function handleDiscard(pizzaSyncId: number, _from: string | undefined) {
  console.log(`[KITCHEN] CmdDiscard syncId=${pizzaSyncId}`)
  const pizza = pizzaBySyncId.get(pizzaSyncId)
  if (!pizza) {
    console.log(`[KITCHEN]   rejected: pizza missing in pizzaBySyncId`)
    return
  }
  const state = PizzaState.getOrNull(pizza)
  if (!state) {
    console.log(`[KITCHEN]   rejected: no PizzaState`)
    return
  }
  if (state.currentStation === CurrentStation.Masa) {
    console.log(`[KITCHEN]   rejected: at Masa`)
    return
  }

  const penalty = penaltyFor(state.step as PizzaStep, state.toppings.length)
  if (penalty !== 0) {
    const round = roundStateMut()
    if (round) round.score += penalty
  }
  releaseStationOwnership(pizza)
  startDisposing(pizza, DisposingState.Discard)
}

// ------------------------------------------------------------------------
// Server systems
// ------------------------------------------------------------------------

function bakingTimerSystem(_dt: number) {
  if (!hornoInsidePizza) return
  const state = PizzaState.getMutableOrNull(hornoInsidePizza)
  if (!state) return
  // Defensive: even though hornoInsidePizza is cleared by every handler
  // that moves the pizza out of the oven, this guard catches any race
  // where the variable lags behind the synced state (e.g. the bake
  // timer ticking on the same frame as CmdSendToDelivery is processed).
  if (state.currentStation !== CurrentStation.Horno) return
  if (state.step !== PizzaStep.Baking && state.step !== PizzaStep.Perfect) return
  const elapsedMs = Date.now() - Number(state.bakeStartTime)
  if (state.step === PizzaStep.Baking && elapsedMs >= BAKE_TIME_PERFECT * 1000) {
    state.step = PizzaStep.Perfect
  } else if (state.step === PizzaStep.Perfect && elapsedMs >= BAKE_TIME_BURNT * 1000) {
    state.step = PizzaStep.Burnt
  }
}

function masaRespawnSystem(_dt: number) {
  if (masaRespawnAt === 0) return
  if (Date.now() < masaRespawnAt) return
  masaRespawnAt = 0
  if (masaPizza !== null) return
  const round = roundStateRead()
  if (!round || round.phase !== RoundPhase.Playing) return
  spawnFreshMasa()
}

function startDisposing(pizza: Entity, kind: DisposingState) {
  const state = PizzaState.getMutableOrNull(pizza)
  if (!state) return
  if (state.disposing !== DisposingState.None) return
  state.disposing = kind
  // Server runs the same animation system as clients — the animation
  // owns the entity removal at the end of its clip.
  if (kind === DisposingState.Discard) discardPizzaWithAnimation(pizza)
  else if (kind === DisposingState.Serve) serveAnimationOnPizza(pizza)
}

function pizzaBySyncIdCleanupSystem(_dt: number) {
  const alive = new Set<Entity>()
  for (const [e] of engine.getEntitiesWith(PizzaState)) alive.add(e)
  for (const [syncId, e] of Array.from(pizzaBySyncId.entries())) {
    if (!alive.has(e)) pizzaBySyncId.delete(syncId)
  }
}

// ------------------------------------------------------------------------
// Helpers
// ------------------------------------------------------------------------

function roundStateRead() {
  for (const [entity] of engine.getEntitiesWith(RoundState)) {
    return RoundState.getOrNull(entity)
  }
  return null
}

function roundStateMut() {
  for (const [entity] of engine.getEntitiesWith(RoundState)) {
    return RoundState.getMutable(entity)
  }
  return null
}

function releaseStationOwnership(pizza: Entity) {
  if (masaPizza === pizza) {
    masaPizza = null
    const round = roundStateRead()
    if (round && round.phase === RoundPhase.Playing) {
      masaRespawnAt = Date.now() + MASA_RESPAWN_DELAY_MS
    }
  }
  if (toppingsPizza === pizza) toppingsPizza = null
  if (hornoFrontPizza === pizza) hornoFrontPizza = null
  if (hornoInsidePizza === pizza) hornoInsidePizza = null
  for (let i = 0; i < deliveryPizzas.length; i++) {
    if (deliveryPizzas[i] === pizza) deliveryPizzas[i] = null
  }
}

function sendServeResult(toAddress: string, ok: boolean, scoreDelta: number, pizzaSyncId: number) {
  room.send(
    'EvtServeResult',
    { ok, scoreDelta, pizzaSyncId },
    { to: [toAddress] }
  )
}

import { RECIPES } from '../client/orders/orderTypes'

function toppingsMatchOrderRecipe(toppings: number[], recipeIndex: number): boolean {
  const recipe = RECIPES[recipeIndex]
  if (!recipe) return false
  if (toppings.length !== recipe.toppings.length) return false
  const a = [...toppings].sort((x, y) => x - y)
  const b = [...recipe.toppings].sort((x, y) => x - y)
  return a.every((t, i) => t === b[i])
}

function penaltyFor(step: PizzaStep, toppingCount: number): number {
  if (step === PizzaStep.Burnt) return SCORE_DISCARD_BURNT
  if (toppingCount === 0) return 0
  return SCORE_DISCARD_WITH_TOPPINGS
}

// Touch sentinels so esbuild keeps these tokens around even after tree
// shaking — the auth-server peer ID is dynamic-only on the wire path.
void AUTH_SERVER_PEER_ID
void SCORE_SERVE_BONUS_MAX
