// client/src/console/photo.ts — milestone 26. Browser-only: turns the file a person chose into what is uploaded and what
// is checked. Kept out of kycLines.ts because it needs a canvas, and that file must run unchanged in the render gate.
//
// TWO SIZES FROM ONE DECODE. The upload is a JPEG at most 2000 px on its long side — a phone's 12-megapixel original is
// 4–8 MB and nothing downstream reads more than the ID's own text — and the check runs on a 640 px copy, which is
// enough to tell soft from sharp and cheap enough to be instant. Re-encoding also drops the EXIF block, and with it the
// GPS position the photo was taken at, which a person handing over an ID did not mean to send.

import { photoChecks } from './kycLines.ts';
import type { PhotoCheck } from './kycLines.ts';

export type Prepared = { blob: Blob; previewUrl: string; checks: PhotoCheck[]; good: boolean };

function drawn(bitmap: ImageBitmap, longSide: number): HTMLCanvasElement {
  const scale = Math.min(1, longSide / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(bitmap.width * scale));
  canvas.height = Math.max(1, Math.round(bitmap.height * scale));
  const ctx = canvas.getContext('2d');
  if (ctx === null) throw new Error('This browser cannot read photos.');
  ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  return canvas;
}

export async function preparePhoto(file: File): Promise<Prepared> {
  const bitmap = await createImageBitmap(file);
  try {
    const big = drawn(bitmap, 2000);
    const blob = await new Promise<Blob>((resolve, reject) => big.toBlob((b) => (b === null ? reject(new Error('That photo could not be read.')) : resolve(b)), 'image/jpeg', 0.85));

    const small = drawn(bitmap, 640);
    const ctx = small.getContext('2d');
    if (ctx === null) throw new Error('This browser cannot read photos.');
    const { checks, good } = photoChecks(ctx.getImageData(0, 0, small.width, small.height));
    return { blob, previewUrl: URL.createObjectURL(blob), checks, good };
  } finally {
    bitmap.close();
  }
}
