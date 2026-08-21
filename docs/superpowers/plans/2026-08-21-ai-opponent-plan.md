# KTOTO AI Opponent Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a moderately strong server-run Tetris AI reached through reserved room code `KTOTO`.

**Architecture:** Keep board-search logic in a new pure `ai-player.js` module. Extend `RoomManager` with private AI rooms, and let `createServer` own AI timers and reuse the existing command broadcast path for skills and results.

**Tech Stack:** Node.js, native test runner, `ws`, existing `game.js` engine.

**Spec:** `docs/superpowers/specs/2026-08-21-ai-opponent-design.md`

## Global Constraints

- `KTOTO` creates an independent room per human.
- Human ready starts the existing three-second countdown automatically.
- AI state and timers live on the server.
- Normal PvP rooms must retain current behavior.
- No new runtime dependency.

---

### Task 1: Pure AI Placement Engine

**Files:**
- Create: `ai-player.js`
- Create: `ai-player.test.js`
- Modify: `package.json`

**Interfaces:**
- Produces: `chooseBestPlacement(player, random?)`, `playBestMove(player, random?)`, `stateFromPlayer(player, stateSeq?)`, `applyStateToPlayer(player, state)`.

- [x] Write failing tests for valid landing, line preference, and state serialization.
- [x] Run `node --test ai-player.test.js` and verify failure because the module is absent.
- [x] Implement rotation enumeration, landing simulation, heuristic scoring, and state adapters.
- [x] Run `node --test ai-player.test.js` and verify all AI engine tests pass.
- [x] Add `ai-player.test.js` to `npm test`.

### Task 2: Reserved AI Rooms And Automatic Start

**Files:**
- Modify: `server.js`
- Modify: `server.test.js`

**Interfaces:**
- Produces: `RoomManager.createAiRoom(playerId)`, room fields `isAi`, `botId`, `publicCode`, `aiPlayer`, and automatic countdown after human ready.
- Consumes: AI state adapters from Task 1.

- [x] Write failing tests proving two `KTOTO` joins create independent rooms and that ready starts countdown.
- [x] Run targeted server tests and verify the new assertions fail.
- [x] Implement private AI room creation, public code snapshots, bot readiness, and automatic start.
- [x] Run targeted tests and verify they pass without changing normal room behavior.

### Task 3: Server AI Loop And Skills

**Files:**
- Modify: `server.js`
- Modify: `server.test.js`

**Interfaces:**
- Produces: server helpers to start, tick, broadcast, and stop each AI room.
- Consumes: `playBestMove`, `applyStateToPlayer`, `stateFromPlayer`, and existing `recordCommand`.

- [x] Write failing tests for a bot tick changing its piece/board and an AI skill reaching the human through the normal effect shape.
- [x] Run targeted tests and verify failure.
- [x] Refactor command broadcasting into a reusable closure.
- [x] Implement 1.1-second AI placement ticks, periodic draw/use strategy, effects import, result detection, and timer cleanup.
- [x] Run server tests and verify AI and PvP paths pass.

### Task 4: Client Copy And End-To-End Verification

**Files:**
- Modify: `app.js`
- Modify: `server.test.js`

**Interfaces:**
- Consumes: snapshots with public code `KTOTO` and bot player state.

- [x] Add clear room status copy identifying the AI opponent while retaining the existing mobile layout.
- [x] Run syntax checks for all JavaScript files.
- [x] Run `npm test` and require zero failures.
- [x] Run `git diff --check`.
- [ ] Commit and push the completed feature, then verify Render health and deployed client markers.
