import ReactEcs, { Button, Label, UiEntity } from '@dcl/sdk/react-ecs'
import { Color4 } from '@dcl/sdk/math'
import { getPlayer } from '@dcl/sdk/players'
import {
  backToIdle,
  createGame,
  endRound,
  getGameState,
  getLobby,
  getRoundRemainingMs,
  isLocalHost,
  isLocalInLobby,
  joinLobby,
  leaveLobby,
  ROUND_DURATION_MS,
  startRound
} from '../gameState'
import { Topping } from '../pizza/pizzaTypes'
import { getBestScore, getScore, SCORE_EXPIRED_TICKET } from '../scoring'
import { getReadyPizzaToppings } from '../stations/delivery'
import { LOBBY_MAX_PLAYERS } from '../../shared/syncedState'
import { getOrderSlots, toppingsMatch } from './orderManager'
import { Order, TICKET_LIFETIME_MS } from './orderTypes'
import {
  enterSpectatorMode,
  exitSpectatorMode,
  isSpectatorCameraActive
} from '../spectatorCamera'

function shortenAddress(addr: string): string {
  if (!addr) return 'Anonymous'
  if (addr.length <= 10) return addr
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`
}

function displayNameFor(addr: string): string {
  const player = getPlayer({ userId: addr })
  if (player?.name && player.name.length > 0) return player.name
  return shortenAddress(addr)
}

// HUD layout
//   Top centre  – 3 order ticket cards (always-visible slots).
//   Top right   – score + remaining round time.
//   Centre      – Start / End overlay while the round isn't running.

const CARD_WIDTH = 280
const CARD_HEIGHT = 200
const CARD_GAP = 16

const COLOR_CARD_BG = Color4.create(0.98, 0.95, 0.88, 0.95)
const COLOR_CARD_BG_READY = Color4.create(0.78, 0.95, 0.72, 0.95)
const COLOR_CARD_BG_EMPTY = Color4.create(0.85, 0.82, 0.76, 0.7)
const COLOR_TEXT_DARK = Color4.create(0.18, 0.1, 0.05, 1)
const COLOR_TEXT_READY = Color4.create(0.12, 0.45, 0.15, 1)
const COLOR_TEXT_MUTED = Color4.create(0.4, 0.3, 0.25, 1)
const COLOR_TEXT_EMPTY = Color4.create(0.5, 0.45, 0.4, 1)
const COLOR_BAR_BG = Color4.create(0.78, 0.74, 0.68, 1)
const COLOR_BAR_OK = Color4.create(0.3, 0.75, 0.3, 1)
const COLOR_BAR_WARN = Color4.create(0.95, 0.78, 0.18, 1)
const COLOR_BAR_DANGER = Color4.create(0.9, 0.3, 0.2, 1)
const COLOR_OVERLAY_BG = Color4.create(0.1, 0.06, 0.04, 0.78)
const COLOR_OVERLAY_PANEL = Color4.create(0.16, 0.1, 0.06, 0.95)
const COLOR_PANEL_LIGHT = Color4.create(1, 0.95, 0.78, 1)
const COLOR_CARD_BG_EXPIRED = Color4.create(0.62, 0.16, 0.16, 0.95)
const COLOR_TEXT_EXPIRED = Color4.create(1, 0.92, 0.85, 1)

function toppingName(t: Topping): string {
  switch (t) {
    case Topping.Tomato:
      return 'Tomato'
    case Topping.Mozzarella:
      return 'Mozzarella'
    case Topping.Salami:
      return 'Salami'
    case Topping.Mushroom:
      return 'Mushroom'
  }
}

const TOPPING_DISPLAY_ORDER: Topping[] = [
  Topping.Tomato,
  Topping.Mozzarella,
  Topping.Salami,
  Topping.Mushroom
]
function formatToppings(toppings: Topping[]): string {
  const counts = new Map<Topping, number>()
  for (const t of toppings) counts.set(t, (counts.get(t) ?? 0) + 1)
  const parts: string[] = []
  for (const t of TOPPING_DISPLAY_ORDER) {
    const n = counts.get(t) ?? 0
    if (n === 0) continue
    parts.push(`${toppingName(t)} x${n}`)
  }
  return parts.join(', ')
}

function barColorFor(progress: number): Color4 {
  if (progress > 0.5) return COLOR_BAR_OK
  if (progress > 0.25) return COLOR_BAR_WARN
  return COLOR_BAR_DANGER
}

function formatRoundClock(remainingMs: number): string {
  const totalSeconds = Math.max(0, Math.ceil(remainingMs / 1000))
  const m = Math.floor(totalSeconds / 60)
  const s = totalSeconds % 60
  return `${m}:${s < 10 ? `0${s}` : s}`
}

function TicketCard(order: Order, isReady: boolean) {
  const now = Date.now()
  const remainingMs = Math.max(0, order.expiresAt - now)
  const progress = remainingMs / TICKET_LIFETIME_MS
  const secondsLeft = Math.ceil(remainingMs / 1000)
  const ingredientLine = formatToppings(order.recipe.toppings)

  return (
    <UiEntity
      key={`ticket-${order.id}`}
      uiTransform={{
        width: CARD_WIDTH,
        height: CARD_HEIGHT,
        margin: { left: CARD_GAP / 2, right: CARD_GAP / 2 },
        flexDirection: 'column',
        padding: 16
      }}
      uiBackground={{ color: isReady ? COLOR_CARD_BG_READY : COLOR_CARD_BG }}
    >
      <Label
        value={order.recipe.displayName}
        fontSize={28}
        color={isReady ? COLOR_TEXT_READY : COLOR_TEXT_DARK}
        textAlign="middle-center"
        uiTransform={{ width: '100%', height: 32 }}
      />
      <Label
        value={isReady ? '✓ Ready to serve!' : ingredientLine}
        fontSize={isReady ? 20 : 18}
        color={isReady ? COLOR_TEXT_READY : COLOR_TEXT_MUTED}
        textAlign="middle-center"
        uiTransform={{ width: '100%', height: 60 }}
      />
      <UiEntity
        uiTransform={{
          width: '100%',
          height: 18,
          margin: { top: 8 }
        }}
        uiBackground={{ color: COLOR_BAR_BG }}
      >
        <UiEntity
          uiTransform={{
            width: `${progress * 100}%`,
            height: '100%'
          }}
          uiBackground={{ color: barColorFor(progress) }}
        />
      </UiEntity>
      <Label
        value={`${secondsLeft}s`}
        fontSize={22}
        color={isReady ? COLOR_TEXT_READY : COLOR_TEXT_DARK}
        textAlign="middle-center"
        uiTransform={{ width: '100%', height: 30, margin: { top: 4 } }}
      />
    </UiEntity>
  )
}

function ExpiredCard(order: Order) {
  return (
    <UiEntity
      key={`expired-${order.id}`}
      uiTransform={{
        width: CARD_WIDTH,
        height: CARD_HEIGHT,
        margin: { left: CARD_GAP / 2, right: CARD_GAP / 2 },
        flexDirection: 'column',
        justifyContent: 'center',
        padding: 16
      }}
      uiBackground={{ color: COLOR_CARD_BG_EXPIRED }}
    >
      <Label
        value={order.recipe.displayName}
        fontSize={26}
        color={COLOR_TEXT_EXPIRED}
        textAlign="middle-center"
        uiTransform={{ width: '100%', height: 36 }}
      />
      <Label
        value="Time's up!"
        fontSize={22}
        color={COLOR_TEXT_EXPIRED}
        textAlign="middle-center"
        uiTransform={{ width: '100%', height: 32, margin: { top: 4 } }}
      />
      <Label
        value={`${SCORE_EXPIRED_TICKET}`}
        fontSize={34}
        color={Color4.create(1, 0.65, 0.55, 1)}
        textAlign="middle-center"
        uiTransform={{ width: '100%', height: 48, margin: { top: 8 } }}
      />
    </UiEntity>
  )
}

function WaitingCard(slotIndex: number) {
  return (
    <UiEntity
      key={`waiting-${slotIndex}`}
      uiTransform={{
        width: CARD_WIDTH,
        height: CARD_HEIGHT,
        margin: { left: CARD_GAP / 2, right: CARD_GAP / 2 },
        flexDirection: 'column',
        justifyContent: 'center',
        padding: 16
      }}
      uiBackground={{ color: COLOR_CARD_BG_EMPTY }}
    >
      <Label
        value="Waiting for order..."
        fontSize={22}
        color={COLOR_TEXT_EMPTY}
        textAlign="middle-center"
        uiTransform={{ width: '100%', height: '100%' }}
      />
    </UiEntity>
  )
}

function InfoPanel(showTimer: boolean) {
  return (
    <UiEntity
      key="info-panel"
      uiTransform={{
        positionType: 'absolute',
        position: { top: 24, right: 24 },
        width: 240,
        height: showTimer ? 188 : 96,
        flexDirection: 'column',
        padding: 14
      }}
      uiBackground={{ color: Color4.create(0.12, 0.07, 0.05, 0.82) }}
    >
      <Label
        value={`Score: ${getScore()}`}
        fontSize={28}
        color={COLOR_PANEL_LIGHT}
        textAlign="middle-left"
        uiTransform={{ width: '100%', height: 36 }}
      />
      <Label
        value={`Best: ${getBestScore()}`}
        fontSize={18}
        color={Color4.create(0.78, 0.72, 0.62, 1)}
        textAlign="middle-left"
        uiTransform={{ width: '100%', height: 26, margin: { top: 4 } }}
      />
      {showTimer ? (
        <Label
          key="timer"
          value={`Time: ${formatRoundClock(getRoundRemainingMs())}`}
          fontSize={20}
          color={COLOR_PANEL_LIGHT}
          textAlign="middle-left"
          uiTransform={{ width: '100%', height: 30, margin: { top: 6 } }}
        />
      ) : null}
      {showTimer ? (
        <Button
          key="quit"
          value="Quit round"
          variant="secondary"
          fontSize={16}
          onMouseDown={() => endRound()}
          uiTransform={{ width: '100%', height: 38, margin: { top: 10 } }}
        />
      ) : null}
    </UiEntity>
  )
}

// Inner panel used for the Start and End modals — rendered inside the
// shared OrdersUi root which already provides the absolute-positioned,
// flex-centered backdrop. We don't wrap it in its own absolute container
// (the way an old CenterOverlay helper would) because React-ECS preserved
// some layout state when OrdersUi's root changed between PlayingHud and
// the overlay, so the End modal showed up at the top of the screen after
// the first Quit. Keeping the OrdersUi root constant fixes that.
function CenterOverlay(children: ReactEcs.JSX.Element) {
  return children
}

// (LeaderboardPanel removed — the Top-10 scoreboard now lives as a
// 3D TextShape on the back wall of the pizzeria via `leaderboardWall.ts`,
// so it's visible at all times rather than only on the Start / End
// modals.)

function PlayerListRow(addr: string, isHost: boolean) {
  return (
    <UiEntity
      key={`lobbyrow-${addr}`}
      uiTransform={{
        width: '100%',
        height: 30,
        margin: { top: 4 }
      }}
    >
      <Label
        value={`• ${displayNameFor(addr)}${isHost ? '  (host)' : ''}`}
        fontSize={18}
        color={isHost ? Color4.create(1, 0.85, 0.4, 1) : COLOR_PANEL_LIGHT}
        textAlign="middle-center"
        uiTransform={{ width: '100%', height: 30 }}
      />
    </UiEntity>
  )
}

function LobbyScreen() {
  const lobby = getLobby()
  const hasHost = lobby.host !== ''
  const inLobby = isLocalInLobby()
  const localIsHost = isLocalHost()
  const playerCount = lobby.players.length
  const lobbyFull = playerCount >= LOBBY_MAX_PLAYERS

  return CenterOverlay(
    <UiEntity
      uiTransform={{
        width: 560,
        height: 460,
        flexDirection: 'column',
        justifyContent: 'flex-start',
        alignItems: 'center',
        padding: 24
      }}
      uiBackground={{ color: COLOR_OVERLAY_PANEL }}
    >
      <Label
        value="Crazy Pizza!"
        fontSize={42}
        color={COLOR_PANEL_LIGHT}
        textAlign="middle-center"
        uiTransform={{ width: '100%', height: 60 }}
      />
      <Label
        value="Serve as many pizzas as you can in 4 minutes."
        fontSize={18}
        color={Color4.create(0.85, 0.78, 0.65, 1)}
        textAlign="middle-center"
        uiTransform={{ width: '100%', height: 36, margin: { top: 4 } }}
      />

      {!hasHost ? (
        <UiEntity
          key="no-host"
          uiTransform={{
            width: '100%',
            height: 220,
            flexDirection: 'column',
            justifyContent: 'center',
            alignItems: 'center',
            margin: { top: 16 }
          }}
        >
          <Label
            value="No game running yet."
            fontSize={20}
            color={COLOR_PANEL_LIGHT}
            textAlign="middle-center"
            uiTransform={{ width: '100%', height: 36 }}
          />
          <Label
            value="Create a lobby and others can join in."
            fontSize={16}
            color={Color4.create(0.78, 0.72, 0.62, 1)}
            textAlign="middle-center"
            uiTransform={{ width: '100%', height: 30, margin: { top: 2 } }}
          />
          <Button
            value="CREATE GAME"
            variant="primary"
            fontSize={24}
            onMouseDown={() => createGame()}
            uiTransform={{ width: 240, height: 60, margin: { top: 20 } }}
          />
        </UiEntity>
      ) : (
        <UiEntity
          key="has-host"
          uiTransform={{
            width: '100%',
            height: 320,
            flexDirection: 'column',
            justifyContent: 'flex-start',
            alignItems: 'center',
            margin: { top: 12 }
          }}
        >
          <Label
            value={`Players (${playerCount}/${LOBBY_MAX_PLAYERS})`}
            fontSize={18}
            color={Color4.create(0.85, 0.78, 0.65, 1)}
            textAlign="middle-center"
            uiTransform={{ width: '100%', height: 28 }}
          />
          {lobby.players.map((addr) => PlayerListRow(addr, addr === lobby.host))}

          {localIsHost ? (
            <UiEntity
              key="host-actions"
              uiTransform={{
                width: '100%',
                height: 120,
                flexDirection: 'column',
                alignItems: 'center',
                margin: { top: 16 }
              }}
            >
              <Button
                key="start"
                value="START GAME"
                variant="primary"
                fontSize={26}
                onMouseDown={() => startRound()}
                uiTransform={{ width: 240, height: 60 }}
              />
              <Button
                key="cancel"
                value="Cancel Lobby"
                variant="secondary"
                fontSize={16}
                onMouseDown={() => leaveLobby()}
                uiTransform={{ width: 240, height: 38, margin: { top: 8 } }}
              />
            </UiEntity>
          ) : inLobby ? (
            <UiEntity
              key="member-actions"
              uiTransform={{
                width: '100%',
                height: 120,
                flexDirection: 'column',
                alignItems: 'center',
                margin: { top: 16 }
              }}
            >
              <Label
                value="Waiting for host to start the game..."
                fontSize={16}
                color={Color4.create(0.78, 0.72, 0.62, 1)}
                textAlign="middle-center"
                uiTransform={{ width: '100%', height: 28 }}
              />
              <Button
                key="leave"
                value="Leave Lobby"
                variant="secondary"
                fontSize={18}
                onMouseDown={() => leaveLobby()}
                uiTransform={{ width: 240, height: 50, margin: { top: 12 } }}
              />
            </UiEntity>
          ) : (
            <UiEntity
              key="join-actions"
              uiTransform={{
                width: '100%',
                height: 120,
                flexDirection: 'column',
                alignItems: 'center',
                margin: { top: 16 }
              }}
            >
              {lobbyFull ? (
                <Label
                  value="Lobby is full — wait for the next round."
                  fontSize={18}
                  color={Color4.create(0.95, 0.6, 0.5, 1)}
                  textAlign="middle-center"
                  uiTransform={{ width: '100%', height: 36 }}
                />
              ) : (
                <Button
                  value="JOIN GAME"
                  variant="primary"
                  fontSize={24}
                  onMouseDown={() => joinLobby()}
                  uiTransform={{ width: 240, height: 60 }}
                />
              )}
            </UiEntity>
          )}
        </UiEntity>
      )}
    </UiEntity>
  )
}

function SpectatorOverlay(message: string, sub?: string, allowSpectatorCamera?: boolean) {
  return CenterOverlay(
    <UiEntity
      uiTransform={{
        width: 560,
        height: 320,
        flexDirection: 'column',
        justifyContent: 'center',
        alignItems: 'center',
        padding: 24
      }}
      uiBackground={{ color: COLOR_OVERLAY_PANEL }}
    >
      <Label
        value={message}
        fontSize={28}
        color={COLOR_PANEL_LIGHT}
        textAlign="middle-center"
        uiTransform={{ width: '100%', height: 48 }}
      />
      {sub ? (
        <Label
          value={sub}
          fontSize={18}
          color={Color4.create(0.85, 0.78, 0.65, 1)}
          textAlign="middle-center"
          uiTransform={{ width: '100%', height: 32, margin: { top: 8 } }}
        />
      ) : null}
      {allowSpectatorCamera ? (
        <Button
          key="enter-spec"
          value="SPECTATOR MODE"
          variant="primary"
          fontSize={22}
          onMouseDown={() => enterSpectatorMode()}
          uiTransform={{ width: 280, height: 56, margin: { top: 24 } }}
        />
      ) : null}
    </UiEntity>
  )
}

// Compact widget shown in the corner while the spectator camera is
// active. Keeps the screen mostly clear (no backdrop) and offers the
// exit button so the player can return to their avatar view anytime.
function SpectatorWidget() {
  return (
    <UiEntity
      uiTransform={{
        positionType: 'absolute',
        position: { top: 24, right: 24 },
        width: 280,
        height: 110,
        flexDirection: 'column',
        padding: 14
      }}
      uiBackground={{ color: Color4.create(0.12, 0.07, 0.05, 0.82) }}
    >
      <Label
        value="Spectating"
        fontSize={20}
        color={COLOR_PANEL_LIGHT}
        textAlign="middle-left"
        uiTransform={{ width: '100%', height: 28 }}
      />
      <Button
        value="EXIT SPECTATOR"
        variant="secondary"
        fontSize={16}
        onMouseDown={() => exitSpectatorMode()}
        uiTransform={{ width: '100%', height: 44, margin: { top: 10 } }}
      />
    </UiEntity>
  )
}

function EndScreen() {
  return CenterOverlay(
    <UiEntity
      uiTransform={{
        width: 520,
        height: 360,
        flexDirection: 'column',
        justifyContent: 'center',
        alignItems: 'center',
        padding: 24
      }}
      uiBackground={{ color: COLOR_OVERLAY_PANEL }}
    >
      <Label
        value="Time's up!"
        fontSize={40}
        color={COLOR_PANEL_LIGHT}
        textAlign="middle-center"
        uiTransform={{ width: '100%', height: 56 }}
      />
      <Label
        value={`Final score: ${getScore()}`}
        fontSize={28}
        color={Color4.create(1, 0.85, 0.4, 1)}
        textAlign="middle-center"
        uiTransform={{ width: '100%', height: 44, margin: { top: 12 } }}
      />
      <Label
        value={`Best: ${getBestScore()}`}
        fontSize={22}
        color={Color4.create(0.85, 0.78, 0.65, 1)}
        textAlign="middle-center"
        uiTransform={{ width: '100%', height: 36, margin: { top: 4 } }}
      />
      <Button
        value="Back to Menu"
        variant="primary"
        fontSize={22}
        onMouseDown={() => backToIdle()}
        uiTransform={{ width: 240, height: 56, margin: { top: 24 } }}
      />
    </UiEntity>
  )
}

function PlayingHud() {
  const slots = getOrderSlots()
  const readyPizzas = getReadyPizzaToppings()
  return (
    <UiEntity uiTransform={{ width: '100%', height: '100%' }}>
      <UiEntity
        uiTransform={{
          width: '100%',
          height: CARD_HEIGHT + 40,
          positionType: 'absolute',
          position: { top: 24 },
          flexDirection: 'row',
          justifyContent: 'center',
          alignItems: 'flex-start'
        }}
      >
        {slots.map((order, idx) => {
          if (order === null) return WaitingCard(idx)
          if (order.expiredSince !== undefined) return ExpiredCard(order)
          const isReady = readyPizzas.some((t) => toppingsMatch(t, order.recipe.toppings))
          return TicketCard(order, isReady)
        })}
      </UiEntity>
      {InfoPanel(true)}
    </UiEntity>
  )
}

export function OrdersUi() {
  const state = getGameState()
  const inLobby = isLocalInLobby()
  const spectatorCamera = isSpectatorCameraActive()
  const isSpectatorPlaying = state === 'playing' && !inLobby
  const isSpectatorEnded = state === 'end' && !inLobby
  // Single stable root for every game state. React-ECS preserved part of
  // the previous render's layout when the root element changed between
  // PlayingHud (relative, no flex centring) and CenterOverlay (absolute,
  // flex centred) — so once the player had pressed Start and Quit once
  // the End modal stuck to the top of the screen. With one constant
  // root that's already absolute + flex-centred, the inner children can
  // swap freely without re-triggering layout re-computation issues.
  // Backdrop applies whenever we show a centred modal — but NOT while
  // the spectator camera is active, since we want the player to see the
  // scene from above with just a small EXIT widget on the corner.
  const showCenteredSpectatorOverlay = (isSpectatorPlaying || isSpectatorEnded) && !spectatorCamera
  const showOverlayBackdrop =
    state === 'idle' || (state === 'end' && inLobby) || showCenteredSpectatorOverlay
  return (
    <UiEntity
      uiTransform={{
        width: '100%',
        height: '100%',
        positionType: 'absolute',
        position: { top: 0, left: 0 },
        justifyContent: 'center',
        alignItems: 'center'
      }}
      uiBackground={showOverlayBackdrop ? { color: COLOR_OVERLAY_BG } : undefined}
    >
      {state === 'idle' ? LobbyScreen() : null}
      {state === 'playing' && inLobby ? PlayingHud() : null}
      {isSpectatorPlaying && !spectatorCamera
        ? SpectatorOverlay('Game in progress', 'Wait for the next round to join.', true)
        : null}
      {state === 'end' && inLobby ? EndScreen() : null}
      {isSpectatorEnded && !spectatorCamera
        ? SpectatorOverlay('Round finished', 'A new lobby will open shortly.')
        : null}
      {spectatorCamera ? SpectatorWidget() : null}
    </UiEntity>
  )
}

// Eslint placeholder so ROUND_DURATION_MS stays imported (used implicitly by
// the timer formatter when we add a "round progress" bar in Hito 3.5).
void ROUND_DURATION_MS
