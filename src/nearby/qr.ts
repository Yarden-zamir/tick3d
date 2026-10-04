// QR codes for the Nearby handshake. Both libraries load on first use, so players who never open
// Nearby never download them.
const QUIET_ZONE = 4;
const SVG_NS = 'http://www.w3.org/2000/svg';

// The dark (true) and light (false) modules of a QR code for `text`, without the quiet zone.
// Level L gives the most room for data; a code shown on a screen has no dirt or damage to correct.
export async function qrModules(text: string): Promise<boolean[][]> {
  const { default: qrcode } = await import('qrcode-generator');
  const qr = qrcode(0, 'L');
  qr.addData(text, 'Byte');
  qr.make();
  const size = qr.getModuleCount();
  return Array.from({ length: size }, (_, row) => Array.from({ length: size }, (_, column) => qr.isDark(row, column)));
}

// A crisp SVG of the code. The modules use currentColor, and the SVG sets its color to black:
// scanners need dark modules on light ground, also in dark themes. A page can still set the color.
export async function renderQr(text: string): Promise<SVGSVGElement> {
  const modules = await qrModules(text);
  const size = modules.length + QUIET_ZONE * 2;
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', `0 0 ${size} ${size}`);
  svg.setAttribute('shape-rendering', 'crispEdges');
  svg.setAttribute('role', 'img');
  svg.setAttribute('aria-label', 'QR code');
  svg.style.color = '#000';
  const ground = document.createElementNS(SVG_NS, 'rect');
  ground.setAttribute('width', String(size));
  ground.setAttribute('height', String(size));
  ground.setAttribute('fill', '#fff');
  // One path with a 1 x 1 square per dark module keeps the DOM small.
  let d = '';
  modules.forEach((row, y) =>
    row.forEach((dark, x) => {
      if (dark) d += `M${x + QUIET_ZONE} ${y + QUIET_ZONE}h1v1h-1z`;
    }),
  );
  const path = document.createElementNS(SVG_NS, 'path');
  path.setAttribute('d', d);
  path.setAttribute('fill', 'currentColor');
  svg.append(ground, path);
  return svg;
}

type DetectedCode = { rawValue: string };
type BarcodeDetectorLike = { detect(source: CanvasImageSource): Promise<DetectedCode[]> };
type BarcodeDetectorClass = {
  new (options: { formats: string[] }): BarcodeDetectorLike;
  getSupportedFormats(): Promise<string[]>;
};

// The browser's own QR reader where it exists (Chrome on Android and desktop), else jsQR.
async function makeDecoder(): Promise<(video: HTMLVideoElement) => Promise<string | undefined>> {
  const Native = (globalThis as { BarcodeDetector?: BarcodeDetectorClass }).BarcodeDetector;
  if (Native !== undefined && (await Native.getSupportedFormats()).includes('qr_code')) {
    const detector = new Native({ formats: ['qr_code'] });
    return async (video) => (await detector.detect(video))[0]?.rawValue;
  }
  const { default: jsQR } = await import('jsqr');
  const canvas = document.createElement('canvas');
  const context = canvas.getContext('2d', { willReadFrequently: true });
  if (context === null) throw new Error('canvas 2d context is not available');
  return async (video) => {
    if (video.videoWidth === 0) return undefined;
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    context.drawImage(video, 0, 0);
    const image = context.getImageData(0, 0, canvas.width, canvas.height);
    return jsQR(image.data, image.width, image.height, { inversionAttempts: 'dontInvert' })?.data;
  };
}

// Shows the back camera in `video` and calls onCode for each new code it reads.
// Returns a function that stops the camera. Throws if the player refuses camera access.
export async function startScanner(video: HTMLVideoElement, onCode: (text: string) => void): Promise<() => void> {
  const decode = await makeDecoder();
  const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' }, audio: false });
  video.srcObject = stream;
  video.setAttribute('playsinline', '');
  video.muted = true;
  await video.play();
  let running = true;
  let last: string | undefined;
  const scan = async () => {
    if (!running) return;
    try {
      const text = await decode(video);
      if (running && text !== undefined && text !== last) {
        last = text;
        onCode(text);
      }
    } catch {
      // A frame that the reader cannot use. The next frame tries again.
    }
    if (running) setTimeout(() => void scan(), 150);
  };
  void scan();
  return () => {
    running = false;
    for (const track of stream.getTracks()) track.stop();
    video.srcObject = null;
  };
}
