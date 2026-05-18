import {
  ColliderLayer,
  EasingFunction,
  Entity,
  Material,
  MeshCollider,
  MeshRenderer,
  Transform,
  Tween,
  TweenSequence,
  engine
} from '@dcl/sdk/ecs'
import { Color4, Quaternion, Vector3 } from '@dcl/sdk/math'
import { isServer } from '@dcl/sdk/network'
import { EntityNames } from '../../../assets/scene/entity-names'
import { FEEDBACK_COLOR_PENALTY, showFloatingText } from '../feedback'
import { onInteract } from '../interaction'
import { findMatchingOrder } from '../orders/orderManager'
import { room } from '../../shared/messages'
import { CurrentStation, DisposingState } from '../../shared/syncedState'
import { getSlotPosition } from '../slots'
import { MASA_CLICKS_REQUIRED, PizzaState, PizzaStep, Topping } from './pizzaTypes'
import { discardPizzaWithAnimation, serveAnimationOnPizza } from './pizzaVisual'

// ---------------------------------------------------------------------------
// Per-client visual reconciler (Hito 4 — fluid version).
//
// Only PizzaState crosses the wire. Each client computes Transform.position
// and Transform.scale every frame from the authoritative state — that
// turns the conveyor into a deterministic 60 Hz local animation instead of
// a CRDT-throttled sync stream, which is what made the earlier version
// feel jumpy.
//
// Animation triggers:
//   • First sight of a pizza → spawn pop (scale ease-out-back).
//   • disposing flag transitions to Discard/Serve → the matching local
//     animation overrides the state-derived Transform until the entity
//     is removed by the server.
// ---------------------------------------------------------------------------

const CONVEYOR_SPEED_M_S = 5
const DELIVERY_SLOT_SPACING = 1.2
const DELIVERY_SLOT_COUNT = 4

const STEP_COLORS: Record<PizzaStep, Color4> = {
  [PizzaStep.RawDough]: Color4.create(0.95, 0.92, 0.85, 1),
  [PizzaStep.FlatDough]: Color4.create(1.0, 0.92, 0.65, 1),
  [PizzaStep.Topped]: Color4.create(1.0, 0.8, 0.2, 1),
  [PizzaStep.Baking]: Color4.create(1.0, 0.6, 0.15, 1),
  [PizzaStep.Perfect]: Color4.create(0.85, 0.55, 0.1, 1),
  [PizzaStep.Burnt]: Color4.create(0.15, 0.08, 0.05, 1)
}

const TOPPING_COLORS: Record<Topping, Color4> = {
  [Topping.Tomato]: Color4.create(0.85, 0.15, 0.1, 1),
  [Topping.Mozzarella]: Color4.create(0.95, 0.92, 0.85, 1),
  [Topping.Salami]: Color4.create(0.55, 0.1, 0.1, 1),
  [Topping.Mushroom]: Color4.create(0.65, 0.55, 0.45, 1)
}

// Path table — MUST match the server's PATH_WAYPOINTS in kitchen.ts so the
// server's transition scheduling and the client's interpolation use the
// same totals.
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

// Anchor slot for steady stations (where the pizza sits between
// transitions). Delivery is special-cased per slotIdx below.
const STATIC_STATION_SLOT: Partial<Record<CurrentStation, EntityNames>> = {
  [CurrentStation.Masa]: EntityNames.Slot_Masa,
  [CurrentStation.Toppings]: EntityNames.Slot_Toppings,
  [CurrentStation.HornoFront]: EntityNames.Slot_Toppings_To_Horno_Conveyor_2,
  [CurrentStation.Horno]: EntityNames.Slot_Horno
}

// Per-pizza visual bookkeeping used by the reconciler to detect changes
// and to track spawned topping cubes.
type Observed = {
  step: PizzaStep
  station: CurrentStation
  disposing: DisposingState
  syncId: number
}
const observed = new Map<Entity, Observed>()
const localToppings = new Map<Entity, Entity[]>()

// Transit movement is driven by the built-in Tween + TweenSequence
// components on each client locally — Babylon interpolates Transform
// between scene ticks (so the visual runs at the renderer's frame rate,
// not the system tick rate, which felt choppy with manual per-frame
// Transform writes). Per pizza we cache the (station, stationStartTime)
// pair we already configured Tweens for so a stable transit doesn't
// recreate Tweens every frame.
type ConveyorSetup = {
  station: CurrentStation
  stationStartTime: number
  // For HornoToDelivery paths, the Tween's final position depends on
  // which slot the server assigned to the pizza. We cache it so that a
  // late-arriving CRDT update with the real slot index invalidates the
  // existing Tween and forces a re-setup pointing at the right slot.
  deliverySlotIdx: number
}
const conveyorSetup = new Map<Entity, ConveyorSetup>()
const TRANSIT_STATIONS = new Set<CurrentStation>([
  CurrentStation.MasaToToppings,
  CurrentStation.ToppingsToHorno,
  CurrentStation.HornoFrontToHorno,
  CurrentStation.HornoToDelivery
])

