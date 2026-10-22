import { cell, expect, marks, test } from './fixtures.ts';
import type { Page } from '@playwright/test';

const nearby = { settings: { mode: 'nearby', muted: true } };

async function manual(page: Page): Promise<void> {
  const details = page.locator('#nearby-manual');
  if ((await details.getAttribute('open')) === null) await details.locator('> summary').click();
}

async function code(page: Page): Promise<string> {
  await expect.poll(() => page.locator('#nearby-code-out').inputValue()).toMatch(/^T3[AB]1\./);
  return page.locator('#nearby-code-out').inputValue();
}

async function fakeMicrophone(page: Page): Promise<void> {
  await page.evaluate(() => {
    const context = new AudioContext();
    const output = context.createMediaStreamDestination();
    const state = { context, output, next: 0 };
    (window as unknown as { soundMic: typeof state }).soundMic = state;
    navigator.mediaDevices.getUserMedia = async () => {
      await context.resume();
      return output.stream;
    };
  });
}

test('a QR offer and a real encoded sound reply connect two devices without a second scan', async ({ open }) => {
  test.setTimeout(120_000);
  const { page: host, context: hostContext } = await open(nearby);
  const { page: guest, context: guestContext } = await open(nearby);
  // Run against a production preview with E2E_SOUND_OFFLINE=1 to verify the first sound transfer
  // uses the offline cache. Block internet HTTP after an offline reload, keeping local RTC intact.
  if (process.env.E2E_SOUND_OFFLINE === '1') {
    for (const [page, context] of [[host, hostContext], [guest, guestContext]] as const) {
      await page.evaluate(() => navigator.serviceWorker.ready.then(() => undefined));
      await page.reload();
      await page.waitForFunction(() => navigator.serviceWorker.controller !== null);
      await context.setOffline(true);
      await page.reload();
      await expect(page.locator('#nearby-host')).toBeVisible();
      await context.setOffline(false);
      await context.route('**/*', (route) => route.abort());
      await page.evaluate(() => Object.defineProperty(navigator, 'onLine', { get: () => false }));
      expect(await page.evaluate(() => fetch('/api/health').then(() => true, () => false))).toBe(false);
    }
  }
  for (const context of [hostContext, guestContext]) await context.route('**/api/nearby/**', (route) => route.abort());
  await guest.evaluate(() => {
    navigator.mediaDevices.getUserMedia = async () => { throw new DOMException('no test camera', 'NotAllowedError'); };
  });
  await host.locator('#nearby-host').click();
  await guest.locator('#nearby-join').click();
  await manual(guest);
  await guest.locator('#nearby-code-in').fill(await code(host));
  await guest.locator('#nearby-use-code').click();
  await expect(guest.locator('#nearby-progress')).toHaveText('Step 2 of 2');
  await manual(host);
  await manual(guest);
  await fakeMicrophone(host);

  // Replace the air between speakers and microphone with a PCM relay. The normal browser sender,
  // AudioWorklet microphone reader, ggwave decoder, packet assembly and WebRTC handshake all run.
  await guest.exposeBinding('relaySoundPacket', async (_source, samples: number[], rate: number) => {
    await host.evaluate(({ samples, rate }) => {
      const state = (window as unknown as { soundMic: { context: AudioContext; output: MediaStreamAudioDestinationNode; next: number } }).soundMic;
      const buffer = state.context.createBuffer(1, samples.length, rate);
      buffer.copyToChannel(Float32Array.from(samples), 0);
      const source = state.context.createBufferSource();
      source.buffer = buffer;
      source.connect(state.output);
      const start = Math.max(state.context.currentTime + 0.02, state.next);
      source.start(start);
      state.next = start + buffer.duration + 0.2;
    }, { samples, rate });
  });
  await guest.evaluate(() => {
    const Context = AudioContext;
    window.AudioContext = class extends Context {
      createBufferSource(): AudioBufferSourceNode {
        const source = super.createBufferSource();
        const start = source.start.bind(source);
        source.start = (when = 0, offset?: number, duration?: number) => {
          const buffer = source.buffer;
          if (buffer !== null) {
            const relay = (window as unknown as { relaySoundPacket: (samples: number[], rate: number) => Promise<void> }).relaySoundPacket;
            void relay(Array.from(buffer.getChannelData(0)), buffer.sampleRate);
          }
          start(when, offset, duration);
        };
        return source;
      }
    };
  });

  await host.locator('#nearby-sound-toggle').click();
  await expect(host.locator('#nearby-sound-status')).toContainText('Listening');
  await guest.locator('#nearby-sound-toggle').click();
  await expect(host.locator('#nearby-devices li')).toHaveCount(2, { timeout: 45_000 });
  await expect(guest.locator('#nearby-devices')).toContainText('You · Plays O');
  await expect.poll(() => host.evaluate(() => (window as unknown as { soundMic: { output: MediaStreamAudioDestinationNode } }).soundMic.output.stream.getTracks().every((track) => track.readyState === 'ended'))).toBe(true);
  await cell(host, 0).click();
  await expect(marks(guest)).toHaveCount(1);
  expect(hostContext.pages()).toHaveLength(1);
  expect(guestContext.pages()).toHaveLength(1);
});

