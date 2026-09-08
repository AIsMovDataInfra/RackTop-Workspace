import sharp from 'sharp';
import { ApiError } from './store.mjs';

export const PHOTO_MAX_BYTES = 512 * 1024;
const SOURCE_MAX_BYTES = 1024 * 1024;
const INPUT_PIXELS = 20_000_000;
sharp.cache({ memory: 16, files: 0, items: 32 });
sharp.concurrency(1);
let processing = 0;

export function validatePhotoBody(body, upload = true) {
  const allowed = upload ? ['version', 'dataUrl'] : ['version'];
  if (!body || typeof body !== 'object' || Array.isArray(body)
    || Object.keys(body).some(key => !allowed.includes(key))
    || !Number.isSafeInteger(body.version) || body.version < 1) {
    throw new ApiError(422, 'INVALID_INPUT', '照片操作需要当前设备版本，不支持额外字段');
  }
}

// Only the normalized JPEG reaches the store. Decoding strips metadata and
// prevents client-provided MIME types, dimensions and filenames becoming trusted.
export async function compressEquipmentPhoto(dataUrl) {
  if (typeof dataUrl !== 'string') throw new ApiError(422, 'INVALID_PHOTO', '请选择一张设备照片');
  if (dataUrl.length > Math.ceil(SOURCE_MAX_BYTES / 3) * 4 + 64) throw new ApiError(413, 'PHOTO_TOO_LARGE', '照片过大，请压缩后重试（上传文件最多 1 MB）');
  const match = /^data:image\/(jpeg|png|webp);base64,([A-Za-z0-9+/]+={0,2})$/.exec(dataUrl);
  if (!match || match[2].length % 4 !== 0) throw new ApiError(415, 'UNSUPPORTED_PHOTO', '请使用 JPEG、PNG 或 WebP 照片');
  const input = Buffer.from(match[2], 'base64');
  if (input.length > SOURCE_MAX_BYTES) throw new ApiError(413, 'PHOTO_TOO_LARGE', '照片过大，请压缩后重试（上传文件最多 1 MB）');
  if (!input.length || input.toString('base64') !== match[2]) throw new ApiError(422, 'INVALID_PHOTO', '照片数据无效');
  const signatureMatches = match[1] === 'jpeg' ? input.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff]))
    : match[1] === 'png' ? input.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
      : input.toString('ascii', 0, 4) === 'RIFF' && input.toString('ascii', 8, 12) === 'WEBP';
  if (!signatureMatches) throw new ApiError(415, 'UNSUPPORTED_PHOTO', '照片内容与文件格式不匹配');
  if (processing >= 2) throw new ApiError(503, 'PHOTO_BUSY', '照片正在处理中，请稍后重试');
  processing++;
  try {
    const image = sharp(input, { failOn: 'warning', limitInputPixels: INPUT_PIXELS, sequentialRead: true });
    const metadata = await image.metadata();
    if (metadata.format !== match[1] || !['jpeg', 'png', 'webp'].includes(metadata.format)
      || (metadata.pages ?? 1) !== 1 || !metadata.width || !metadata.height
      || metadata.width * metadata.height > INPUT_PIXELS) {
      throw new ApiError(422, 'INVALID_PHOTO', '照片格式、尺寸或帧数不支持，请重新选择静态照片');
    }
    for (const [size, quality] of [[1600, 80], [1600, 65], [1280, 65], [960, 60]]) {
      const { data, info } = await image.clone().autoOrient().flatten({ background: '#ffffff' })
        .resize({ width: size, height: size, fit: 'inside', withoutEnlargement: true })
        .jpeg({ quality, mozjpeg: true }).timeout({ seconds: 8 }).toBuffer({ resolveWithObject: true });
      if (data.length <= PHOTO_MAX_BYTES) return { bytes: data, width: info.width, height: info.height };
    }
    throw new ApiError(413, 'PHOTO_TOO_LARGE', '照片压缩后仍过大，请选择较小的照片');
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw new ApiError(422, 'INVALID_PHOTO', '无法读取这张照片，请重新拍摄或选择 JPEG、PNG、WebP 图片');
  } finally { processing--; }
}
