// LeviTap in the browser: point to move a cursor, pinch to click,
// two fingers up to scroll. Everything runs client-side; the camera is only
// opened after explicit consent and nothing is uploaded anywhere.
(() => {
  'use strict';

  const BTN = document.getElementById('levitap-toggle');
  if (!BTN) return;

  const MIN_WIDTH = 900;
  const MP = 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14';
  const MODEL = 'https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task';

  // Thresholds. Detection/tracking confidences are the ones from the original
  // Python build (0.8/0.8), which is what stopped false positives there.
  const CONF = 0.8;
  const PINCH_ON = 0.35;    // thumb-index gap / hand size, below = pinch
  const PINCH_OFF = 0.5;    // above = release (hysteresis)
  const PINCH_FREEZE = 0.5; // below = fingers closing, cursor locks in place
  const SMOOTH = 0.35;      // cursor EMA factor per frame
  const BAND = [0.2, 0.8];  // fraction of the frame mapped to the full viewport
  const SCROLL_GAIN = 2.5;  // viewport heights scrolled per frame height of hand travel
  const CLICKABLE = 'a,button,[role="button"],summary,label,input,select,textarea';

  if (window.innerWidth < MIN_WIDTH || !navigator.mediaDevices?.getUserMedia) return;

  const st = { on: false, loading: false, vision: null, landmarker: null, stream: null,
               video: null, cam: null, cursor: null, raf: 0 };

  const label = (t) => { BTN.innerHTML = '<span class="dot"></span> ' + t; };
  BTN.disabled = false;
  BTN.title = 'Control this page with your hand. Camera stays in your browser.';
  label('Hand control');
  BTN.addEventListener('click', () => (st.on || st.loading) ? stop() : showConsent());

  // Project-card badge: <a href="...#levitap-toggle">
  document.querySelectorAll('a[href$="#levitap-toggle"]').forEach((a) => {
    a.addEventListener('click', (e) => { e.preventDefault(); if (!st.on) showConsent(); });
  });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && (st.on || st.loading)) stop(); });
  document.addEventListener('visibilitychange', () => { if (document.hidden && st.on) stop(); });

  // Hand control survives navigation within the site: an internal link sets a
  // one-shot flag that the next page consumes to start again without asking.
  // An off-site link opens a new tab, so this page switches it off instead.
  const CARRY = 'levitap-carry';
  document.addEventListener('click', (e) => {
    const a = e.target.closest('a[href]');
    if (!a || !st.on || e.defaultPrevented) return;
    const internal = a.origin === location.origin && !a.target;
    if (internal) sessionStorage.setItem(CARRY, '1');
    else stop();
  });
  if (sessionStorage.getItem(CARRY)) {
    sessionStorage.removeItem(CARRY);
    start();
  }

  // ---- consent ------------------------------------------------------------

  let box = null;
  function panel(html) {
    if (!box) {
      box = document.createElement('div');
      box.id = 'levitap-consent';
      document.body.appendChild(box);
    }
    box.innerHTML = html;
    box.classList.add('show');
    return box;
  }
  const hide = () => box && box.classList.remove('show');

  function showConsent() {
    panel('<p><b>Control this page with your hand.</b> This turns on your camera and ' +
          'runs hand tracking entirely in your browser. No video is uploaded, recorded ' +
          'or sent anywhere, including to me.</p>' +
          '<p>Move your hand to move the cursor, pinch thumb and index to click, hold up ' +
          'two fingers and move your hand to scroll. Esc turns it off.</p>' +
          '<button class="go" id="lt-go">Turn on camera</button> ' +
          '<button id="lt-no">Cancel</button>');
    box.querySelector('#lt-no').onclick = hide;
    box.querySelector('#lt-go').onclick = () => { hide(); start(); };
  }

  function showError(msg) {
    panel('<p><b>Couldn’t start hand control.</b> ' + msg + '</p><button id="lt-no">Close</button>');
    box.querySelector('#lt-no').onclick = hide;
  }

  // ---- start / stop -------------------------------------------------------

  async function start() {
    st.loading = true;
    label('Hand control · loading…');
    try {
      // Camera prompt and the ~6 MB runtime+model download run in parallel.
      const [stream] = await Promise.all([
        navigator.mediaDevices.getUserMedia({ video: { width: 640, height: 480, facingMode: 'user' } }),
        loadLandmarker()
      ]);
      if (!st.loading) { stream.getTracks().forEach((t) => t.stop()); return; } // cancelled
      st.stream = stream;
    } catch (err) {
      st.loading = false;
      label('Hand control');
      const denied = err && (err.name === 'NotAllowedError' || err.name === 'SecurityError');
      showError(denied ? 'Camera permission was refused. The page works as normal with a mouse.'
                       : 'Something failed while loading the tracker: ' + (err && err.message || err));
      return;
    }

    const cam = document.createElement('div');
    cam.id = 'levitap-cam';
    const video = document.createElement('video');
    video.autoplay = true; video.playsInline = true; video.muted = true;
    video.srcObject = st.stream;
    const hint = document.createElement('p');
    hint.textContent = 'move hand · pinch to click · two fingers to scroll · Esc to stop';
    cam.append(video, hint);
    document.body.appendChild(cam);

    const cursor = document.createElement('div');
    cursor.id = 'levitap-cursor';
    cursor.className = 'lost';
    cursor.style.transform = `translate(${window.innerWidth / 2}px, ${window.innerHeight / 2}px)`;
    document.body.appendChild(cursor);

    Object.assign(st, { on: true, loading: false, video, cam, cursor });
    label('Hand control · on');
    BTN.classList.add('on');
    st.raf = requestAnimationFrame(makeLoop());
  }

  async function loadLandmarker() {
    if (st.landmarker) return st.landmarker;
    st.vision = st.vision || await import(MP + '/vision_bundle.mjs');
    const files = await st.vision.FilesetResolver.forVisionTasks(MP + '/wasm');
    const opts = (delegate) => ({
      baseOptions: { modelAssetPath: MODEL, delegate },
      numHands: 1,
      runningMode: 'VIDEO',
      minHandDetectionConfidence: CONF,
      minHandPresenceConfidence: CONF,
      minTrackingConfidence: CONF
    });
    try {
      st.landmarker = await st.vision.HandLandmarker.createFromOptions(files, opts('GPU'));
    } catch (_) {
      st.landmarker = await st.vision.HandLandmarker.createFromOptions(files, opts('CPU'));
    }
    return st.landmarker;
  }

  function stop() {
    st.loading = false;
    st.on = false;
    cancelAnimationFrame(st.raf);
    if (st.stream) st.stream.getTracks().forEach((t) => t.stop());
    if (st.hover) st.hover.dispatchEvent(new PointerEvent('pointerleave'));
    document.dispatchEvent(new PointerEvent('pointerup', { bubbles: true }));
    st.cam?.remove();
    st.cursor?.remove();
    st.stream = st.video = st.cam = st.cursor = st.hover = null;
    BTN.classList.remove('on');
    label('Hand control');
  }

  // ---- tracking loop ------------------------------------------------------

  const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
  const clamp01 = (v) => Math.min(1, Math.max(0, v));
  const band = (u) => clamp01((u - BAND[0]) / (BAND[1] - BAND[0]));

  // A finger counts as extended when its tip is further from the wrist than
  // its PIP joint, which holds for any hand orientation the camera will see.
  // The cursor is driven by the index knuckle (MCP), not the fingertip: the
  // knuckle barely moves when you pinch, so the click lands where you aimed.
  function readHand(lm) {
    const wrist = lm[0];
    const size = dist(wrist, lm[9]) || 1e-6;          // wrist to middle MCP
    const ext = (tip, pip) => dist(lm[tip], wrist) > dist(lm[pip], wrist) * 1.1;
    return {
      point: lm[5],
      anchor: lm[9],
      pinch: dist(lm[4], lm[8]) / size,
      index: ext(8, 6), middle: ext(12, 10), ring: ext(16, 14), pinky: ext(20, 18)
    };
  }

  function makeLoop() {
    const { video, cursor, landmarker } = st;
    let lastT = -1;
    const cur = { x: window.innerWidth / 2, y: window.innerHeight / 2 };
    let pinching = false;
    let scrollAnchor = null;
    let hover = null;
    const pointer = (type, el) => el.dispatchEvent(new PointerEvent(type, {
      clientX: cur.x, clientY: cur.y, button: 0, bubbles: type !== 'pointerenter' && type !== 'pointerleave'
    }));

    return function frame() {
      if (!st.on) return;
      st.raf = requestAnimationFrame(frame);
      if (video.readyState < 2 || video.currentTime === lastT) return;
      lastT = video.currentTime;

      const res = landmarker.detectForVideo(video, performance.now());
      const lm = res.landmarks && res.landmarks[0];
      if (!lm) {
        cursor.classList.add('lost');
        if (pinching) pointer('pointerup', document);
        if (hover) { pointer('pointerleave', hover); hover = st.hover = null; }
        pinching = false; scrollAnchor = null;
        return;
      }
      cursor.classList.remove('lost');
      const h = readHand(lm);

      // Cursor follows the index knuckle, and freezes as soon as the thumb
      // starts closing in so the pinch itself can't drag it off target.
      // The preview is mirrored, so flip x.
      if (h.pinch >= PINCH_FREEZE && !pinching) {
        const tx = band(1 - h.point.x) * window.innerWidth;
        const ty = band(h.point.y) * window.innerHeight;
        cur.x += (tx - cur.x) * SMOOTH;
        cur.y += (ty - cur.y) * SMOOTH;
        cursor.style.transform = `translate(${cur.x}px, ${cur.y}px)`;
        pointer('pointermove', document);
      }

      const under = document.elementFromPoint(cur.x, cur.y);
      const target = under && under.closest(CLICKABLE);
      cursor.classList.toggle('over', !!target);
      if (target !== hover) {
        // Hand the hover to anything listening for a real pointer, such as
        // the arm in the hero, which plans a grasp on pointerenter.
        if (hover) pointer('pointerleave', hover);
        if (target) pointer('pointerenter', target);
        hover = st.hover = target;
      }

      // Pinch with hysteresis; click on the closing edge.
      const wasPinching = pinching;
      pinching = pinching ? h.pinch < PINCH_OFF : h.pinch < PINCH_ON;
      cursor.classList.toggle('pinch', pinching);
      if (pinching && !wasPinching && target) {
        pointer('pointerdown', target);
        target.focus?.({ preventScroll: true });
        if (target.matches('a[target="_blank"]')) {
          // A synthetic click can't open a new tab (browsers treat it as a
          // popup and block it), so off-site links are followed in this tab.
          stop();
          location.href = target.href;
        } else {
          target.click();
        }
      }
      if (!pinching && wasPinching) pointer('pointerup', document);

      // Two fingers up (index + middle, ring + pinky folded): vertical hand
      // travel scrolls the page, content following the hand like a trackpad.
      const twoUp = !pinching && h.index && h.middle && !h.ring && !h.pinky;
      cursor.classList.toggle('scroll', twoUp);
      if (twoUp) {
        if (scrollAnchor !== null) {
          window.scrollBy(0, (scrollAnchor - h.anchor.y) * window.innerHeight * SCROLL_GAIN);
        }
        scrollAnchor = h.anchor.y;
      } else {
        scrollAnchor = null;
      }
    };
  }
})();
