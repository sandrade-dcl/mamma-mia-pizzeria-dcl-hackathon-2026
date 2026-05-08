import {
  ColliderLayer,
  Entity,
  Material,
  MeshCollider,
  MeshRenderer,
  Transform,
  Tween,
  engine
} from '@dcl/sdk/ecs'
import { Color4, Quaternion, Vector3 } from '@dcl/sdk/math'
import { PizzaState, PizzaStep, Topping } from './pizzaTypes'

const STEP_COLORS: Record<PizzaStep, Color4> = {
  [PizzaStep.RawDough]: Color4.create(0.95, 0.92, 0.85, 1),
  [PizzaStep.FlatDough]: Color4.create(1.0, 0.92, 0.65, 1),
  [PizzaStep.Topped]: Color4.create(1.0, 0.80, 0.20, 1),
  [PizzaStep.Baking]: Color4.create(1.0, 0.60, 0.15, 1),
  [PizzaStep.Perfect]: Color4.create(0.85, 0.55, 0.10, 1),
  [PizzaStep.Burnt]: Color4.create(0.15, 0.08, 0.05, 1)
}

const TOPPING_COLORS: Record<Topping, Color4> = {
  [Topping.Tomato]: Color4.create(0.85, 0.15, 0.10, 1),
  [Topping.Mozzarella]: Color4.create(0.95, 0.92, 0.85, 1),
  [Topping.Salami]: Color4.create(0.55, 0.10, 0.10, 1),
  [Topping.Mushroom]: Color4.create(0.65, 0.55, 0.45, 1)
}

export function spawnPizza(position: Vector3, step: PizzaStep): Entity {
  const pizza = engine.addEntity()
  Transform.create(pizza, {
    position,
    // Raw dough starts as a small ball; later steps are flat discs.
    scale: step === PizzaStep.RawDough ? Vector3.create(0.7, 0.7, 0.7) : Vector3.create(1, 0.075, 1),
    rotation: Quaternion.Identity()
  })

  if (step === PizzaStep.RawDough) {
    MeshRenderer.setSphere(pizza)
    MeshCollider.setSphere(pizza, ColliderLayer.CL_POINTER)
  } else {
    MeshRenderer.setCylinder(pizza, 0.5, 0.5)
    MeshCollider.setCylinder(pizza, 0.5, 0.5, ColliderLayer.CL_POINTER)
  }
  Material.setPbrMaterial(pizza, { albedoColor: STEP_COLORS[step] })
  PizzaState.create(pizza, { step, toppings: [], bakeStartTime: 0, doughClicks: 0 })
  return pizza
}

export function updatePizzaStep(pizza: Entity, step: PizzaStep): void {
  PizzaState.getMutable(pizza).step = step
  Material.setPbrMaterial(pizza, { albedoColor: STEP_COLORS[step] })
}

// Visual progression for the dough as the player presses E.
//   clicks=1 → ball squashes a bit
//   clicks=2 → squashes more
//   clicks=3 → snaps to flat cylinder + yellow color (FlatDough)
export function applyDoughClickVisual(pizza: Entity, clicks: number): void {
  const transform = Transform.getMutable(pizza)
  if (clicks === 1) {
    transform.scale = Vector3.create(0.85, 0.5, 0.85)
  } else if (clicks === 2) {
    transform.scale = Vector3.create(1.0, 0.3, 1.0)
  } else if (clicks >= 3) {
    transform.scale = Vector3.create(1, 0.075, 1)
    MeshRenderer.setCylinder(pizza, 0.5, 0.5)
    MeshCollider.setCylinder(pizza, 0.5, 0.5, ColliderLayer.CL_POINTER)
    updatePizzaStep(pizza, PizzaStep.FlatDough)
  }
}

export function spawnTopping(pizza: Entity, type: Topping, slotIndex: number): Entity {
  const topping = engine.addEntity()
  // Vogel sunflower distribution: radius grows with sqrt(n) and angle steps by
  // the golden angle (137.5°). The first topping lands in the centre and each
  // new one fills the most-empty spot, covering the whole disc uniformly.
  // Pizza radius (local) is 0.5 and topping radius is 0.06, so 0.40 is the
  // largest safe centre radius. Beyond that we cap at 0.40 — extra toppings
  // pile up near the edge but never spill outside the pizza.
  const angle = slotIndex * 2.39996
  const radius = Math.min(Math.sqrt(slotIndex) * 0.1, 0.4)
  const localX = Math.cos(angle) * radius
  const localZ = Math.sin(angle) * radius

  Transform.create(topping, {
    // Pizza top face sits at local Y = 0.5. With local scale (0.12, 0.3, 0.12)
    // the topping is half-height 0.15, so local Y = 0.65 puts its bottom flush
    // on the pizza surface after the parent's scale is applied.
    position: Vector3.create(localX, 0.65, localZ),
    scale: Vector3.create(0.12, 0.3, 0.12),
    rotation: Quaternion.Identity(),
    parent: pizza
  })

  // All toppings are thin cylindrical slices; only the colour varies.
  MeshRenderer.setCylinder(topping, 0.5, 0.5)
  Material.setPbrMaterial(topping, { albedoColor: TOPPING_COLORS[type] })
  return topping
}

export function despawnPizza(pizza: Entity): void {
  // Children (toppings) are removed automatically when the parent is removed.
  engine.removeEntityWithChildren(pizza)
}

// ---------------------------------------------------------------------------
// Discard animation
// ---------------------------------------------------------------------------
// Plays a quick "puff up then shrink to nothing" scale animation on the pizza
// while it also pops up and falls back to its original Y. Both animations run
// in parallel and finish at the same instant, after which the entity is
// removed. The Tween component can only host one channel per entity, so the
// scale and the jump are computed manually each frame in this system.
//
// The pizza is logically gone the moment this is called — game state stops
// tracking it; only the visual lingers for ~400 ms while the animation plays.

const PUFF_UP_RATIO = 0.375 // 150 ms of the 400 ms total spent puffing up
const TOTAL_MS = 400
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

  // Drop any in-flight tween (e.g. conveyor) so it doesn't fight our manual
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
    const elapsed = now - p.startTime

    if (elapsed >= TOTAL_MS) {
      engine.removeEntityWithChildren(p.pizza)
      pendingDiscards.splice(i, 1)
      continue
    }

    const transform = Transform.getMutableOrNull(p.pizza)
    if (!transform) {
      pendingDiscards.splice(i, 1)
      continue
    }

    const t = elapsed / TOTAL_MS

    // Scale curve: puff up to PUFF_FACTOR (ease-out), then collapse to 0
    // (ease-in). Ends exactly at t=1.
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

    // Jump: a half-sine peak that returns to the original Y at t=1.
    const jumpProgress = Math.sin(t * Math.PI)
    transform.position = Vector3.create(
      p.originalPosition.x,
      p.originalPosition.y + JUMP_HEIGHT_M * jumpProgress,
      p.originalPosition.z
    )
  }
}

engine.addSystem(discardAnimationSystem)
