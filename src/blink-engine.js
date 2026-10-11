// Red Eye — blink & fatigue engine.
// Pure logic: no DOM, no MediaPipe. Feed it one sample per camera frame:
//   sample = { t: ms, openness: 0..1 (1 = fully open, 0 = closed) | null, faceOk: boolean }
// `openness` is the fused signal built in detector.js (blendshapes + EAR).

export const DEFAULTS = {
  calibrationMs: 6000,        // learn the user's "eyes open" level
  closeFrac: 0.6,             // below baseline*closeFrac  => eye is closed
  openFrac: 0.78,             // above baseline*openFrac   => eye is open again (hysteresis)
  minBlinkMs: 40,             // shorter than this = noise
  maxBlinkMs: 400,            // longer than this = long closure, not a normal blink
  microsleepMs: 1000,         // closure this long = drowsiness event
  partialBand: [0.6, 0.88],    // a quick dip inside this band = incomplete blink
  partialMaxMs: 400,
  windowMs: 60000,            // rolling window for the blink rate
  smooth: 0.35,               // EMA on the openness signal (0 = none)
  faceLostMs: 1500,           // face missing this long => pause measuring
  lowBpm: 10,                 // blinks/min below this = staring at the screen
  minRateMs: 10000,           // need this much valid face time before reporting a rate
  readyMs: 30000,             // need this much tracked time before judging fatigue
  earlyMs: 120000             // first N ms of a session = "fresh eyes" reference
};

const median = (a) => {
  const s = a.slice().sort((x, y) => x - y);
  return s[Math.floor(s.length / 2)];
};

export class BlinkEngine {
  constructor(opts = {}) {
    this.o = { ...DEFAULTS, ...opts };
    this.phase = 'calibrating';   // 'calibrating' | 'tracking'
    this.baseline = null;
    this._resetCalibration();
    this.newSession();
  }

  _resetCalibration() {
    this.calStart = null;
    this.calSamples = [];
    this.ema = null;
  }

  // Full reset (new person / camera moved): recalibrates.
  recalibrate() {
    this.phase = 'calibrating';
    this.baseline = null;
    this._resetCalibration();
    this.newSession();
  }

  // Start of a new 20-minute session: keeps the calibration, clears the counters.
  newSession() {
    this.closed = false;
    this.closeStart = 0;
    this.minInClose = 1;
    this.blinks = [];            // {t, dur, depth}
    this.longClosures = [];      // {t, dur}
    this.microsleeps = [];       // t
    this.partials = [];          // t
    this.validLog = [];          // {t, dt}: face-valid time inside the rolling window
    this.recent = [];            // {t, v}: normalised openness, last 60 s
    this.earlyBuf = [];
    this.earlyMed = null;
    this.trackMs = 0;
    this.total = 0;
    this._dip = null; this._dipStart = 0; this._dipT = 0;
    this._ignoreUntilOpen = false;
    this._microFlag = false;
    this.lastT = null;
    this.lastSeen = null;
    this.faceMissing = false;
  }

  _finishCalibration() {
    if (this.calSamples.length < 20) { this._resetCalibration(); return; }
    // Median of the upper half: blinks are ~10% of the time, so they never reach it.
    const m = median(this.calSamples);
    this.baseline = median(this.calSamples.filter(v => v >= m));
    this.phase = 'tracking';
  }

  push(sample) {
    const { t, faceOk } = sample;
    const dt = this.lastT == null ? 0 : Math.min(Math.max(t - this.lastT, 0), 500);
    this.lastT = t;

    // "noFace" = no face in frame at all. "faceOk=false" alone = a face is there
    // but unusable (looking down / turned away): pause measuring, but it is not a break.
    if (this.lastSeen == null) this.lastSeen = t;
    if (!sample.noFace) this.lastSeen = t;
    this.faceMissing = t - this.lastSeen > this.o.faceLostMs;

    if (!faceOk || sample.openness == null) {
      this.closed = false;             // never count a blink across a lost / unusable face
      this._dip = null;
      return this.state(t);
    }

    let v = sample.openness;
    this.ema = this.ema == null ? v : this.ema + (v - this.ema) * (1 - this.o.smooth);
    v = this.ema;

    if (this.phase === 'calibrating') {
      if (this.calStart == null) this.calStart = t;
      this.calSamples.push(v);
      if (t - this.calStart >= this.o.calibrationMs) this._finishCalibration();
      return this.state(t);
    }

    this.trackMs += dt;
    this.validLog.push({ t, dt });
    this._track(t, v);
    return this.state(t);
  }

