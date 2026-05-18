import { Entity, Transform, Tween, engine } from '@dcl/sdk/ecs'
import { Vector3 } from '@dcl/sdk/math'
import { isServer } from '@dcl/sdk/network'
import { DisposingState } from '../../shared/syncedState'
import { hasPendingDisposingPrediction } from './pizzaSync'
import { PizzaState } from './pizzaTypes'

// ---------------------------------------------------------------------------
// Pizza animations — Hito 4 Option A.
//
// Server-driven. The authoritative kitchen.ts calls these helpers; the
// matching animation systems run on the server too (module-level
// engine.addSystem) and mutate the synced Transform every frame, so
// clients see the animation through CRDT Transform updates.
//
// Animation lifecycle owns the entity removal at the end of each clip,
// keeping the despawn aligned with the visual.
// ---------------------------------------------------------------------------

// Discard puff = scale grows then collapses to zero, with a sin-arc jump
// in Y. ~400 ms total, ends with engine.removeEntityWithChildren.
const PUFF_UP_RATIO = 0.375
const DISCARD_TOTAL_MS = 400
const PUFF_FACTOR = 1.4
const JUMP_HEIGHT_M = 0.6

type DiscardPending = {
  pizza: Entity
  startTime: number
  originalScale: { x: number; y: number; z: number }
  originalPosition: { x: number; y: number; z: number }
}

const pendingDiscards: DiscardPending[] = []

export function discardPizzaWithAnimation(pizza: Entity): void {
  const transform = Transform.getOrNull(pizza)
  if (!transform) {
    engine.removeEntityWithChildren(pizza)
    return
  }
  // Drop any in-flight tween (conveyor) so it doesn't fight our manual
  // per-frame updates to position and scale.
  Tween.deleteFrom(pizza)
  pendingDiscards.push({
    pizza,
    startTime: Date.now(),
    originalScale: {
      x: transform.scale.x,
      y: transform.scale.y,
      z: transform.scale.z
    },
    originalPosition: {
      x: transform.position.x,
      y: transform.position.y,
      z: transform.position.z
    }
  })
}

function discardAnimationSystem(_dt: number) {
  if (pendingDiscards.length === 0) return
  const now = Date.now()
  for (let i = pendingDiscards.length - 1; i >= 0; i--) {
    const p = pendingDiscards[i]
    // Abort only when the authoritative state says "no disposing" AND
    // the optimistic prediction has been rolled back (or never existed).
    // Otherwise we'd bail in the first frame after F was pressed,
    // because the server hasn't acknowledged yet and state.disposing
    // is still None even though pred.disposing is Discard.
    if (!isServer()) {
      const state = PizzaState.getOrNull(p.pizza)
      if (
        state &&
        state.disposing === DisposingState.None &&
        !hasPendingDisposingPrediction(state.syncId)
      ) {
        pendingDiscards.splice(i, 1)
        continue
      }
    }
    const elapsed = now - p.startTime
    if (elapsed >= DISCARD_TOTAL_MS) {
      // Only the authoritative server removes the entity; the client
      // would race with the server's removeEntity and re-instate via
      // CRDT, causing a flicker.
      if (isServer()) {
        engine.removeEntityWithChildren(p.pizza)
      }
      pendingDiscards.splice(i, 1)
      continue
    }
    const transform = Transform.getMutableOrNull(p.pizza)
    if (!transform) {
      pendingDiscards.splice(i, 1)
      continue
    }
    const t = elapsed / DISCARD_TOTAL_MS
    let scaleFactor: number
    if (t < PUFF_UP_RATIO) {
      const tNorm = t / PUFF_UP_RATIO
      const eased = 1 - (1 - tNorm) * (1 - tNorm)
      scaleFactor = 1 + (PUFF_FACTOR - 1) * eased
    } else {
      const tNorm = (t - PUFF_UP_RATIO) / (1 - PUFF_UP_RATIO)
      const eased = tNorm * tNorm
      scaleFactor = PUFF_FACTOR * (1 - eased)
    }
    transform.scale = Vector3.create(
      p.originalScale.x * scaleFactor,
      p.originalScale.y * scaleFactor,
      p.originalScale.z * scaleFactor
    )
    const jumpProgress = Math.sin(t * Math.PI)
    transform.position = Vector3.create(
      p.originalPosition.x,
      p.originalPosition.y + JUMP_HEIGHT_M * jumpProgress,
      p.originalPosition.z
    )
  }
}

engine.addSystem(discardAnimationSystem)

// Serve = parabolic arc southwards while shrinking; "flies to the
// customer". 800 ms, removes entity at the end.
const SERVE_DURATION_MS = 800
const SERVE_DX = 0
const SERVE_DZ = -10
const SERVE_ARC_PEAK_M = 1.5

