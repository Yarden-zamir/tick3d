// The in-app camera reads a QR without leaving the game or opening another browser tab.
// The decoder is part of the offline app cache, but only loads when somebody opens the scanner.
class CameraProblem extends Error {}

export function cameraProblem(error: unknown): string {
  if (error instanceof CameraProblem) return error.message;
  if (error instanceof DOMException) {
    if (error.name === 'NotAllowedError' || error.name === 'SecurityError') {
      return 'Camera access is off. Allow it in your browser or app settings, then try again. You can also paste a code under Other ways to connect.';
    }
    if (error.name === 'NotFoundError' || error.name === 'OverconstrainedError') {
      return 'No camera was found. You can paste a code under Other ways to connect.';
    }
    if (error.name === 'NotReadableError') return 'The camera is busy. Close other apps using it, then try again.';
  }
  return 'The camera could not start. Try again, or paste a code under Other ways to connect.';
}

export async function scanQr(video: HTMLVideoElement, signal: AbortSignal, found: (code: string) => void): Promise<void> {
  if (navigator.mediaDevices?.getUserMedia === undefined) {
    throw new CameraProblem('Camera scanning needs a supported browser on HTTPS. You can paste a code under Other ways to connect.');
  }
  const { default: decode } = await import('jsqr');
  signal.throwIfAborted();
  const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: 'environment' } }, audio: false });
  let frame = 0;
  let stopped = false;
  const stop = () => {
    if (stopped) return;
    stopped = true;
    cancelAnimationFrame(frame);
    for (const track of stream.getTracks()) track.stop();
    if (video.srcObject === stream) {
      video.pause();
      video.srcObject = null;
    }
    signal.removeEventListener('abort', stop);
  };
  // Permission can take a long time: a cancelled attempt must not leave its camera running later.
  if (signal.aborted) {
    stop();
    signal.throwIfAborted();
  }
  signal.addEventListener('abort', stop, { once: true });
  try {
    video.muted = true;
    video.srcObject = stream;
    await video.play();
    if (signal.aborted) return;
    const canvas = document.createElement('canvas');
    const context = canvas.getContext('2d', { willReadFrequently: true });
    if (context === null) throw new CameraProblem('The camera image could not be read. Try again or paste a code under Other ways to connect.');
    let lastRead = -Infinity;
    const read = (now: number) => {
      if (signal.aborted) return;
      // A small, throttled frame keeps scanning light enough for older phones.
      if (now - lastRead >= 250 && video.readyState >= 2 && video.videoWidth > 0 && video.videoHeight > 0) {
        lastRead = now;
        const scale = Math.min(1, 720 / Math.max(video.videoWidth, video.videoHeight));
        canvas.width = Math.max(1, Math.round(video.videoWidth * scale));
        canvas.height = Math.max(1, Math.round(video.videoHeight * scale));
        context.drawImage(video, 0, 0, canvas.width, canvas.height);
        const pixels = context.getImageData(0, 0, canvas.width, canvas.height);
        const code = decode(pixels.data, pixels.width, pixels.height, { inversionAttempts: 'dontInvert' });
        if (code !== null) found(code.data);
      }
      if (!signal.aborted) frame = requestAnimationFrame(read);
    };
    frame = requestAnimationFrame(read);
  } catch (error) {
    stop();
    throw error;
  }
}
