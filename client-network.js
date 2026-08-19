(function (root) {
  class MatchClient {
    constructor({ onEvent = () => {}, onStatus = () => {} } = {}) {
      this.onEvent = onEvent;
      this.onStatus = onStatus;
      this.socket = null;
      this.roomCode = '';
    }
    connect(url) {
      if (this.socket && this.socket.readyState <= 1) return;
      this.onStatus('connecting');
      try {
        this.socket = new WebSocket(url);
        this.socket.onopen = () => this.onStatus('connected');
        this.socket.onclose = () => this.onStatus('offline - practice mode');
        this.socket.onerror = () => this.onStatus('connection failed - practice mode');
        this.socket.onmessage = event => {
          try { this.onEvent(JSON.parse(event.data)); } catch { this.onEvent({ type: 'error', code: 'BAD_SERVER_MESSAGE' }); }
        };
      } catch { this.onStatus('connection failed - practice mode'); }
    }
    send(type, payload = {}) { if (this.socket?.readyState === 1) this.socket.send(JSON.stringify({ type, ...payload })); }
    create() { this.send('create'); }
    join(code) { this.send('join', { code }); }
    ready() { this.send('ready'); }
    command(payload) { this.send('command', { payload }); }
    state(state) { this.send('state', { state }); }
  }
  root.MatchClient = MatchClient;
})(typeof window !== 'undefined' ? window : globalThis);
