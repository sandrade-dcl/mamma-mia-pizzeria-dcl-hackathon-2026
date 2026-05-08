import { Entity, Transform, engine } from '@dcl/sdk/ecs'
import { Vector3 } from '@dcl/sdk/math'
import { EntityNames } from '../../assets/scene/entity-names'

// Resolves a composite-defined entity by its Name. Throws if missing — composite
// drift is a hard error, not a runtime fallback case.
export function getEntityByName(name: EntityNames): Entity {
  const entity = engine.getEntityOrNullByName(name)
  if (!entity) {
    throw new Error(`[slots] Entity '${name}' not found in composite`)
  }
  return entity
}

export function getSlotPosition(name: EntityNames): Vector3 {
  return Transform.get(getEntityByName(name)).position
}
