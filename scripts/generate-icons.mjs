import fs from 'fs';
import zlib from 'zlib';
import path from 'path';

function createSolidIconPng(width, height, isMaskable) {
  // Create raw RGBA pixel buffer
  const rawData = Buffer.alloc(height * (1 + width * 4));
  const bgR = 15, bgG = 41, bgB = 66; // #0F2942 Navy
  const fgR = 255, fgG = 255, fgB = 255;
  const acR = 56, acG = 189, acB = 248; // #38BDF8 Sky accent

  const cx = width / 2;
  const cy = height / 2;
  const scale = isMaskable ? 0.72 : 0.85;
  const boxHalf = (width * 0.28) * scale;
  const stroke = Math.max(4, Math.round(width * 0.035 * scale));

  for (let y = 0; y < height; y++) {
    const rowOffset = y * (1 + width * 4);
    rawData[rowOffset] = 0; // filter type 0
    for (let x = 0; x < width; x++) {
      const pxOffset = rowOffset + 1 + x * 4;
      let r = bgR, g = bgG, b = bgB, a = 255;

      // Rounded rect mask for non-maskable
      if (!isMaskable) {
        const rad = width * 0.2;
        const dx = Math.max(0, Math.abs(x - cx) - (width / 2 - rad));
        const dy = Math.max(0, Math.abs(y - cy) - (height / 2 - rad));
        if (dx * dx + dy * dy > rad * rad) {
          a = 0;
        }
      }

      if (a > 0) {
        const rx = x - cx;
        const ry = y - cy;
        const ax = Math.abs(rx);
        const ay = Math.abs(ry);

        // Face scan frame corners
        const inOuterBox = ax <= boxHalf && ay <= boxHalf;
        const inInnerBox = ax <= boxHalf - stroke && ay <= boxHalf - stroke;
        const isCornerZone = ax >= boxHalf * 0.55 && ay >= boxHalf * 0.55;
        if (inOuterBox && !inInnerBox && isCornerZone) {
          r = fgR; g = fgG; b = fgB;
        }

        // Head circle
        const headY = ry + boxHalf * 0.15;
        const distHead = Math.sqrt(rx * rx + headY * headY);
        const headRad = boxHalf * 0.34;
        if (Math.abs(distHead - headRad) <= stroke * 0.48) {
          r = acR; g = acG; b = acB;
        }

        // Shoulders arc
        const shY = ry - boxHalf * 0.55;
        const distSh = Math.sqrt(rx * rx + shY * shY);
        const shRad = boxHalf * 0.52;
        if (ry > boxHalf * 0.18 && ry < boxHalf * 0.55 && Math.abs(distSh - shRad) <= stroke * 0.48) {
          r = acR; g = acG; b = acB;
        }
      }

      rawData[pxOffset] = r;
      rawData[pxOffset + 1] = g;
      rawData[pxOffset + 2] = b;
      rawData[pxOffset + 3] = a;
    }
  }

  function crc32(buf) {
    let crc = 0xffffffff;
    for (let i = 0; i < buf.length; i++) {
      crc ^= buf[i];
      for (let j = 0; j < 8; j++) {
        crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
      }
    }
    return (crc ^ 0xffffffff) >>> 0;
  }

  function makeChunk(type, data) {
    const typeBuf = Buffer.from(type, 'ascii');
    const lenBuf = Buffer.alloc(4);
    lenBuf.writeUInt32BE(data.length, 0);
    const crcInput = Buffer.concat([typeBuf, data]);
    const crcBuf = Buffer.alloc(4);
    crcBuf.writeUInt32BE(crc32(crcInput), 0);
    return Buffer.concat([lenBuf, typeBuf, data, crcBuf]);
  }

  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  const compressed = zlib.deflateSync(rawData, { level: 9 });
  return Buffer.concat([
    signature,
    makeChunk('IHDR', ihdr),
    makeChunk('IDAT', compressed),
    makeChunk('IEND', Buffer.alloc(0)),
  ]);
}

fs.mkdirSync('public', { recursive: true });
fs.writeFileSync('public/pwa-192x192.png', createSolidIconPng(192, 192, false));
fs.writeFileSync('public/pwa-512x512.png', createSolidIconPng(512, 512, false));
fs.writeFileSync('public/pwa-maskable-512x512.png', createSolidIconPng(512, 512, true));
fs.writeFileSync('public/apple-touch-icon.png', createSolidIconPng(180, 180, true));
console.log('Generated PWA PNG icons successfully.');
