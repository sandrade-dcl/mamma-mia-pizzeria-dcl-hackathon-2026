import { ColliderLayer, Entity, Material, MeshCollider, MeshRenderer, Transform, engine } from '@dcl/sdk/ecs'
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
