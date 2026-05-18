import {
  LightSource,
  PBParticleSystem_BlendMode,
  PBParticleSystem_PlaybackState,
  ParticleSystem,
  Transform,
  engine
} from '@dcl/sdk/ecs'
import { Color3, Color4, Vector3 } from '@dcl/sdk/math'
import { EntityNames } from '../../../assets/scene/entity-names'
import { PizzaState, PizzaStep } from '../pizza/pizzaTypes'
import { getEntityByName } from '../slots'
import { CurrentStation } from '../../shared/syncedState'

// Hito 4 — Option A: the horno state machine (insertion tween, bake
// timer, send to delivery) lives in `src/server/kitchen.ts`. What stays
// on the client is the *ambience*: the orange light + grey smoke + station
// pulse that react to whatever pizza is currently inside the oven on the
// authoritative side. The view-only contract: read `engine.getEntitiesWith
// (PizzaState)`, find the one with `currentStation === Horno`, and pick
// the visual based on its step (Baking/Perfect → fire, Burnt → burnt,
// none → off).

type OvenState = 'off' | 'fire' | 'burnt'

const FIRE_LIGHT_COLOR = Color3.create(1, 0.647, 0)
const BURNT_LIGHT_COLOR = Color3.create(1, 0.1, 0.1)

const SMOKE_FIRE_START = Color4.create(0.6, 0.6, 0.6, 0.5)
const SMOKE_FIRE_END = Color4.create(0.4, 0.4, 0.4, 0)
const SMOKE_BURNT_START = Color4.create(0.15, 0.15, 0.15, 0.7)
const SMOKE_BURNT_END = Color4.create(0.05, 0.05, 0.05, 0)

const SMOKE_RATE_NORMAL = 20
const SMOKE_RATE_BURNT = SMOKE_RATE_NORMAL * 2

const BURNT_PULSE_FREQ_RAD_S = 18
const BURNT_PULSE_AMPLITUDE = 0.005

let hornoOriginalScale: { x: number; y: number; z: number } | null = null
let burntPulseActive = false
// Start at null so the first setOvenAmbience('off') after setup actually
// fires its write to LightSource / ParticleSystem — otherwise the dedup
// check would early-return and the composite's default `active: true`
// would leave the oven lit at boot with no pizza inside.
let currentAmbience: OvenState | null = null

export function setupHornoStation(): void {
  initSmokeEmitter()
  setOvenAmbience('off')
  engine.addSystem(hornoAmbienceWatcherSystem)
  engine.addSystem(burntPulseSystem)
}

export function resetHornoStation(): void {
  // Server-owned. The ambience watcher will turn the oven off as soon as
  // the synced PizzaState no longer reports a pizza inside.
}

function initSmokeEmitter() {
  const smoke = getEntityByName(EntityNames.SmokeEmitter)
  ParticleSystem.createOrReplace(smoke, {
    rate: SMOKE_RATE_NORMAL,
    lifetime: 2.5,
    maxParticles: 150,
    initialSize: { start: 0.15, end: 0.3 },
    sizeOverTime: { start: 1.0, end: 2.5 },
    initialColor: { start: SMOKE_FIRE_START, end: SMOKE_FIRE_START },
    colorOverTime: { start: SMOKE_FIRE_START, end: SMOKE_FIRE_END },
    initialVelocitySpeed: { start: 0.3, end: 0.6 },
    gravity: -0.15,
    blendMode: PBParticleSystem_BlendMode.PSB_ALPHA,
    shape: ParticleSystem.Shape.Cone({ angle: 15, radius: 0.15 }),
    loop: true,
    playbackState: PBParticleSystem_PlaybackState.PS_STOPPED
  })
}

function ensureHornoOriginalScale() {
  if (hornoOriginalScale !== null) return
  const transform = Transform.getOrNull(getEntityByName(EntityNames.Station_Horno))
  if (!transform) return
  hornoOriginalScale = {
    x: transform.scale.x,
    y: transform.scale.y,
    z: transform.scale.z
  }
}

function setHornoBurntPulse(active: boolean) {
  ensureHornoOriginalScale()
  burntPulseActive = active
  if (!active && hornoOriginalScale) {
    const transform = Transform.getMutableOrNull(getEntityByName(EntityNames.Station_Horno))
    if (transform) {
      transform.scale = Vector3.create(
        hornoOriginalScale.x,
        hornoOriginalScale.y,
        hornoOriginalScale.z
      )
    }
  }
}

function burntPulseSystem(_dt: number) {
  if (!burntPulseActive || !hornoOriginalScale) return
  const transform = Transform.getMutableOrNull(getEntityByName(EntityNames.Station_Horno))
  if (!transform) return
  const t = Date.now() / 1000
  const pulse = ((Math.sin(t * BURNT_PULSE_FREQ_RAD_S) + 1) / 2) * BURNT_PULSE_AMPLITUDE
  transform.scale = Vector3.create(
    hornoOriginalScale.x + pulse,
    hornoOriginalScale.y + pulse,
    hornoOriginalScale.z + pulse
  )
}

function setOvenAmbience(state: OvenState) {
  if (state === currentAmbience) return
  currentAmbience = state
  setHornoBurntPulse(state === 'burnt')

  const light = getEntityByName(EntityNames.Horno_Light)
  const ls = LightSource.getMutableOrNull(light)
  if (ls) {
    if (state === 'off') {
      ls.active = false
    } else {
      ls.active = true
      ls.color = state === 'burnt' ? BURNT_LIGHT_COLOR : FIRE_LIGHT_COLOR
    }
  }

  const smoke = getEntityByName(EntityNames.SmokeEmitter)
  const ps = ParticleSystem.getMutableOrNull(smoke)
  if (ps) {
    if (state === 'off') {
      ps.playbackState = PBParticleSystem_PlaybackState.PS_STOPPED
    } else {
      ps.playbackState = PBParticleSystem_PlaybackState.PS_PLAYING
      const burnt = state === 'burnt'
      ps.rate = burnt ? SMOKE_RATE_BURNT : SMOKE_RATE_NORMAL
      const startC = burnt ? SMOKE_BURNT_START : SMOKE_FIRE_START
      const endC = burnt ? SMOKE_BURNT_END : SMOKE_FIRE_END
      ps.initialColor = { start: startC, end: startC }
      ps.colorOverTime = { start: startC, end: endC }
    }
  }
}

// Pick the ambience from whatever pizza is currently inside the oven on
// the authoritative server — Baking/Perfect → fire, Burnt → burnt, no
// pizza → off.
function hornoAmbienceWatcherSystem(_dt: number) {
  let target: OvenState = 'off'
  for (const [, state] of engine.getEntitiesWith(PizzaState)) {
    if (state.currentStation !== CurrentStation.Horno) continue
    if (state.step === PizzaStep.Burnt) {
      target = 'burnt'
      break
    }
    if (state.step === PizzaStep.Baking || state.step === PizzaStep.Perfect) {
      target = 'fire'
    }
  }
  setOvenAmbience(target)
}
