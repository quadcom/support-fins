// SpaceMouse through 3DxWare (PLAN_SF_01): the WAMP client (ui/navlib.js) and the
// view 3DxWare moves (ui/navlibcamera.js). Ported from Adrian's Layerling fork,
// where the protocol and the motion were tried on a real SpaceMouse; what is new
// here is the Z-up turn: 3DxWare works Y up, Support Fins Z up.
import * as THREE from '../web/vendor/three/three.core.js';
import { NavlibSession, navlibCommandTree, navlibSocketUrl, parseNavlibInfo } from '../web/ui/navlib.js';
import { createNavlibCameraModel } from '../web/ui/navlibcamera.js';
import { VIEWS, dirPosition } from '../web/ui/viewpresets.js';
import { assert } from './_util.js';

const flush = () => new Promise((r) => setTimeout(r, 0));
const eq = (a, b, msg) => assert(JSON.stringify(a) === JSON.stringify(b), `${msg}: ${JSON.stringify(a)} != ${JSON.stringify(b)}`);
const near = (a, b, tol, msg) => assert(Math.abs(a - b) <= tol, `${msg}: ${a} != ${b}`);
const round = (v) => v.map((x) => Math.round(x) + 0);

// ------------------------------------------------------------------ protocol
function sessionWith(model = null) {
  const sent = [];
  const calls = { ready: 0, failed: 0, commands: [] };
  const session = new NavlibSession('Support Fins', 'http://localhost:8731/', {
    send: (m) => sent.push(m),
    model: () => model,
    ready: () => calls.ready++,
    command: (id) => calls.commands.push(id),
    failed: () => calls.failed++,
  });
  const reply = (m) => session.handle(JSON.stringify(m));
  return { session, sent, calls, reply };
}

/** The handshake as 3DxWare 1.5 answered it on a real machine. */
async function connected(model = null) {
  const w = sessionWith(model);
  w.reply([0, 'session', 1, 'Nl-Proxy v1.5.0.21893']);
  await flush();
  const mouseCall = w.sent.find((m) => m[0] === 2);
  w.reply([3, mouseCall[1], { connexion: 'mouse-1' }]);
  await flush();
  const controllerCall = w.sent.filter((m) => m[0] === 2)[1];
  w.reply([3, controllerCall[1], { instance: 236857590423 }]);
  await flush();
  return { ...w, mouseCall, controllerCall };
}

Deno.test('spacemouse: the info page gives the socket port, and nothing else passes', () => {
  eq(parseNavlibInfo('{ "port" : 8182, "version" : "1.5.0.21893" }'), { port: 8182, version: '1.5.0.21893' }, 'parsed');
  eq(navlibSocketUrl(8182), 'wss://127.51.68.120:8182/', 'socket url');
  for (const bad of ['<html>', '{"port": "8182"}', '{"port": 70000}', 'null']) eq(parseNavlibInfo(bad), null, bad);
});

Deno.test('spacemouse: the handshake names the prefixes, then the mouse and the controller', async () => {
  const { sent, calls, mouseCall, controllerCall } = await connected();
  eq(sent.slice(0, 3), [
    [1, '3dx_rpc', 'wss://127.51.68.120/3dconnexion#'],
    [1, '3dconnexion', 'wss://127.51.68.120/3dconnexion'],
    [1, 'self', 'http://localhost:8731/'],
  ], 'prefixes');
  eq(mouseCall.slice(2), ['3dx_rpc:create', '3dconnexion:3dmouse', '0.8.0'], 'mouse');
  // A version as a number and nothing more: a richer controller was never answered.
  eq(controllerCall.slice(2), ['3dx_rpc:create', '3dconnexion:3dcontroller', 'mouse-1',
    { version: 0.8, name: 'Support Fins', rowMajorOrder: false }], 'controller');
  eq(sent.at(-1), [5, '3dconnexion:3dcontroller/236857590423'], 'subscribe');
  eq(calls.ready, 1, 'ready once');
});

Deno.test('spacemouse: updates go to the controller', async () => {
  const { session, sent } = await connected();
  session.update({ focus: true }).catch(() => {});
  eq(sent.at(-1).slice(2), ['3dx_rpc:update', '3dconnexion:3dcontroller/236857590423', { focus: true }], 'update');
});

