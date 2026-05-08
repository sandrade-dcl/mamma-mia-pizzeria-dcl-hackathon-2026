# Mamma Mia's Pizzeria — Game Design Document

> Italian pizza-making cooperative game for the Decentraland Hackathon 2026.
> Theme: **Italy** (cuisine angle). Style: **Cartoon**. Parcel: **2x2 (32×32m)**.
> Time budget: ~20 hours over ~1 week.

---

## 1. Concept

A short-session cooperative cooking game (4-minute shifts) inspired by Overcooked, set in a cartoon Italian pizzeria. **1-4 players** work together to fulfill pizza orders against the clock. Difficulty scales with the number of connected players. Score is a team effort but persists individually on a global leaderboard.

There is **no Game Over** — the score can go negative; the round ends only by the timer.

## 2. Core gameplay loop

1. Tickets appear on the order board (max 3 simultaneous, time bar each).
2. Players move freely between the 3 stations (no fixed roles).
3. Pizzas progress through the pipeline: **Masa → Toppings → Horno → Counter_Delivery**.
4. A conveyor belt visually moves pizzas between stations (`Tween`).
5. When a pizza is finished, click on the matching ticket at the delivery counter to score.
6. Errors (burnt pizza, wrong ingredients, expired ticket) deduct points; a trash bin discards mistakes.
7. Order pace accelerates with time (every 20s → every 8s).
8. At the end of the shift, the team score is recorded and pushed to the leaderboard.

### Stations (one slot each — pipeline-style)

| Station | Action | Implementation hint |
|---|---|---|
| **1. Masa** | Click x3 to flatten dough | `pointerEventsSystem` + scale animation |
| **2. Toppings** | Click ingredient boxes (4 types) — order doesn't matter, must match ticket | `pointerEventsSystem` + child entities |
| **3. Horno** | Click to insert, wait, click to remove before burning | timer + emissive material change (raw → perfect → burnt) |

### Ingredients & Pizzas (only 4 of each)

- **Ingredients**: tomato, mozzarella, salami, mushrooms.
- **Pizzas**: Margherita, Diavola, Funghi, Quattro Formaggi.

### Initial state
Only **Station 1 (Masa)** starts with a raw dough ball. Players at later
stations wait for the pizza to arrive from the previous step. This keeps the
flow direction obvious — pizzas only ever appear from upstream — and avoids
confusion about where each pre-stocked pizza came from.

### Errors & penalties

| Error | Effect | Points |
|---|---|---|
| Burnt pizza | Trash via bin | −50 |
| Wrong ingredients served | At delivery | −100 |
| Ticket expired | Auto-removed | −100 |
| Correctly served pizza | At delivery | +100 + speed bonus |

## 3. Multiplayer

- **Min**: 1 player (single-player viable, slower order pace).
- **Sweet spot**: 2-3 players (one station each).
- **Max**: 4 players (a "runner" handles overflow).
- **Architecture**: **Authoritative Server** via `@dcl/sdk@auth-server`. The server owns: order generation, scoring, validation, leaderboard. Clients render and forward player actions.
- **Leaderboard**: individual records, updated when a team score beats the player's previous best. Top 10 displayed on a wall in the pizzeria.

## 4. Camera

- **Hito 1-4 default**: third-person forced via `CameraModeArea` covering the whole parcel.
- **Stretch goal (if time)**: experimental top-down isometric `VirtualCamera` (B.2 in earlier discussion).

## 5. Visual direction — Cartoon

Pragmatic strategy: build with **primitives + flat PBR materials** for speed and stylistic consistency. Use GLB models only where they add clear value (floor, eventually a proper oven model).

### Color palette

| Color | Hex-ish (RGB 0-1) | Use |
|---|---|---|
| 🍅 Rojo tomate | (0.85, 0.18, 0.18) | Walls, tablecloth accents |
| 🤍 Blanco crema | (0.95, 0.92, 0.85) | Counter, plates |
| 🟫 Marrón madera | (0.55, 0.35, 0.18) | Tables, station benches |
| 🟢 Verde albahaca | (0.20, 0.55, 0.25) | Decorative details, basil |
| 🟡 Amarillo queso | (1.00, 0.80, 0.20) | Pizza base, oven accents |
| 🟠 Naranja horno | (1.00, 0.45, 0.10) emissive | Oven body |

## 6. Parcel layout

2x2 parcels (`["0,0","1,0","0,1","1,1"]`, base `"0,0"`). Coordinate space: 0-32 in X and Z, Y up.

```
Z=32  ┌────────[Wall_Back]─────────┐
      │                            │
      │   E1     E2     E3 (horno) │  ← stations row at z≈26
Z=24  │   ─────[Conveyor]─────     │  ← conveyor at z=24
      │                            │
      │      [Counter_Delivery]    │  ← delivery counter at z=14
      │                            │
Z=1   ├──[Wall_Front_L]──┤  ├──[Wall_Front_R]──┤
                         ↑
                  4 m entrance gap
                  (x=14 → x=18)
      X=0                       X=32
              ↑
        Spawn (14-18, 0, 14-18) — appears just inside the doorway
        cameraTarget (16, 1, 16)
```

