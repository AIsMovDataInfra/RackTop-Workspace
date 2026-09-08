import test from 'node:test';
import assert from 'node:assert/strict';
import sharp from 'sharp';
import { compressEquipmentPhoto, PHOTO_MAX_BYTES, validatePhotoBody } from '../server/equipment-photo.mjs';

const dataUrl = (bytes, type = 'jpeg') => `data:image/${type};base64,${bytes.toString('base64')}`;

test('photos are rotated, downsized, normalized to JPEG and stripped of metadata', async () => {
  const source = await sharp({ create: { width: 2400, height: 1200, channels: 3, background: '#215d92' } })
    .withMetadata({ orientation: 6 }).jpeg({ quality: 95 }).toBuffer();
  assert.ok((await sharp(source).metadata()).exif);
  const result = await compressEquipmentPhoto(dataUrl(source));
  const info = await sharp(result.bytes).metadata();
  assert.equal(info.format, 'jpeg'); assert.equal(info.width, 800); assert.equal(info.height, 1600);
  assert.equal(result.width, info.width); assert.equal(result.height, info.height);
  assert.ok(result.bytes.length <= PHOTO_MAX_BYTES); assert.ok(result.bytes.length < source.length);
  assert.equal(info.exif, undefined); assert.equal(info.icc, undefined); assert.equal(info.orientation, undefined);
});

test('PNG and WebP become a single static JPEG without scaling up', async () => {
  for (const format of ['png', 'webp']) {
    const source = await sharp({ create: { width: 64, height: 48, channels: 4, background: '#00112255' } })[format]().toBuffer();
    const result = await compressEquipmentPhoto(dataUrl(source, format));
    const info = await sharp(result.bytes).metadata();
    assert.equal(info.format, 'jpeg'); assert.equal(info.width, 64); assert.equal(info.height, 48); assert.equal(info.hasAlpha, false);
  }
});

test('invalid, disguised, oversized and excessive-pixel photos are rejected', async () => {
  for (const input of [undefined, '', 'data:image/svg+xml;base64,AAAA', dataUrl(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'), 'png'), 'data:image/jpeg;base64,A===', dataUrl(Buffer.from([0xff, 0xd8, 0xff, 0]))]) {
    await assert.rejects(() => compressEquipmentPhoto(input), error => [413, 415, 422].includes(error.status));
  }
  await assert.rejects(() => compressEquipmentPhoto(dataUrl(Buffer.alloc(1024 * 1024 + 1))), error => error.status === 413);
  const huge = await sharp({ create: { width: 5000, height: 5000, channels: 3, background: '#ffffff' } }).png().toBuffer();
  await assert.rejects(() => compressEquipmentPhoto(dataUrl(huge, 'png')), error => error.status === 422);
});

test('photo writes need a current version and reject client-generated metadata', () => {
  assert.doesNotThrow(() => validatePhotoBody({ version: 1, dataUrl: 'handled by decoder' }));
  assert.doesNotThrow(() => validatePhotoBody({ version: 2 }, false));
  for (const value of [{ version: 0 }, { version: 1, width: 123 }, { dataUrl: 'x' }, { version: 1, path: '/tmp/file' }]) assert.throws(() => validatePhotoBody(value), error => error.status === 422);
  assert.throws(() => validatePhotoBody({ version: 1, dataUrl: 'x' }, false), error => error.status === 422);
});
