import { useFrame, useThree } from '@react-three/fiber';
import { ThreeCanvas } from '@remotion/three';
import { useEffect, useRef, useState } from 'react';
import type { WebGLRenderer } from 'three';
import { AbsoluteFill, Html5Audio, staticFile, useCurrentFrame, useDelayRender, useVideoConfig } from 'remotion';

// The picture of a video: `render` draws one frame with three.js, as a function of the frame number only.
export type Picture = { render(gl: WebGLRenderer, frame: number): void; dispose(): void };
type Create = (width: number, height: number) => Picture;

// The weight of every word of the videos (src/style.css bundles Bricolage Grotesque from 200 to 800).
const FONT = '800 100px "Bricolage Grotesque"';

// Draws the frame of the Remotion timeline with three.js. R3F only hosts the renderer: the picture renders
// itself in a useFrame callback with priority 1, so R3F does not render on its own.
const Frame = ({ width, height, create }: { width: number; height: number; create: Create }) => {
  const frame = useCurrentFrame();
  const [picture] = useState<Picture>(() => create(width, height));
  const current = useRef(frame);
  current.current = frame;
  const gl = useThree((state) => state.gl);
  useEffect(() => () => picture.dispose(), [picture]);
  useFrame(() => picture.render(gl, current.current), 1);
  return null;
};

// A video: the picture of `create` over the soundtrack `audio` of public/, once the font has loaded.
export const Film = ({ create, audio }: { create: Create; audio: string }) => {
  const { width, height } = useVideoConfig();
  const { delayRender, continueRender, cancelRender } = useDelayRender();
  const [fontReady, setFontReady] = useState(false);
  useEffect(() => {
    const handle = delayRender('Loading Bricolage Grotesque');
    document.fonts
      .load(FONT)
      .then((faces) => {
        if (faces.length === 0) throw new Error('Bricolage Grotesque did not load');
        setFontReady(true);
        continueRender(handle);
      })
      .catch((error: unknown) => cancelRender(error));
  }, [delayRender, continueRender, cancelRender]);
  return (
    <AbsoluteFill>
      {fontReady && (
        <ThreeCanvas width={width} height={height} dpr={1} legacy linear flat gl={{ antialias: true, preserveDrawingBuffer: true }}>
          <Frame width={width} height={height} create={create} />
        </ThreeCanvas>
      )}
      <Html5Audio src={staticFile(audio)} />
    </AbsoluteFill>
  );
};
