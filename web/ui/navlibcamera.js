/**
 * The 3D view as 3DxWare sees it (ui/navlib.js): the camera, the model's box and
 * hit testing. Ported from Adrian's Layerling fork, where it was tried on a real
 * SpaceMouse; three.js comes in as an argument so the Deno tests can pass their own.
 *
 * Z UP. Support Fins is Z up (app.js); 3DxWare's world is Y up with the front
 * camera looking down -Z. Rather than teach 3DxWare another frame, everything it
 * reads or writes goes through a turn of -90° about X, app (x, y, z) -> 3DxWare
 * (x, z, -y): the plate's up is its up, and its front camera (on +Z) is ours on -Y,
 * where Front (ui/viewpresets.js) puts it. The motion code below then works in
 * 3DxWare's frame on a stand-in camera, exactly as in Layerling.
 *
 * 3DxWare hands back whole camera matrices. The view turns as the mouse turns it
 * (`mouseLikeTurn`), so a roll of the cap is dropped and the tilt stops short of
 * straight down or up. The orbit target stays on the camera's line of sight: at the
 * depth 3DxWare names as its target, or at the depth the old one lies at, so a push
 * forward comes closer to it; once that is nearly as close as the view may come,
 * the target moves on to what lies ahead, as the wheel does, and the zoom goes
 * right up to the model.
 *
 * `app` (all in the app's own Z-up frame):
 *   camera()        the PerspectiveCamera
 *   target()        the orbit target, moved in place
 *   minDistance()   how close the view may come to its target
 *   modelBox()      Box3 of what is on the plate, or null
 *   hitTest(o, d)   nearest point of the model on the ray, or null
 *   pointer()       the mouse over the view, -1..1 each way, or null
 *   changed()       the camera or the target moved
 *   showPivot(p)    3DxWare's pivot marker at p, or null to hide it
 *   moving(on)      3DxWare starts or stops moving the view
 *   squareView(f)   optional: 3DxWare's own view button for side f was pressed
 *   locked()        optional: the view is held to a side; pan and zoom only
 */

