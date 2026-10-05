// A WebRTC data channel between two devices on the same network, with no server.
// The host makes an offer code, the guest answers it with an answer code, and the host accepts it.
// Each code carries all network candidates at once ("non-trickle"), because there is no server
// to send late candidates through. No STUN or TURN servers: this works on a local network only,
// and it works with no internet.
import { type Hello, decodeSignal, encodeSignal } from './signal.ts';

export type Channel = {
  send(message: unknown): void;
  onMessage(handler: (message: unknown) => void): void;
  onClose(handler: () => void): void;
  close(): void;
};

const CHANNEL_LABEL = 'tick3d';
const ICE_GATHERING_TIMEOUT_MS = 5000;
const CONNECT_TIMEOUT_MS = 15_000;
// The guest waits while a person scans its answer code on the host, so this wait is long.
const GUEST_WAIT_MS = 10 * 60_000;
// Chrome accepts data channel messages up to 256 kB. Larger messages go in frames of this size.
const FRAME_CHARS = 16_000;
// A message larger than this closes the channel. A session view with hundreds of games is far below it.
const MAX_MESSAGE_CHARS = 4_000_000;

// Frames: "M" + a whole message, or "P" + one part of a long message and "E" + its last part.
// The channel is ordered and reliable, so the parts arrive in order.
export function wrapChannel(dc: RTCDataChannel, pc: RTCPeerConnection): Channel {
  const messageHandlers: ((message: unknown) => void)[] = [];
  const closeHandlers: (() => void)[] = [];
  let parts: string[] = [];
  let partChars = 0;
  let closed = false;

  const close = () => {
    if (closed) return;
    closed = true;
    dc.close();
    pc.close();
    for (const handler of closeHandlers) handler();
  };

  dc.onmessage = (event: MessageEvent<unknown>) => {
    const frame = event.data;
    // A peer is not trusted: a frame of the wrong shape ends the connection.
    if (typeof frame !== 'string' || frame.length === 0) return close();
    const kind = frame[0];
    const body = frame.slice(1);
    if (kind === 'P' || kind === 'E') {
      // The sender never sends an empty part, and empty parts would grow `parts` with no limit.
      if (body.length === 0) return close();
      partChars += body.length;
      if (partChars > MAX_MESSAGE_CHARS) return close();
      parts.push(body);
      if (kind === 'P') return;
    } else if (kind !== 'M' || parts.length > 0) {
      return close();
    }
    const text = kind === 'M' ? body : parts.join('');
    parts = [];
    partChars = 0;
    let message: unknown;
    try {
      message = JSON.parse(text);
    } catch {
      return close();
    }
    for (const handler of messageHandlers) handler(message);
  };
  dc.onclose = close;
  pc.addEventListener('connectionstatechange', () => {
    if (pc.connectionState === 'failed' || pc.connectionState === 'closed') close();
  });

  return {
    send(message) {
      if (closed || dc.readyState !== 'open') throw new Error('The connection to the other device is closed.');
      const text = JSON.stringify(message);
      if (text.length > MAX_MESSAGE_CHARS) throw new Error(`a message of ${text.length} characters is too large to send`);
      if (text.length <= FRAME_CHARS) return dc.send(`M${text}`);
      for (let start = 0; start < text.length; start += FRAME_CHARS) {
        const last = start + FRAME_CHARS >= text.length;
        dc.send((last ? 'E' : 'P') + text.slice(start, start + FRAME_CHARS));
      }
    },
    onMessage(handler) {
      messageHandlers.push(handler);
    },
    onClose(handler) {
      if (closed) handler();
      else closeHandlers.push(handler);
    },
    close,
  };
}

// Resolves when the browser has found all its network candidates, or after a timeout with the
// candidates found so far. A local network answers in well under a second.
function gatherCandidates(pc: RTCPeerConnection): Promise<void> {
  if (pc.iceGatheringState === 'complete') return Promise.resolve();
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer);
      pc.removeEventListener('icegatheringstatechange', check);
      resolve();
    };
    const check = () => {
      if (pc.iceGatheringState === 'complete') done();
    };
    const timer = setTimeout(done, ICE_GATHERING_TIMEOUT_MS);
    pc.addEventListener('icegatheringstatechange', check);
  });
}

function localCode(pc: RTCPeerConnection, hello: Hello): Promise<string> {
  const desc = pc.localDescription;
  if (desc === null) throw new Error('the connection has no local description');
  if (!desc.sdp.includes('a=candidate:')) throw new Error('No network found. Connect to Wi-Fi and try again.');
  return encodeSignal(desc, hello);
}

