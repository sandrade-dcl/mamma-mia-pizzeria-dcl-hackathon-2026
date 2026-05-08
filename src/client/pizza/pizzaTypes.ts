import { Schemas, engine } from '@dcl/sdk/ecs'

export enum PizzaStep {
  RawDough = 0,
  FlatDough = 1,
  Topped = 2,
  Baking = 3,
  Perfect = 4,
  Burnt = 5
}

export enum Topping {
  Tomato = 0,
  Mozzarella = 1,
  Salami = 2,
  Mushroom = 3
}

// Custom ECS component attached to every active pizza entity. Step + topping
// list + bake timer is everything the gameplay needs. Hito 4 will sync this.
export const PizzaState = engine.defineComponent('mammamia::PizzaState', {
  step: Schemas.Int,
  toppings: Schemas.Array(Schemas.Int),
  bakeStartTime: Schemas.Float,
  doughClicks: Schemas.Int
})

export const MASA_CLICKS_REQUIRED = 3
export const BAKE_TIME_PERFECT = 5
export const BAKE_TIME_BURNT = 9