## 7. Implementation plan — 5 hitos

| Hito | Description | Hours | Status |
|---|---|---|---|
| **1. Foundation** | Setup, composite, walls, stations placeholder, audio ambient, walkable scene | ~3.5h | ✅ Completed |
| **2. Mechanics core (single-player)** | Station interactions, conveyor tweens, dough/toppings/oven flow, F-key discard | ~5h | ✅ Completed |
| **3. Game loop complete** | Orders, tickets UI, scoring, timer, start/end states. **MVP single-player playable.** | ~3.5h | ⏳ Pending |
| **4. Auth Server + multiplayer** | `isServer()` branching, `registerMessages`, server-authoritative orders/scoring, `Storage` leaderboard | ~6h | ⏳ Pending |
| **5. Polish** | Particles (flour, smoke), SFX, feedback on success/fail, bug fixing | ~2h | ⏳ Pending |

Total ≈ 20h.

## 8. Architecture decisions (locked)

- **SDK**: `@dcl/sdk@auth-server` from day 1 (avoid mid-project migration).
- **Composite-first**: all static entities live in `assets/scene/main.composite`. `src/index.ts` is reserved for behavior, systems, dynamic entities. No `engine.addEntity()` for static stuff.
- **Composite mode**: edit-mode (Creator Hub-aware) — preserve `inspector::*` components and update `inspector::Nodes` whenever entities are added/removed.
- **Entity ID convention**: user entities start at 512. Reserved 0 (root), 1 (player), 2 (camera).
- **Authoring style**: cartoon → primitives + flat PBR materials. GLB models only where they add real value.
- **Logic-to-visual decoupling (CRITICAL)**: game logic NEVER references visible meshes (the cube/cylinder/GLB of a station, counter, etc.). Instead, every "where does the pizza live?" / "where does the ticket float?" / "where does the trash go?" point is materialized as a child **Slot** or **Anchor** entity with a stable name. The logic binds to those slots, so swapping a station's visible model later (cube → GLB pizzeria oven) only requires repositioning the slot — zero code changes.

### Slots/Anchors planned for Hito 2

| Slot / Anchor | Parent | Purpose |
|---|---|---|
| `Slot_Masa` | `Station_Masa` | Where the dough/pizza-in-progress lives during the masa step |
| `Slot_Toppings` | `Station_Toppings` | Where the pizza lives during toppings |
| `Slot_Horno` | `Station_Horno` | Where the pizza lives inside the oven |
| `Slot_Conveyor_1` | `Conveyor` | Tween waypoint between Masa and Toppings |
| `Slot_Conveyor_2` | `Conveyor` | Tween waypoint between Toppings and Horno |
| `Slot_Delivery` | `Counter_Delivery` | Where the finished pizza waits to be served |
| `Anchor_Order_Board` | (root) | World-space point where order tickets float |
| `Anchor_Trash` | `Trash_Bin` | Where pizzas vanish into when discarded |

These are **invisible** entities (just `Transform` + `Name`, no MeshRenderer). They use local positions relative to their parent so a parent swap (cube → GLB) only needs the slot's local Y/Z fine-tuned.

## 9. Current state — Hitos 1 & 2 completed

### Hito 2 — single-player sandbox

The full pizza-making flow is playable end-to-end (no orders/scoring yet):

- **Pizza model**: custom ECS component `PizzaState` tracks `step`, `toppings[]`, `bakeStartTime`, `doughClicks`. Spawned at runtime, lives in world space (`parent: 0`), moves between stations with `Tween`.
- **Masa**: starts with a raw-dough sphere; 3 clicks progressively flatten it (sphere → squashed → flat cylinder, yellow). One more click sends the pizza along the belt and respawns a fresh ball. No discard here.
- **Toppings**: empty at start; receives the flattened dough from masa. 4 ingredient boxes (cubes coloured tomato / mozzarella / salami / mushroom) at the back of the table; click adds a topping (Vogel sunflower distribution covers the whole disc). Click on the pizza sends it to the oven once it has at least one topping.
- **Horno**: empty at start; pizza arrives at the oven mouth (`Slot_Toppings_To_Horno_Conveyor_2`) and waits. Click slides it inside (`Slot_Horno`), starts the bake timer (5 s → Perfect, 9 s → Burnt). Click on Perfect sends it down the delivery belt.
- **Delivery**: receives the finished pizza; no primary action yet (Hito 3 will add click-to-serve).
- **Discard**: secondary action (F key) on any pizza except the masa one removes it. Hovering shows "Tirar a la basura".
- **Conveyor**: pizzas glide at constant 5 m/s through any number of waypoints (`sendPizzaAlongPath`). Easing is linear so velocity stays uniform across the whole path.
- **Interaction**: custom `interaction.ts` helper supports a primary action (left click) and an optional secondary action (F key) with independent hover text per button. WASD does NOT trigger interactions.

### Code layout (src/client/)

