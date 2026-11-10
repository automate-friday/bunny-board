import { Context, Effect, Layer } from 'effect';
import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import path from 'node:path';

export const MAX_FRAME_IMAGE_BYTES = 4 * 1024 * 1024;
const filePattern = /^[a-f0-9]{32}\.(png|jpg|gif|webp)$/;
export function frameImageFile(src: string): string {
  let pathname: string;
  try { pathname = new URL(src, 'http://board.invalid').pathname; }
  catch { throw new Error('Image is not a stored board attachment'); }
  const match = /^\/api\/assets\/([^/]+)$/.exec(pathname);
  if (!match || !filePattern.test(match[1])) throw new Error('Image is not a stored board attachment');
  return match[1];
}
export type FrameImage = { data: string; mimeType: string };
export class FrameImages extends Context.Tag('bunny/FrameImages')<FrameImages, {
  readonly read: (file: string) => Effect.Effect<FrameImage, Error>;
}>() {}
function encode(file: string, bytes: Buffer): FrameImage {
  if (!filePattern.test(file)) throw new Error('Invalid board image filename');
  if (bytes.length > MAX_FRAME_IMAGE_BYTES) throw new Error('Image exceeds the 4 MiB vision limit; attach a smaller image');
  const ext = path.extname(file).slice(1);
  const mimeType = ext === 'jpg' ? 'image/jpeg' : `image/${ext}`;
  return {data:bytes.toString('base64'), mimeType};
}
const error = (e: unknown) => e instanceof Error ? e : new Error(String(e));
export function FrameImagesMock(files: Record<string, Buffer> = {}) {
  return Layer.succeed(FrameImages, {read: (file: string) => Effect.try({try: () => {
    if (!filePattern.test(file)) throw new Error('Invalid board image filename');
    if (!Object.hasOwn(files, file)) throw new Error('Board image not found');
    return encode(file, files[file]);
  }, catch:error})});
}
export function FrameImagesLive(assetsDir: string) {
  return Layer.succeed(FrameImages, {read: (file: string) => Effect.tryPromise({try: async () => {
    if (!filePattern.test(file)) throw new Error('Invalid board image filename');
    // No arbitrary paths, URLs, redirects or symlinks. Open once and bound the read.
    const handle = await open(path.join(assetsDir, file), constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const stat = await handle.stat();
      if (!stat.isFile()) throw new Error('Board image is not a regular file');
      if (stat.size > MAX_FRAME_IMAGE_BYTES) throw new Error('Image exceeds the 4 MiB vision limit; attach a smaller image');
      const buffer = Buffer.alloc(MAX_FRAME_IMAGE_BYTES + 1);
      let length = 0;
      while (length < buffer.length) {
        const {bytesRead} = await handle.read(buffer, length, buffer.length - length, null);
        if (!bytesRead) break;
        length += bytesRead;
      }
      return encode(file, buffer.subarray(0, length));
    } finally { await handle.close(); }
  }, catch:error})});
}