function pathDurationMsFor(station: CurrentStation): number | null {
  const waypoints = PATH_WAYPOINTS[station]
  if (!waypoints || waypoints.length < 2) return null
  let total = 0
  for (let i = 0; i < waypoints.length - 1; i++) {
    const a = getSlotPosition(waypoints[i])
    const b = getSlotPosition(waypoints[i + 1])
    total += (Vector3.distance(a, b) / CONVEYOR_SPEED_M_S) * 1000
  }
  return total
}

// Where each transit lands. The reconciler clears a predicted transit if
// the server is already at the destination — CRDT can batch the two
// writes (transit + destination) into a single delivery that only carries
// the latter, especially on short paths like HornoFrontToHorno (~500 ms).
// Without this fallback, the prediction would persist forever and the
// pizza would stay stuck in a transit visual that has no click action.
const TRANSIT_DESTINATIONS: Partial<Record<CurrentStation, CurrentStation>> = {
  [CurrentStation.MasaToToppings]: CurrentStation.Toppings,
  [CurrentStation.ToppingsToHorno]: CurrentStation.HornoFront,
  [CurrentStation.HornoFrontToHorno]: CurrentStation.Horno,
  [CurrentStation.HornoToDelivery]: CurrentStation.Delivery
}

function clearConveyorTweens(entity: Entity) {
  if (Tween.getOrNull(entity)) Tween.deleteFrom(entity)
  if (TweenSequence.getOrNull(entity)) TweenSequence.deleteFrom(entity)
  conveyorSetup.delete(entity)
}

function maybeSetupConveyorTween(entity: Entity, eff: EffectiveState) {
  if (!TRANSIT_STATIONS.has(eff.currentStation)) {
    if (conveyorSetup.has(entity)) clearConveyorTweens(entity)
    return false
  }
  const currentDeliverySlot = PizzaState.getOrNull(entity)?.deliverySlotIdx ?? 0
  const existing = conveyorSetup.get(entity)
  if (
    existing &&
    existing.station === eff.currentStation &&
    existing.stationStartTime === eff.stationStartTime &&
    existing.deliverySlotIdx === currentDeliverySlot
  ) {
    return true
  }
  const waypoints = PATH_WAYPOINTS[eff.currentStation]
  if (!waypoints || waypoints.length < 2) {
    clearConveyorTweens(entity)
    return false
  }
  // For HornoToDelivery the conveyor must land on the slot the server
  // assigned to this pizza — not the centred Slot_Delivery anchor — so
  // when there are multiple pizzas on the counter at the same time they
  // don't all stack at the middle of the bench.
  const isDeliveryPath = eff.currentStation === CurrentStation.HornoToDelivery
  const finalState = isDeliveryPath ? PizzaState.getOrNull(entity) : null
  const finalSlotPosition = (): Vector3 => {
    if (!finalState) return getSlotPosition(waypoints[waypoints.length - 1])
    const base = getSlotPosition(EntityNames.Slot_Delivery)
    const offsetX =
      (finalState.deliverySlotIdx - (DELIVERY_SLOT_COUNT - 1) / 2) * DELIVERY_SLOT_SPACING
    return Vector3.create(base.x + offsetX, base.y, base.z)
  }
  const waypointPos = (idx: number): Vector3 => {
    if (isDeliveryPath && idx === waypoints.length - 1) return finalSlotPosition()
    return getSlotPosition(waypoints[idx])
  }
  const segments = waypoints.length - 1
  const segDurations: number[] = []
  for (let i = 0; i < segments; i++) {
    segDurations.push((Vector3.distance(waypointPos(i), waypointPos(i + 1)) / CONVEYOR_SPEED_M_S) * 1000)
  }
  let elapsed = Math.max(0, Date.now() - eff.stationStartTime)
  let segIdx = 0
  while (segIdx < segments && elapsed >= segDurations[segIdx]) {
    elapsed -= segDurations[segIdx]
    segIdx += 1
  }
  if (segIdx >= segments) {
    // Whole path already elapsed — just pin to the final waypoint and
    // let the next CRDT update flip the station to static.
    clearConveyorTweens(entity)
    const transform = Transform.getMutableOrNull(entity)
    if (transform) transform.position = waypointPos(segments)
    conveyorSetup.set(entity, {
      station: eff.currentStation,
      stationStartTime: eff.stationStartTime,
      deliverySlotIdx: currentDeliverySlot
    })
    return true
  }
  const startA = waypointPos(segIdx)
  const startB = waypointPos(segIdx + 1)
  Tween.createOrReplace(entity, {
    mode: Tween.Mode.Move({
      start: Vector3.create(startA.x, startA.y, startA.z),
      end: Vector3.create(startB.x, startB.y, startB.z)
    }),
    duration: segDurations[segIdx],
    easingFunction: EasingFunction.EF_LINEAR,
    currentTime: segDurations[segIdx] > 0 ? elapsed / segDurations[segIdx] : 1,
    playing: true
  })
  type SegmentTween = NonNullable<Parameters<typeof Tween.createOrReplace>[1]>
  const tail: SegmentTween[] = []
  for (let i = segIdx + 1; i < segments; i++) {
    const a = waypointPos(i)
    const b = waypointPos(i + 1)
    tail.push({
      mode: Tween.Mode.Move({
        start: Vector3.create(a.x, a.y, a.z),
        end: Vector3.create(b.x, b.y, b.z)
      }),
      duration: segDurations[i],
      easingFunction: EasingFunction.EF_LINEAR
    })
  }
  if (tail.length > 0) {
    // Omitting `loop` is the "no loop" behaviour — TweenLoop only
    // declares TL_RESTART (0) and TL_YOYO (1).
    TweenSequence.createOrReplace(entity, { sequence: tail })
  } else if (TweenSequence.getOrNull(entity)) {
    TweenSequence.deleteFrom(entity)
  }
  conveyorSetup.set(entity, {
    station: eff.currentStation,
    stationStartTime: eff.stationStartTime,
    deliverySlotIdx: currentDeliverySlot
  })
  return true
}