```
src/client/
├── setup.ts                 wires station handlers, conveyor, delivery
├── interaction.ts           onInteract() helper — left-click + F-key
├── conveyor.ts              sendPizzaAlongPath() with constant 5 m/s speed
├── slots.ts                 getEntityByName / getSlotPosition helpers
├── pizza/
│   ├── pizzaTypes.ts        PizzaStep, Topping, PizzaState component, constants
│   └── pizzaVisual.ts       spawnPizza, applyDoughClickVisual, spawnTopping…
└── stations/
    ├── masa.ts              setup + handler + auto-respawn after send
    ├── toppings.ts          setup + ingredient boxes + topping placement
    ├── horno.ts             setup + receive + insert tween + bake timer
    └── delivery.ts          receive pizza (Hito 3 will add serve action)
```

### Composite changes since Hito 1

8 new Slot/Anchor entities added (IDs 528-535+), then refined manually by the
user to match the new conveyor geometry. Current navigation slots:

- `Slot_Masa`, `Slot_Masa_To_Toppings_Conveyor_1`, `Slot_Masa_To_Toppings_Conveyor_2`, `Slot_Toppings`
- `Slot_Toppings_To_Horno_Conveyor_1`, `Slot_Toppings_To_Horno_Conveyor_2`, `Slot_Horno`
- `Slot_Horno_To_Delivery_Conveyor_1`, `Slot_Delivery`
- `Anchor_Trash` (decorative — discard is now per-pizza, no longer needed for logic)

### Composite entities (Hito 1 baseline, 16 user-defined)

| ID | Name | Type | Notes |
|---|---|---|---|
| 512-515 | `Floor_SW/SE/NW/NE` | GltfContainer | `floor-base-concrete-01.glb`, modular 16×16 tiles |
| 516 | `Wall_Back` | Box + Material | Red, (16, 1.5, 31), scale (28, 3, 0.4) |
| 517 | `Wall_Left` | Box + Material | Red, (1, 1.5, 16), scale (0.4, 3, 30) |
| 518 | `Wall_Right` | Box + Material | Red, (31, 1.5, 16), scale (0.4, 3, 30) |
| 519 | `Station_Masa` | Box + Material | Wood brown, (8, 0.5, 26), scale (3, 1, 2) |
| 520 | `Station_Toppings` | Box + Material | Wood brown, (16, 0.5, 26), scale (3, 1, 2) |
| 521 | `Station_Horno` | Box + Material | Orange emissive, (24, 1.5, 26), scale (3.5, 3, 2.5) |
| 522 | `Conveyor` | Box + Material | Light grey, (16, 0.4, 24), scale (15, 0.2, 0.8) — no collider |
| 523 | `Counter_Delivery` | Box + Material | Cream, (16, 0.5, 14), scale (8, 1, 2) |
| 524 | `Trash_Bin` | Cylinder + Material | Dark grey, (29, 0.6, 26), radius 0.5, height 1.2 |
| 525 | `Audio_Ambient` | AudioSource | `upbeat_1.mp3`, loop, global, volume 0.4 |
| 526 | `Wall_Front_Left` | Box + Material | Red, (7.5, 1.5, 1), scale (13, 3, 0.4) — left half of front wall |
| 527 | `Wall_Front_Right` | Box + Material | Red, (24.5, 1.5, 1), scale (13, 3, 0.4) — right half of front wall, leaving a 4 m doorway between x=14 and x=18 |

All collidable entities use `collisionMask: 3` (CL_POINTER + CL_PHYSICS).

### Assets downloaded

| Path | Source | Size |
|---|---|---|
| `assets/Models/floor-base-concrete-01.glb` | DCL catalog | 53 KB |
| `assets/Audio/upbeat_1.mp3` | DCL catalog | 3.2 MB |
| `assets/Audio/bell.mp3` | DCL catalog (reserved for Hito 3 — order-ready chime) | 206 KB |

## 10. Open questions / future decisions

- **Pizza visual representation**: still TBD — likely a flat yellow cylinder + sphere toppings, or eventually a proper GLB pizza model.
- **Cinta transportadora visual**: currently a static grey strip. In Hito 2, will need slot positions on each station and a `Tween` to slide pizzas between them.
- **Italian SFX/voices** ("Mamma mia!", "Bravo!"): Hito 5 stretch — find royalty-free on freesound.org.
- **Tutorial NPC**: was considered (re-using the previous Mario NPC); deferred — currently no NPC in scene.
- **Ticket UI**: floating world-space TextShape + icons, or screen-space React-ECS UI? Decision in Hito 3.

## 11. Tooling notes

- **npm path**: use `C:\Program Files\nodejs\npm.cmd` directly, not the Creator Hub's bundled npm (broken on this machine).
- **Build verification**: `& "C:\Program Files\nodejs\npm.cmd" run build` should print "Type checking completed without errors".
- **Preview**: `& "C:\Program Files\nodejs\npm.cmd" start` (user-launched, not by Claude — preview is persistent).
- **scene.json was modified by SDK**: `authoritativeMultiplayer: true` was auto-added when first building with the auth-server SDK. Keep it.
