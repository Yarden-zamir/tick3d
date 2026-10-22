// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cameraProblem, scanQr } from './scanner.ts';

const decode = vi.hoisted(() => vi.fn((): { data: string } | null => null));
vi.mock('jsqr', () => ({ default: decode }));

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  decode.mockReset();
});

function camera() {
  const stop = vi.fn();
  const stream = new MediaStream();
  Object.defineProperty(stream, 'getTracks', { value: () => [{ stop }] });
  const getUserMedia = vi.fn(async () => stream);
  vi.stubGlobal('navigator', { mediaDevices: { getUserMedia } });
  const video = document.createElement('video');
  const play = vi.spyOn(video, 'play').mockResolvedValue();
  vi.spyOn(video, 'pause').mockImplementation(() => undefined);
  vi.spyOn(video, 'readyState', 'get').mockReturnValue(2);
  Object.defineProperties(video, { videoWidth: { value: 1920 }, videoHeight: { value: 1080 } });
  const callbacks: FrameRequestCallback[] = [];
  const request = vi.fn((callback: FrameRequestCallback) => callbacks.push(callback));
  const cancel = vi.fn();
  vi.stubGlobal('requestAnimationFrame', request);
  vi.stubGlobal('cancelAnimationFrame', cancel);
  const drawImage = vi.fn();
  const pixels = { data: new Uint8ClampedArray(4), width: 720, height: 405 };
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({ drawImage, getImageData: () => pixels } as unknown as CanvasRenderingContext2D);
  return { stop, stream, video, play, callbacks, request, cancel, drawImage, pixels, getUserMedia };
}

describe('the in-app QR camera', () => {
  it('uses video only, prefers the rear camera, and stops every track on cancellation', async () => {
    const { stop, video, stream, getUserMedia, cancel } = camera();
    const abort = new AbortController();
    await scanQr(video, abort.signal, vi.fn());
    expect(getUserMedia).toHaveBeenCalledWith({ video: { facingMode: { ideal: 'environment' } }, audio: false });
    expect(video.srcObject).toBe(stream);
    abort.abort();
    expect(stop).toHaveBeenCalledOnce();
    expect(cancel).toHaveBeenCalled();
    expect(video.srcObject).toBeNull();
  });

  it('stops a camera that arrives after the permission dialog was cancelled', async () => {
    const { stop, video, stream, getUserMedia, request } = camera();
    let allow!: (stream: MediaStream) => void;
    getUserMedia.mockImplementation(() => new Promise((resolve) => { allow = resolve; }));
    const abort = new AbortController();
    const starting = scanQr(video, abort.signal, vi.fn());
    await vi.waitFor(() => expect(getUserMedia).toHaveBeenCalled());
    abort.abort();
    allow(stream);
    await expect(starting).rejects.toMatchObject({ name: 'AbortError' });
    expect(stop).toHaveBeenCalledOnce();
    expect(request).not.toHaveBeenCalled();
  });

  it('scans a small frame at most four times per second and stops when a code is accepted', async () => {
    const { video, callbacks, drawImage, pixels, stop, request } = camera();
    const abort = new AbortController();
    const found = vi.fn(() => abort.abort());
    await scanQr(video, abort.signal, found);
    callbacks[0]?.(0);
    callbacks[1]?.(100);
    expect(decode).toHaveBeenCalledTimes(1);
    decode.mockReturnValue({ data: 'tick3d-code' });
    callbacks[2]?.(250);
    expect(drawImage).toHaveBeenCalledWith(video, 0, 0, 720, 405);
    expect(decode).toHaveBeenLastCalledWith(pixels.data, 720, 405, { inversionAttempts: 'dontInvert' });
    expect(found).toHaveBeenCalledWith('tick3d-code');
    expect(stop).toHaveBeenCalledOnce();
    expect(request).toHaveBeenCalledTimes(3);
  });

  it('releases the camera if video playback fails', async () => {
    const { stop, video, play } = camera();
    play.mockRejectedValue(new Error('playback failed'));
    await expect(scanQr(video, new AbortController().signal, vi.fn())).rejects.toThrow('playback failed');
    expect(stop).toHaveBeenCalledOnce();
    expect(video.srcObject).toBeNull();
  });

  it.each([
    ['NotAllowedError', 'Allow it in your browser or app settings'],
    ['NotFoundError', 'No camera was found'],
    ['NotReadableError', 'camera is busy'],
  ])('explains %s with a useful next action', (name, message) => {
    expect(cameraProblem(new DOMException('camera failed', name))).toContain(message);
  });

  it('offers a code fallback on browsers without camera support', async () => {
    vi.stubGlobal('navigator', {});
    const error = await scanQr(document.createElement('video'), new AbortController().signal, vi.fn()).catch((error: unknown) => error);
    expect(cameraProblem(error)).toContain('HTTPS');
    expect(cameraProblem(error)).toContain('paste a code');
  });
});
