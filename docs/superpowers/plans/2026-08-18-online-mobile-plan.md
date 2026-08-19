# Online Mobile 1v1 Implementation Plan

> **For agentic workers:** Execute task-by-task with verification checkpoints.

**Goal:** Add a mobile-first realtime 1v1 prototype with a server-authoritative WebSocket room flow.

**Architecture:** Keep the current browser game as the gameplay validator, add a small Node.js WebSocket server for rooms and authoritative event routing, and isolate the protocol so a future Cocos client can replace the browser UI.

**Tech Stack:** HTML/CSS/JavaScript, Node.js, `ws`, JSON messages over WebSocket.

**Spec:** `docs/superpowers/specs/2026-08-18-online-mobile-design.md`

## Global Constraints

- Mobile viewport is portrait-first and touch controls remain usable at 320px wide.
- Server owns room membership, readiness, matchmaking, and event ordering.
- No login, payments, ranking, ads, or social graph in phase one.

---

### Task 1: WebSocket protocol and room server

**Files:** Create `package.json`, `server.js`, `server.test.js`.

- [x] Write tests for room creation, join by code, ready state, and broadcast.
- [x] Run `node --test server.test.js` and observe failure.
- [x] Implement an in-memory room manager and WebSocket message router.
- [x] Run tests and verify all pass.

### Task 2: Browser client connection shell

**Files:** Modify `index.html`; create `client-network.js`.

- [x] Add room code input, create/join controls, and connection status.
- [x] Connect to the current host WebSocket endpoint and render room events.
- [x] Keep local practice mode available when no server is reachable.
- [ ] Verify on desktop and 390x844 viewport.

### Task 3: Mobile interaction and protocol integration

**Files:** Modify `index.html`, `game.js`, `client-network.js`.

- [x] Send player commands through the protocol.
- [x] Render opponent summary and server snapshots.
- [ ] Add reconnect handling and a 20-second room grace period.
- [ ] Run rule tests and browser interaction checks.

### Task 4: Delivery verification

- [ ] Start the WebSocket server and static client.
- [ ] Verify two browser tabs can join one room and receive events.
- [ ] Verify mobile touch controls and fallback practice mode.
- [ ] Document local and tunnel startup commands.
