/**
 * SpaceMouse (NDOF) support, through 3Dconnexion's 3DxWare driver: its local
 * server moves the view (ui/navlib.js is the protocol, ui/navlibcamera.js the view
 * it moves), and its buttons run the commands offered below, set in 3DxWare's own
 * button panel, where Support Fins shows up as an application of its own.
 *
 * Without 3DxWare the page asks again only when its window comes to the front, at
 * most every half minute, so nothing piles up. The switch and its status sit in the
 * View popover under Mouse; off, the page never looks. View only: nothing here
 * reaches the undo history or a saved session.
 */
import * as THREE from 'three';
import { el } from './dom.js';
import { t } from './i18n.js';
import { scene, camera, controls, renderer, requestRender, plate, clip, MODEL } from './scene.js';
import { NAVLIB_INFO_URL, NavlibSession, navlibCommandTree, navlibSocketUrl, parseNavlibInfo } from './navlib.js';
import { createNavlibCameraModel } from './navlibcamera.js';
import { VIEWS, HOME_DIR } from './viewpresets.js';
import { glideTo, stopGlide } from './camviews.js';
import { undo, redo } from './history.js';
import { part } from './part.js';

const APP_NAME = 'Support Fins';
const RETRY_GAP_MS = 30_000;
const STORE_KEY = 'sf.spaceMouse';

// ------------------------------------------------------------------ the view
const pointerAt = { x: 0, y: 0, over: false };
renderer.domElement.addEventListener('pointermove', (e) => {
  const r = renderer.domElement.getBoundingClientRect();
  pointerAt.x = ((e.clientX - r.left) / r.width) * 2 - 1;
  pointerAt.y = -((e.clientY - r.top) / r.height) * 2 + 1;
  pointerAt.over = true;
});
renderer.domElement.addEventListener('pointerleave', () => { pointerAt.over = false; });

// 3DxWare's pivot: a small dot that keeps one size on screen, drawn over the part.
const pivotDot = new THREE.Mesh(
  new THREE.SphereGeometry(1, 16, 12),
  new THREE.MeshBasicMaterial({ color: 0x4fc3f7, depthTest: false, transparent: true, opacity: 0.9 }));
pivotDot.visible = false;
pivotDot.renderOrder = 10;
pivotDot.raycast = () => {};
pivotDot.onBeforeRender = (_r, _s, cam) => {
  pivotDot.scale.setScalar(Math.max(1e-3, cam.position.distanceTo(pivotDot.position) * 0.006));
  pivotDot.updateMatrixWorld();
};
scene.add(pivotDot);

const ray = new THREE.Raycaster();
ray.layers.set(MODEL);
const shown = (o) => { for (; o; o = o.parent) if (!o.visible) return false; return true; };
const clipped = (p) => clip.some((plane) => plane.distanceToPoint(p) < -1e-3);

/** The plate's footprint, flat at z = 0. */
function plateBox() {
  const b = new THREE.Box3().setFromObject(plate);
  if (b.isEmpty()) return null;
  b.min.z = 0;
  b.max.z = 0;
  return b;
}

function modelBox() {
  const b = plateBox() ?? new THREE.Box3();
  if (part) b.union(new THREE.Box3().setFromObject(part));
  return b.isEmpty() ? null : b;
}

/** The nearest point of the part, its fins or walls on a ray; else the plate, if the ray meets it there. */
function hitTest(origin, direction) {
  ray.set(origin, direction);
  const found = ray.intersectObjects(scene.children, true)
    .find((h) => h.object.isMesh && shown(h.object) && !clipped(h.point));
  if (found) return found.point.clone();
  const onPlate = ray.ray.intersectPlane(new THREE.Plane(new THREE.Vector3(0, 0, 1), 0), new THREE.Vector3());
  const pb = plateBox();
  return onPlate && pb && onPlate.x >= pb.min.x && onPlate.x <= pb.max.x
    && onPlate.y >= pb.min.y && onPlate.y <= pb.max.y ? onPlate : null;
}

const view = createNavlibCameraModel(THREE, {
  camera: () => camera,
  target: () => controls.target,
  minDistance: () => Math.max(controls.minDistance, camera.near * 4),
  modelBox,
  hitTest,
  pointer: () => (pointerAt.over ? { x: pointerAt.x, y: pointerAt.y } : null),
  changed: () => { stopGlide(); requestRender(); },
  showPivot: (p) => {
    pivotDot.visible = !!p;
    if (p) pivotDot.position.copy(p);
    requestRender();
  },
  moving: () => requestRender(),
  squareView: (face) => glideTo(VIEWS[face].dir),
});

// ------------------------------------------------------------------ commands
/** The whole part in view, from where the camera looks now. */
function fitView() {
  if (!part) return;
  const sphere = new THREE.Box3().setFromObject(part).getBoundingSphere(new THREE.Sphere());
  stopGlide();
  const half = THREE.MathUtils.degToRad(camera.getEffectiveFOV()) / 2;
  const across = Math.atan(Math.tan(half) * camera.aspect);
  const dist = (sphere.radius * 1.1) / Math.sin(Math.min(half, across));
  const dir = camera.position.clone().sub(controls.target).normalize();
  controls.target.copy(sphere.center);
  camera.position.copy(sphere.center).addScaledVector(dir, dist);
  controls.update();
  requestRender();
}

/** A button of the page, pressed as if clicked, unless it can't be now. */
const pressButton = (id) => () => {
  const b = document.getElementById(id);
  if (!b || b.disabled || b.hidden) return;
  if (b.closest('#viewbar')?.hidden) return;      // no part loaded: the toolbar is away
  b.click();
};