// Local-only spawn animation. The server doesn't sync Transform so we
// drive the pop-in entirely client-side — read the target scale once and
// ease out-back from near-zero.
const SPAWN_ANIM_MS = 400
const EASE_OUT_BACK_C1 = 1.70158
const EASE_OUT_BACK_C3 = EASE_OUT_BACK_C1 + 1
type SpawnAnim = { pizza: Entity; startTime: number; targetScale: Vector3 }
const spawnAnims: SpawnAnim[] = []

function scaleForStep(step: PizzaStep, doughClicks: number): Vector3 {
  if (step === PizzaStep.RawDough) {
    if (doughClicks <= 0) return Vector3.create(0.7, 0.7, 0.7)
    if (doughClicks === 1) return Vector3.create(0.85, 0.5, 0.85)
    if (doughClicks === 2) return Vector3.create(1.0, 0.3, 1.0)
  }
  // FlatDough / Topped / Baking / Perfect / Burnt all share the flat
  // cylinder profile — same shape, only material colour differs.
  return Vector3.create(1, 0.075, 1)
}

function meshForStep(entity: Entity, step: PizzaStep) {
  if (step === PizzaStep.RawDough) {
    MeshRenderer.setSphere(entity)
    MeshCollider.setSphere(entity, ColliderLayer.CL_POINTER)
  } else {
    MeshRenderer.setCylinder(entity, 0.5, 0.5)
    MeshCollider.setCylinder(entity, 0.5, 0.5, ColliderLayer.CL_POINTER)
  }
  Material.setPbrMaterial(entity, { albedoColor: STEP_COLORS[step] })
}

function positionForState(
  station: CurrentStation,
  stationStartTime: number,
  deliverySlotIdx: number
): Vector3 {
  const staticSlot = STATIC_STATION_SLOT[station]
  if (staticSlot !== undefined) return getSlotPosition(staticSlot)
  if (station === CurrentStation.Delivery) {
    const base = getSlotPosition(EntityNames.Slot_Delivery)
    const offsetX =
      (deliverySlotIdx - (DELIVERY_SLOT_COUNT - 1) / 2) * DELIVERY_SLOT_SPACING
    return Vector3.create(base.x + offsetX, base.y, base.z)
  }
  const waypoints = PATH_WAYPOINTS[station]
  if (!waypoints || waypoints.length < 2) return Vector3.create(0, 0, 0)
  // Distribute elapsed time across segments proportionally to length so
  // velocity stays constant along the path.
  const elapsedMs = Math.max(0, Date.now() - stationStartTime)
  let remaining = elapsedMs
  for (let i = 0; i < waypoints.length - 1; i++) {
    const a = getSlotPosition(waypoints[i])
    const b = getSlotPosition(waypoints[i + 1])
    const segMs = (Vector3.distance(a, b) / CONVEYOR_SPEED_M_S) * 1000
    if (remaining <= segMs) {
      const t = segMs > 0 ? remaining / segMs : 1
      return Vector3.create(
        a.x + (b.x - a.x) * t,
        a.y + (b.y - a.y) * t,
        a.z + (b.z - a.z) * t
      )
    }
    remaining -= segMs
  }
  const last = getSlotPosition(waypoints[waypoints.length - 1])
  return last
}

