/* =========================================================
   3D car view – built with Three.js (lib/three.min.js, MIT licence)
   The car is made from shapes in code (no model files), so it works offline.
   Drag left/right to rotate. If WebGL is not available, script.js
   shows the flat 2D drawing instead.
   ========================================================= */
(function () {
  'use strict';

  function create(canvas, opts) {
    const T = window.THREE;
    if (!T) throw new Error('Three.js not loaded');

    const renderer = new T.WebGLRenderer({ canvas, antialias: true, alpha: true, powerPreference: 'high-performance' });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    renderer.outputEncoding = T.sRGBEncoding;
    renderer.toneMapping = T.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.05;
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = T.PCFSoftShadowMap;

    const scene = new T.Scene();
    // Colours below are written as normal web colours and converted for the 3D renderer
    const C = (hex) => new T.Color(hex).convertSRGBToLinear();
    const camera = new T.PerspectiveCamera(30, 1, 0.1, 100);

    /* ---- studio reflections (soft light boxes) ---- */
    const pmrem = new T.PMREMGenerator(renderer);
    const envScene = new T.Scene();
    envScene.add(new T.Mesh(new T.BoxGeometry(30, 30, 30), new T.MeshBasicMaterial({ color: 0x3e3456, side: T.BackSide })));
    const softbox = (w, h, x, y, z, rx, ry, s) => {
      const col = Array.isArray(s) ? new T.Color(s[0], s[1], s[2]) : new T.Color(s, s, s);
      const m = new T.Mesh(new T.PlaneGeometry(w, h), new T.MeshBasicMaterial({ color: col, side: T.DoubleSide }));
      m.position.set(x, y, z); m.rotation.set(rx, ry, 0); envScene.add(m);
    };
    softbox(16, 10, 0, 12, 0, Math.PI / 2, 0, 3.0);
    softbox(10, 5, 13, 4, 0, 0, -Math.PI / 2, [2.2, 1.45, 1.05]);   // warm peach light on one side
    softbox(10, 5, -13, 4, 2, 0, Math.PI / 2, [1.0, 0.85, 1.9]);    // lilac light on the other
    softbox(12, 3, 0, 3, -13, 0, 0, 1.5);
    scene.environment = pmrem.fromScene(envScene, 0.035).texture;

    /* ---- lights ---- */
    scene.add(new T.HemisphereLight(0xfff4ee, 0x6a58a8, 0.45));
    const sun = new T.DirectionalLight(0xffffff, 1.35);
    sun.position.set(4, 9, 5);
    sun.castShadow = true;
    sun.shadow.mapSize.set(1024, 1024);
    Object.assign(sun.shadow.camera, { left: -4, right: 4, top: 4, bottom: -4, near: 1, far: 25 });
    sun.shadow.radius = 5;
    sun.shadow.bias = -0.0006;
    scene.add(sun);

    /* ---- platform ---- */
    const platformMat = new T.MeshStandardMaterial({ color: C('#f4efff'), roughness: 0.85, metalness: 0 });
    const platformSide = new T.MeshPhysicalMaterial({ color: C('#6d4aff'), roughness: 0.3, clearcoat: 1, clearcoatRoughness: 0.1 });
    const platform = new T.Mesh(new T.CylinderGeometry(3.0, 3.08, 0.2, 96), [platformSide, platformMat, platformSide]);
    platform.position.y = -0.1;
    platform.receiveShadow = true;
    scene.add(platform);

    const ringMat = new T.MeshBasicMaterial({ color: 0x22c55e, transparent: true, opacity: 0.9 });
    const ring = new T.Mesh(new T.RingGeometry(2.84, 2.96, 128), ringMat);
    ring.rotation.x = -Math.PI / 2; ring.position.y = 0.003;
    scene.add(ring);

    const pulseMat = new T.MeshBasicMaterial({ color: 0xef4444, transparent: true, opacity: 0, depthWrite: false });
    const pulse = new T.Mesh(new T.RingGeometry(0.96, 1.0, 128), pulseMat);
    pulse.rotation.x = -Math.PI / 2; pulse.position.y = 0.005;
    scene.add(pulse);

    // soft contact shadow under the car
    const shadowCanvas = document.createElement('canvas');
    shadowCanvas.width = shadowCanvas.height = 128;
    const sctx = shadowCanvas.getContext('2d');
    const grad = sctx.createRadialGradient(64, 64, 4, 64, 64, 64);
    grad.addColorStop(0, 'rgba(36,12,80,0.55)');
    grad.addColorStop(1, 'rgba(36,12,80,0)');
    sctx.fillStyle = grad; sctx.fillRect(0, 0, 128, 128);
    const contact = new T.Mesh(new T.PlaneGeometry(5.6, 2.8),
      new T.MeshBasicMaterial({ map: new T.CanvasTexture(shadowCanvas), transparent: true, depthWrite: false }));
    contact.rotation.x = -Math.PI / 2; contact.position.y = 0.004;

    /* ---- the car ---- */
    const car = new T.Group();
    scene.add(car);
    car.add(contact);

    const paint = new T.MeshPhysicalMaterial({
      color: C('#6a48ff'), metalness: 0.3, roughness: 0.28, clearcoat: 1, clearcoatRoughness: 0.05,
      emissive: 0xef4444, emissiveIntensity: 0
    });

    // side profile of the body (x = length, y = height), with wheel arches
    const body = new T.Shape();
    body.moveTo(-2.3, 0.5);
    body.quadraticCurveTo(-2.36, 0.95, -2.0, 1.02);
    body.lineTo(1.15, 1.0);
    body.quadraticCurveTo(2.15, 0.98, 2.32, 0.72);
    body.quadraticCurveTo(2.38, 0.4, 2.1, 0.33);
    body.lineTo(2.04, 0.33);
    body.absarc(1.42, 0.33, 0.62, 0, Math.PI, false);
    body.lineTo(-0.8, 0.33);
    body.absarc(-1.42, 0.33, 0.62, 0, Math.PI, false);
    body.lineTo(-2.1, 0.33);
    body.quadraticCurveTo(-2.3, 0.33, -2.3, 0.5);
    const bodyGeo = new T.ExtrudeGeometry(body, {
      depth: 1.62, bevelEnabled: true, bevelThickness: 0.14, bevelSize: 0.12, bevelSegments: 8, curveSegments: 28
    });
    bodyGeo.translate(0, 0, -0.81);
    const bodyMesh = new T.Mesh(bodyGeo, paint);
    bodyMesh.castShadow = true;
    car.add(bodyMesh);

    // dark interior floor (shows the heat colour)
    const floorMat = new T.MeshStandardMaterial({ color: C('#2c2145'), roughness: 0.8, emissive: 0x000000 });
    const floor = new T.Mesh(new T.PlaneGeometry(2.9, 1.32), floorMat);
    floor.rotation.x = -Math.PI / 2; floor.position.set(-0.25, 1.145, 0);
    car.add(floor);

    // seats (right-hand drive: driver on the right side)
    const seatMat = new T.MeshStandardMaterial({ color: C('#4a3670'), roughness: 0.6 });
    const seat = (x, z, w) => {
      const g = new T.Group();
      const cushion = new T.Mesh(new T.BoxGeometry(0.46, 0.08, w), seatMat);
      cushion.position.set(x, 1.19, z);
      const back = new T.Mesh(new T.BoxGeometry(0.1, 0.36, w), seatMat);
      back.position.set(x - 0.25, 1.36, z); back.rotation.z = -0.12;
      g.add(cushion, back);
      g.children.forEach((m) => { m.castShadow = true; });
      car.add(g);
    };
    seat(0.42, 0.33, 0.46); seat(0.42, -0.33, 0.46);
    seat(-0.82, 0.33, 0.46); seat(-0.82, -0.33, 0.46);

    // dashboard + fan
    const dash = new T.Mesh(new T.BoxGeometry(0.22, 0.12, 1.3), new T.MeshStandardMaterial({ color: C('#2a2040'), roughness: 0.6 }));
    dash.position.set(0.98, 1.2, 0);
    car.add(dash);
    const fan = new T.Group();
    const bladeMat = new T.MeshStandardMaterial({ color: 0x9aa0a6, metalness: 0.6, roughness: 0.35, emissive: 0x000000 });
    for (let i = 0; i < 3; i++) {
      const b = new T.Mesh(new T.BoxGeometry(0.02, 0.17, 0.06), bladeMat);
      b.position.y = 0.075;
      const holder = new T.Group(); holder.rotation.x = (i * Math.PI * 2) / 3; holder.add(b);
      fan.add(holder);
    }
    fan.position.set(0.86, 1.36, 0);
    car.add(fan);
    const airMat = new T.MeshBasicMaterial({ color: C('#9af5df'), transparent: true, opacity: 0, depthWrite: false });
    const air = new T.Mesh(new T.ConeGeometry(0.32, 1.1, 32, 1, true), airMat);
    air.rotation.z = Math.PI / 2; air.position.set(0.3, 1.36, 0);
    car.add(air);

    // child on the rear seat (left side)
    const childMat = new T.MeshStandardMaterial({ color: C('#ff4f98'), roughness: 0.4, emissive: C('#ff2f86'), emissiveIntensity: 0.5 });
    const child = new T.Group();
    const torso = new T.Mesh(new T.CapsuleGeometry(0.11, 0.05, 6, 16), childMat);
    torso.position.set(-0.8, 1.33, 0.33);
    const head = new T.Mesh(new T.SphereGeometry(0.09, 24, 16), childMat);
    head.position.set(-0.8, 1.555, 0.33);
    child.add(torso, head);
    child.children.forEach((m) => { m.castShadow = true; });
    car.add(child);

    // floating marker above the child
    const pinMat = new T.MeshStandardMaterial({ color: 0xf59e0b, emissive: 0xf59e0b, emissiveIntensity: 0.6, roughness: 0.3 });
    const pin = new T.Group();
    const cone = new T.Mesh(new T.ConeGeometry(0.11, 0.26, 24), pinMat);
    cone.rotation.x = Math.PI;
    const ball = new T.Mesh(new T.SphereGeometry(0.11, 24, 16), pinMat);
    ball.position.y = 0.17;
    pin.add(cone, ball);
    pin.position.set(-0.8, 2.25, 0.33);
    car.add(pin);

    // glass cabin (see-through roof)
    const glassShape = new T.Shape();
    glassShape.moveTo(-1.75, 1.0);
    glassShape.quadraticCurveTo(-1.45, 1.62, -0.7, 1.66);
    glassShape.lineTo(0.3, 1.66);
    glassShape.quadraticCurveTo(0.8, 1.64, 1.25, 1.0);
    glassShape.lineTo(-1.75, 1.0);
    const glassGeo = new T.ExtrudeGeometry(glassShape, {
      depth: 1.3, bevelEnabled: true, bevelThickness: 0.07, bevelSize: 0.05, bevelSegments: 5, curveSegments: 24
    });
    glassGeo.translate(0, 0, -0.65);
    const glassMat = new T.MeshPhysicalMaterial({
      color: C('#1c1430'), metalness: 0, roughness: 0.04, clearcoat: 1, transparent: true, opacity: 0.34,
      envMapIntensity: 1.6, depthWrite: false, emissive: 0x000000, emissiveIntensity: 0
    });
    const glass = new T.Mesh(glassGeo, glassMat);
    car.add(glass);

    // light bars
    const frontLight = new T.Mesh(new T.BoxGeometry(0.05, 0.05, 1.25),
      new T.MeshStandardMaterial({ color: 0xffffff, emissive: 0xfff4d6, emissiveIntensity: 1.4 }));
    frontLight.position.set(2.41, 0.72, 0);
    const rearLightMat = new T.MeshStandardMaterial({ color: C('#7c0a1e'), emissive: C('#ff3355'), emissiveIntensity: 0.9 });
    const rearLight = new T.Mesh(new T.BoxGeometry(0.05, 0.06, 1.3), rearLightMat);
    rearLight.position.set(-2.43, 0.86, 0);
    car.add(frontLight, rearLight);

    // wheels
    const tireMat = new T.MeshStandardMaterial({ color: 0x141518, roughness: 0.85 });
    const rimMat = new T.MeshStandardMaterial({ color: 0xc4c7cc, metalness: 0.9, roughness: 0.25 });
    [[1.42, 0.8], [1.42, -0.8], [-1.42, 0.8], [-1.42, -0.8]].forEach(([x, z]) => {
      const tire = new T.Mesh(new T.CylinderGeometry(0.4, 0.4, 0.26, 40), tireMat);
      tire.rotation.x = Math.PI / 2; tire.position.set(x, 0.4, z); tire.castShadow = true;
      const rim = new T.Mesh(new T.CylinderGeometry(0.25, 0.25, 0.27, 24), rimMat);
      rim.rotation.x = Math.PI / 2; rim.position.set(x, 0.4, z);
      car.add(tire, rim);
    });

    // heat glow inside the cabin
    const heatLight = new T.PointLight(0xff3b30, 0, 3.2, 1.5);
    heatLight.position.set(-0.3, 1.45, 0);
    car.add(heatLight);

    /* ---- state ---- */
    const COL = { ok: C('#12b893'), warn: C('#ffb020'), danger: C('#ec2f4b') };
    let st = { level: 0, child: false, fan: false, locked: false, buzzer: false, heat: [34, 197, 94], heatK: 0, empty: true };
    let childVis = 0, fanSpeed = 0, heatK = 0;
    const FAN_GLOW = C('#12b893');

    function setColours(c) {
      if (!c) return;
      ['ok', 'warn', 'danger'].forEach((k) => { if (c[k]) COL[k].set(c[k]).convertSRGBToLinear(); });
    }
    function setTheme(theme) {
      platformMat.color.copy(C(theme === 'dark' ? '#2d2347' : '#f4efff'));
      platformMat.envMapIntensity = theme === 'dark' ? 0.35 : 1;
      platformSide.color.copy(C(theme === 'dark' ? '#7b5cff' : '#6d4aff'));
      renderer.toneMappingExposure = theme === 'dark' ? 1.1 : 1.02;
    }

    /* ---- drag to rotate ---- */
    let yaw = -0.75, targetYaw = yaw, dragging = false, lastX = 0, lastMove = 0;
    canvas.addEventListener('pointerdown', (e) => { dragging = true; lastX = e.clientX; lastMove = performance.now(); canvas.setPointerCapture(e.pointerId); });
    canvas.addEventListener('pointermove', (e) => {
      if (!dragging) return;
      targetYaw += (e.clientX - lastX) * 0.01; lastX = e.clientX; lastMove = performance.now();
    });
    const end = () => { dragging = false; lastMove = performance.now(); };
    canvas.addEventListener('pointerup', end);
    canvas.addEventListener('pointercancel', end);

    /* ---- size + camera framing ---- */
    function resize() {
      const w = canvas.clientWidth, h = canvas.clientHeight;
      if (!w || !h) return;
      renderer.setSize(w, h, false);
      camera.aspect = w / h;
      const vfov = (camera.fov * Math.PI) / 180;
      const hfov = 2 * Math.atan(Math.tan(vfov / 2) * camera.aspect);
      const fitW = 3.15 / Math.tan(hfov / 2);
      const fitH = 2.25 / Math.tan(vfov / 2);
      const dist = Math.max(fitW, fitH, 7);
      const elev = 0.58;
      camera.position.set(0, Math.sin(elev) * dist + 0.3, Math.cos(elev) * dist);
      camera.lookAt(0, 0.62, 0);
      camera.updateProjectionMatrix();
      renderer.render(scene, camera);   // draw at once, so the view is never blank after a resize
    }
    if ('ResizeObserver' in window) new ResizeObserver(resize).observe(canvas);
    window.addEventListener('resize', resize);
    resize();

    let visible = true;
    if ('IntersectionObserver' in window) {
      new IntersectionObserver((entries) => { visible = entries[0].isIntersecting; }).observe(canvas);
    }
    const reduceMotion = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

    /* ---- animation loop ---- */
    const clock = new T.Clock();
    const tmp = new T.Color();
    function frame() {
      requestAnimationFrame(frame);
      if (!visible) return;
      const dt = Math.min(clock.getDelta(), 0.05);
      const t = clock.elapsedTime;

      if (!dragging && !reduceMotion && performance.now() - lastMove > 2500) targetYaw += dt * 0.18;
      yaw += (targetYaw - yaw) * Math.min(1, dt * 6);
      car.rotation.y = yaw;

      const lvlCol = st.level === 2 ? COL.danger : st.level === 1 ? COL.warn : COL.ok;
      ringMat.color.copy(lvlCol);
      ringMat.opacity = st.empty ? 0.25 : st.level ? 0.65 + 0.35 * Math.sin(t * (st.level === 2 ? 7 : 3)) : 0.85;

      // expanding danger pulse on the floor
      if (st.level === 2 && !reduceMotion) {
        const k = (t * 0.7) % 1;
        pulse.scale.setScalar(1 + k * 1.9);
        pulseMat.opacity = 0.55 * (1 - k);
      } else {
        pulseMat.opacity = 0;
      }

      // child appears / disappears smoothly
      childVis += ((st.child ? 1 : 0) - childVis) * Math.min(1, dt * 6);
      child.visible = childVis > 0.02;
      child.scale.setScalar(0.6 + 0.4 * childVis);
      pin.visible = st.child && st.locked;
      pinMat.color.copy(st.level === 2 ? COL.danger : COL.warn);
      pinMat.emissive.copy(pinMat.color);
      pin.position.y = 2.25 + Math.sin(t * 3) * 0.08;
      pin.rotation.y = t * 1.5;

      // fan
      fanSpeed += ((st.fan ? 18 : 0) - fanSpeed) * Math.min(1, dt * 3);
      fan.rotation.x += fanSpeed * dt;
      if (st.fan) bladeMat.emissive.copy(FAN_GLOW); else bladeMat.emissive.set(0x000000);
      bladeMat.emissiveIntensity = st.fan ? 0.5 : 0;
      airMat.opacity = st.fan ? 0.08 + 0.05 * Math.sin(t * 10) : 0;

      // heat glow
      heatK += (st.heatK - heatK) * Math.min(1, dt * 2);
      tmp.setRGB(st.heat[0] / 255, st.heat[1] / 255, st.heat[2] / 255).convertSRGBToLinear();
      heatLight.color.copy(tmp);
      heatLight.intensity = heatK * 3;
      floorMat.emissive.copy(tmp);
      floorMat.emissiveIntensity = 0.1 + heatK * 0.9;
      glassMat.emissive.copy(tmp);
      glassMat.emissiveIntensity = heatK * 0.35;

      // body flashes red in danger, lights flash with the buzzer
      paint.emissiveIntensity = st.level === 2 ? 0.08 + 0.08 * Math.sin(t * 7) : 0;
      rearLightMat.emissiveIntensity = st.buzzer ? (Math.sin(t * 12) > 0 ? 2.2 : 0.3) : 0.9;

      renderer.render(scene, camera);
    }
    requestAnimationFrame(frame);

    return {
      update(s) {
        st = Object.assign({}, st, s, { empty: false });
        // 0 below 30 °C, 1 at 45 °C and above
        st.heatK = Math.max(0, Math.min(1, ((s.temp || 0) - 30) / 15));
      },
      clear() { st = Object.assign({}, st, { level: 0, child: false, fan: false, locked: false, buzzer: false, heatK: 0, empty: true }); },
      setColours,
      setTheme,
      resize
    };
  }

  window.Car3D = { create };
})();
