// Red Eye — camera loop.
// Opens the camera, feeds every frame to the detector, and the result to the BlinkEngine.
// Frames are read through MediaStreamTrackProcessor (driven by the camera itself, so it is
// not throttled when the page is hidden, e.g. in the offscreen document). A <video> +
// setInterval fallback is used where that API does not exist.

export class CameraLoop {
  constructor({ detector, engine, onState, onFrame, onError, stateEveryMs = 500 }) {
    this.detector = detector;
    this.engine = engine;
    this.onState = onState || (() => {});
    this.onFrame = onFrame || (() => {});
    this.onError = onError || (() => {});
    this.stateEveryMs = stateEveryMs;
    this.running = false;
    this.stream = null;
    this._lastEmit = 0;
    this._fails = 0;
  }

  async start({ hiRes = true, fps = 30, deviceId } = {}) {
    this.stop();
    const video = {
      width: { ideal: hiRes ? 1280 : 640 },
      height: { ideal: hiRes ? 720 : 480 },
      frameRate: { ideal: fps, min: 15 },
      facingMode: 'user'
    };
    if (deviceId) video.deviceId = { exact: deviceId };
    this.stream = await navigator.mediaDevices.getUserMedia({ video, audio: false });
    this.track = this.stream.getVideoTracks()[0];
    this.running = true;
    this._fails = 0;
    this._lastEmit = 0;
    this._off = null;
    this.fps = fps;
    if ('MediaStreamTrackProcessor' in globalThis) this._runProcessor();
    else this._runVideo();
    return this.stream;
  }

  stop() {
    this.running = false;
    if (this._timer) { clearInterval(this._timer); this._timer = null; }
    if (this._reader) { try { this._reader.cancel(); } catch (_) {} this._reader = null; }
    if (this.stream) { this.stream.getTracks().forEach(t => t.stop()); this.stream = null; }
    if (this._video) { this._video.srcObject = null; this._video = null; }
  }

  _process(source, tsMs, w, h) {
    try {
      const r = this.detector.detect(source, tsMs, w, h);
      const sample = { t: tsMs, openness: r.openness, faceOk: r.faceOk, noFace: r.noFace };
      const state = this.engine.push(sample);
      this._fails = 0;
      this.onFrame(r, state, sample);
      if (tsMs - this._lastEmit >= this.stateEveryMs) {
        this._lastEmit = tsMs;
        this.onState(state);
      }
    } catch (err) {
      if (++this._fails >= 30) { this._fails = 0; this.onError(err); }
    }
  }

  async _runProcessor() {
    const proc = new MediaStreamTrackProcessor({ track: this.track, maxBufferSize: 1 });
    const reader = proc.readable.getReader();
    this._reader = reader;
    try {
      while (this.running) {
        const { value: frame, done } = await reader.read();
        if (done || !frame) break;
        try {
          // Keep the camera's exact frame spacing, but anchor it to performance.now() so
          // time stays monotonic across camera restarts (rest -> work).
          const ts = frame.timestamp / 1000;
          if (this._off == null) this._off = performance.now() - ts;
          this._process(frame, ts + this._off, frame.displayWidth, frame.displayHeight);
        } finally {
          frame.close();
        }
      }
    } catch (err) {
      if (this.running) this.onError(err);
    }
  }

  async _runVideo() {
    const v = document.createElement('video');
    v.muted = true; v.playsInline = true; v.srcObject = this.stream;
    this._video = v;
    await v.play();
    let lastTime = -1;
    this._timer = setInterval(() => {
      if (!this.running || v.readyState < 2 || v.currentTime === lastTime) return;
      lastTime = v.currentTime;
      this._process(v, performance.now(), v.videoWidth, v.videoHeight);
    }, Math.round(1000 / this.fps));
  }
}
