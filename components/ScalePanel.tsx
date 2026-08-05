'use client';

// Scale reference & distance storytelling — an honest caption for a dishonest
// picture.
//
// Every 3D space view exaggerates: objects are enlarged to be visible, and the
// solar system's emptiness is compressed to fit a screen. Rather than pretend
// otherwise, this panel states exactly what is being distorted and by how much,
// and — when a satellite is selected — turns its raw altitude and speed into
// comparisons a person can actually feel (lib/storytelling).

import { useMemo } from 'react';
import { Ruler, Sparkles, X } from 'lucide-react';
import type { SatData } from '@/lib/satellite';
import { getSatelliteRealtimeInfo } from '@/lib/satellite';
import { scaleNotes, orbitStory } from '@/lib/storytelling';

export function ScalePanel({
  view, selectedSat, now, onClose,
}: {
  view: 'earth' | 'solar';
  selectedSat: SatData | null;
  now: Date;
  onClose: () => void;
}) {
  const notes = useMemo(() => scaleNotes(view), [view]);

  const story = useMemo(() => {
    if (!selectedSat || now.getTime() < selectedSat.launchMs) return null;
    const info = getSatelliteRealtimeInfo(selectedSat.satrec, now);
    if (!info) return null;
    return { name: selectedSat.name, lines: orbitStory(info.altitude, info.speed) };
  }, [selectedSat, now]);

  return (
    // Height is `dvh`, not `vh`, and only a bit over half of it on a phone.
    //
    // This panel is hosted by the bottom action rail, which is anchored to the
    // bottom edge and grows UPWARD — so its own height is not free space, it is
    // measured against whatever the rail already holds: up to three wrapped rows
    // of chips (~110 px at 320 px wide), the gap above them, the safe-area
    // offset, and the mobile top bar it must not slide under. At `80vh` on a
    // 640 px-tall phone that arithmetic came to more than the screen, and since
    // the rail has no `top` to push back against, the part that did not fit went
    // off the TOP — taking the title and the close button with it.
    //
    // `vh` made it worse than the number suggests: the body here is
    // `position: fixed`, so the page can never scroll and the mobile URL bar
    // never collapses, which means `100vh` (the LARGE viewport) is permanently
    // taller than the visible area. `dvh` is the height actually on screen, and
    // it is what the rest of the app already sizes against.
    <div className="pointer-events-auto w-[min(94vw,26rem)] max-w-full max-h-[min(58dvh,42rem)] sm:max-h-[min(70dvh,42rem)] lg:max-h-[min(80dvh,42rem)] flex flex-col bg-black/85 backdrop-blur-2xl border border-white/10 rounded-2xl p-3 sm:p-4 shadow-2xl animate-fade-up">
      <div className="flex items-start justify-between gap-2 sm:gap-3 shrink-0">
        <div className="text-[9px] font-mono uppercase tracking-widest text-cyan-300 flex items-start gap-1.5 min-w-0">
          <Ruler className="w-3 h-3 shrink-0 mt-px" />
          <span className="min-w-0">Scale &amp; distance — {view === 'earth' ? 'Earth orbit' : 'Solar system'}</span>
        </div>
        <button
          onClick={onClose}
          className="p-1.5 -mt-1 -mr-1 rounded-full text-gray-400 hover:text-white hover:bg-white/10 shrink-0"
          aria-label="Close scale reference"
        >
          <X className="w-4 h-4" />
        </button>
      </div>

      <div className="flex-1 min-h-0 overflow-y-auto custom-scrollbar -mr-2 pr-2">
      {/* If something is selected, its story leads — it is the most concrete
          thing on screen. */}
      {story && story.lines.length > 0 && (
        <div className="mt-3 bg-gradient-to-b from-cyan-500/10 to-transparent border border-cyan-400/25 rounded-xl p-3">
          <div className="text-[9px] font-mono uppercase tracking-widest text-cyan-300 flex items-center gap-1.5 mb-1.5">
            <Sparkles className="w-3 h-3" /> {story.name}, in human terms
          </div>
          <ul className="space-y-1.5">
            {story.lines.map((line, i) => (
              <li key={i} className="text-[11px] font-mono text-gray-200 leading-snug flex gap-1.5">
                <span className="text-cyan-400 shrink-0">›</span>
                <span>{line}</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      <div className="mt-3 space-y-2">
        {notes.map((note) => (
          <div key={note.title} className="bg-white/5 border border-white/5 rounded-xl px-3 py-2">
            <div className="text-[11px] font-mono font-bold text-white">{note.title}</div>
            <p className="text-[10px] font-mono text-gray-400 leading-relaxed mt-0.5">{note.body}</p>
          </div>
        ))}
      </div>
      </div>
    </div>
  );
}
