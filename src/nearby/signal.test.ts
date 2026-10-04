import { describe, expect, it } from 'vitest';
import { buildSdp, decodeSignal, encodeSignal, readSdp } from './signal.ts';

// A Chrome data channel offer with mDNS host candidates, as a page on a local network makes it.
const CHROME_OFFER = [
  'v=0',
  'o=- 8402358124157376734 2 IN IP4 127.0.0.1',
  's=-',
  't=0 0',
  'a=group:BUNDLE 0',
  'a=extmap-allow-mixed',
  'a=msid-semantic: WMS',
  'm=application 9 UDP/DTLS/SCTP webrtc-datachannel',
  'c=IN IP4 0.0.0.0',
  'a=candidate:2747365284 1 udp 2113937151 0f5e2c5a-3b4d-4e6f-8a9b-1c2d3e4f5a6b.local 54321 typ host generation 0 network-cost 999',
  'a=candidate:1928374655 1 udp 2113939711 6a7b8c9d-0e1f-4a2b-8c3d-4e5f6a7b8c9d.local 54322 typ host generation 0 network-cost 999',
  'a=candidate:3829471029 1 tcp 1518283007 0f5e2c5a-3b4d-4e6f-8a9b-1c2d3e4f5a6b.local 9 typ host tcptype active generation 0 network-cost 999',
  'a=ice-ufrag:Hv7d',
  'a=ice-pwd:8m2KxQd0yYc6p1oB9tS3vL4w',
  'a=ice-options:trickle',
  'a=fingerprint:sha-256 4A:2C:9E:71:03:B8:5D:6F:E2:19:AC:47:80:3B:D5:6E:91:0F:7C:28:A4:5B:E3:6D:12:9F:C0:84:57:3A:BE:61',
  'a=setup:actpass',
  'a=mid:0',
  'a=sctp-port:5000',
  'a=max-message-size:262144',
  '',
].join('\r\n');

const CHROME_ANSWER = CHROME_OFFER.replace('a=setup:actpass', 'a=setup:active')
  .replace('a=ice-ufrag:Hv7d', 'a=ice-ufrag:Qw3e')
  .replace('a=ice-pwd:8m2KxQd0yYc6p1oB9tS3vL4w', 'a=ice-pwd:Zr5tGh8jKl2mNb4vCx6zAs9d');

describe('readSdp and buildSdp', () => {
  it('keeps the fields a data channel needs and rebuilds a standard description', () => {
    const fields = readSdp(CHROME_OFFER);
    expect(fields.ufrag).toBe('Hv7d');
    expect(fields.setup).toBe('actpass');
    expect(fields.fingerprint).toHaveLength(32);
    // The TCP candidate is dropped: devices on one network connect over UDP.
    expect(fields.candidates).toEqual([
      { address: '0f5e2c5a-3b4d-4e6f-8a9b-1c2d3e4f5a6b.local', port: 54321, priority: 2113937151 },
      { address: '6a7b8c9d-0e1f-4a2b-8c3d-4e5f6a7b8c9d.local', port: 54322, priority: 2113939711 },
    ]);
    const rebuilt = buildSdp(fields);
    expect(readSdp(rebuilt)).toEqual(fields);
    expect(rebuilt).toContain('a=fingerprint:sha-256 4A:2C:9E:71:03:B8:5D:6F:E2:19:AC:47:80:3B:D5:6E:91:0F:7C:28:A4:5B:E3:6D:12:9F:C0:84:57:3A:BE:61');
    expect(rebuilt).toContain('m=application 9 UDP/DTLS/SCTP webrtc-datachannel');
    expect(rebuilt.endsWith('\r\n')).toBe(true);
  });

  it('refuses a description without a fingerprint', () => {
    const noFingerprint = CHROME_OFFER.split('\r\n').filter((line) => !line.startsWith('a=fingerprint:')).join('\r\n');
    expect(() => readSdp(noFingerprint)).toThrow('fingerprint');
  });
});

describe('encodeSignal and decodeSignal', () => {
  it('round-trips an offer and an answer, and stays short enough for a QR code', async () => {
    const offer = await encodeSignal({ type: 'offer', sdp: CHROME_OFFER }, { device: 'phone', name: "Alice's phone" });
    const answer = await encodeSignal({ type: 'answer', sdp: CHROME_ANSWER }, { device: 'computer', name: 'Bob' });
    console.log(`offer code: ${offer.length} characters, answer code: ${answer.length} characters`);
    expect(offer.startsWith('T3A1.')).toBe(true);
    expect(answer.startsWith('T3B1.')).toBe(true);
    // A version 15 QR code at level L holds 520 bytes and still scans well from a screen.
    expect(offer.length).toBeLessThan(520);

    const decoded = await decodeSignal(offer);
    expect(decoded.kind).toBe('offer');
    expect(decoded.hello).toEqual({ device: 'phone', name: "Alice's phone" });
    expect(decoded.desc.type).toBe('offer');
    expect(readSdp(decoded.desc.sdp ?? '')).toEqual(readSdp(CHROME_OFFER));
    expect((await decodeSignal(` ${answer}\n`)).kind).toBe('answer');
  });

  it('refuses an invalid name or description when encoding', async () => {
    await expect(encodeSignal({ type: 'offer', sdp: CHROME_OFFER }, { device: 'phone', name: '  ' })).rejects.toThrow();
    await expect(encodeSignal({ type: 'offer', sdp: CHROME_OFFER }, { device: 'phone', name: 'x'.repeat(25) })).rejects.toThrow();
    await expect(encodeSignal({ type: 'pranswer', sdp: CHROME_OFFER }, { device: 'phone', name: 'A' })).rejects.toThrow();
  });

  it.each([
    ['an empty text', ''],
    ['a foreign text', 'hello world'],
    ['an online game code', 'AB3K'],
    ['a newer version', 'T3A2.abcdef'],
    ['broken base64', 'T3A1.!!!!'],
    ['data that is not deflate', 'T3A1.aGVsbG8gd29ybGQ'],
    ['a code that is too long', `T3A1.${'A'.repeat(5000)}`],
  ])('refuses %s', async (_, text) => {
    await expect(decodeSignal(text)).rejects.toThrow(Error);
  });

  it('refuses a tampered code', async () => {
    const code = await encodeSignal({ type: 'offer', sdp: CHROME_OFFER }, { device: 'phone', name: 'Alice' });
    const middle = Math.floor(code.length / 2);
    const tampered = code.slice(0, middle) + (code[middle] === 'A' ? 'B' : 'A') + code.slice(middle + 1);
    await expect(decodeSignal(tampered)).rejects.toThrow();
  });

  it('refuses a description with no network candidates', async () => {
    const noCandidates = CHROME_OFFER.split('\r\n').filter((line) => !line.startsWith('a=candidate:')).join('\r\n');
    await expect(encodeSignal({ type: 'offer', sdp: noCandidates }, { device: 'phone', name: 'Alice' })).rejects.toThrow('candidates');
  });

  it('carries plain IP addresses too, for browsers that do not hide them', async () => {
    const plain = CHROME_OFFER.replaceAll('0f5e2c5a-3b4d-4e6f-8a9b-1c2d3e4f5a6b.local', '192.168.1.23');
    const decoded = await decodeSignal(await encodeSignal({ type: 'offer', sdp: plain }, { device: 'computer', name: 'Desk' }));
    expect(readSdp(decoded.desc.sdp ?? '').candidates[0]?.address).toBe('192.168.1.23');
  });
});
