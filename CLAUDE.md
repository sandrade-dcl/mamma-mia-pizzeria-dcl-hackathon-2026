# Crazy Pizza! — Hackathon 2026

Italian cooperative pizza-making game built in Decentraland SDK7, themed for the company hackathon.

## ⚠ READ FIRST

**`GAME_DESIGN.md`** in the repo root contains the full design doc, plan-by-hito, current state, locked decisions, and open questions. **Always read it at the start of a session** before suggesting changes — it is the source of truth for what's been decided.

## Skill context

Decentraland SDK7 skills live in `.claude/skills/decentraland-sdk-skills/`. Use them. If they ever go missing, run `npx skills add decentraland/sdk-skills` to reinstall.

## Locked technical conventions

- **SDK branch**: `@dcl/sdk@auth-server` (already installed). Do NOT migrate to standard `@dcl/sdk`.
- **Composite-first authoring**: every static entity goes in `assets/scene/main.composite`. `src/index.ts` is reserved for systems, behavior, and runtime-spawned entities. Never `engine.addEntity()` for static scenery.
- **Composite is in edit-mode**: `inspector::*` components must be preserved, and `inspector::Nodes` must be updated whenever entities are added or removed.
- **Entity IDs**: user entities start at **512**. Reserved 0 (root), 1 (PlayerEntity), 2 (CameraEntity).
- **Visual style**: cartoon → primitives + flat PBR materials are preferred over realistic GLB models. See palette in `GAME_DESIGN.md`.
- **Parcels**: 2x2 (`["0,0","1,0","0,1","1,1"]`, base `"0,0"`). Coordinate space 0-32 in X/Z. Do not change parcels without explicit confirmation — it shifts world bounds.

## npm tooling on this machine

The Creator Hub's bundled npm is broken on this machine (missing `npm-prefix.js`). Always use the global Node.js install:

```powershell
& "C:\Program Files\nodejs\npm.cmd" run build
& "C:\Program Files\nodejs\npm.cmd" start
```

## Working style

The user (Santi) prefers **iterative validation**: discuss design, get explicit approval at each branching point, then implement. Avoid jumping straight to code on architectural questions.
