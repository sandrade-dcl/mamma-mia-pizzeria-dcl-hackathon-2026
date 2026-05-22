# Crazy Pizza!

A cooperative pizza-making arena for 1–3 players, built in Decentraland SDK7
for the company hackathon 2026. Theme: an Italian cartoon pizzeria. One
shift, four minutes, as many pizzas as you can serve.

---

## Concept

You and up to two friends run a tiny Italian pizzeria. Orders pop up on the
ticket board, you push raw dough through the station pipeline (Masa →
Toppings → Horno → Delivery), and you click the matching ticket to score.
Mistakes cost points but the round never ends early — only the clock does.
There is no "Game Over"; your score can go negative if you're sloppy.

## How to play

### The pipeline

| Station       | What you do                                                                |
|---------------|----------------------------------------------------------------------------|
| **Masa**      | Click the dough ball **10 times** to knead it flat                         |
| **Toppings**  | Click ingredient boxes to add toppings matching a ticket                   |
| **Horno**     | Click to insert the pizza, then click again to pull it out before it burns |
| **Delivery**  | Click the matching ticket on the order board to serve                      |

A short conveyor belt animates the pizza from one station to the next at
5 m/s — you can't queue more than one pizza at any station, so pace
yourselves.

### Controls

- **Left click** — primary action on the pizza or station you're hovering.
- **F** — discard the pizza in front of you (works at Toppings, Horno and
  Delivery). The dough at Masa cannot be discarded.

Every cube and pizza shows a hover label so you always know what the click
will do (`Knead`, `Insert in oven`, `Send to delivery`, `Serve order`, …).

### Recipes

Each pizza is a **multiset** of toppings — you must place the exact counts,
not just the right kinds.

| Pizza            | Toppings                                         | Total |
|------------------|--------------------------------------------------|-------|
| Margherita       | Tomato ×2, Mozzarella ×4                         | 6     |
| Diavola          | Tomato ×2, Mozzarella ×2, Salami ×4              | 8     |
| Funghi           | Tomato ×2, Mozzarella ×2, Mushroom ×4            | 8     |
| Quattro Stagioni | Tomato ×2, Mozzarella ×2, Salami ×2, Mushroom ×2 | 8     |

Each ingredient cube at the Toppings station is colour-coded and labeled
with its name floating above it.

### The oven

The horno bakes for 5 seconds before the pizza is **Perfect**, and burns
4 seconds after that. While the pizza is Perfect the oven shell pulses
visibly — that's your "take it out now!" signal. Miss the window and the
smoke goes black, the light turns red, and the pizza becomes worth nothing
but a penalty.

### Scoring

| Event                                     | Points                                    |
|-------------------------------------------|-------------------------------------------|
| Serve a correctly built pizza             | **+100** base + up to **+50** speed bonus |
| Ticket expires (timer ran out)            | **−100**                                  |
| Discard a burnt pizza                     | **−50**                                   |
| Discard a pizza that already had toppings | **−25**                                   |
| Discard empty dough                       | 0                                         |

The speed bonus scales linearly with how much of the ticket's timer was
left when you served it — clearing tickets fast is the path to a top
leaderboard score.

## Multiplayer

- **1–3 players** per round. Difficulty scales with the lobby size: with
  three players the kitchen receives roughly 3× as many orders as a solo
  run, so the throughput stays meaningful no matter how many cooks you
  have.
- **Lobby flow**: the first player to enter the scene presses `CREATE
  GAME` to open a lobby. Other players can `JOIN GAME` until it's full.
  Only the host can `START GAME`.
- **Spectators**: anyone in the scene who is not in the lobby during a
  live round sees the same ticket board, score and timer as the players.
  They can also enter a top-down **spectator camera** to watch the action
  from above.
- **Leaderboard**: a per-player best-score table lives on the back wall
  of the pizzeria, persisted server-side. When a round ends, every
  participant of the round gets their best score updated if the new
  shared team score beats their previous personal record.

## Round structure

A round lasts **4 minutes**. Orders generate into 3 simultaneous ticket
slots, starting at one new order every 22 s and ramping linearly to one
every 10 s by the end of the round (further divided by the lobby's player
count — see above).

Tickets normally live **45 seconds**, but any ticket that *spawns* during
the last 60 seconds of the round only lives **30 seconds**, raising the
pressure for the final stretch.

## Tech

- **Decentraland SDK7** on the `@dcl/sdk@auth-server` branch — every
  round runs on a headless authoritative server, with clients as pure
  readers + senders. State (round phase, score, orders, lobby, pizzas)
  is synced via CRDT components defined in
  [`src/shared/syncedState.ts`](src/shared/syncedState.ts).
- Pizza movement is server-driven but **Transform is not synced**: each
  client computes pizza positions per frame from a shared waypoint table
  against `currentStation` + `stationStartTime`, so the conveyor animates
  at full framerate without CRDT throttling.
- Static scenery lives in `assets/scene/main.composite` (Creator-Hub
  editable). `src/index.ts` and `src/client/**` only host runtime
  systems, behaviour and dynamically-spawned entities.
- Cartoon visual style: primitives (boxes, cylinders, spheres) +
  flat PBR materials, sized for a 2×2 parcel (32×32 m).

For the full design history, locked decisions and per-hito breakdown see
[`GAME_DESIGN.md`](GAME_DESIGN.md).

## Running locally

The Creator Hub's bundled npm is broken on the dev machine, so use a
standalone Node install. From the repo root:

```powershell
& "C:\Program Files\nodejs\npm.cmd" start
```

That launches the SDK preview server on `http://localhost:8000` and prints
a `decentraland://...` URL you can paste into the Decentraland desktop
client (or the explorer's "Open in client" option) to connect against the
local realm.

To type-check the project without booting the preview:

```powershell
& "C:\Program Files\nodejs\npm.cmd" run build
```

## Project layout

```text
src/
├── index.ts                Routes to client or server boot based on isServer()
├── shared/
│   ├── messages.ts         Cmd*/Evt* network schemas
│   └── syncedState.ts      RoundState, OrderSlot, Lobby, Leaderboard, PizzaState meta
├── server/
│   ├── server.ts           Round state machine, order generation, scoring, leaderboard
│   └── kitchen.ts          Authoritative pizza state machine + conveyor scheduling
└── client/
    ├── setup.ts            Wires HUD, stations, spectator camera, leaderboard, SFX
    ├── gameState.ts        Read-through helpers over synced components
    ├── sfx.ts              Score-delta sound effects
    ├── spectatorCamera.ts  Top-down VirtualCamera for non-players
    ├── leaderboardWall.ts  3D TextShape leaderboard on the back wall
    ├── avatarVisibility.ts Hides player avatars during active rounds
    ├── orders/             Ticket UI, recipe definitions
    ├── pizza/              Pizza visuals + per-frame Transform reconciliation
    └── stations/           Masa, Toppings, Horno, Delivery interaction handlers
```

## Credits

Built by the Decentraland Foundation team for the company hackathon 2026.
Audio assets from the Decentraland public asset catalog and royalty-free
sources.