Deno.test("spacemouse: 3DxWare's reads and writes are answered from the view", async () => {
  const model = {
    read: (p) => (p === 'view.perspective' ? true : p === 'hit.lookat' ? null : undefined),
    write: (p) => p === 'motion',
  };
  const { sent, reply } = await connected(model);
  const topic = 'wss://127.51.68.120/3dconnexion3dcontroller/236857590423';
  reply([8, topic, [2, 'r1', 'self:read', '', 'view.perspective']]);
  reply([8, topic, [2, 'r2', 'self:read', '', 'hit.lookat']]);
  reply([8, topic, [2, 'r3', 'self:read', '', 'nonsense']]);
  reply([8, topic, [2, 'w1', 'self:update', '', 'motion', true]]);
  reply([8, topic, [2, 'w2', 'self:update', '', 'nonsense', 1]]);
  eq(sent.slice(-5), [
    [3, 'r1', true],
    [3, 'r2', null],
    [4, 'r3', 'self:read#generic', 'nonsense unknown property'],
    [3, 'w1', null],
    [4, 'w2', 'self:update#generic', 'nonsense unknown property'],
  ], 'answers');
});

Deno.test("spacemouse: a button's command is passed on, its release is not", async () => {
  const { calls, reply, sent } = await connected();
  reply([8, 't', [2, 'c1', 'self:update', '', 'commands.activeCommand', 'sf-fit']]);
  reply([8, 't', [2, 'c2', 'self:update', '', 'commands.activeCommand', '']]);
  eq(calls.commands, ['sf-fit'], 'commands');
  eq(sent.slice(-2), [[3, 'c1', null], [3, 'c2', null]], 'acks');
});

Deno.test('spacemouse: frame notes are answered with no view; a failed handshake is reported', async () => {
  const { reply, sent } = await connected(null);
  reply([8, 't', [2, 't1', 'self:update', '', 'transaction', 1]]);
  reply([8, 't', [2, 't2', 'self:read', '', 'view.affine']]);
  eq(sent.slice(-2), [[3, 't1', null], [4, 't2', 'self:read#generic', 'view.affine no view']], 'no view');

  const w = sessionWith();
  w.reply([0, 'session', 1, 'server']);
  await flush();
  w.reply([4, w.sent.find((m) => m[0] === 2)[1], 'error', 'no device']);
  await flush();
  eq([w.calls.failed, w.calls.ready], [1, 0], 'failed, never ready');
});

Deno.test("spacemouse: the button panel's tree leaves empty groups out", () => {
  const tree = navlibCommandTree([{ id: 'Default', label: 'Support Fins', categories: [
    { id: 'v', label: 'View', actions: [{ id: 'sf-fit', label: 'Fit' }] },
    { id: 'e', label: 'Nothing', actions: [] },
  ] }]);
  eq(tree, { nodes: [{ id: 'Default', label: 'Support Fins', type: 0, nodes: [
    { id: 'v', label: 'View', type: 1, nodes: [{ id: 'sf-fit', label: 'Fit', description: '', type: 2 }] },
  ] }] }, 'tree');
});

// ------------------------------------------------------------------ the view, Z up
/** The app's camera on the front (-Y), looking at the origin, Z up; 3DxWare sees it on +Z. */
function view() {
  const camera = new THREE.PerspectiveCamera(45, 1.5, 1, 5000);
  camera.up.set(0, 0, 1);
  camera.position.set(0, -300, 0);
  camera.lookAt(0, 0, 0);
  camera.updateMatrixWorld();
  const target = new THREE.Vector3();
  const app = {
    pivot: null, faces: [], changes: 0,
    camera: () => camera,
    target: () => target,
    minDistance: () => 3,
    // the part: 20 x 20 x 20 standing on the plate at the origin
    modelBox: () => new THREE.Box3(new THREE.Vector3(-10, -10, 0), new THREE.Vector3(10, 10, 20)),
    // the plate, z = 0, met from above
    hitTest: (o, d) => (d.z < 0 ? o.clone().addScaledVector(d, o.z / -d.z) : null),
    pointer: () => null,
    changed: () => app.changes++,
    showPivot: (p) => { app.pivot = p; },
    moving: () => {},
  };
  return { camera, target, app, model: createNavlibCameraModel(THREE, app) };
}
const affine = (m) => m.toArray();
const forwardOf = (camera) => camera.getWorldDirection(new THREE.Vector3());

