import { useFrame, useThree } from '@react-three/fiber';
import { ThreeCanvas } from '@remotion/three';
import { useEffect, useRef, useState } from 'react';
import type { WebGLRenderer } from 'three';
import { AbsoluteFill, Html5Audio, staticFile, useCurrentFrame, useDelayRender, useVideoConfig } from 'remotion';
import { BADGE_FILES, type BadgeArt } from './lettering.ts';

// The picture of a video: `render` draws one frame with three.js, as a function of the frame number only.
export type Picture = { render(gl: WebGLRenderer, frame: number): void; dispose(): void };
type Create = (width: number, height: number, art: BadgeArt) => Picture;

// The weight of every word of the videos (src/style.css bundles Bricolage Grotesque from 200 to 800).
const FONT = '800 100px "Bricolage Grotesque"';

// Draws the frame of the Remotion timeline with three.js. R3F only hosts the renderer: the picture renders
// itself in a useFrame callback with priority 1, so R3F does not render on its own.
const Frame = ({ width, height, art, create }: { width: number; height: number; art: BadgeArt; create: Create }) => {
  const frame = useCurrentFrame();
  const [picture] = useState<Picture>(() => create(width, height, art));
  const current = useRef(frame);
  current.current = frame;
  const gl = useThree((state) => state.gl);
  useEffect(() => () => picture.dispose(), [picture]);
  useFrame(() => picture.render(gl, current.current), 1);
  return null;
};

// A video: the picture of `create` over the soundtrack `audio` of public/, once the font and the store badges of
// the end card have loaded.
export const Film = ({ create, audio }: { create: Create; audio: string }) => {
  const { width, height } = useVideoConfig();
  const { delayRender, continueRender, cancelRender } = useDelayRender();
  const [art, setArt] = useState<BadgeArt | undefined>(undefined);
  useEffect(() => {
    const handle = delayRender('Loading Bricolage Grotesque and the store badges');
    const image = (file: string) => {
      const element = new Image();
      element.src = staticFile(file);
      return element.decode().then(() => element);
    };
    Promise.all([document.fonts.load(FONT), image(BADGE_FILES['app-store']), image(BADGE_FILES['google-play'])])
      .then(([faces, appStore, googlePlay]) => {
        if (faces.length === 0) throw new Error('Bricolage Grotesque did not load');
        setArt({ 'app-store': appStore, 'google-play': googlePlay });
        continueRender(handle);
      })
      .catch((error: unknown) => cancelRender(error));
  }, [delayRender, continueRender, cancelRender]);
  return (
    <AbsoluteFill>
      {art !== undefined && (
        <ThreeCanvas width={width} height={height} dpr={1} legacy linear flat gl={{ antialias: true, preserveDrawingBuffer: true }}>
          <Frame width={width} height={height} art={art} create={create} />
        </ThreeCanvas>
      )}
      <Html5Audio src={staticFile(audio)} />
    </AbsoluteFill>
  );
};
