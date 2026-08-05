'use client';

// Orbital Sonification — "Music of the Spheres"
//
// A real, always-on ambient space soundtrack, generated entirely in the Web
// Audio API so nothing is downloaded (it works offline, like the rest of the
// bundled site). Two layers:
//
//  1. A generative SPACE BED that plays the moment sound is enabled, with or
//     without a satellite selected: a slow four-voice pad that drifts through a
//     small set of consonant chords, a high shimmer detuned a few cents for a
//     slow beating, and a filtered-noise "solar wind" underneath. This is the
//     soundtrack the user hears.
//
//  2. A LEAD voice layered on top that tracks the selected satellite — its
//     altitude sets the pitch, its speed the pulse — so selecting a bird adds a
//     melodic line over the bed rather than replacing it.
//
// Everything is scheduled through a single AudioContext and torn down cleanly
// on disable/unmount. No per-frame work: the bed evolves on a slow timer and
// with long setTargetAtTime glides, so it costs effectively nothing.

import { useEffect, useRef, useCallback } from 'react';
import { SatData, getSatelliteRealtimeInfo } from '@/lib/satellite';

// Pentatonic scale frequencies (C3 → C6, 5 octaves, very consonant)
const PENTATONIC = [
  130.81, 146.83, 164.81, 196.0, 220.0, // C3 D3 E3 G3 A3
  261.63, 293.66, 329.63, 392.0, 440.0, // C4 D4 E4 G4 A4
  523.25, 587.33, 659.25, 783.99, 880.0, // C5 D5 E5 G5 A5
  1046.5, // C6
];

// Chord bed: slow progression of four-note voicings (Hz), low and wide so it
// reads as "vast/space" rather than "melody". Roughly Am9 → Fmaj7 → Cadd9 →
// Gsus — all sharing tones, so voices glide a small interval between chords.
const CHORDS: number[][] = [
  [110.0, 164.81, 220.0, 329.63], // A2 E3 A3 E4
  [87.31, 130.81, 174.61, 261.63], // F2 C3 F3 C4
  [130.81, 196.0, 261.63, 392.0], // C3 G3 C4 G4
  [98.0, 146.83, 196.0, 293.66], // G2 D3 G3 D4
];

// Map altitude (km) to a pentatonic index
function altToNote(altKm: number): number {
  const t = Math.max(0, Math.min(1, (altKm - 150) / 40000));
  return Math.floor(t * (PENTATONIC.length - 1));
}

// Map speed (km/s) to pulse rate (Hz)
function speedToPulse(speedKmS: number): number {
  return 0.3 + (speedKmS / 8) * 2.2;
}

interface OrbitalSonificationProps {
  enabled: boolean;
  selectedSat: SatData | null;
  simulatedTimeRef: React.MutableRefObject<Date>;
}