// Labels are the English the page already translates; t() runs when they're sent.
const CATEGORIES = [
  { id: 'sf-view', label: 'View', actions: [
    { id: 'sf-fit', label: 'Fit', run: fitView },
    { id: 'sf-home', label: 'Home', run: () => glideTo(HOME_DIR) },
    ...Object.entries(VIEWS).map(([key, v]) => ({ id: `sf-${key}`, label: v.label, run: () => glideTo(v.dir) })),
  ] },
  { id: 'sf-edit', label: 'Edit', actions: [
    { id: 'sf-undo', label: 'Undo', run: () => undo() },
    { id: 'sf-redo', label: 'Redo', run: () => redo() },
  ] },
  { id: 'sf-supports', label: 'Supports', actions: [
    { id: 'sf-fins', label: 'Fins on or off', run: pressButton('fins-toggle') },
    { id: 'sf-remove-fins', label: 'Remove fins', run: pressButton('remove-fins-toggle') },
  ] },
  { id: 'sf-tools', label: 'Tools', actions: [
    ['move-badge', 'Move'], ['arrange-btn', 'Arrange'], ['rotate-badge', 'Rotate'],
    ['rot-x', 'Rotate 90° about X'], ['rot-y', 'Rotate 90° about Y'], ['rot-z', 'Rotate 90° about Z'],
    ['rot-reset', 'Reset rotation'], ['lay-face', 'Lay a face flat'], ['scale-badge', 'Scale'],
    ['suggest-badge', 'Suggest'], ['suggest-orient', 'Suggest orientation'],
    ['strength-badge', 'Strength'], ['section', 'Section'], ['view-badge', 'View'],
  ].map(([id, label]) => ({ id: `sf-btn-${id}`, label, run: pressButton(id) })) },
];
const RUN = new Map(CATEGORIES.flatMap((c) => c.actions.map((a) => [a.id, a.run])));

/** The button panel's tree, in the page's language now. */
export const commandSets = () => [{
  id: 'Default',
  label: APP_NAME,
  categories: CATEGORIES.map((c) => ({
    id: c.id, label: t(c.label),
    actions: c.actions.map((a) => ({ id: a.id, label: t(a.label) })),
  })),
}];

function runCommand(id) {
  const run = RUN.get(id);
  if (!run) return;
  run();
  requestRender();
}

// ------------------------------------------------------------------ connection
let enabled = true;
try { enabled = localStorage.getItem(STORE_KEY) !== '0'; } catch { /* storage off */ }

let state = 'off';            // off | searching | connected | notFound
let socket = null;
let session = null;
let connecting = false;
let lastAttempt = -Infinity;
let sentCommands = '';

function setState(s) {
  state = s;
  renderStatus();
}

const focused = () => document.hasFocus() && !document.hidden;
function sendFocus() {
  if (session?.ready) session.update({ focus: focused() }).catch(() => {});
}

/** Send the button panel's commands when they changed since this connection last sent them. */
function sendCommands() {
  if (!session?.ready) return;
  const sets = commandSets();
  const sig = JSON.stringify(sets);
  if (sig === sentCommands) return;
  sentCommands = sig;
  session.update({ commands: { activeSet: sets[0].id, tree: navlibCommandTree(sets) } })
    .catch(() => { sentCommands = ''; });
}

function closeConnection() {
  session?.close();
  session = null;
  sentCommands = '';
  if (socket) {
    socket.onclose = null;
    socket.close();
  }
  socket = null;
}

async function connect() {
  if (connecting || !enabled || socket || typeof WebSocket === 'undefined') return;
  connecting = true;
  try { await openConnection(); } finally { connecting = false; }
}

async function openConnection() {
  lastAttempt = performance.now();
  setState('searching');
  let info = null;
  try {
    const res = await fetch(NAVLIB_INFO_URL, { cache: 'no-store', headers: { Accept: 'application/json' } });
    info = res.ok ? parseNavlibInfo(await res.text()) : null;
  } catch { info = null; }
  if (!info || !enabled || socket) {
    if (!socket) setState(enabled ? 'notFound' : 'off');
    return;
  }
  const opened = new WebSocket(navlibSocketUrl(info.port), ['wamp']);
  socket = opened;
  const current = new NavlibSession(APP_NAME, location.href, {
    send: (m) => { if (opened.readyState === WebSocket.OPEN) opened.send(JSON.stringify(m)); },
    model: () => view,
    ready: () => { setState('connected'); sendFocus(); sendCommands(); },
    command: runCommand,
    failed: () => { closeConnection(); setState('notFound'); },
  });
  session = current;
  opened.onmessage = (e) => current.handle(String(e.data));
  opened.onclose = () => {
    if (socket !== opened) return;
    closeConnection();
    setState(enabled ? 'notFound' : 'off');
  };
}

addEventListener('focus', () => {
  sendFocus();
  if (!socket && enabled && performance.now() - lastAttempt >= RETRY_GAP_MS) connect();
});
addEventListener('blur', sendFocus);
document.addEventListener('visibilitychange', sendFocus);

// ------------------------------------------------------------------ the switch
const box = el('spacemouse');
const status = el('spacemouse-status');
const STATUS = {
  off: '',
  searching: 'Looking for 3DxWare…',
  connected: 'Connected to 3DxWare.',
  notFound: '3DxWare not found. Start it, then click back into this window.',
};
function renderStatus() {
  status.textContent = t(STATUS[state]);
  status.hidden = !STATUS[state];
}
box.checked = enabled;
box.addEventListener('change', () => {
  enabled = box.checked;
  try { localStorage.setItem(STORE_KEY, enabled ? '1' : '0'); } catch { /* storage off */ }
  if (enabled) {
    lastAttempt = -Infinity;
    connect();
  } else {
    closeConnection();
    setState('off');
  }
});
window.addEventListener('languagechange', () => { renderStatus(); sendCommands(); });

renderStatus();
connect();
