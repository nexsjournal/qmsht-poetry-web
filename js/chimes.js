// Web Audio 合成钟声（无音频文件）。结构移植自 marinabudarina/chimes 的 chimes.js，
// 音色改为单一「青铜钟」：五声 C-D-E-G-A，偏磬的部分谐波。
const PROFILE = {
  // 宫商角徵羽（C D E G A）两列八音
  freqs: [261.63, 293.66, 329.63, 392.0, 440.0, 523.25, 587.33, 659.25],
  partials: [
    { ratio: 1.0, gain: 0.62 },
    { ratio: 1.5, gain: 0.12 },
    { ratio: 2.0, gain: 0.2 },
    { ratio: 2.76, gain: 0.22 },
    { ratio: 4.07, gain: 0.06 }
  ],
  duration: 1.45,
  attack: 0.018,
  peak: 0.2,
  droop: 0.988,
  noiseDur: 0.05,
  noiseGain: 0.06,
  noiseQ: 2.5,
  noiseMul: 1.6,
  shelfHz: 1200,
  shelfGain: 1,
  minIntervalMs: 60
};

class StringChimes {
  constructor() {
    this.enabled = true;
    this.ctx = null;
    this.master = null;
    this.shelf = null;
    this.volume = 0.28;
    this.lastStrikeAt = 0;
    this.activeVoices = 0;
    this.maxVoices = 10;
    this.lastParticleId = -1;
    this.prevX = 0;
    this.prevY = 0;
  }

  async ensure() {
    if (!this.ctx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return false;
      this.ctx = new AC();
      this.master = this.ctx.createGain();
      this.master.gain.value = this.volume;
      this.shelf = this.ctx.createBiquadFilter();
      this.shelf.type = "highshelf";
      this.shelf.frequency.value = PROFILE.shelfHz;
      this.shelf.gain.value = PROFILE.shelfGain;
      this.master.connect(this.shelf);
      this.shelf.connect(this.ctx.destination);
    }
    if (this.ctx.state === "suspended") {
      try {
        await this.ctx.resume();
      } catch (_) {
        return false;
      }
    }
    return true;
  }

  setVolume(v) {
    this.volume = Math.max(0, Math.min(1, v));
    if (this.master) this.master.gain.value = this.volume;
  }

  /**
   * @param {{ x:number, y:number, particle?:{id:number}, gridW?:number, intensity?:number, force?:boolean }} opts
   */
  async strike(opts = {}) {
    if (!this.enabled) return;
    const ok = await this.ensure();
    if (!ok || !this.ctx) return;

    const now = performance.now();
    const force = !!opts.force;
    if (!force && now - this.lastStrikeAt < PROFILE.minIntervalMs) return;
    if (this.activeVoices >= this.maxVoices) return;

    const particle = opts.particle;
    if (particle && particle.id === this.lastParticleId && !force) return;

    const dx = (opts.x ?? 0) - this.prevX;
    const dy = (opts.y ?? 0) - this.prevY;
    const speed = Math.hypot(dx, dy);
    this.prevX = opts.x ?? this.prevX;
    this.prevY = opts.y ?? this.prevY;

    let intensity = opts.intensity;
    if (intensity == null) intensity = Math.min(1, 0.25 + speed / 40);
    if (!force && intensity < 0.2 && speed < 1.5) return;

    this.lastStrikeAt = now;
    if (particle) this.lastParticleId = particle.id;

    // 音高随列位置：左→右 C→E，横移如弹筝
    const freqs = PROFILE.freqs;
    const pitchT =
      particle && opts.gridW > 1
        ? (particle.id % opts.gridW) / (opts.gridW - 1)
        : Math.random();
    const idx = Math.min(
      freqs.length - 1,
      Math.max(0, Math.round(pitchT * (freqs.length - 1) + (Math.random() - 0.5)))
    );
    const freq = freqs[idx] * (0.985 + Math.random() * 0.03);
    this.playBell(freq, intensity);
  }

  playBell(freq, intensity) {
    const ctx = this.ctx;
    const t = ctx.currentTime;
    const duration = PROFILE.duration * (0.75 + intensity * 0.5);

    const voice = ctx.createGain();
    const peak = PROFILE.peak * (0.55 + intensity * 0.7);
    voice.gain.setValueAtTime(0.0001, t);
    voice.gain.exponentialRampToValueAtTime(Math.max(0.0002, peak), t + PROFILE.attack);
    voice.gain.exponentialRampToValueAtTime(0.0001, t + duration);
    voice.connect(this.master);

    this.activeVoices += 1;
    setTimeout(() => {
      this.activeVoices = Math.max(0, this.activeVoices - 1);
    }, (duration + 0.05) * 1000);

    for (const { ratio, gain } of PROFILE.partials) {
      const osc = ctx.createOscillator();
      const g = ctx.createGain();
      osc.type = "sine";
      const f0 = freq * ratio;
      osc.frequency.setValueAtTime(f0, t);
      osc.frequency.exponentialRampToValueAtTime(Math.max(20, f0 * PROFILE.droop), t + duration);
      g.gain.value = gain;
      osc.connect(g);
      g.connect(voice);
      osc.start(t);
      osc.stop(t + duration + 0.02);
    }

    const buffer = ctx.createBuffer(1, Math.max(1, Math.floor(ctx.sampleRate * PROFILE.noiseDur)), ctx.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < data.length; i++) data[i] = (Math.random() * 2 - 1) * (1 - i / data.length);
    const noise = ctx.createBufferSource();
    noise.buffer = buffer;
    const noiseFilter = ctx.createBiquadFilter();
    noiseFilter.type = "bandpass";
    noiseFilter.frequency.value = freq * PROFILE.noiseMul;
    noiseFilter.Q.value = PROFILE.noiseQ;
    const noiseGain = ctx.createGain();
    noiseGain.gain.setValueAtTime(Math.max(0.0001, PROFILE.noiseGain * intensity), t);
    noiseGain.gain.exponentialRampToValueAtTime(0.0001, t + PROFILE.noiseDur);
    noise.connect(noiseFilter);
    noiseFilter.connect(noiseGain);
    noiseGain.connect(voice);
    noise.start(t);
    noise.stop(t + PROFILE.noiseDur + 0.01);
  }
}

export const chimes = new StringChimes();
