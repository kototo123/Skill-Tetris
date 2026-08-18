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
      this.onStatus('连接中');
      try {
        this.socket = new WebSocket(url);
        this.socket.onopen = () => this.onStatus('已连接');
        this.socket.onclose = () => this.onStatus('离线 · 可继续练习');
        this.socket.onerror = () => this.onStatus('连接失败 · 单机练习');
        this.socket.onmessage = event => this.onEvent(JSON.parse(event.data));
      } catch { this.onStatus('连接失败 · 单机练习'); }
    }
    send(type, payload = {}) { if (this.socket?.readyState === 1) this.socket.send(JSON.stringify({ type, ...payload })); }
    create() { this.send('create'); }
    join(code) { this.send('join', { code }); }
    ready() { this.send('ready'); }
    command(payload) { this.send('command', { payload }); }
  }
  root.MatchClient = MatchClient;
})(typeof window !== 'undefined' ? window : globalThis);