type ServePending = {
  pizza: Entity
  startTime: number
  originalScale: { x: number; y: number; z: number }
  startPosition: { x: number; y: number; z: number }
}

const pendingServes: ServePending[] = []

export function serveAnimationOnPizza(pizza: Entity): void {
  const transform = Transform.getOrNull(pizza)
  if (!transform) {
    engine.removeEntityWithChildren(pizza)
    return
  }
  Tween.deleteFrom(pizza)
  pendingServes.push({
    pizza,
    startTime: Date.now(),
    originalScale: {
      x: transform.scale.x,
      y: transform.scale.y,
      z: transform.scale.z
    },
    startPosition: {
      x: transform.position.x,
      y: transform.position.y,
      z: transform.position.z
    }
  })
}

function serveAnimationSystem(_dt: number) {
  if (pendingServes.length === 0) return
  const now = Date.now()
  for (let i = pendingServes.length - 1; i >= 0; i--) {
    const p = pendingServes[i]
    // Cancel only after the optimistic prediction has been rolled back
    // (EvtServeResult ok=false → rollbackPrediction). While the
    // prediction is still standing, state.disposing will be None until
    // the server acknowledges — we must not bail on it.
    if (!isServer()) {
      const state = PizzaState.getOrNull(p.pizza)
      if (
        state &&
        state.disposing === DisposingState.None &&
        !hasPendingDisposingPrediction(state.syncId)
      ) {
        pendingServes.splice(i, 1)
        continue
      }
    }
    const elapsed = now - p.startTime
    if (elapsed >= SERVE_DURATION_MS) {
      if (isServer()) {
        engine.removeEntityWithChildren(p.pizza)
      }
      pendingServes.splice(i, 1)
      continue
    }
    const transform = Transform.getMutableOrNull(p.pizza)
    if (!transform) {
      pendingServes.splice(i, 1)
      continue
    }
    const t = elapsed / SERVE_DURATION_MS
    transform.position = Vector3.create(
      p.startPosition.x + SERVE_DX * t,
      p.startPosition.y + Math.sin(t * Math.PI) * SERVE_ARC_PEAK_M,
      p.startPosition.z + SERVE_DZ * t
    )
    const scaleFactor = 1 - t * t
    transform.scale = Vector3.create(
      p.originalScale.x * scaleFactor,
      p.originalScale.y * scaleFactor,
      p.originalScale.z * scaleFactor
    )
  }
}

engine.addSystem(serveAnimationSystem)

// Spawn pop = ease-out-back from ~zero to target. Called by the kitchen
// right after creating a fresh masa pizza. Reads current scale as the
// target and snaps to 0.001 so the system can grow it back.
const SPAWN_DURATION_MS = 400
const EASE_OUT_BACK_C1 = 1.70158
const EASE_OUT_BACK_C3 = EASE_OUT_BACK_C1 + 1

type SpawnPending = {
  pizza: Entity
  startTime: number
  targetScale: { x: number; y: number; z: number }
}

const pendingSpawns: SpawnPending[] = []

export function playSpawnAnimation(pizza: Entity): void {
  const transform = Transform.getMutableOrNull(pizza)
  if (!transform) return
  const targetScale = {
    x: transform.scale.x,
    y: transform.scale.y,
    z: transform.scale.z
  }
  transform.scale = Vector3.create(0.001, 0.001, 0.001)
  pendingSpawns.push({ pizza, startTime: Date.now(), targetScale })
}

function spawnAnimationSystem(_dt: number) {
  if (pendingSpawns.length === 0) return
  const now = Date.now()
  for (let i = pendingSpawns.length - 1; i >= 0; i--) {
    const p = pendingSpawns[i]
    const elapsed = now - p.startTime
    const transform = Transform.getMutableOrNull(p.pizza)
    if (!transform) {
      pendingSpawns.splice(i, 1)
      continue
    }
    if (elapsed >= SPAWN_DURATION_MS) {
      transform.scale = Vector3.create(p.targetScale.x, p.targetScale.y, p.targetScale.z)
      pendingSpawns.splice(i, 1)
      continue
    }
    const t = elapsed / SPAWN_DURATION_MS
    const tm1 = t - 1
    const factor = 1 + EASE_OUT_BACK_C3 * tm1 * tm1 * tm1 + EASE_OUT_BACK_C1 * tm1 * tm1
    transform.scale = Vector3.create(
      p.targetScale.x * factor,
      p.targetScale.y * factor,
      p.targetScale.z * factor
    )
  }
}

engine.addSystem(spawnAnimationSystem)
