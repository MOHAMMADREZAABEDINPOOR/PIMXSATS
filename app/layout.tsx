import type {Metadata, Viewport} from 'next';
import './globals.css'; // Global styles
import {ServiceWorkerRegistrar} from '@/components/ServiceWorkerRegistrar';

export const metadata: Metadata = {
  title: 'PIMXSATS — Satellite & Solar System Tracker',
  description: 'Real-time 3D tracking of 10,000+ satellites and the entire Solar System.',
};

// viewportFit: 'cover' lets the UI extend behind notches/home bars; the
// overlay pads itself with env(safe-area-inset-*) where it matters.
export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  viewportFit: 'cover',
  themeColor: '#010204',
};

export default function RootLayout({children}: {children: React.ReactNode}) {
  return (
    <html lang="en">
      <body suppressHydrationWarning>
        {children}
        <ServiceWorkerRegistrar />
      </body>
    </html>
  );
}