const IDENTITY = Object.freeze([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
const PLANE_UP = Object.freeze([0, 1, 0, 0]);
/** How close to straight down or up the view may tilt. */
const TILT_LIMIT = 1e-3;

const isVector = (v) => Array.isArray(v) && v.length >= 3 && v.slice(0, 3).every((x) => typeof x === 'number' && Number.isFinite(x));
const isMatrix = (v) => Array.isArray(v) && v.length === 16 && v.every((x) => typeof x === 'number' && Number.isFinite(x));
const boxArray = (b) => [b.min.x, b.min.y, b.min.z, b.max.x, b.max.y, b.max.z];

export function createNavlibCameraModel(THREE, app) {
  const { Vector3, Quaternion, Matrix4, Box3, MathUtils } = THREE;
  const WORLD_UP = new Vector3(0, 1, 0);

  // ------------------------------------------------ app (Z up) <-> 3DxWare (Y up)
  const TO_NAV = new Matrix4().makeRotationX(-Math.PI / 2);
  const TO_APP = new Matrix4().makeRotationX(Math.PI / 2);
  const Q_TO_NAV = new Quaternion().setFromRotationMatrix(TO_NAV);
  const Q_TO_APP = Q_TO_NAV.clone().invert();
  const toNav = (v) => v.clone().applyMatrix4(TO_NAV);
  const toApp = (v) => v.clone().applyMatrix4(TO_APP);

  const navCamera = new THREE.PerspectiveCamera();
  const navTarget = new Vector3();

  /** The stand-in camera, set from the app's. */
  function camera() {
    const c = app.camera();
    navCamera.fov = c.fov;
    navCamera.aspect = c.aspect;
    navCamera.near = c.near;
    navCamera.far = c.far;
    navCamera.zoom = c.zoom;
    navCamera.updateProjectionMatrix();
    navCamera.position.copy(c.position).applyMatrix4(TO_NAV);
    navCamera.quaternion.copy(c.quaternion).premultiply(Q_TO_NAV);
    navCamera.up.set(0, 1, 0);
    navCamera.updateMatrixWorld();
    return navCamera;
  }
  const target = () => navTarget.copy(app.target()).applyMatrix4(TO_NAV);
  /** Hand the stand-in camera and target back to the app. */
  function changed() {
    const c = app.camera();
    c.position.copy(navCamera.position).applyMatrix4(TO_APP);
    c.quaternion.copy(navCamera.quaternion).premultiply(Q_TO_APP);
    c.updateMatrixWorld();
    app.target().copy(navTarget).applyMatrix4(TO_APP);
    app.changed();
  }
  const modelBox = () => {
    const b = app.modelBox();
    return b && !b.isEmpty() ? b.clone().applyMatrix4(TO_NAV) : null;
  };
  const hitTest = (origin, direction) => {
    const p = app.hitTest(toApp(origin), direction.clone().transformDirection(TO_APP));
    return p ? toNav(p) : null;
  };

  // ------------------------------------------------ the motion, in 3DxWare's frame
  /** The side a camera looks from, when it is square to one (3DxWare's own view buttons). */
  function squareFace(rotation) {
    const back = new Vector3(0, 0, 1).applyQuaternion(rotation);
    const right = new Vector3(1, 0, 0).applyQuaternion(rotation);
    const square = (v) => [v.x, v.y, v.z].filter((x) => Math.abs(Math.abs(x) - 1) < 1e-5).length === 1;
    if (!square(back) || !square(right)) return null;
    if (back.y > 0.5) return 'top';
    if (back.y < -0.5) return 'bottom';
    if (back.z > 0.5) return 'front';
    if (back.z < -0.5) return 'back';
    return back.x > 0 ? 'right' : 'left';
  }

  /**
   * The turn the view takes for the one 3DxWare sent (`sent`, from the camera as it
   * was, `before`), the way the mouse turns it: round the vertical and up or down,
   * never past straight down or up, never rolled. Taking 3DxWare's camera as it is
   * swung the view round near straight down (Layerling): there a small sideways move
   * of the line of sight is a large change of heading. The twist counts the same
   * whether 3DxWare turned it about the screen's up or the world's.
   */
  function mouseLikeTurn(before, sent) {
    const turn = sent.w < 0 ? new Quaternion(-sent.x, -sent.y, -sent.z, -sent.w) : sent.clone();
    const half = Math.acos(Math.min(1, turn.w));
    const sine = Math.sin(half);
    const axis = new Vector3(turn.x, turn.y, turn.z).multiplyScalar(sine > 1e-9 ? (2 * half) / sine : 2);
    const right = new Vector3(1, 0, 0).applyQuaternion(before);
    const up = new Vector3(0, 1, 0).applyQuaternion(before);
    const polar = Math.acos(MathUtils.clamp(new Vector3(0, 0, 1).applyQuaternion(before).y, -1, 1));
    // In the plane of the screen's up and the world's, the one direction that reads a twist about either as itself.
    const around = axis.dot(up.clone().add(WORLD_UP)) / (1 + Math.sin(polar));
    const tilt = MathUtils.clamp(polar + axis.dot(right), TILT_LIMIT, Math.PI - TILT_LIMIT) - polar;
    const spin = new Quaternion().setFromAxisAngle(WORLD_UP, around);
    const level = new Vector3(right.x, 0, right.z);
    if (level.lengthSq() < 1e-12) level.set(1, 0, 0);
    return new Quaternion().setFromAxisAngle(level.normalize().applyQuaternion(spin), tilt).multiply(spin);
  }

  const hit = { from: new Vector3(), direction: new Vector3(0, 0, -1) };
  let pendingTarget = null;
  let pivot = null;
  let inMotion = false;
  let motionEnded = -Infinity;

  const fallbackBox = () => new Box3(new Vector3(-50, 0, -50), new Vector3(50, 50, 50));

  function read(property) {
    const cam = camera();
    switch (property) {
      case 'view.affine':
        return Array.from(cam.matrixWorld.elements);
      case 'view.perspective':
        return true;
      case 'view.fov':
        return MathUtils.degToRad(cam.getEffectiveFOV());
      case 'view.frustum': {
        const h = cam.near * Math.tan(MathUtils.degToRad(cam.getEffectiveFOV()) / 2);
        const w = h * cam.aspect;
        return [-w, w, -h, h, cam.near, cam.far];
      }
      case 'view.extents': {
        // What the view shows at the target's depth.
        const depth = cam.position.distanceTo(target());
        const h = depth * Math.tan(MathUtils.degToRad(cam.getEffectiveFOV()) / 2);
        return [-h * cam.aspect, -h, -cam.far, h * cam.aspect, h, cam.far];
      }
      case 'view.target':
        return target().toArray();
      case 'view.rotatable':
        return true;
      case 'view.constructionPlane':
      case 'model.floorPlane':
        return [...PLANE_UP];
      case 'model.extents':
      case 'selection.extents':
        return boxArray(modelBox() ?? fallbackBox());
      case 'model.unitsToMeters':
        return 0.001;
      case 'coordinateSystem':
      case 'views.front':
      case 'selection.affine':
        return [...IDENTITY];
      case 'selection.empty':
        return true;
      case 'pivot.position':
        return (pivot ?? target()).toArray();
      case 'pivot.user':
        return false;
      case 'hit.lookat': {
        const p = hitTest(hit.from, hit.direction.clone().normalize());
        return p ? p.toArray() : null;
      }
      case 'pointer.position': {
        const at = app.pointer() ?? { x: 0, y: 0 };
        return new Vector3(at.x, at.y, -1).unproject(cam).toArray();
      }
      case 'frame.timingSource':
        return 0;
      case 'frame.time':
        return performance.now();
      default:
        return undefined;
    }
  }

  function applyAffine(matrix) {
    const cam = camera();
    const tgt = target();
    const position = new Vector3();
    const rotation = new Quaternion();
    new Matrix4().fromArray(matrix).decompose(position, rotation, new Vector3());
    const before = cam.quaternion.clone();
    // 3DxWare's own view buttons set the camera square to a side: that is our view
    // button of the same name. Away from a motion of the cap it is one (pressed
    // again too); within one, or just after it, only a move onto a side the view
    // was not square to already (a pan in a square view stays square).
    const face = squareFace(rotation);
    const pressed = !inMotion && performance.now() - motionEnded > 300;
    if (face && app.squareView && (pressed || face !== squareFace(before))) {
      app.squareView(face);
      return;
    }
    // 3DxWare turned its camera about the pivot and moved it; the move is kept as
    // it is, the turn is the mouse's (none while the view is held to a side).
    const sent = rotation.clone().multiply(before.clone().invert());
    const about = (pivot ?? tgt).clone();
    const turnedOnly = cam.position.clone().sub(about).applyQuaternion(sent).add(about);
    const moved = position.clone().sub(turnedOnly);
    const turn = app.locked?.() ? new Quaternion() : mouseLikeTurn(before, sent);
    const orientation = turn.clone().multiply(before);
    // The move goes the same way on the screen: right is right of the view as it is turned now.
    moved.applyQuaternion(rotation.clone().invert()).applyQuaternion(orientation);
    position.copy(cam.position).sub(about).applyQuaternion(turn).add(about).add(moved);
    const forward = new Vector3(0, 0, -1).applyQuaternion(orientation).normalize();
    const depthOf = (p) => p.clone().sub(position).dot(forward);
    const closest = app.minDistance();
    let depth = pendingTarget && depthOf(pendingTarget) > 1e-6 ? depthOf(pendingTarget) : depthOf(tgt);
    if (!(depth > closest * 1.5)) {
      // Nearly at the target, or past it: aim at what lies further ahead. Right at
      // a surface the camera stops there; with nothing ahead the target goes along.
      const ahead = hitTest(position, forward);
      const aheadDepth = ahead ? depthOf(ahead) : 0;
      if (aheadDepth > closest * 1.5) depth = aheadDepth;
      else if (ahead) depth = Math.max(depth, closest);
      else depth = Math.max(cam.position.distanceTo(tgt), closest);
    }
    tgt.copy(position).addScaledVector(forward, depth);
    cam.position.copy(position);
    // Set, not looked at: straight down has no heading of its own for lookAt to find.
    cam.quaternion.copy(orientation);
    cam.updateMatrixWorld();
    changed();
  }

  function write(property, value) {
    switch (property) {
      case 'view.affine':
        if (isMatrix(value)) applyAffine(value);
        return true;
      case 'view.target':
        if (isVector(value)) pendingTarget = new Vector3(value[0], value[1], value[2]);
        return true;
      case 'view.extents':
      case 'view.fov':
        // The field of view stays the app's own; 3DxWare zooms by moving the camera.
        return true;
      case 'pivot.position':
        if (isVector(value)) pivot = new Vector3(value[0], value[1], value[2]);
        return true;
      case 'pivot.visible':
        app.showPivot(value === true ? toApp(pivot ?? target()) : null);
        return true;
      case 'hit.lookfrom':
        if (isVector(value)) hit.from.set(value[0], value[1], value[2]);
        return true;
      case 'hit.direction':
        if (isVector(value)) hit.direction.set(value[0], value[1], value[2]);
        return true;
      case 'hit.selectionOnly':
      case 'hit.aperture':
      case 'selection.affine':
      case 'settings.changed':
      case 'events.keyPress':
      case 'events.keyRelease':
        return true;
      case 'transaction':
        // A new frame begins: a target from the last one no longer counts.
        if (typeof value === 'number' && value > 0) pendingTarget = null;
        return true;
      case 'motion':
        if (inMotion && value !== true) motionEnded = performance.now();
        inMotion = value === true;
        if (value !== true) pendingTarget = null;
        app.moving(value === true);
        return true;
      default:
        return false;
    }
  }

  return { read, write };
}
