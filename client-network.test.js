const test = require('node:test');
const assert = require('node:assert/strict');

class FakeWebSocket {
  static instances = [];
  constructor() { this.readyState = 0; this.sent = []; FakeWebSocket.instances.push(this); }
  send(value) { this.sent.push(JSON.parse(value)); }
  open() { this.readyState = 1; this.onopen(); }
}

global.WebSocket = FakeWebSocket;
require('./client-network.js');

test('queues room creation until the WebSocket connection opens', () => {
  const client = new global.MatchClient();
  client.connect('ws://example.test');
  client.create();
  client.state({ score: 10 });
  const socket = FakeWebSocket.instances.at(-1);
  assert.deepEqual(socket.sent, []);
  socket.open();
  assert.deepEqual(socket.sent, [{ type: 'create' }]);
});
