// QR codes for the Nearby handshake and the online game link. The library loads on first use, so
// players who never show a code never download it. Codes are links, so a phone's own camera reads them;
// the page has no scanner of its own.
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
