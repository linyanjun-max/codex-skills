// Simple-Scada 2 admin interface client (port 8758 by default).
//
// The desktop server ships a browser admin UI (Web/webintf.html + js/sswebintf.js).
// That UI talks JSON over a plain WebSocket to ws://127.0.0.1:8758:
//
//   connect  -> {"type":501,"wine":0}                     after c:100
//   request  -> {"c":100,"login":"","pass":"<sha256hex>","sil":0|1}
//   page     -> {"c":101,"page":N,"filters":{...},"same":0}
//   command  -> {"c":COD,"id":ID}                         start/stop/restart/stop-client/shutdown
//   server   -> {"type":500} auth failed / {"type":504} periodic state push
//               {"type":502,"page":N,...} page payload
//               {"type":501} auth ok
//
// Page numbers (from the UI constants): 1 server state, 2 projects, 3 OPC servers,
// 4 clients, 5 databases, 6 journal, 7 shutdown, 8 loading.
// Project states: 0 stopped, 1 activating, 2 activating!, 3 active?, 4 starting,
// 5 running, 6/7 transitional — the UI maps 5 to "Running" and 0 to "Stopped".
//
// Commands (from the UI handlers): 104 start project, 105 stop project,
// 106 restart project, 102 disconnect client, 103 stop server, 107 refresh.

export const PAGE = {
  SERVER: 1,
  PROJECTS: 2,
  OPC: 3,
  CLIENTS: 4,
  DATABASES: 5,
  JOURNAL: 6,
  SHUTDOWN: 7,
  LOADING: 8,
}

export const CMD = {
  AUTH: 100,
  PAGE: 101,
  DISCONNECT_CLIENT: 102,
  STOP_SERVER: 103,
  START_PROJECT: 104,
  STOP_PROJECT: 105,
  RESTART_PROJECT: 106,
  REFRESH: 107,
}

// Labels taken verbatim from Web/js/wilang_en.js (_c26, _a21.._a24):
//   1 = queued, 2 = stopping, 3 = stopped, 4 = starting, 5 = started
// State 0 means "never activated" and is rendered like "stopped" by the UI
// (the UI treats both 0 and 3 as "not running": it shows the start button).
export const PROJECT_STATE = {
  0: 'stopped',
  1: 'queued',
  2: 'stopping',
  3: 'stopped',
  4: 'starting',
  5: 'started',
  6: 'stopping',
  7: 'stopped',
}

export const RUNNING_STATES = [1, 4, 5]
export const STOPPED_STATES = [0, 3, 7]

const DEFAULT_FILTERS = {
  clientsOnly: 0,
  level: 0,
  grScripts: 1,
  grOPC: 1,
  grReports: 1,
  grDB: 1,
  grMail: 1,
}

function sha256Hex(text) {
  // node:crypto is always available in the plugin host process.
  // eslint-disable-next-line no-undef
  return globalThis.__scadaSha256 ? globalThis.__scadaSha256(text) : null
}

export class AdminClient {
  constructor(options) {
    const o = options || {}
    this.host = o.host || '127.0.0.1'
    this.port = o.port || 8758
    this.timeoutMs = o.timeoutMs || 8000
    this.ws = null
    this.authed = false
    this.messages = []
    this.waiters = []
    this.page = null
    this.pageData = {}
    this.common = null
    this.closed = false
    this.sha256 = o.sha256 || sha256Hex
    this.WebSocketImpl = o.WebSocket || globalThis.WebSocket
  }

  get url() {
    return 'ws://' + this.host + ':' + this.port
  }

  async connect() {
    if (typeof this.WebSocketImpl !== 'function') {
      throw new Error('WebSocket is not available in this Node runtime')
    }
    const self = this
    this.ws = new this.WebSocketImpl(this.url)
    this.ws.onmessage = function (ev) { self._onMessage(ev) }
    this.ws.onopen = function () { self._ping() }
    this.ws.onerror = function () { self._ping() }
    this.ws.onclose = function () { self.closed = true; self._ping() }
    await this._waitFor(function () { return self.ws && self.ws.readyState === 1 }, this.timeoutMs, 'WebSocket open')
    return this
  }

  // Re-evaluate pending waiters after any socket event (open/message/close).
  _ping() {
    const pending = this.waiters.slice()
    for (const w of pending) {
      let ok = false
      try { ok = !!w.test() } catch (e) { ok = false }
      if (ok) {
        this.waiters.splice(this.waiters.indexOf(w), 1)
        clearTimeout(w.timer)
        w.resolve(true)
      }
    }
  }

  _onMessage(ev) {
    let msg
    try { msg = JSON.parse(String(ev.data)) } catch (e) { return }
    this.messages.push(msg)
    if (msg && msg.pagedata && Object.keys(msg.pagedata).length) {
      if (msg.pagedata.projects) this.pageData.projects = msg.pagedata.projects
      if (msg.pagedata.messages) this.pageData.messages = msg.pagedata.messages
    }
    if (msg && msg.common) this.common = msg.common
    if (msg && msg.type === 501) this.authed = true
    if (msg && msg.type === 502) this.page = msg.page
    const pending = this.waiters.slice()
    for (const w of pending) {
      if (w.test(msg)) {
        this.waiters.splice(this.waiters.indexOf(w), 1)
        clearTimeout(w.timer)
        w.resolve(msg)
      }
    }
  }

