import Konva from 'konva';
import { FrameObject } from '../types/canvas';

const TARGET_PX = 1024;

/**
 * Exports the portion of the Konva stage that lies within the frame's world bounds.
 * Returns a data URL (PNG). All layers (strokes, shapes, images) are included.
 */
export function captureFrameFromStage(stage: Konva.Stage, frame: FrameObject): string {
  const tf = stage.getAbsoluteTransform();
  const tl = tf.point({ x: frame.x, y: frame.y });
  const br = tf.point({ x: frame.x + frame.width, y: frame.y + frame.height });

  const sw = br.x - tl.x;
  const sh = br.y - tl.y;
  const pixelRatio = TARGET_PX / Math.max(sw, sh, 1);

  return stage.toDataURL({
    x: tl.x,
    y: tl.y,
    width: sw,
    height: sh,
    pixelRatio,
    mimeType: 'image/png',
  });
}

type Bounds = { x: number; y: number; width: number; height: number };

function targetDims(w: number, h: number) {
  const ratio = w / h;
  return {
    outW: ratio >= 1 ? TARGET_PX : Math.round(TARGET_PX * ratio),
    outH: ratio < 1  ? TARGET_PX : Math.round(TARGET_PX / ratio),
  };
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = src;
  });
}


export function buildTransparentMask(width: number, height: number): string {
  const { outW, outH } = targetDims(width, height);
  const canvas = document.createElement('canvas');
  canvas.width = outW;
  canvas.height = outH;
  const ctx = canvas.getContext('2d')!;
  ctx.clearRect(0, 0, outW, outH);
  return canvas.toDataURL('image/png');
}

export async function buildFrameBaseImage(frame: FrameObject): Promise<string> {
  const { outW, outH } = targetDims(frame.width, frame.height);
  const canvas = document.createElement('canvas');
  canvas.width = outW;
  canvas.height = outH;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Could not get 2D context');

  ctx.clearRect(0, 0, outW, outH);
  if (frame.imageData) {
    const img = await loadImage(frame.imageData);
    ctx.drawImage(img, 0, 0, outW, outH);
  }

  return canvas.toDataURL('image/png');
}

/**
 * Composite PNG for outpainting: original image placed at its offset within the
 * expanded canvas. The surrounding new area is left transparent.
 * Pair this with buildOutpaintMask and send both to images.edit.
 */
export function buildOutpaintComposite(
  originalImageDataUrl: string,
  oldBounds: Bounds,
  newBounds: Bounds,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const { outW, outH } = targetDims(newBounds.width, newBounds.height);
    const canvas = document.createElement('canvas');
    canvas.width = outW;
    canvas.height = outH;
    const ctx = canvas.getContext('2d');
    if (!ctx) return reject(new Error('Could not get 2D context'));

    ctx.clearRect(0, 0, outW, outH);

    const ox = ((oldBounds.x - newBounds.x) / newBounds.width) * outW;
    const oy = ((oldBounds.y - newBounds.y) / newBounds.height) * outH;
    const iw = (oldBounds.width  / newBounds.width)  * outW;
    const ih = (oldBounds.height / newBounds.height) * outH;

    const img = new Image();
    img.onload = () => { ctx.drawImage(img, ox, oy, iw, ih); resolve(canvas.toDataURL('image/png')); };
    img.onerror = reject;
    img.src = originalImageDataUrl;
  });
}

/**
 * Mask PNG for outpainting — same pixel dims as buildOutpaintComposite output.
 * Transparent = generate (new area), opaque white = preserve (original image area).
 */
export function buildOutpaintMask(oldBounds: Bounds, newBounds: Bounds): string {
  const { outW, outH } = targetDims(newBounds.width, newBounds.height);
  const canvas = document.createElement('canvas');
  canvas.width = outW;
  canvas.height = outH;
  const ctx = canvas.getContext('2d')!;

  // Everything transparent = generate by default
  ctx.clearRect(0, 0, outW, outH);

  // Opaque white over the original image area = preserve
  const ox = ((oldBounds.x - newBounds.x) / newBounds.width) * outW;
  const oy = ((oldBounds.y - newBounds.y) / newBounds.height) * outH;
  const iw = (oldBounds.width  / newBounds.width)  * outW;
  const ih = (oldBounds.height / newBounds.height) * outH;

  ctx.fillStyle = 'rgba(255,255,255,1)';
  ctx.fillRect(ox, oy, iw, ih);

  return canvas.toDataURL('image/png');
}

/**
 * Scaled copy of the background image at the same dims used by buildInpaintMask.
 */
export function buildInpaintImage(backgroundDataUrl: string, bgBounds: Bounds): Promise<string> {
  return new Promise((resolve, reject) => {
    const { outW, outH } = targetDims(bgBounds.width, bgBounds.height);
    const canvas = document.createElement('canvas');
    canvas.width = outW;
    canvas.height = outH;
    const ctx = canvas.getContext('2d');
    if (!ctx) return reject(new Error('Could not get 2D context'));

    const img = new Image();
    img.onload = () => { ctx.drawImage(img, 0, 0, outW, outH); resolve(canvas.toDataURL('image/png')); };
    img.onerror = reject;
    img.src = backgroundDataUrl;
  });
}

/**
 * Mask PNG for inpainting — same pixel dims as buildInpaintImage output.
 * Transparent = generate (overlay region), opaque white = preserve (everything else).
 */
export function buildInpaintMask(bgBounds: Bounds, overlayBounds: Bounds): string {
  const { outW, outH } = targetDims(bgBounds.width, bgBounds.height);
  const canvas = document.createElement('canvas');
  canvas.width = outW;
  canvas.height = outH;
  const ctx = canvas.getContext('2d')!;

  // Start fully opaque = preserve everything
  ctx.fillStyle = 'rgba(255,255,255,1)';
  ctx.fillRect(0, 0, outW, outH);

  // Clear the overlay region = generate here
  const clampedX = Math.max(0, overlayBounds.x - bgBounds.x);
  const clampedY = Math.max(0, overlayBounds.y - bgBounds.y);
  const clampedW = Math.min(overlayBounds.width,  bgBounds.width  - clampedX);
  const clampedH = Math.min(overlayBounds.height, bgBounds.height - clampedY);

  ctx.clearRect(
    (clampedX / bgBounds.width)  * outW,
    (clampedY / bgBounds.height) * outH,
    (clampedW / bgBounds.width)  * outW,
    (clampedH / bgBounds.height) * outH,
  );

  return canvas.toDataURL('image/png');
}
