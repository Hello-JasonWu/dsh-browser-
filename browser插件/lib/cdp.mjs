// Minimal zero-dependency Chrome DevTools Protocol client.
// Requires Node >= 22 (global WebSocket).

export class CDP {
  constructor(wsUrl) {
    this.wsUrl = wsUrl;
    this.id = 0;
    this.pending = new Map();
    this.handlers = new Map();
    this.closed = false;
    this.ws = null;
  }

  connect(timeoutMs = 15000) {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(this.wsUrl);
      this.ws = ws;
      const timer = setTimeout(() => reject(new Error('CDP connect timeout')), timeoutMs);
      ws.addEventListener('open', () => {
        clearTimeout(timer);
        resolve(this);
      });
      ws.addEventListener('error', () => {
        clearTimeout(timer);
        reject(new Error(`CDP websocket error: ${this.wsUrl}`));
      });
      ws.addEventListener('message', (ev) => this.#onMessage(ev.data));
      ws.addEventListener('close', () => {
        this.closed = true;
        for (const p of this.pending.values()) p.reject(new Error('CDP connection closed'));
        this.pending.clear();
      });
    });
  }

  #onMessage(raw) {
    let msg;
    try {
      msg = JSON.parse(typeof raw === 'string' ? raw : raw.toString());
    } catch {
      return;
    }
    if (msg.id !== undefined && this.pending.has(msg.id)) {
      const { resolve, reject } = this.pending.get(msg.id);
      this.pending.delete(msg.id);
      if (msg.error) reject(new Error(`${msg.error.message} (code ${msg.error.code})`));
      else resolve(msg.result);
      return;
    }
    if (msg.method) {
      for (const fn of this.handlers.get(msg.method) || []) fn(msg.params, msg.sessionId);
      for (const fn of this.handlers.get('*') || []) fn(msg);
    }
  }

  send(method, params = {}, timeoutMs = 60000) {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`CDP timeout after ${timeoutMs}ms: ${method}`));
        }
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (v) => {
          clearTimeout(timer);
          resolve(v);
        },
        reject: (e) => {
          clearTimeout(timer);
          reject(e);
        },
      });
      try {
        this.ws.send(JSON.stringify({ id, method, params }));
      } catch (err) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(err);
      }
    });
  }

  on(method, fn) {
    if (!this.handlers.has(method)) this.handlers.set(method, []);
    this.handlers.get(method).push(fn);
    return () => {
      const arr = this.handlers.get(method) || [];
      const i = arr.indexOf(fn);
      if (i >= 0) arr.splice(i, 1);
    };
  }

  /** Resolve with the first event payload, or null on timeout. Never rejects. */
  waitFor(method, timeoutMs = 30000) {
    return new Promise((resolve) => {
      let done = false;
      const finish = (v) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        off();
        resolve(v);
      };
      const off = this.on(method, (params) => finish(params));
      const timer = setTimeout(() => finish(null), timeoutMs);
    });
  }

  /** Evaluate an expression in the page; returns the JSON value. */
  async evaluate(expression, { awaitPromise = true, timeoutMs = 30000, returnByValue = true } = {}) {
    const res = await this.send(
      'Runtime.evaluate',
      { expression, awaitPromise, returnByValue, userGesture: true },
      timeoutMs,
    );
    if (res.exceptionDetails) {
      const d = res.exceptionDetails;
      const msg = d.exception?.description || d.text || 'evaluation failed';
      throw new Error(msg);
    }
    return res.result?.value;
  }

  close() {
    try {
      this.ws?.close();
    } catch {
      /* ignore */
    }
  }
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
