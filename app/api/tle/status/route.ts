import { NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';

// Progress of the catalog aggregation running in /api/tle. The state lives on
// globalThis because dev-mode route bundles do not share module instances.
export async function GET() {
  const g = globalThis as unknown as {
    __tleState?: { progress: { phase: string; done: number; total: number; source: string } };
  };
  const progress = g.__tleState?.progress ?? { phase: 'idle', done: 0, total: 0, source: '' };
  return NextResponse.json(progress, { headers: { 'Cache-Control': 'no-store' } });
}
