const LIGHT_Y = '45%';
const CORE_SIZE = '42% 82%';
const GLOW_SIZE = '92% 92%';
const GRAIN_OPACITY = 0.07;

const amberGlow = `radial-gradient(ellipse ${GLOW_SIZE} at 100% ${LIGHT_Y}, #bd8d4c 0%, #a8742f 22%, #7a5528 43%, #3a2815 64%, transparent 83%)`;
const lightCore = `radial-gradient(ellipse ${CORE_SIZE} at 100% ${LIGHT_Y}, #f4f4f4 0%, #d9d9d9 19%, #b9a47f 48%, transparent 100%)`;
const grainTexture =
  "url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='160' height='160'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.8' numOctaves='2' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23n)'/%3E%3C/svg%3E\")";

export default function HeroArt(): React.JSX.Element {
  return (
    <aside className="brand-panel" aria-hidden="true">
      <div
        className="login-light-amber pointer-events-none absolute inset-0 z-0 blur-[56px]"
        aria-hidden="true"
        style={{ background: amberGlow }}
      />
      <div
        className="login-light-core pointer-events-none absolute inset-0 z-0 blur-[30px] brightness-125"
        aria-hidden="true"
        style={{ background: lightCore }}
      />
      <div className="login-art-shade" />
      <div
        className="pointer-events-none absolute inset-0 z-20 mix-blend-overlay"
        aria-hidden="true"
        style={{ backgroundImage: grainTexture, opacity: GRAIN_OPACITY }}
      />
      <img src="/qapaq-secops-analyst.webp" alt="" className="login-analyst" />
    </aside>
  );
}
