// Postcard export: turn the current WebGL frame into a shareable PNG with a
// small branded caption bar, then hand it to the browser as a download.
//
// The caption is composited in a 2D canvas rather than screenshotting the DOM,
// so the export is deterministic — no overlay panels, no scroll position, no
// device-specific UI chrome baked into the image.

export interface PostcardMeta {
  /** Big line — usually the selected object, or the view name. */
  title: string;
  /** Small line under it — category, coordinates, whatever fits. */
  subtitle: string;
  /** Right-hand stamp, normally the simulated timestamp. */
  stamp: string;
}

/** Height of the caption bar as a fraction of the image height, clamped so it
 *  stays legible on a phone screenshot and unobtrusive on a desktop one. */
function captionHeight(imageHeight: number): number {
  return Math.min(160, Math.max(74, Math.round(imageHeight * 0.11)));
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('frame decode failed'));
    img.src = src;
  });
}

/**
 * Compose `frameDataUrl` into a captioned postcard and download it.
 * Resolves to the filename written, or null if the browser refused.
 */
export async function downloadPostcard(
  frameDataUrl: string,
  meta: PostcardMeta
): Promise<string | null> {
  let frame: HTMLImageElement;
  try {
    frame = await loadImage(frameDataUrl);
  } catch {
    return null;
  }

  const width = frame.naturalWidth;
  const height = frame.naturalHeight;
  if (!width || !height) return null;

  const bar = captionHeight(height);
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height + bar;
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;

  ctx.drawImage(frame, 0, 0, width, height);

  // Caption bar
  ctx.fillStyle = '#010204';
  ctx.fillRect(0, height, width, bar);
  const glow = ctx.createLinearGradient(0, height, width, height);
  glow.addColorStop(0, '#2563eb');
  glow.addColorStop(0.5, '#38bdf8');
  glow.addColorStop(1, '#2563eb');
  ctx.fillStyle = glow;
  ctx.fillRect(0, height, width, Math.max(2, Math.round(bar * 0.025)));

  const pad = Math.round(bar * 0.3);
  const titleSize = Math.round(bar * 0.31);
  const subSize = Math.round(bar * 0.19);

  ctx.textBaseline = 'alphabetic';
  ctx.fillStyle = '#ffffff';
  ctx.font = `700 ${titleSize}px ui-monospace, SFMono-Regular, Menlo, monospace`;
  ctx.fillText(meta.title, pad, height + bar * 0.5);

  ctx.fillStyle = '#94a3b8';
  ctx.font = `400 ${subSize}px ui-monospace, SFMono-Regular, Menlo, monospace`;
  ctx.fillText(meta.subtitle, pad, height + bar * 0.78);

  ctx.textAlign = 'right';
  ctx.fillStyle = '#38bdf8';
  ctx.font = `700 ${subSize}px ui-monospace, SFMono-Regular, Menlo, monospace`;
  ctx.fillText('PIMXSATS', width - pad, height + bar * 0.5);
  ctx.fillStyle = '#64748b';
  ctx.font = `400 ${Math.round(subSize * 0.9)}px ui-monospace, SFMono-Regular, Menlo, monospace`;
  ctx.fillText(meta.stamp, width - pad, height + bar * 0.78);

  const filename = `pimxsats-${meta.title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'view'}.png`;

  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'));
  if (!blob) return null;

  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  // Revoked on the next turn so the navigation has definitely started.
  setTimeout(() => URL.revokeObjectURL(url), 10000);
  return filename;
}