Deno.test("spacemouse: the front view is 3DxWare's own front, and the part box turns with it", () => {
  const { model } = view();
  const a = model.read('view.affine');
  eq(round(a), [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 300, 1], 'front camera, Y up');
  eq(model.read('coordinateSystem'), [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1], 'coordinate system');
  eq(round(model.read('model.extents')), [-10, 0, -10, 10, 20, 10], 'part box, Y up');
  eq(model.read('model.floorPlane'), [0, 1, 0, 0], 'plate is the floor');
  eq(model.read('selection.empty'), true, 'no selection');
  near(model.read('view.fov'), THREE.MathUtils.degToRad(45), 1e-9, 'fov');
  eq(model.read('anything else'), undefined, 'unknown');
});

Deno.test("spacemouse: every view button of the app reads back to 3DxWare as that side", () => {
  for (const key of Object.keys(VIEWS)) {
    const { model, camera, app } = view();
    camera.position.fromArray(dirPosition(VIEWS[key].dir, [0, 0, 0], 300));
    camera.lookAt(0, 0, 0);
    camera.updateMatrixWorld();
    app.squareView = (f) => app.faces.push(f);
    // 3DxWare sets the camera exactly where it is: its own button for this side, pressed again.
    model.write('view.affine', model.read('view.affine'));
    eq(app.faces, [key], `${key} view`);
  }
});

Deno.test("spacemouse: 3DxWare's camera comes back Z up, with the target on its line of sight", () => {
  const { model, camera, target, app } = view();
  model.write('transaction', 1);
  model.write('view.target', [5, 2, 0]);
  model.write('view.affine', [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 5, 2, 250, 1]);
  model.write('transaction', 0);
  eq(round(camera.position.toArray()), [5, -250, 2], 'camera, app frame');
  eq(round(target.toArray()), [5, 0, 2], 'target, app frame');
  eq(camera.up.toArray(), [0, 0, 1], 'app camera keeps Z up');
  near(new THREE.Vector3(0, 1, 0).applyQuaternion(camera.quaternion).z, 1, 1e-9, 'screen up is Z');
  assert(app.changes > 0, 'changed() called');
});

Deno.test('spacemouse: a roll of the cap is dropped; a push forward comes closer to the target', () => {
  const { model, camera, target } = view();
  const rolled = new THREE.Matrix4().makeRotationZ(Math.PI / 2).setPosition(0, 0, 200);
  model.write('transaction', 1);
  model.write('view.affine', affine(rolled));
  eq(round(target.toArray()), [0, 0, 0], 'target kept');
  near(camera.position.y, -200, 1e-6, '100 closer');
  near(new THREE.Vector3(0, 1, 0).applyQuaternion(camera.quaternion).z, 1, 1e-9, 'still upright');
});

Deno.test('spacemouse: a tilt stops at straight down, on the front side, not over the top', () => {
  const { model, camera, target } = view();
  const tilted = (deg) => affine(new THREE.Matrix4().makeTranslation(0, 0, 300)
    .premultiply(new THREE.Matrix4().makeRotationX(-THREE.MathUtils.degToRad(deg))));
  model.write('view.affine', tilted(85));
  model.write('view.affine', tilted(100));
  const f = forwardOf(camera);
  near(f.z, -1, 1e-5, 'looking straight down (app -Z)');
  assert(camera.position.y < 0, 'still on the front side');
  assert(f.y > 0, 'still looking toward the back');
  near(camera.position.z, 300, 0.5, 'above the target');
  eq(round(target.toArray()), [0, 0, 0], 'target kept');
});

Deno.test('spacemouse: a tilt stops at straight up too', () => {
  const { model, camera } = view();
  const tilted = (deg) => affine(new THREE.Matrix4().makeTranslation(0, 0, 300)
    .premultiply(new THREE.Matrix4().makeRotationX(THREE.MathUtils.degToRad(deg))));
  model.write('view.affine', tilted(85));
  model.write('view.affine', tilted(95));
  const f = forwardOf(camera);
  near(f.z, 1, 1e-5, 'looking straight up');
  assert(camera.position.y < 0 && f.y > 0, 'front side');
});

