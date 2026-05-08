import { Billboard, BillboardMode, Entity, TextShape, Transform, engine } from '@dcl/sdk/ecs'
import { Color4, Quaternion, Vector3 } from '@dcl/sdk/math'

const DEFAULT_WORLD_HEIGHT_M = 1.0
const DEFAULT_DURATION_S = 2.0
const FONT_SIZE = 2
const TEXT_COLOR = Color4.create(1, 0.25, 0.25, 1)

type Pending = {
  label: Entity
  parent: Entity
  offsetY: number
  expireAt: number
}

const pending: Pending[] = []

// Spawn a short-lived label that floats above another entity (typically a
// pizza). The label is a top-level world entity, NOT a child of the parent —
// that way it keeps a fixed world-space size regardless of the pizza's scale,
// and Billboard keeps it always facing the camera. A system updates its
// position each frame to track the parent.
export function showFloatingText(
  parent: Entity,
  text: string,
  duration: number = DEFAULT_DURATION_S,
  worldHeight: number = DEFAULT_WORLD_HEIGHT_M
) {
  const parentPos = Transform.getOrNull(parent)?.position ?? Vector3.Zero()

  const label = engine.addEntity()
  Transform.create(label, {
    position: Vector3.create(parentPos.x, parentPos.y + worldHeight, parentPos.z),
    rotation: Quaternion.Identity(),
    scale: Vector3.One()
  })
  TextShape.create(label, {
    text,
    fontSize: FONT_SIZE,
    textColor: TEXT_COLOR
  })
  Billboard.create(label, { billboardMode: BillboardMode.BM_ALL })

  pending.push({
    label,
    parent,
    offsetY: worldHeight,
    expireAt: Date.now() + duration * 1000
  })
}

function feedbackSystem(_dt: number) {
  if (pending.length === 0) return
  const now = Date.now()

  for (let i = pending.length - 1; i >= 0; i--) {
    const entry = pending[i]

    if (entry.expireAt <= now) {
      engine.removeEntity(entry.label)
      pending.splice(i, 1)
      continue
    }

    // Track the parent each frame; if the parent has been removed we drop the
    // label early instead of leaving it floating in space.
    const parentTransform = Transform.getOrNull(entry.parent)
    if (!parentTransform) {
      engine.removeEntity(entry.label)
      pending.splice(i, 1)
      continue
    }

    const labelTransform = Transform.getMutable(entry.label)
    labelTransform.position = Vector3.create(
      parentTransform.position.x,
      parentTransform.position.y + entry.offsetY,
      parentTransform.position.z
    )
  }
}

engine.addSystem(feedbackSystem)
