(function (root) {
  class MatchClient {
    constructor({ onEvent = () => {}, onStatus = () => {} } = {}) {
      this.onEvent = onEvent;
      this.onStatus = onStatus;
      this.socket = null;
      this.roomCode = '';
      this.pending = [];
    }
    connect(url) {
      if (this.socket && this.socket.readyState <= 1) return;
      this.onStatus('connecting');
      try {
        this.socket = new WebSocket(url);
        this.socket.onopen = () => {
          this.onStatus('connected');
          this.pending.splice(0).forEach(message => this.socket.send(JSON.stringify(message)));
        };
        this.socket.onclose = () => this.onStatus('offline - practice mode');
        this.socket.onerror = () => this.onStatus('connection failed - practice mode');
        this.socket.onmessage = event => {
          let message;
          try { message = JSON.parse(event.data); }
          catch { this.onEvent({ type: 'error', code: 'BAD_SERVER_MESSAGE' }); return; }
          if (message.room?.code) this.roomCode = message.room.code;
          try { this.onEvent(message); }
          catch (error) { this.onEvent({ type: 'error', code: 'CLIENT_EVENT_ERROR', detail: error?.message || 'unknown' }); }
        };
      } catch { this.onStatus('connection failed - practice mode'); }
    }
    send(type, payload = {}, queue = false) {
      const message = { type, ...payload };
      if (this.socket?.readyState === 1) this.socket.send(JSON.stringify(message));
      else if (queue) this.pending.push(message);
    }
    create() { this.send('create', {}, true); }
    join(code) { this.send('join', { code }, true); }
    ready() { if (this.roomCode) this.send('ready'); }
    start() { if (this.roomCode) this.send('start'); }
    command(payload) { if (this.roomCode) this.send('command', { payload }); }
    state(state) { if (this.roomCode) this.send('state', { state }); }
    leave() {
      if (!this.roomCode) return;
      this.send('leave');
      this.roomCode = '';
    }
  }
  root.MatchClient = MatchClient;
})(typeof window !== 'undefined' ? window : globalThis);
