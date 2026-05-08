import { EasingFunction, Entity, Tween, engine } from '@dcl/sdk/ecs'
import { Vector3 } from '@dcl/sdk/math'
import { EntityNames } from '../../assets/scene/entity-names'
import { getSlotPosition } from './slots'

// Pizza speed along the conveyor in metres per second. Each segment's tween
// duration is computed from this so pizzas glide at a consistent pace whether
// the next waypoint is 1 m or 10 m away.
export const CONVEYOR_SPEED_M_S = 5

type Handoff = { finishAt: number; callback: () => void }
const pending: Handoff[] = []

// Slide a pizza along a sequence of slots — useful for routing through the
// conveyor's waypoints. Each segment's duration scales with its length so
// velocity stays constant across the whole path. Calls `finalCallback` once
// the last segment finishes.
export function sendPizzaAlongPath(pizza: Entity, slots: EntityNames[], finalCallback: () => void) {
  const numSegments = slots.length - 1
  if (numSegments < 1) {
    finalCallback()
    return
  }
  runSegment(pizza, slots, 0, finalCallback)
}

function runSegment(pizza: Entity, slots: EntityNames[], index: number, finalCallback: () => void) {
  if (index >= slots.length - 1) {
    finalCallback()
    return
  }
  const startPos = getSlotPosition(slots[index])
  const endPos = getSlotPosition(slots[index + 1])
  const distance = Vector3.distance(startPos, endPos)
  const segmentMs = (distance / CONVEYOR_SPEED_M_S) * 1000

  Tween.createOrReplace(pizza, {
    mode: Tween.Mode.Move({
      start: Vector3.create(startPos.x, startPos.y, startPos.z),
      end: Vector3.create(endPos.x, endPos.y, endPos.z)
    }),
    duration: segmentMs,
    // Linear so the pizza glides at constant speed across the whole belt;
    // ease-in-out per segment would cause visible deceleration at every
    // waypoint.
    easingFunction: EasingFunction.EF_LINEAR
  })
  pending.push({
    finishAt: Date.now() + segmentMs,
    callback: () => runSegment(pizza, slots, index + 1, finalCallback)
  })
}

function conveyorHandoffSystem(_dt: number) {
  if (pending.length === 0) return
  const now = Date.now()
  for (let i = pending.length - 1; i >= 0; i--) {
    if (pending[i].finishAt <= now) {
      pending[i].callback()
      pending.splice(i, 1)
    }
  }
}

engine.addSystem(conveyorHandoffSystem)