function spawnToppingVisual(pizza: Entity, type: Topping, slotIndex: number): Entity {
  const angle = slotIndex * 2.39996
  const radius = Math.min(Math.sqrt(slotIndex) * 0.1, 0.4)
  const localX = Math.cos(angle) * radius
  const localZ = Math.sin(angle) * radius

  const topping = engine.addEntity()
  Transform.create(topping, {
    position: Vector3.create(localX, 0.65, localZ),
    scale: Vector3.create(0.12, 0.3, 0.12),
    rotation: Quaternion.Identity(),
    parent: pizza
  })
  MeshRenderer.setCylinder(topping, 0.5, 0.5)
  Material.setPbrMaterial(topping, { albedoColor: TOPPING_COLORS[type] })

  let list = localToppings.get(pizza)
  if (!list) {
    list = []
    localToppings.set(pizza, list)
  }
  list.push(topping)
  return topping
}

// What does a click do right now? Step + station uniquely determine the
// action; transit states return undefined so clicks during a belt segment
// are ignored.
type ClickAction = { hover: string; cmd: 'CmdKnead' | 'CmdSendToToppings' | 'CmdSendToHorno' | 'CmdInsertHorno' | 'CmdSendToDelivery' | 'CmdAttemptServe' }

function clickActionFor(step: PizzaStep, station: CurrentStation): ClickAction | undefined {
  if (station === CurrentStation.Masa) {
    if (step === PizzaStep.RawDough) return { hover: 'Knead', cmd: 'CmdKnead' }
    if (step === PizzaStep.FlatDough) return { hover: 'Send to Toppings', cmd: 'CmdSendToToppings' }
    return undefined
  }
  if (station === CurrentStation.Toppings && step === PizzaStep.Topped)
    return { hover: 'Send to Oven', cmd: 'CmdSendToHorno' }
  if (station === CurrentStation.HornoFront && step === PizzaStep.Topped)
    return { hover: 'Insert into oven', cmd: 'CmdInsertHorno' }
  if (station === CurrentStation.Horno && step === PizzaStep.Perfect)
    return { hover: 'Send to Delivery', cmd: 'CmdSendToDelivery' }
  if (station === CurrentStation.Delivery)
    return { hover: 'Serve', cmd: 'CmdAttemptServe' }
  return undefined
}

// Optimistic prediction overlay. We deliberately do NOT mutate PizzaState
// locally: the auth server's CRDT layer responds to any non-authoritative
// PizzaState write by sending an "authoritative correction" back, which
// would override the prediction with the pre-Cmd state and snap the
// visual backwards. Instead, predictions live in a non-synced Map<syncId>
// and the reconciler combines them with the authoritative PizzaState to
// compute the visible "effective" state. The overlay is cleared the moment
// the server's authoritative state catches up (or after a 2 s timeout, or
// on EvtActionRejected).
type Prediction = {
  doughClicks?: number
  step?: PizzaStep
  currentStation?: CurrentStation
  stationStartTime?: number
  // Topping prediction works as a queue: each click pushes a type to the
  // back, each server confirmation (state.toppings.length grew by N
  // since the previous reconcile) shifts N off the front. This stays
  // correct under rapid clicks where multiple CmdAddTopping messages are
  // in flight at the same time — the older "track cumulative
  // toppingsLength" approach double-counted when state.toppings.length
  // advanced between clicks.
  pendingToppings?: Topping[]
  lastObservedToppingsLength?: number
  // Predict the disposing flag (Discard) so the puff animation starts on
  // the same frame as the F press, without waiting for CmdDiscard's
  // round trip. Cleared when state.disposing catches up (or via
  // rollbackPrediction if the server somehow rejects).
  disposing?: DisposingState
  createdAt: number
}
const predictions = new Map<number, Prediction>()
// Hard ceiling so a never-confirmed prediction can't leak forever. Sized
// well above the longest path (masa→toppings ≈ 3 s at 5 m/s) so the
// timeout never fires mid-transit and rewinds the conveyor visual.
const PREDICTION_MAX_AGE_MS = 30_000

type EffectiveState = {
  step: PizzaStep
  doughClicks: number
  currentStation: CurrentStation
  stationStartTime: number
  toppings: Topping[]
  disposing: DisposingState
  syncId: number
}

