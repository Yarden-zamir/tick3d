import { useFrame, useThree } from '@react-three/fiber';
import { ThreeCanvas } from '@remotion/three';
import { useEffect, useRef, useState } from 'react';
import { AbsoluteFill, Html5Audio, getInputProps, staticFile, useCurrentFrame, useDelayRender, useVideoConfig } from 'remotion';
import { VARIANT } from './timeline.ts';
import { BADGE_FILES, type BadgeArt } from './hud.ts';
import { type World, createWorld } from './world.ts';

// The render passes the variant twice: as VIDEO_VARIANT for the timeline, and as an input prop for this check, so
// a render can never fall back to the base cut in silence.
function checkVariant(): void {
  const props: unknown = getInputProps();
  const wanted = typeof props === 'object' && props !== null && 'variant' in props ? props.variant : 'classic';
  if (wanted !== VARIANT) throw new Error(`the render asked for variant ${String(wanted)}, but the timeline loaded ${VARIANT}`);
}

// The weight of every word of the spot (src/style.css bundles Bricolage Grotesque from 200 to 800).
const FONT = '800 100px "Bricolage Grotesque"';

// Draws the frame of the Remotion timeline with three.js. R3F only hosts the renderer: the world renders
// itself in a useFrame callback with priority 1, so R3F does not render on its own.
const Frame = ({ width, height, art }: { width: number; height: number; art: BadgeArt }) => {
  const frame = useCurrentFrame();
  const [world] = useState<World>(() => {
    checkVariant();
    return createWorld(width, height, art);
  });
  const current = useRef(frame);
  current.current = frame;
  const gl = useThree((state) => state.gl);
  useEffect(() => () => world.dispose(), [world]);
  useFrame(() => world.render(gl, current.current), 1);
  return null;
};

export const Spot = () => {
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
          <Frame width={width} height={height} art={art} />
        </ThreeCanvas>
      )}
      <Html5Audio src={staticFile('soundtrack.wav')} />
    </AbsoluteFill>
  );
};
