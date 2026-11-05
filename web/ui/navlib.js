/**
 * A 3Dconnexion SpaceMouse, through the 3DxWare driver's local server: the way
 * Onshape does it, and it works in every browser (Firefox has no WebHID). 3DxWare
 * does the moving itself, with the user's own speed, axes and buttons; the page
 * answers its questions about the camera and the model and takes the camera it
 * hands back. This file is the protocol only, no browser: ui/spacemouse.js opens
 * the socket, ui/navlibcamera.js is the view 3DxWare moves.
 *
 * The server speaks WAMP version 1 (JSON arrays) on a secure socket on the
 * loopback address below; the port comes from an info page. The page names
 * prefixes, creates a "3D mouse" and a "3D controller" for its view, and listens on
 * the controller's topic, where 3DxWare's reads and writes of properties arrive as
 * calls inside events. Written from the protocol, with no 3Dconnexion code.
 */

export const NAVLIB_HOST = '127.51.68.120';
export const NAVLIB_INFO_URL = `https://${NAVLIB_HOST}:8181/3dconnexion/nlproxy`;
/** The client protocol version the page speaks; the server answers older clients differently. */
export const NAVLIB_CLIENT_VERSION = '0.8.0';

export const navlibSocketUrl = (port) => `wss://${NAVLIB_HOST}:${port}/`;

/** The socket's port from the info page, `{ "port" : 8182, "version" : "1.5.0.21893" }`, or null. */
export function parseNavlibInfo(text) {
  try {
    const p = JSON.parse(text);
    if (!p || !Number.isInteger(p.port) || p.port <= 0 || p.port > 65535) return null;
    return { port: p.port, version: typeof p.version === 'string' ? p.version : null };
  } catch {
    return null;
  }
}

const WELCOME = 0, PREFIX = 1, CALL = 2, CALL_RESULT = 3, CALL_ERROR = 4, SUBSCRIBE = 5, EVENT = 8;

const RPC_PREFIX_URI = `wss://${NAVLIB_HOST}/3dconnexion#`;
const RESOURCE_PREFIX_URI = `wss://${NAVLIB_HOST}/3dconnexion`;

const ACTION_SET_NODE = 0, CATEGORY_NODE = 1, ACTION_NODE = 2;

/**
 * The tree 3DxWare's button panel reads: banks (`{ id, label, categories }`; the
 * one with the id "Default" shows no label of its own), groups (`{ id, label,
 * actions }`) and commands (`{ id, label, description? }`). A button set to a
 * command sends its id back.
 */
export function navlibCommandTree(sets) {
  return {
    nodes: sets.map((set) => ({
      id: set.id,
      label: set.label,
      type: ACTION_SET_NODE,
      nodes: set.categories.filter((c) => c.actions.length).map((c) => ({
        id: c.id,
        label: c.label,
        type: CATEGORY_NODE,
        nodes: c.actions.map((a) => ({ id: a.id, label: a.label, description: a.description ?? '', type: ACTION_NODE })),
      })),
    })),
  };
}

/**
 * One connection's conversation. It starts when the server's welcome arrives and is
 * ready once the controller exists; `handle` takes every message from the socket.
 *
 * `events`:
 *   send(message)  -- put an array on the socket
 *   model()        -- the view 3DxWare moves now ({ read(prop), write(prop, value) }),
 *                     or null. `read` gives undefined for a property it does not
 *                     know (null is a real answer: "no hit"); `write` gives false.
 *   ready()        -- the controller is there: focus and commands can be sent
 *   command(id)    -- a button set to one of the page's commands went down
 *   failed(reason)
 */
export class NavlibSession {
  #pending = new Map();
  #counter = 0;
  #controller = null;

  constructor(appName, selfUri, events) {
    this.appName = appName;
    this.selfUri = selfUri;
    this.events = events;
  }

  get ready() { return this.#controller !== null; }

  handle(raw) {
    let m;
    try { m = JSON.parse(raw); } catch { return; }
    if (!Array.isArray(m)) return;
    const [type] = m;
    if (type === WELCOME) this.#start();
    else if (type === CALL_RESULT) this.#settle(String(m[1]), (p) => p.resolve(m[2]));
    else if (type === CALL_ERROR) this.#settle(String(m[1]), (p) => p.reject(`${m[2]} ${m[3] ?? ''}`.trim()));
    else if (type === EVENT && Array.isArray(m[2]) && m[2][0] === CALL) this.#answer(m[2]);
  }

  /** Change properties of the controller: `{ focus: true }`, `{ commands: { tree, activeSet } }`. */
  update(value) {
    if (!this.#controller) return Promise.reject('not ready');
    return this.#call('3dx_rpc:update', this.#controllerUri(), value);
  }

  /** The socket is gone: every call still waiting fails. */
  close() {
    this.#controller = null;
    for (const p of this.#pending.values()) p.reject('closed');
    this.#pending.clear();
  }

  #controllerUri() { return `3dconnexion:3dcontroller/${this.#controller}`; }

  async #start() {
    const send = this.events.send;
    send([PREFIX, '3dx_rpc', RPC_PREFIX_URI]);
    send([PREFIX, '3dconnexion', RESOURCE_PREFIX_URI]);
    send([PREFIX, 'self', this.selfUri]);
    try {
      const mouse = await this.#call('3dx_rpc:create', '3dconnexion:3dmouse', NAVLIB_CLIENT_VERSION);
      if (!mouse || mouse.connexion === undefined) throw 'no 3D mouse';
      // The version is a number here, and nothing else may be in it: the server
      // did not answer a richer one.
      const ctl = await this.#call('3dx_rpc:create', '3dconnexion:3dcontroller', mouse.connexion, {
        version: Number.parseFloat(NAVLIB_CLIENT_VERSION),
        name: this.appName,
        rowMajorOrder: false,
      });
      if (!ctl || ctl.instance === undefined) throw 'no controller';
      this.#controller = String(ctl.instance);
      send([SUBSCRIBE, this.#controllerUri()]);
      this.events.ready();
    } catch (why) {
      this.events.failed(String(why));
    }
  }

  #call(uri, ...args) {
    const id = `sf${++this.#counter}`;
    return new Promise((resolve, reject) => {
      this.#pending.set(id, { resolve, reject });
      this.events.send([CALL, id, uri, ...args]);
    });
  }

  #settle(id, run) {
    const p = this.#pending.get(id);
    if (!p) return;
    this.#pending.delete(id);
    run(p);
  }

  /** A read or write from 3DxWare: `[2, id, "self:read" | "self:update", _, property, value]`. */
  #answer(call) {
    const id = call[1];
    const method = String(call[2]);
    const property = String(call[4]);
    const send = this.events.send;
    const refuse = (why) => send([CALL_ERROR, id, `${method}#generic`, `${property} ${why}`]);
    if (method.endsWith(':update')) {
      const value = call[5];
      if (property === 'commands.activeCommand') {
        // The press, then an empty one when the button is let go.
        if (typeof value === 'string' && value) this.events.command(value);
        send([CALL_RESULT, id, null]);
        return;
      }
      const model = this.events.model();
      // Without a view the frame and setting notes still need an answer, or 3DxWare waits for one.
      if (model ? model.write(property, value) : true) send([CALL_RESULT, id, null]);
      else refuse('unknown property');
    } else if (method.endsWith(':read')) {
      const model = this.events.model();
      const value = model ? model.read(property) : undefined;
      if (value === undefined) refuse(model ? 'unknown property' : 'no view');
      else send([CALL_RESULT, id, value]);
    } else {
      refuse('unknown procedure');
    }
  }
}
