import { NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';
export const runtime = 'edge';

// Progress of the catalog aggregation running in /api/tle. The state lives on
// globalThis; note that on Cloudflare each route is a separate Worker isolate,
// so cross-route sharing is best-effort — the client treats a missing/idle
// status as non-fatal and shows a generic "downloading" message.
export async function GET() {
  const g = globalThis as unknown as {
    __tleState?: { progress: { phase: string; done: number; total: number; source: string } };
  };
  const progress = g.__tleState?.progress ?? { phase: 'idle', done: 0, total: 0, source: '' };
  return NextResponse.json(progress, { headers: { 'Cache-Control': 'no-store' } });
}