// Once the local elapsed-time has passed the path's full duration, we
// pretend the pizza is already at the destination station — that lets the
// click handler switch to the destination's action ("Insert into oven"
// etc.) the moment the visual arrives, instead of waiting for the
// server's scheduled task to fire and the CRDT update to land.
function maybePromoteToDestination(
  station: CurrentStation,
  stationStartTime: number
): CurrentStation {
  if (!TRANSIT_STATIONS.has(station)) return station
  const dur = pathDurationMsFor(station)
  if (dur === null) return station
  if (Date.now() - stationStartTime < dur) return station
  return TRANSIT_DESTINATIONS[station] ?? station
}

function effectiveStateFor(
  state: ReturnType<typeof PizzaState.get>
): EffectiveState {
  const pred = predictions.get(state.syncId)
  const baseStation = (pred?.currentStation ?? state.currentStation) as CurrentStation
  const stationStartTime = pred?.stationStartTime ?? Number(state.stationStartTime)
  const promotedStation = maybePromoteToDestination(baseStation, stationStartTime)
  const toppings =
    pred && pred.pendingToppings && pred.pendingToppings.length > 0
      ? ([...state.toppings, ...pred.pendingToppings] as Topping[])
      : ([...state.toppings] as Topping[])
  return {
    step: (pred?.step ?? state.step) as PizzaStep,
    doughClicks: pred?.doughClicks ?? state.doughClicks,
    currentStation: promotedStation,
    stationStartTime,
    toppings,
    disposing: (pred?.disposing ?? state.disposing) as DisposingState,
    syncId: state.syncId
  }
}

function reconcilePrediction(state: ReturnType<typeof PizzaState.get>) {
  const pred = predictions.get(state.syncId)
  if (!pred) return
  if (Date.now() - pred.createdAt > PREDICTION_MAX_AGE_MS) {
    predictions.delete(state.syncId)
    return
  }
  if (pred.doughClicks !== undefined && state.doughClicks >= pred.doughClicks) {
    pred.doughClicks = undefined
  }
  if (pred.step !== undefined && state.step === pred.step) {
    pred.step = undefined
  }
  if (pred.currentStation !== undefined) {
    const predicted = pred.currentStation as CurrentStation
    const dest = TRANSIT_DESTINATIONS[predicted]
    if (state.currentStation === predicted || state.currentStation === dest) {
      // Drop the `currentStation` override but keep `stationStartTime`:
      // the server's authoritative timestamp is always later than the
      // predicted one by click-to-server latency, so switching to it now
      // would shrink elapsed-since-start and rewind the conveyor visual.
      pred.currentStation = undefined
    }
  }
  if (pred.disposing !== undefined && state.disposing === pred.disposing) {
    pred.disposing = undefined
  }
  // Shift confirmed toppings off the front of the pending queue. The
  // server adds one topping per CmdAddTopping, so each unit of growth in
  // state.toppings.length corresponds to exactly one popped prediction.
  if (pred.pendingToppings && pred.pendingToppings.length > 0) {
    const prevLength = pred.lastObservedToppingsLength ?? state.toppings.length
    const delta = state.toppings.length - prevLength
    if (delta > 0) {
      pred.pendingToppings = pred.pendingToppings.slice(delta)
      pred.lastObservedToppingsLength = state.toppings.length
    }
    if (pred.pendingToppings.length === 0) {
      pred.pendingToppings = undefined
      pred.lastObservedToppingsLength = undefined
    }
  }
  // Once the server has progressed past the predicted transit (e.g. the
  // pizza reached its static destination), the predicted stationStartTime
  // is no longer needed — clear it so a future prediction starts clean.
  if (
    pred.stationStartTime !== undefined &&
    pred.currentStation === undefined &&
    !TRANSIT_STATIONS.has(state.currentStation as CurrentStation)
  ) {
    pred.stationStartTime = undefined
  }
  if (
    pred.doughClicks === undefined &&
    pred.step === undefined &&
    pred.currentStation === undefined &&
    pred.pendingToppings === undefined &&
    pred.stationStartTime === undefined &&
    pred.disposing === undefined
  ) {
    predictions.delete(state.syncId)
  }
}

function setPrediction(syncId: number, partial: Omit<Prediction, 'createdAt'>) {
  const existing = predictions.get(syncId)
  predictions.set(syncId, { ...existing, ...partial, createdAt: Date.now() })
}