// Close() of an offer or an answer rejects its pending promise with this error.
const cancelled = () => new DOMException('The connection attempt was cancelled.', 'AbortError');

function openChannel(dc: RTCDataChannel, pc: RTCPeerConnection, signal: AbortSignal): Promise<Channel> {
  return new Promise((resolve, reject) => {
    const finish = () => {
      clearTimeout(timer);
      signal.removeEventListener('abort', aborted);
      dc.removeEventListener('open', opened);
    };
    const timer = setTimeout(() => {
      finish();
      pc.close();
      reject(new Error('The devices did not connect. Check that both are on the same network.'));
    }, CONNECT_TIMEOUT_MS);
    const aborted = () => {
      finish();
      reject(signal.reason);
    };
    const opened = () => {
      finish();
      resolve(wrapChannel(dc, pc));
    };
    signal.addEventListener('abort', aborted);
    dc.addEventListener('open', opened);
    if (signal.aborted) aborted();
    else if (dc.readyState === 'open') opened();
  });
}

// Host side: makes the offer code to show, then accepts the guest's answer code.
// close() ends the attempt: it closes the connection, and a pending accept() rejects with an
// AbortError. After accept() returns a channel, close() does nothing: the channel owns the connection.
export async function createOffer(hello: Hello): Promise<{
  code: string;
  accept(answerCode: string): Promise<{ channel: Channel; peer: Hello }>;
  close(): void;
}> {
  const pc = new RTCPeerConnection({ iceServers: [] });
  const abort = new AbortController();
  let opened = false;
  let code: string;
  let dc: RTCDataChannel;
  try {
    dc = pc.createDataChannel(CHANNEL_LABEL, { ordered: true });
    await pc.setLocalDescription(await pc.createOffer());
    await gatherCandidates(pc);
    code = await localCode(pc, hello);
  } catch (error) {
    pc.close();
    throw error;
  }
  return {
    code,
    async accept(answerCode) {
      abort.signal.throwIfAborted();
      const answer = await decodeSignal(answerCode);
      if (answer.kind !== 'answer') throw new Error('This is a host code. Scan the code on the joining device.');
      abort.signal.throwIfAborted();
      await pc.setRemoteDescription(answer.desc);
      const channel = await openChannel(dc, pc, abort.signal);
      opened = true;
      return { channel, peer: answer.hello };
    },
    close() {
      if (opened || abort.signal.aborted) return;
      abort.abort(cancelled());
      pc.close();
    },
  };
}

// Guest side: reads the host's offer code and makes the answer code to show to the host.
// close() ends the attempt: it closes the connection, and `connected` rejects with an AbortError.
// After `connected` resolves, close() does nothing: the channel owns the connection.
export async function answerOffer(
  offerCode: string,
  hello: Hello,
): Promise<{ code: string; peer: Hello; connected: Promise<Channel>; close(): void }> {
  const offer = await decodeSignal(offerCode);
  if (offer.kind !== 'offer') throw new Error('This is a joining code. Scan the code on the hosting device.');
  const pc = new RTCPeerConnection({ iceServers: [] });
  const abort = new AbortController();
  let opened = false;
  const close = () => {
    if (opened || abort.signal.aborted) return;
    abort.abort(cancelled());
    pc.close();
  };
  // The listener starts before the answer exists, so no data channel event can come first.
  const channel = new Promise<RTCDataChannel>((resolve, reject) => {
    const finish = () => {
      clearTimeout(timer);
      abort.signal.removeEventListener('abort', aborted);
      pc.removeEventListener('datachannel', arrived);
    };
    const timer = setTimeout(() => {
      finish();
      pc.close();
      reject(new Error('The host did not scan the code in time. Start again.'));
    }, GUEST_WAIT_MS);
    const aborted = () => {
      finish();
      reject(abort.signal.reason);
    };
    const arrived = (event: RTCDataChannelEvent) => {
      if (event.channel.label !== CHANNEL_LABEL) return;
      finish();
      resolve(event.channel);
    };
    abort.signal.addEventListener('abort', aborted);
    pc.addEventListener('datachannel', arrived);
  });
  let code: string;
  try {
    await pc.setRemoteDescription(offer.desc);
    await pc.setLocalDescription(await pc.createAnswer());
    await gatherCandidates(pc);
    code = await localCode(pc, hello);
  } catch (error) {
    // Nobody awaits `channel` yet, so its AbortError must not become an unhandled rejection.
    channel.catch(() => undefined);
    close();
    throw error;
  }
  const connected = channel
    .then((dc) => openChannel(dc, pc, abort.signal))
    .then((opening) => {
      opened = true;
      return opening;
    });
  return { code, peer: offer.hello, connected, close };
}