  _waitFor(test, timeoutMs, label) {
    const self = this
    if (test()) return Promise.resolve(true)
    return new Promise(function (resolve, reject) {
      const w = {
        test: test,
        resolve: resolve,
        reject: reject,
        timer: setTimeout(function () {
          const i = self.waiters.indexOf(w)
          if (i >= 0) self.waiters.splice(i, 1)
          reject(new Error('timeout waiting for ' + label + ' (' + timeoutMs + ' ms)'))
        }, timeoutMs),
      }
      self.waiters.push(w)
    })
  }

  _waitMessage(test, timeoutMs, label) {
    const self = this
    return this._waitFor(function () {
      for (const m of self.messages) if (test(m)) return true
      return false
    }, timeoutMs || this.timeoutMs, label).then(function () {
      for (const m of self.messages) if (test(m)) return m
      return null
    })
  }

  send(obj) {
    if (!this.ws || this.ws.readyState !== 1) throw new Error('admin socket is not open')
    this.ws.send(JSON.stringify(obj))
  }

  async auth(login, password) {
    login = login || ''
    password = password || ''
    const pass = login === '' && password === ''
      ? ''
      : (this.sha256 ? this.sha256(password) : password)
    this.messages.length = 0
    this.send({ c: CMD.AUTH, login: login, pass: pass, sil: login === '' && password === '' ? 1 : 0 })
    const msg = await this._waitMessage(function (m) { return m.type === 501 || m.type === 500 }, this.timeoutMs, 'authentication')
    if (msg.type === 500) throw new Error('Simple-Scada admin authentication failed (login/password rejected)')
    return msg
  }

  async requestPage(page, filters) {
    this.page = null
    this.send({ c: CMD.PAGE, page: page, filters: filters || DEFAULT_FILTERS, same: 0 })
    // The answer to a page request is type 502 with the full payload; the
    // periodic type 504 pushes carry deltas (e.g. {"id":2} without a name), so
    // waiting for the first of either could return an incomplete project list.
    const msg = await this._waitMessage(function (m) {
      return m.type === 502 && m.page === page
    }, this.timeoutMs, 'page ' + page)
    if (msg && Array.isArray(msg.messages)) this.pageData.messages = msg.messages
    return {
      page: page,
      pagedata: msg.pagedata || {},
      messages: Array.isArray(msg.messages) ? msg.messages : null,
      common: msg.common || null,
      type: msg.type,
    }
  }

  // Projects are only fully described on a page-2 request; the periodic 504
  // pushes carry deltas (an entry may contain just {"id":2}).
  async projects() {
    const result = await this.requestPage(PAGE.PROJECTS)
    const list = (result.pagedata.projects || []).map(function (p) {
      return {
        id: p.id,
        name: p.name || null,
        state: p.state === undefined ? null : p.state,
        stateName: p.state === undefined ? null : (PROJECT_STATE[p.state] || String(p.state)),
        vars: p.vars === undefined ? null : p.vars,
        exec: p.exec || null,
        scripts: p.scriptscur === undefined ? null : p.scriptscur,
        debug: p.debug === undefined ? null : p.debug,
      }
    })
    return { projects: list, common: result.common }
  }

  async command(code, id) {
    this.send({ c: code, id: id })
    // Give the server a moment to accept the command; state changes arrive on
    // the periodic push and are polled with waitForProjectState().
    await new Promise(function (r) { setTimeout(r, 400) })
    return true
  }

  startProject(id) { return this.command(CMD.START_PROJECT, id) }
  stopProject(id) { return this.command(CMD.STOP_PROJECT, id) }
  restartProject(id) { return this.command(CMD.RESTART_PROJECT, id) }
  stopServer() { return this.command(CMD.STOP_SERVER, 0) }

  // Poll page 2 until the given project reaches one of `states`.
  async waitForProjectState(id, states, timeoutMs) {
    const self = this
    const deadline = Date.now() + (timeoutMs || 30000)
    let last = null
    while (Date.now() < deadline) {
      const res = await this.projects()
      const p = (res.projects || []).find(function (x) { return x.id === id })
      if (p && p.state !== null) {
        last = p
        if (states.indexOf(p.state) >= 0) return p
      }
      await new Promise(function (r) { setTimeout(r, 600) })
    }
    return last
  }

  // Journal messages arrive as a flat triple array on the page-6 answer:
  //   [kind, text, time, kind, text, time, ...]  (kind: 1 normal, 2 warning, 3 alarm)
  async journal(filters) {
    const result = await this.requestPage(PAGE.JOURNAL, filters || DEFAULT_FILTERS)
    const flat = result.messages || []
    const items = []
    for (let i = 0; i + 2 < flat.length + 1; i += 3) {
      items.push({ kind: flat[i], text: flat[i + 1], time: flat[i + 2] })
    }
    return Object.assign({}, result, { items: items })
  }

  async serverState() {
    const result = await this.requestPage(PAGE.SERVER)
    return result
  }

  close() {
    try { if (this.ws) this.ws.close() } catch (e) { }
    this.ws = null
  }
}

// One-shot helper: connect, authenticate, run `fn(session)`, always close.
export async function withAdmin(options, fn) {
  const session = new AdminClient(options)
  await session.connect()
  try {
    await session.auth(options && options.login, options && options.password)
    return await fn(session)
  } finally {
    session.close()
  }
}