Deno.test('spacemouse: a twist near straight down spins round Z, not a swing over the top', () => {
  const { model, camera } = view();
  const down = new THREE.Matrix4().makeRotationX(-THREE.MathUtils.degToRad(88));
  model.write('view.affine', affine(new THREE.Matrix4().makeTranslation(0, 0, 300).premultiply(down)));
  // 3DxWare's frame from here: read it back, twist it 5° about the screen's up.
  const m = new THREE.Matrix4().fromArray(model.read('view.affine'));
  const pos = new THREE.Vector3(), q = new THREE.Quaternion();
  m.decompose(pos, q, new THREE.Vector3());
  const twist = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0).applyQuaternion(q), THREE.MathUtils.degToRad(5));
  model.write('view.affine', affine(new THREE.Matrix4().compose(pos.applyQuaternion(twist), q.premultiply(twist), new THREE.Vector3(1, 1, 1))));
  const f = forwardOf(camera);
  near(THREE.MathUtils.radToDeg(Math.acos(-f.z)), 2, 1e-4, 'still 2° off straight down');
  near(THREE.MathUtils.radToDeg(Math.atan2(-f.x, f.y)), 5, 1e-4, 'heading turned 5°');
  near(new THREE.Vector3(1, 0, 0).applyQuaternion(camera.quaternion).z, 0, 1e-6, 'no roll');
});

Deno.test("spacemouse: 3DxWare's own Top button is our Top; a pan in a square view stays a pan", () => {
  const { model, camera, app } = view();
  app.squareView = (f) => app.faces.push(f);
  model.write('view.affine', affine(new THREE.Matrix4().makeRotationX(-Math.PI / 2).setPosition(0, 300, 0)));
  eq(app.faces, ['top'], 'top');
  eq(round(camera.position.toArray()), [0, -300, 0], 'left to the glide');
  model.write('motion', true);
  model.write('view.affine', [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 5, 0, 300, 1]);
  model.write('motion', false);
  eq(app.faces, ['top'], 'a pan in the front view is not a press');
  near(camera.position.x, 5, 1e-6, 'panned');
});

Deno.test('spacemouse: a zoom right up to the part stops at its surface; past the target it moves on', () => {
  const a = view();
  a.app.hitTest = (o, d) => (d.y > 0 ? o.clone().addScaledVector(d, -o.y / d.y) : null);   // the part's front face, y = 0
  a.model.write('view.affine', [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 3.5, 1]);
  eq(round(a.target.toArray()), [0, 0, 0], 'target held at the surface');

  const b = view();
  b.app.hitTest = (o, d) => o.clone().addScaledVector(d, 40);
  b.model.write('view.affine', [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, -10, 1]);
  eq(round(b.target.toArray()), [0, 50, 0], 'target on to what lies ahead');
});

Deno.test("spacemouse: 3DxWare's hit tests and pivot are turned to the app's frame and back", () => {
  const { model, app } = view();
  model.write('hit.lookfrom', [3, 300, -4]);       // app (3, 4, 300)
  model.write('hit.direction', [0, -1, 0]);        // app straight down
  eq(round(model.read('hit.lookat')), [3, 0, -4], 'the plate under (3, 4)');
  model.write('hit.direction', [0, 1, 0]);
  eq(model.read('hit.lookat'), null, 'nothing above');
  model.write('pivot.position', [1, 2, 3]);
  model.write('pivot.visible', true);
  eq(round(app.pivot.toArray()), [1, -3, 2], 'pivot in the app frame');
  model.write('pivot.visible', false);
  eq(app.pivot, null, 'hidden');
});

Deno.test('spacemouse: every new string is in the page and in every locale', async () => {
  const KEYS = ['SpaceMouse',
    'Move the view with a 3Dconnexion SpaceMouse. Needs the 3DxWare driver running on this computer; set its buttons in 3DxWare.',
    'Looking for 3DxWare…', 'Connected to 3DxWare.',
    '3DxWare not found. Start it, then click back into this window.',
    'Fit', 'Home', 'Supports', 'Tools', 'Fins on or off',
    'Rotate 90° about X', 'Rotate 90° about Y', 'Rotate 90° about Z', 'Reset rotation'];
  const src = await Deno.readTextFile(new URL('../web/ui/spacemouse.js', import.meta.url))
    + await Deno.readTextFile(new URL('../web/index.html', import.meta.url));
  for (const k of KEYS) assert(src.includes(k), `the page no longer says "${k}"; update the key`);
  for (const lang of ['de', 'nl', 'pt', 'zh', 'ar']) {
    const { default: dict } = await import(`../web/i18n/${lang}.js`);
    for (const k of KEYS) assert(typeof dict[k] === 'string' && dict[k].length, `${lang} is missing "${k}"`);
  }
});