  _track(t, v) {
    const o = this.o;
    const norm = v / this.baseline;

    // slow baseline drift (light / posture); only while clearly open
    if (!this.closed && norm > 0.9) this.baseline += (v - this.baseline) * 0.002;

    this.recent.push({ t, v: norm });
    if (this.earlyMed == null) {
      this.earlyBuf.push(norm);
      if (this.trackMs >= o.earlyMs) this.earlyMed = median(this.earlyBuf);
    }

    if (!this.closed) {
      if (norm < o.closeFrac) {
        this.closed = true;
        this.closeStart = t;
        this.minInClose = norm;
        this._dip = null;
      } else if (this._ignoreUntilOpen) {
        if (norm >= o.partialBand[1]) this._ignoreUntilOpen = false;
      } else if (norm < o.partialBand[1]) {
        if (this._dip == null) { this._dip = norm; this._dipStart = t; }
        this._dip = Math.min(this._dip, norm);
        this._dipT = t;
      } else if (this._dip != null) {
        const d = t - this._dipStart;
        if (d >= 30 && d <= o.partialMaxMs && this._dip < 0.8) this.partials.push(this._dipT);
        this._dip = null;
      }
    } else {
      this.minInClose = Math.min(this.minInClose, norm);
      if (norm > o.openFrac) {
        const dur = t - this.closeStart;
        this.closed = false;
        this._ignoreUntilOpen = true;
        this._microFlag = false;
        if (dur >= o.minBlinkMs && dur <= o.maxBlinkMs) {
          this.blinks.push({ t, dur, depth: this.minInClose });
          this.total++;
        } else if (dur > o.maxBlinkMs) {
          this.longClosures.push({ t, dur });
        }
      } else if (t - this.closeStart > o.microsleepMs && !this._microFlag) {
        this._microFlag = true;
        this.microsleeps.push(t);
      }
    }
    this._prune(t);
  }

  _prune(t) {
    const cut = t - this.o.windowMs;
    const drop = (arr, key) => { while (arr.length && (key ? arr[0][key] : arr[0]) < cut) arr.shift(); };
    drop(this.blinks, 't'); drop(this.longClosures, 't'); drop(this.validLog, 't');
    drop(this.microsleeps); drop(this.partials);
    const cut2 = t - 60000;
    while (this.recent.length && this.recent[0].t < cut2) this.recent.shift();
  }

  validMs() { return this.validLog.reduce((s, x) => s + x.dt, 0); }

  bpm() {
    if (this.phase !== 'tracking') return null;
    const win = this.validMs();
    if (win < this.o.minRateMs) return null;
    return (this.blinks.length * 60000) / win;
  }

  // How much lower the lids sit now vs. the start of the session (0.1 = 10% lower).
  opennessDrop() {
    if (this.earlyMed == null || this.recent.length < 100) return 0;
    return Math.max(0, this.earlyMed - median(this.recent.map(x => x.v)));
  }

  // Fatigue score 0..100 from independent signs.
  fatigue() {
    if (this.phase !== 'tracking' || this.trackMs < this.o.readyMs) {
      return { score: 0, reasons: [], ready: false };
    }
    const reasons = [];
    let score = 0;

    const bpm = this.bpm();
    if (bpm != null) {
      if (bpm < 6) { score += 40; reasons.push('low_rate'); }
      else if (bpm < this.o.lowBpm) { score += 25; reasons.push('low_rate'); }
    }

    if (this.longClosures.length >= 3) { score += 30; reasons.push('long_blinks'); }
    else if (this.longClosures.length >= 1) score += 12;

    const nB = this.blinks.length;
    if (nB >= 8) {
      const avg = this.blinks.reduce((s, b) => s + b.dur, 0) / nB;
      if (avg > 300) { score += 18; reasons.push('slow_blinks'); }
    }
    if (this.partials.length >= 4 && this.partials.length / (this.partials.length + nB) > 0.4) {
      score += 15; reasons.push('partial_blinks');
    }

    const drop = this.opennessDrop();
    if (drop > 0.12) { score += 25; reasons.push('heavy_lids'); }
    else if (drop > 0.07) score += 12;

    if (this.microsleeps.length >= 1) { score += 35; reasons.push('microsleep'); }

    return { score: Math.min(100, score), reasons, ready: true };
  }

  state() {
    const f = this.fatigue();
    return {
      phase: this.phase,
      calibrationProgress: this.phase === 'tracking' ? 1
        : (this.calStart != null && this.lastT != null
          ? Math.min(1, (this.lastT - this.calStart) / this.o.calibrationMs) : 0),
      faceMissing: this.faceMissing,
      bpm: this.bpm(),
      totalBlinks: this.total,
      closed: this.closed,
      longClosures: this.longClosures.length,
      microsleeps: this.microsleeps.length,
      fatigue: f.score,
      fatigueReasons: f.reasons,
      fatigueReady: f.ready
    };
  }
}
