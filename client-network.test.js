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

test('reports client event failures separately from malformed server messages', () => {
  const events = [];
  const client = new global.MatchClient({ onEvent: event => {
    events.push(event);
    if (event.type === 'room') throw new Error('render failed');
  }});
  client.connect('ws://example.test');
  const socket = FakeWebSocket.instances.at(-1);
  socket.open();
  socket.onmessage({ data: JSON.stringify({ type: 'room', room: { code: 'ABCDE' } }) });
  assert.equal(events.at(-1).code, 'CLIENT_EVENT_ERROR');
  socket.onmessage({ data: '{broken' });
  assert.equal(events.at(-1).code, 'BAD_SERVER_MESSAGE');
});
