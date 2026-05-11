import { Topping } from '../pizza/pizzaTypes'

export enum PizzaRecipeId {
  Margherita = 'Margherita',
  Diavola = 'Diavola',
  Funghi = 'Funghi',
  QuattroStagioni = 'QuattroStagioni'
}

export type PizzaRecipe = {
  id: PizzaRecipeId
  displayName: string
  toppings: Topping[]
}

// The 4 menu pizzas. `toppings` is a MULTISET — repeated entries mean the
// player has to place that many of the ingredient on the pizza. Match is done
// against the exact multiset (same kinds AND same counts).
export const RECIPES: PizzaRecipe[] = [
  {
    id: PizzaRecipeId.Margherita,
    displayName: 'Margherita',
    toppings: [Topping.Tomato, Topping.Mozzarella, Topping.Mozzarella]
  },
  {
    id: PizzaRecipeId.Diavola,
    displayName: 'Diavola',
    toppings: [Topping.Tomato, Topping.Mozzarella, Topping.Salami, Topping.Salami]
  },
  {
    id: PizzaRecipeId.Funghi,
    displayName: 'Funghi',
    toppings: [Topping.Tomato, Topping.Mozzarella, Topping.Mushroom, Topping.Mushroom]
  },
  {
    id: PizzaRecipeId.QuattroStagioni,
    displayName: 'Quattro Stagioni',
    toppings: [Topping.Tomato, Topping.Mozzarella, Topping.Salami, Topping.Mushroom]
  }
]

export type Order = {
  id: number
  recipe: PizzaRecipe
  createdAt: number // Date.now() ms
  expiresAt: number // Date.now() ms
  // When set, the order has timed out and is briefly shown in "Expired"
  // visual state before the slot opens up again.
  expiredSince?: number
}

// How long a timed-out ticket lingers as a red "Time's up!" card before the
// slot is freed for a new order.
export const EXPIRED_DISPLAY_MS = 1500

// Tuning. Sized so a single player can keep up: a Margherita cycle takes
// ~14 s end-to-end, a Quattro Stagioni ~20 s, so a 45 s lifetime leaves
// real margin for juggling 2-3 tickets at once. Hito 4 (multiplayer) will
// re-tighten these.
export const MAX_ACTIVE_ORDERS = 3
export const TICKET_LIFETIME_MS = 45_000
export const INITIAL_GENERATION_INTERVAL_MS = 22_000
export const FINAL_GENERATION_INTERVAL_MS = 10_000
export const GENERATION_RAMP_DURATION_MS = 4 * 60 * 1000