function predictAction(pizza: Entity, cmd: ClickAction['cmd']) {
  const state = PizzaState.getOrNull(pizza)
  if (!state) return
  const eff = effectiveStateFor(state)
  switch (cmd) {
    case 'CmdKnead':
      if (eff.currentStation !== CurrentStation.Masa || eff.step !== PizzaStep.RawDough) return
      {
        const nextClicks = eff.doughClicks + 1
        const next: Omit<Prediction, 'createdAt'> = { doughClicks: nextClicks }
        if (nextClicks >= MASA_CLICKS_REQUIRED) next.step = PizzaStep.FlatDough
        setPrediction(state.syncId, next)
      }
      return
    case 'CmdSendToToppings':
      if (eff.currentStation !== CurrentStation.Masa || eff.step !== PizzaStep.FlatDough) return
      setPrediction(state.syncId, {
        currentStation: CurrentStation.MasaToToppings,
        stationStartTime: Date.now()
      })
      return
    case 'CmdSendToHorno':
      if (eff.currentStation !== CurrentStation.Toppings || eff.step !== PizzaStep.Topped) return
      setPrediction(state.syncId, {
        currentStation: CurrentStation.ToppingsToHorno,
        stationStartTime: Date.now()
      })
      return
    case 'CmdInsertHorno':
      if (eff.currentStation !== CurrentStation.HornoFront || eff.step !== PizzaStep.Topped) return
      setPrediction(state.syncId, {
        currentStation: CurrentStation.HornoFrontToHorno,
        stationStartTime: Date.now()
      })
      return
    case 'CmdSendToDelivery':
      if (eff.currentStation !== CurrentStation.Horno || eff.step !== PizzaStep.Perfect) return
      setPrediction(state.syncId, {
        currentStation: CurrentStation.HornoToDelivery,
        stationStartTime: Date.now()
      })
      return
    case 'CmdAttemptServe':
      // Outcome depends on the live order list; we can't predict locally.
      return
  }
}

export function predictAddTopping(type: Topping): number | null {
  for (const [entity, state] of engine.getEntitiesWith(PizzaState)) {
    void entity
    const eff = effectiveStateFor(state)
    if (eff.currentStation !== CurrentStation.Toppings) continue
    if (eff.step !== PizzaStep.FlatDough && eff.step !== PizzaStep.Topped) continue
    if (eff.disposing !== DisposingState.None) continue
    const pred = predictions.get(state.syncId)
    const pendingToppings = [...(pred?.pendingToppings ?? []), type]
    setPrediction(state.syncId, {
      pendingToppings,
      // Anchor to the server-side length we know at the moment we queue
      // this click. The reconciler uses (state.toppings.length - this
      // baseline) to figure out how many of the pending entries have
      // since been confirmed and pop them off the front.
      lastObservedToppingsLength:
        pred?.lastObservedToppingsLength ?? state.toppings.length,
      step: eff.step === PizzaStep.FlatDough ? PizzaStep.Topped : undefined
    })
    return state.syncId
  }
  return null
}

export function rollbackPrediction(pizzaSyncId: number) {
  predictions.delete(pizzaSyncId)
}

// pizzaVisual.ts uses this to decide whether a not-yet-confirmed
// disposing flag is the result of a local prediction (animation should
// keep running) or a stale entry from a rolled-back prediction
// (animation should abort).
export function hasPendingDisposingPrediction(pizzaSyncId: number): boolean {
  return predictions.get(pizzaSyncId)?.disposing !== undefined
}

// Each "send to next station" action has a fixed destination. The client
// pre-checks whether that destination is currently full — if it is, we
// don't even send the Cmd (and surface "Toppings busy!" / "Oven busy!"
// / "Delivery busy!" locally). Otherwise the predicted Tween would run
// the pizza all the way over there before the server's EvtActionRejected
// rolls it back, which is a jarring snap.
const DELIVERY_SLOT_CAPACITY = 4
const DESTINATION_BUSY_LABEL: Partial<Record<ClickAction['cmd'], string>> = {
  CmdSendToToppings: 'Toppings busy!',
  CmdSendToHorno: 'Oven busy!',
  CmdInsertHorno: 'Oven busy!',
  CmdSendToDelivery: 'Delivery busy!'
}

