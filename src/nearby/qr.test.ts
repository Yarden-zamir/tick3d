// jsQR reads the rendered code back, to prove the code is scannable. It is a test-only dependency.
import jsQR from 'jsqr';
import { describe, expect, it } from 'vitest';
import { qrModules } from './qr.ts';
import { encodeSignal } from './signal.ts';

// Draws the modules as RGBA pixels with a quiet zone, as a camera sees the screen.
function rasterize(modules: boolean[][], scale = 4, quiet = 4): { data: Uint8ClampedArray; size: number } {
  const size = (modules.length + quiet * 2) * scale;
  const data = new Uint8ClampedArray(size * size * 4).fill(255);
  modules.forEach((row, y) =>
    row.forEach((dark, x) => {
      if (!dark) return;
      for (let dy = 0; dy < scale; dy++) {
        for (let dx = 0; dx < scale; dx++) {
          const offset = (((y + quiet) * scale + dy) * size + (x + quiet) * scale + dx) * 4;
          data.fill(0, offset, offset + 3);
        }
      }
    }),
  );
  return { data, size };
}

const SDP = [
  'v=0',
  'o=- 1 2 IN IP4 127.0.0.1',
  's=-',
  't=0 0',
  'm=application 9 UDP/DTLS/SCTP webrtc-datachannel',
  'c=IN IP4 0.0.0.0',
  'a=candidate:1 1 udp 2113937151 0f5e2c5a-3b4d-4e6f-8a9b-1c2d3e4f5a6b.local 54321 typ host',
  'a=candidate:2 1 udp 2113939711 6a7b8c9d-0e1f-4a2b-8c3d-4e5f6a7b8c9d.local 54322 typ host',
  'a=ice-ufrag:Hv7d',
  'a=ice-pwd:8m2KxQd0yYc6p1oB9tS3vL4w',
  'a=fingerprint:sha-256 4A:2C:9E:71:03:B8:5D:6F:E2:19:AC:47:80:3B:D5:6E:91:0F:7C:28:A4:5B:E3:6D:12:9F:C0:84:57:3A:BE:61',
  'a=setup:actpass',
  'a=mid:0',
  'a=sctp-port:5000',
  '',
].join('\r\n');

describe('qrModules', () => {
  it('makes a QR code that a reader decodes back to the handshake code', async () => {
    const code = await encodeSignal({ type: 'offer', sdp: SDP }, { device: 'tablet', name: 'Kitchen tablet' });
    const modules = await qrModules(code);
    console.log(`QR for a ${code.length} character code: ${modules.length} x ${modules.length} modules`);
    const { data, size } = rasterize(modules);
    expect(jsQR(data, size, size)?.data).toBe(code);
  });
});
