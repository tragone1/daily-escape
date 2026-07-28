/**
 * Tiny generated-sound layer. No asset files: everything is oscillators and a noise
 * buffer. Entirely optional — every method degrades to a no-op if WebAudio is
 * unavailable or has not been unlocked by a user gesture yet.
 */

import { CONFIG } from "./config";
import { clamp } from "./math";

export class GameAudio {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private engineOsc: OscillatorNode | null = null;
  private engineGain: GainNode | null = null;
  private engineFilter: BiquadFilterNode | null = null;
  private sirenOsc: OscillatorNode | null = null;
  private sirenGain: GainNode | null = null;
  private noiseBuffer: AudioBuffer | null = null;
  private sirenPhase = 0;

  /** Must be called from a user gesture (browsers block audio otherwise). */
  init(): void {
    if (this.ctx || !CONFIG.audio.enabled) return;
    try {
      const Ctor =
        window.AudioContext ??
        (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!Ctor) return;
      const ctx = new Ctor();
      this.ctx = ctx;

      this.master = ctx.createGain();
      this.master.gain.value = CONFIG.audio.masterVolume;
      this.master.connect(ctx.destination);

      // Engine: a filtered saw whose pitch tracks speed.
      this.engineOsc = ctx.createOscillator();
      this.engineOsc.type = "sawtooth";
      this.engineOsc.frequency.value = 60;
      this.engineFilter = ctx.createBiquadFilter();
      this.engineFilter.type = "lowpass";
      this.engineFilter.frequency.value = 500;
      this.engineGain = ctx.createGain();
      this.engineGain.gain.value = 0;
      this.engineOsc.connect(this.engineFilter);
      this.engineFilter.connect(this.engineGain);
      this.engineGain.connect(this.master);
      this.engineOsc.start();

      // Siren: single oscillator, frequency flipped between two tones.
      this.sirenOsc = ctx.createOscillator();
      this.sirenOsc.type = "square";
      this.sirenOsc.frequency.value = 760;
      this.sirenGain = ctx.createGain();
      this.sirenGain.gain.value = 0;
      this.sirenOsc.connect(this.sirenGain);
      this.sirenGain.connect(this.master);
      this.sirenOsc.start();

      // Shared noise buffer for impacts and the boost whoosh.
      const frames = ctx.sampleRate * 0.5;
      const buf = ctx.createBuffer(1, frames, ctx.sampleRate);
      const data = buf.getChannelData(0);
      for (let i = 0; i < frames; i++) data[i] = Math.random() * 2 - 1;
      this.noiseBuffer = buf;
    } catch {
      this.ctx = null;
    }
  }

  resume(): void {
    if (this.ctx?.state === "suspended") void this.ctx.resume();
  }

  /** Called every frame with the player's speed ratio and nearest police distance. */
  updateLoop(dt: number, speedRatio: number, boosting: boolean, nearestPolice: number): void {
    if (!this.ctx || !this.engineOsc || !this.engineGain || !this.engineFilter) return;
    const t = this.ctx.currentTime;

    const pitch = 62 + speedRatio * 190 + (boosting ? 45 : 0);
    this.engineOsc.frequency.setTargetAtTime(pitch, t, 0.05);
    this.engineFilter.frequency.setTargetAtTime(400 + speedRatio * 1600, t, 0.08);
    this.engineGain.gain.setTargetAtTime(0.05 + speedRatio * 0.09, t, 0.1);

    if (this.sirenOsc && this.sirenGain) {
      // Proximity-driven volume gives you an audible cue before you see them.
      const proximity = clamp(1 - nearestPolice / 70, 0, 1);
      this.sirenGain.gain.setTargetAtTime(proximity * proximity * 0.06, t, 0.15);
      this.sirenPhase += dt;
      if (this.sirenPhase > 0.42) {
        this.sirenPhase = 0;
        const hi = this.sirenOsc.frequency.value > 850;
        this.sirenOsc.frequency.setTargetAtTime(hi ? 700 : 980, t, 0.02);
      }
    }
  }

  private burst(duration: number, volume: number, filterFrom: number, filterTo: number): void {
    if (!this.ctx || !this.noiseBuffer || !this.master) return;
    const ctx = this.ctx;
    const src = ctx.createBufferSource();
    src.buffer = this.noiseBuffer;
    const filter = ctx.createBiquadFilter();
    filter.type = "lowpass";
    filter.frequency.setValueAtTime(filterFrom, ctx.currentTime);
    filter.frequency.exponentialRampToValueAtTime(
      Math.max(40, filterTo),
      ctx.currentTime + duration,
    );
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(volume, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + duration);
    src.connect(filter);
    filter.connect(gain);
    gain.connect(this.master);
    src.start();
    src.stop(ctx.currentTime + duration);
  }

  impact(strength: number): void {
    this.burst(0.18 + strength * 0.12, 0.14 + strength * 0.3, 1400, 120);
  }

  boost(): void {
    this.burst(0.5, 0.22, 300, 3200);
  }

  /** Short bright chirp when a pickup is collected. */
  pickup(): void {
    this.tone(880, 0, 0.12, 0.16);
    this.tone(1320, 0.06, 0.14, 0.12);
  }

  rocketLaunch(): void {
    this.burst(0.35, 0.3, 2600, 500);
  }

  /** Low, long and loud — the blast should land harder than any collision. */
  explosion(): void {
    this.burst(0.75, 0.55, 900, 60);
    this.tone(70, 0, 0.5, 0.3);
  }

  private tone(freq: number, start: number, duration: number, volume: number): void {
    if (!this.ctx || !this.master) return;
    const ctx = this.ctx;
    const osc = ctx.createOscillator();
    osc.type = "triangle";
    osc.frequency.value = freq;
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0.0001, ctx.currentTime + start);
    gain.gain.exponentialRampToValueAtTime(volume, ctx.currentTime + start + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + start + duration);
    osc.connect(gain);
    gain.connect(this.master);
    osc.start(ctx.currentTime + start);
    osc.stop(ctx.currentTime + start + duration + 0.05);
  }

  victory(): void {
    [523, 659, 784, 1047].forEach((f, i) => this.tone(f, i * 0.11, 0.35, 0.18));
  }

  failure(): void {
    [392, 330, 262, 196].forEach((f, i) => this.tone(f, i * 0.14, 0.45, 0.16));
  }

  /** Silence the continuous loops when a run ends. */
  quietLoops(): void {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    this.engineGain?.gain.setTargetAtTime(0, t, 0.2);
    this.sirenGain?.gain.setTargetAtTime(0, t, 0.2);
  }
}