test('sound is opt-in and a denied microphone leaves the QR alternative intact', async ({ open }) => {
  const { page } = await open(nearby);
  await page.evaluate(() => {
    const state = { requests: 0 };
    (window as unknown as { soundPermission: typeof state }).soundPermission = state;
    navigator.mediaDevices.getUserMedia = async () => {
      state.requests++;
      throw new DOMException('blocked', 'NotAllowedError');
    };
  });
  await page.locator('#nearby-host').click();
  await manual(page);
  expect(await page.evaluate(() => (window as unknown as { soundPermission: { requests: number } }).soundPermission.requests)).toBe(0);
  await expect(page.locator('#nearby-sound-toggle')).toHaveText('Listen for reply');
  await page.locator('#nearby-sound-toggle').click();
  await expect(page.locator('#nearby-sound-status')).toContainText('Microphone access is off');
  await expect(page.locator('#nearby-sound-toggle')).toHaveText('Listen for reply');
  await expect(page.locator('#nearby-qr svg')).toBeVisible();
  await expect(page.locator('#nearby-scan')).toBeEnabled();
});

test('stopping sound listening releases the microphone and keeps the invite', async ({ open }) => {
  const { page } = await open(nearby);
  await page.locator('#nearby-host').click();
  const invite = await code(page);
  await manual(page);
  await fakeMicrophone(page);
  await page.locator('#nearby-sound-toggle').click();
  await expect(page.locator('#nearby-sound-status')).toContainText('Listening');
  await page.locator('#nearby-sound-toggle').click();
  await expect.poll(() => page.evaluate(() => (window as unknown as { soundMic: { output: MediaStreamAudioDestinationNode } }).soundMic.output.stream.getTracks().every((track) => track.readyState === 'ended'))).toBe(true);
  expect(await code(page)).toBe(invite);
  await expect(page.locator('#nearby-sound-status')).toBeHidden();
});

for (const event of ['mute', 'ended']) {
  test(`a microphone ${event} stops listening and offers retry without losing the QR`, async ({ open }) => {
    const { page } = await open(nearby);
    await page.locator('#nearby-host').click();
    await manual(page);
    await fakeMicrophone(page);
    await page.locator('#nearby-sound-toggle').click();
    await expect(page.locator('#nearby-sound-status')).toContainText('Listening');
    await page.evaluate((event) => {
      const stream = (window as unknown as { soundMic: { output: MediaStreamAudioDestinationNode } }).soundMic.output.stream;
      stream.getAudioTracks()[0]?.dispatchEvent(new Event(event));
    }, event);
    await expect(page.locator('#nearby-sound-status')).toContainText('Microphone was interrupted');
    await expect(page.locator('#nearby-sound-toggle')).toHaveText('Listen for reply');
    await expect.poll(() => page.evaluate(() => (window as unknown as { soundMic: { output: MediaStreamAudioDestinationNode } }).soundMic.output.stream.getTracks().every((track) => track.readyState === 'ended'))).toBe(true);
    await expect(page.locator('#nearby-qr svg')).toBeVisible();
  });
}

test('a suspended sound send fails fast instead of waiting forever for onended', async ({ open }) => {
  const { page: host } = await open(nearby);
  const { page: guest } = await open(nearby);
  await guest.evaluate(() => {
    navigator.mediaDevices.getUserMedia = async () => { throw new DOMException('no test camera', 'NotAllowedError'); };
    const Context = AudioContext;
    window.AudioContext = class extends Context {
      constructor(options?: AudioContextOptions) {
        super(options);
        (window as unknown as { soundContext: AudioContext }).soundContext = this;
      }
    };
  });
  await host.locator('#nearby-host').click();
  await guest.locator('#nearby-join').click();
  await manual(guest);
  await guest.locator('#nearby-code-in').fill(await code(host));
  await guest.locator('#nearby-use-code').click();
  await expect(guest.locator('#nearby-progress')).toHaveText('Step 2 of 2');
  await manual(guest);
  await guest.locator('#nearby-sound-toggle').click();
  await expect(guest.locator('#nearby-sound-status')).toContainText('Sending');
  await guest.evaluate(() => (window as unknown as { soundContext: AudioContext }).soundContext.suspend());
  await expect(guest.locator('#nearby-sound-status')).toContainText('Sound was interrupted');
  await expect(guest.locator('#nearby-sound-toggle')).toHaveText('Send reply by sound');
  await expect.poll(() => guest.evaluate(() => (window as unknown as { soundContext: AudioContext }).soundContext.state)).toBe('closed');
  await expect(guest.locator('#nearby-qr svg')).toBeVisible();
});
