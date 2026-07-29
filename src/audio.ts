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
  private engineSub: OscillatorNode | null = null;
  private engineGain: GainNode | null = null;
  private engineFilter: BiquadFilterNode | null = null;
  private rushGain: GainNode | null = null;
  private rushFilter: BiquadFilterNode | null = null;
  private sirenOsc: OscillatorNode | null = null;
  private sirenGain: GainNode | null = null;
  private noiseBuffer: AudioBuffer | null = null;
  private sirenPhase = 0;
  /** True while the loops are meant to stay silent (run over, or tab hidden). */
  private silenced = false;

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

      // Shared noise buffer for impacts, the boost whoosh and the tyre rush.
      const frames = ctx.sampleRate * 0.5;
      const buf = ctx.createBuffer(1, frames, ctx.sampleRate);
      const data = buf.getChannelData(0);
      for (let i = 0; i < frames; i++) data[i] = Math.random() * 2 - 1;
      this.noiseBuffer = buf;
      this.watchVisibility();

      /*
       * Engine.
       *
       * Two detuned triangles and a band of filtered noise, rather than the raw sawtooth
       * this started as. A saw swept through a lowpass across the exact band the ear is
       * most sensitive in is the classic angry-wasp drone: correct in principle, tiring
       * within about thirty seconds, and this is a game you are meant to sit in for
       * minutes at a time. Triangles carry the pitch without the harmonic bite, and
       * moving most of the loudness into the noise layer means speed reads as *rush*
       * rather than as a louder buzz.
       */
      this.engineOsc = ctx.createOscillator();
      this.engineOsc.type = "triangle";
      this.engineOsc.frequency.value = 128;
      this.engineSub = ctx.createOscillator();
      this.engineSub.type = "triangle";
      this.engineSub.frequency.value = 64;
      this.engineFilter = ctx.createBiquadFilter();
      this.engineFilter.type = "lowpass";
      this.engineFilter.frequency.value = 900;
      this.engineGain = ctx.createGain();
      this.engineGain.gain.value = 0;
      this.engineOsc.connect(this.engineFilter);
      this.engineSub.connect(this.engineFilter);
      this.engineFilter.connect(this.engineGain);
      this.engineGain.connect(this.master);
      this.engineOsc.start();
      this.engineSub.start();

      // Tyre and wind rush: a looping noise bed opened up by speed.
      if (this.noiseBuffer) {
        const rush = ctx.createBufferSource();
        rush.buffer = this.noiseBuffer;
        rush.loop = true;
        this.rushFilter = ctx.createBiquadFilter();
        this.rushFilter.type = "bandpass";
        this.rushFilter.frequency.value = 500;
        this.rushFilter.Q.value = 0.7;
        this.rushGain = ctx.createGain();
        this.rushGain.gain.value = 0;
        rush.connect(this.rushFilter);
        this.rushFilter.connect(this.rushGain);
        this.rushGain.connect(this.master);
        rush.start();
      }

      // Siren: single oscillator, frequency flipped between two tones.
      this.sirenOsc = ctx.createOscillator();
      this.sirenOsc.type = "square";
      this.sirenOsc.frequency.value = 760;
      this.sirenGain = ctx.createGain();
      this.sirenGain.gain.value = 0;
      this.sirenOsc.connect(this.sirenGain);
      this.sirenGain.connect(this.master);
      this.sirenOsc.start();
    } catch {
      this.ctx = null;
    }
  }

  resume(): void {
    if (this.ctx?.state === "suspended") void this.ctx.resume();
  }

  /** Called every frame with the player's speed ratio and nearest police distance. */
  updateLoop(dt: number, speedRatio: number, boosting: boolean, nearestPolice: number): void {
    if (this.silenced) return;
    if (!this.ctx || !this.engineOsc || !this.engineGain || !this.engineFilter) return;
    const t = this.ctx.currentTime;

    // Up an octave from where this sat: the low version read as a diesel idling rather
    // than a car being driven, and there was nothing in it that rose when you did.
    const pitch = 128 + speedRatio * 235 + (boosting ? 60 : 0);
    this.engineOsc.frequency.setTargetAtTime(pitch, t, 0.06);
    if (this.engineSub) this.engineSub.frequency.setTargetAtTime(pitch * 0.5, t, 0.06);
    this.engineFilter.frequency.setTargetAtTime(750 + speedRatio * 1500, t, 0.1);
    // Quieter than it was, and it stays quiet: the rush layer carries the sense of speed.
    this.engineGain.gain.setTargetAtTime(0.035 + speedRatio * 0.045, t, 0.12);

    if (this.rushGain && this.rushFilter) {
      this.rushFilter.frequency.setTargetAtTime(420 + speedRatio * 1500, t, 0.1);
      this.rushGain.gain.setTargetAtTime(speedRatio * speedRatio * 0.075 + (boosting ? 0.03 : 0), t, 0.12);
    }

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
  /**
   * Silence everything that loops.
   *
   * `rushGain` was missing from this, and more importantly `updateLoop` kept being called
   * every frame after the run ended — so it immediately reset the engine gain back to its
   * idle value and the car sat there humming behind the BUSTED card indefinitely. Callers
   * must stop driving the loops as well as asking for quiet; `updateLoop` now refuses to
   * do anything once silenced.
   */
  quietLoops(): void {
    this.silenced = true;
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    this.engineGain?.gain.setTargetAtTime(0, t, 0.12);
    this.sirenGain?.gain.setTargetAtTime(0, t, 0.12);
    this.rushGain?.gain.setTargetAtTime(0, t, 0.12);
  }

  /** Let the loops run again — called when a new run starts. */
  resumeLoops(): void {
    this.silenced = false;
  }

  /**
   * Drop everything when the tab goes away, and stay quiet until it comes back.
   *
   * A browser will happily keep an oscillator running in a background tab, which is how a
   * finished run ends up humming at somebody from a window they are no longer looking at.
   */
  private watchVisibility(): void {
    document.addEventListener("visibilitychange", () => {
      if (document.hidden) void this.ctx?.suspend();
      else if (!this.silenced) void this.ctx?.resume();
    });
  }
}
