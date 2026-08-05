import type {Metadata, Viewport} from 'next';
import './globals.css'; // Global styles
import {ServiceWorkerRegistrar} from '@/components/ServiceWorkerRegistrar';

export const metadata: Metadata = {
  title: 'PIMXSATS — Satellite & Solar System Tracker',
  description: 'Real-time 3D tracking of 10,000+ satellites and the entire Solar System.',
};

// viewportFit: 'cover' lets the UI extend behind notches/home bars; the
// overlay pads itself with env(safe-area-inset-*) where it matters.
//
// maximumScale/userScalable lock out the BROWSER's own pinch-zoom and
// double-tap-zoom. This app is a full-screen 3D canvas: every pinch is meant
// for the camera, and letting the page scale as well made a two-finger
// gesture move the document under the canvas — the "the whole page jumps"
// effect on phones. Page text is never the reading surface here, so nothing
// is lost by disabling document zoom.
export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  maximumScale: 1,
  userScalable: false,
  viewportFit: 'cover',
  themeColor: '#010204',
};

export default function RootLayout({children}: {children: React.ReactNode}) {
  return (
    <html lang="en">
      <head>
        {/* Display face for the wordmark only (see `.font-display` in
            globals.css). Orbitron is a geometric, wide-tracking face designed
            for exactly this — it reads as instrumentation rather than as a
            website heading.

            Loaded as a plain stylesheet <link> rather than through
            `next/font/google` on purpose: next/font downloads the file at BUILD
            time, which would make an offline build fail, and this app is built
            to work offline (the catalog and textures are bundled). A stylesheet
            link costs nothing when it cannot be reached — the wordmark simply
            falls back to the condensed system stack declared alongside it. */}
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="" />
        <link
          rel="stylesheet"
          href="https://fonts.googleapis.com/css2?family=Orbitron:wght@500;700;900&display=swap"
        />
      </head>
      <body suppressHydrationWarning>
        {children}
        <ServiceWorkerRegistrar />
      </body>
    </html>
  );
}
