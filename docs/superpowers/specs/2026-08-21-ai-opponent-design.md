# KTOTO AI Opponent Design

## Goal

Entering room code `KTOTO` creates a private one-player-versus-AI match. The human presses ready once, the AI is already ready, and the normal three-second countdown starts automatically.

## Room Model

- `KTOTO` is a reserved public alias, not a shared global room.
- Every join creates a normal internally unique room with `isAi`, `botId`, and `publicCode: "KTOTO"` metadata.
- The human is host and the AI occupies the second player slot.
- Snapshots expose `KTOTO` to the client while server commands continue using the socket-bound internal room.
- AI rooms use the existing ready, countdown, rematch, result, and cleanup states.

## AI Play

- The AI runs on the server and therefore continues when the human hides the page.
- For each piece it evaluates legal rotations and columns by simulating the landing.
- The heuristic rewards cleared lines and penalizes holes, aggregate height, maximum height, and surface bumpiness.
- The AI places approximately one piece every 1.1 seconds. Small random score noise prevents identical play every round.
- Lock, zone, forced drop, intercept, offset, mirror, shape swap, and other authoritative effects are imported before each AI move.

## AI Skills

- The AI starts with the same 50 energy and empty random hand.
- Every few placements it may draw a card for 10 energy.
- It uses affordable cards through `RoomManager.recordCommand`, so costs, reflection, private hands, and effect broadcasts follow the same server rules as humans.
- Under pressure it prioritizes cleanse, clear-top, reshape, and reflect. Otherwise it favors attacks.

## Lifecycle

- Human ready automatically marks both players ready and starts countdown.
- At countdown completion the server starts an AI timer.
- AI death awards the human; human death awards the AI.
- Room finish, human leave, socket timeout, or room deletion stops the timer.
- Returning to ready resets the AI for the next round.

## Testing

- Reserved code creates independent AI rooms.
- AI is present and ready and human ready starts countdown automatically.
- Placement avoids holes better than an obviously bad placement and produces valid state.
- AI continues placing pieces on server ticks.
- AI skill commands use normal costs and effects.
- Win/loss and room cleanup stop AI timers.