export function OrbitalSonification({
  enabled,
  selectedSat,
  simulatedTimeRef,
}: OrbitalSonificationProps) {
  const ctxRef = useRef<AudioContext | null>(null);
  // Pad voices (the space bed) and the lead voice that tracks a satellite.
  const padOscRef = useRef<OscillatorNode[]>([]);
  const leadRef = useRef<OscillatorNode | null>(null);
  const leadGainRef = useRef<GainNode | null>(null);
  const lfoRef = useRef<OscillatorNode | null>(null);
  const noiseRef = useRef<AudioBufferSourceNode | null>(null);
  const chordTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const leadTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const chordIdxRef = useRef(0);

  const teardown = useCallback(() => {
    if (chordTimerRef.current) { clearInterval(chordTimerRef.current); chordTimerRef.current = null; }
    if (leadTimerRef.current) { clearInterval(leadTimerRef.current); leadTimerRef.current = null; }
    padOscRef.current.forEach((o) => { try { o.stop(); } catch { /* already stopped */ } });
    padOscRef.current = [];
    try { leadRef.current?.stop(); } catch { /* already stopped */ }
    try { lfoRef.current?.stop(); } catch { /* already stopped */ }
    try { noiseRef.current?.stop(); } catch { /* already stopped */ }
    leadRef.current = null;
    leadGainRef.current = null;
    lfoRef.current = null;
    noiseRef.current = null;
    if (ctxRef.current && ctxRef.current.state !== 'closed') {
      ctxRef.current.close().catch(() => {});
    }
    ctxRef.current = null;
  }, []);

  useEffect(() => {
    if (!enabled) { teardown(); return; }

    const Ctor =
      window.AudioContext ||
      (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    const ctx = new Ctor();
    ctxRef.current = ctx;
    // A user gesture drives the enable toggle, but Safari can still start the
    // context suspended — resume so the bed is audible immediately.
    ctx.resume?.().catch(() => {});

    const now = ctx.currentTime;

    // Master bus with a gentle low-pass so nothing is harsh, and a slow tremolo
    // (LFO → master gain) that makes the whole bed "breathe".
    const master = ctx.createGain();
    master.gain.value = 0;
    const tone = ctx.createBiquadFilter();
    tone.type = 'lowpass';
    tone.frequency.value = 1400;
    tone.Q.value = 0.4;
    master.connect(tone);
    tone.connect(ctx.destination);

    const lfo = ctx.createOscillator();
    lfo.type = 'sine';
    lfo.frequency.value = 0.08; // one slow swell every ~12 s
    const lfoGain = ctx.createGain();
    lfoGain.gain.value = 0.04;
    lfo.connect(lfoGain);
    lfoGain.connect(master.gain);
    lfo.start();
    lfoRef.current = lfo;

    // --- Pad: four detuned sine voices, one per chord tone ------------------
    const chord = CHORDS[0];
    const padGain = ctx.createGain();
    padGain.gain.value = 0.9;
    padGain.connect(master);
    const pad: OscillatorNode[] = [];
    chord.forEach((freq, i) => {
      const o = ctx.createOscillator();
      o.type = i === 0 ? 'triangle' : 'sine';
      o.frequency.value = freq;
      // A few cents of detune per voice gives the slow, wide beating that reads
      // as an analog space pad rather than a static organ chord.
      o.detune.value = (i - 1.5) * 4;
      const g = ctx.createGain();
      g.gain.value = i === 0 ? 0.28 : 0.16;
      o.connect(g);
      g.connect(padGain);
      o.start();
      pad.push(o);
    });
    padOscRef.current = pad;

    // --- Shimmer: filtered noise "solar wind" -------------------------------
    const noiseBuf = ctx.createBuffer(1, ctx.sampleRate * 2, ctx.sampleRate);
    const data = noiseBuf.getChannelData(0);
    for (let i = 0; i < data.length; i++) data[i] = (Math.random() * 2 - 1) * 0.5;
    const noise = ctx.createBufferSource();
    noise.buffer = noiseBuf;
    noise.loop = true;
    const noiseFilter = ctx.createBiquadFilter();
    noiseFilter.type = 'bandpass';
    noiseFilter.frequency.value = 600;
    noiseFilter.Q.value = 0.6;
    const noiseGain = ctx.createGain();
    noiseGain.gain.value = 0.05;
    noise.connect(noiseFilter);
    noiseFilter.connect(noiseGain);
    noiseGain.connect(master);
    noise.start();
    noiseRef.current = noise;

    // --- Lead: tracks the selected satellite --------------------------------
    const lead = ctx.createOscillator();
    lead.type = 'sine';
    lead.frequency.value = PENTATONIC[8];
    const leadGain = ctx.createGain();
    leadGain.gain.value = 0; // silent until a satellite is selected
    lead.connect(leadGain);
    leadGain.connect(master);
    lead.start();
    leadRef.current = lead;
    leadGainRef.current = leadGain;

    // Fade the whole bed in.
    master.gain.setTargetAtTime(0.16, now, 1.5);

    // Chord progression: glide each pad voice to the next chord's matching tone
    // every ~9 s. Long glides (setTargetAtTime) make the change feel like drift,
    // not a cut.
    chordIdxRef.current = 0;
    chordTimerRef.current = setInterval(() => {
      const c = ctxRef.current;
      if (!c) return;
      chordIdxRef.current = (chordIdxRef.current + 1) % CHORDS.length;
      const next = CHORDS[chordIdxRef.current];
      padOscRef.current.forEach((o, i) => {
        o.frequency.setTargetAtTime(next[i] ?? next[0], c.currentTime, 2.5);
      });
      // Sweep the master tone gently in sympathy for a little motion.
      tone.frequency.setTargetAtTime(1100 + Math.random() * 700, c.currentTime, 3);
    }, 9000);

    // Lead update: map the selected satellite's live state to pitch + pulse.
    leadTimerRef.current = setInterval(() => {
      const c = ctxRef.current;
      if (!c || !leadRef.current || !leadGainRef.current) return;
      if (!selectedSat) {
        leadGainRef.current.gain.setTargetAtTime(0, c.currentTime, 0.6);
        return;
      }
      const t = simulatedTimeRef.current;
      if (t.getTime() < selectedSat.launchMs) {
        leadGainRef.current.gain.setTargetAtTime(0, c.currentTime, 0.6);
        return;
      }
      const info = getSatelliteRealtimeInfo(selectedSat.satrec, t);
      if (!info) return;
      const freq = PENTATONIC[altToNote(info.altitude)];
      leadRef.current.frequency.setTargetAtTime(freq, c.currentTime, 0.25);
      leadGainRef.current.gain.setTargetAtTime(0.09, c.currentTime, 0.5);
      // Nudge the breathing LFO toward the satellite's pulse so the bed and the
      // lead feel coupled.
      lfoRef.current?.frequency.setTargetAtTime(
        Math.min(1.2, speedToPulse(info.speed) * 0.35),
        c.currentTime,
        0.5
      );
    }, 500);

    return teardown;
  }, [enabled, selectedSat, simulatedTimeRef, teardown]);

  return null; // Pure audio, no visual output
}