function destinationOccupied(cmd: ClickAction['cmd'], senderSyncId: number): boolean {
  let countDelivery = 0
  let toppingsOccupied = false
  let hornoOccupied = false
  let hornoInsideOccupied = false
  for (const [entity, state] of engine.getEntitiesWith(PizzaState)) {
    void entity
    if (state.syncId === senderSyncId) continue
    const eff = effectiveStateFor(state)
    if (eff.disposing !== DisposingState.None) continue
    const st = eff.currentStation
    if (st === CurrentStation.Toppings) toppingsOccupied = true
    if (
      st === CurrentStation.HornoFront ||
      st === CurrentStation.Horno ||
      st === CurrentStation.HornoFrontToHorno
    ) {
      hornoOccupied = true
    }
    if (st === CurrentStation.Horno) hornoInsideOccupied = true
    if (st === CurrentStation.Delivery || st === CurrentStation.HornoToDelivery) {
      countDelivery += 1
    }
  }
  switch (cmd) {
    case 'CmdSendToToppings':
      return toppingsOccupied
    case 'CmdSendToHorno':
      return hornoOccupied
    case 'CmdInsertHorno':
      return hornoInsideOccupied
    case 'CmdSendToDelivery':
      console.log(`[CLIENT] CmdSendToDelivery check: countDelivery=${countDelivery} capacity=${DELIVERY_SLOT_CAPACITY}`)
      return countDelivery >= DELIVERY_SLOT_CAPACITY
    default:
      return false
  }
}

function dispatchClick(pizza: Entity) {
  const state = PizzaState.getOrNull(pizza)
  if (!state) return
  const eff = effectiveStateFor(state)
  if (eff.disposing !== DisposingState.None) return
  const action = clickActionFor(eff.step, eff.currentStation)
  if (!action) return
  // Refuse if the destination station is already taken — avoids the
  // visual snap-back that would happen when the server's
  // EvtActionRejected lands a frame or two later.
  if (destinationOccupied(action.cmd, state.syncId)) {
    const label = DESTINATION_BUSY_LABEL[action.cmd]
    if (label) showFloatingText(pizza, label, 1.2, 1.0, FEEDBACK_COLOR_PENALTY)
    return
  }
  predictAction(pizza, action.cmd)
  // Serve is special: the outcome depends on the live order list. We
  // only predict the optimistic animation when the local synced order
  // slots already show a matching ticket — otherwise the user would
  // see the pizza fly away and bounce back when EvtActionRejected /
  // EvtServeResult ok=false rolled the prediction back. If the local
  // check disagrees with the server (rare race), the rollback path
  // still catches it.
  if (action.cmd === 'CmdAttemptServe' && findMatchingOrder(eff.toppings)) {
    setPrediction(state.syncId, { disposing: DisposingState.Serve })
  }
  room.send(action.cmd, { pizzaSyncId: state.syncId })
}

function dispatchSecondary(pizza: Entity) {
  const state = PizzaState.getOrNull(pizza)
  if (!state) return
  if (state.disposing !== DisposingState.None) return
  if (state.currentStation === CurrentStation.Masa) return
  // Predict the disposing flag so the puff animation kicks off on the
  // exact frame F was pressed instead of waiting for the server.
  setPrediction(state.syncId, { disposing: DisposingState.Discard })
  room.send('CmdDiscard', { pizzaSyncId: state.syncId })
}

function wireClickHandler(pizza: Entity, step: PizzaStep, station: CurrentStation) {
  const action = clickActionFor(step, station)
  const allowDiscard = station !== CurrentStation.Masa
  const secondary = allowDiscard
    ? { hoverText: 'Throw away', callback: () => dispatchSecondary(pizza) }
    : undefined
  onInteract(
    pizza,
    { hoverText: action?.hover, maxDistance: 6, secondary },
    action ? () => dispatchClick(pizza) : undefined
  )
}

// The reconciler runs on every client every frame. Reading PizzaState and
// writing Transform locally yields a deterministic, 60 Hz, jitter-free
// rendering — all clients compute the same Transform from the same state.
function pizzaVisualReconcileSystem(_dt: number) {
  if (isServer()) return

  const live = new Set<Entity>()
  const now = Date.now()
  for (const [entity, state] of engine.getEntitiesWith(PizzaState)) {
    live.add(entity)
    reconcilePrediction(state)
    const eff = effectiveStateFor(state)
    const prev = observed.get(entity)

    if (!prev) {
      // First sight: full visual setup + spawn pop animation.
      meshForStep(entity, eff.step)
      Transform.createOrReplace(entity, {
        position: positionForState(eff.currentStation, eff.stationStartTime, state.deliverySlotIdx),
        scale: Vector3.create(0.001, 0.001, 0.001),
        rotation: Quaternion.Identity()
      })
      spawnAnims.push({
        pizza: entity,
        startTime: now,
        targetScale: scaleForStep(eff.step, eff.doughClicks)
      })
      wireClickHandler(entity, eff.step, eff.currentStation)
    } else {
      if (prev.step !== eff.step) {
        meshForStep(entity, eff.step)
      }
      if (
        prev.step !== eff.step ||
        prev.station !== eff.currentStation ||
        prev.disposing !== eff.disposing
      ) {
        wireClickHandler(entity, eff.step, eff.currentStation)
      }
      // Just-flipped disposing flag → queue the matching local animation
      // so the client renders the puff / flying-arc against its locally
      // computed Transform. The server removes the entity at its own
      // animation end; CRDT propagates the removal so we don't double-up.
      if (prev.disposing === DisposingState.None && eff.disposing !== DisposingState.None) {
        if (eff.disposing === DisposingState.Discard) discardPizzaWithAnimation(entity)
        else if (eff.disposing === DisposingState.Serve) serveAnimationOnPizza(entity)
      }
    }
    observed.set(entity, {
      step: eff.step,
      station: eff.currentStation,
      disposing: eff.disposing,
      syncId: state.syncId
    })

    // Toppings: reconcile local visual cubes to match the effective array
    // length — predictions can push the count up; rolling them back
    // (or the server settling on a shorter array) brings it down.
    const expected = eff.toppings.length
    let list = localToppings.get(entity)
    if (!list) {
      list = []
      localToppings.set(entity, list)
    }
    while (list.length < expected) {
      spawnToppingVisual(entity, eff.toppings[list.length], list.length)
    }
    while (list.length > expected) {
      const extra = list.pop()
      if (extra !== undefined) engine.removeEntity(extra)
    }

    // Disposing animations are handled by the discard/serve systems in
    // pizzaVisual.ts — the reconciler stops writing Transform here so
    // those animations own scale + position uninterrupted.
    if (eff.disposing !== DisposingState.None) {
      clearConveyorTweens(entity)
      continue
    }

    // Transit movement is delegated to Tween + TweenSequence so the
    // renderer can interpolate at its own frame rate; while a Tween is
    // active for this pizza we don't overwrite Transform.position from
    // here (it would fight the renderer's interpolation).
    const tweening = maybeSetupConveyorTween(entity, eff)

    if (spawnAnims.some((a) => a.pizza === entity)) {
      // Spawn pop owns Transform.scale; position is owned by either
      // Tween (transit) or the reconciler below (static stations).
      if (!tweening) {
        const transform = Transform.getMutableOrNull(entity)
        if (transform) {
          transform.position = positionForState(
            eff.currentStation,
            eff.stationStartTime,
            state.deliverySlotIdx
          )
        }
      }
      continue
    }

    const transform = Transform.getMutableOrNull(entity)
    if (!transform) continue
    if (!tweening) {
      transform.position = positionForState(
        eff.currentStation,
        eff.stationStartTime,
        state.deliverySlotIdx
      )
    }
    transform.scale = scaleForStep(eff.step, eff.doughClicks)
  }

  // Cleanup observed + topping children for entities that disappeared.
  for (const e of Array.from(observed.keys())) {
    if (!live.has(e)) observed.delete(e)
  }
  for (const e of Array.from(localToppings.keys())) {
    if (!live.has(e)) {
      const list = localToppings.get(e)!
      for (const t of list) engine.removeEntity(t)
      localToppings.delete(e)
    }
  }
  for (const e of Array.from(conveyorSetup.keys())) {
    if (!live.has(e)) conveyorSetup.delete(e)
  }
}

// Spawn pop runs on each client locally and writes Transform.scale every
// frame for 400 ms. After completion the reconciler takes over and
// writes scale from the authoritative state.
function spawnPopAnimationSystem(_dt: number) {
  if (spawnAnims.length === 0) return
  const now = Date.now()
  for (let i = spawnAnims.length - 1; i >= 0; i--) {
    const a = spawnAnims[i]
    const transform = Transform.getMutableOrNull(a.pizza)
    if (!transform) {
      spawnAnims.splice(i, 1)
      continue
    }
    const elapsed = now - a.startTime
    if (elapsed >= SPAWN_ANIM_MS) {
      transform.scale = Vector3.create(a.targetScale.x, a.targetScale.y, a.targetScale.z)
      spawnAnims.splice(i, 1)
      continue
    }
    const t = elapsed / SPAWN_ANIM_MS
    const tm1 = t - 1
    const factor = 1 + EASE_OUT_BACK_C3 * tm1 * tm1 * tm1 + EASE_OUT_BACK_C1 * tm1 * tm1
    transform.scale = Vector3.create(
      a.targetScale.x * factor,
      a.targetScale.y * factor,
      a.targetScale.z * factor
    )
  }
}

engine.addSystem(pizzaVisualReconcileSystem)
engine.addSystem(spawnPopAnimationSystem)

// Keep MASA_CLICKS_REQUIRED imported so the value stays alive if we ever
// add a UI hint that surfaces the click count.
void MASA_CLICKS_REQUIRED
