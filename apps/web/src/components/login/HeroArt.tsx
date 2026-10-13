import qapaqMask from '../../assets/qapaq-q-mask.png';

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
    <aside
      className="brand-panel relative grid min-h-svh place-items-center overflow-hidden bg-black"
      aria-label="Identidad visual QAPAQ"
    >
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
      <div
        className="pointer-events-none absolute inset-0 z-10 bg-gradient-to-b from-black via-transparent to-black opacity-80"
        aria-hidden="true"
      />
      <div
        className="pointer-events-none absolute inset-0 z-20 mix-blend-overlay"
        aria-hidden="true"
        style={{ backgroundImage: grainTexture, opacity: GRAIN_OPACITY }}
      />
      <img
        src="/qapaq-analyst.webp"
        alt=""
        aria-hidden="true"
        className="pointer-events-none absolute bottom-0 right-[2%] z-[5] h-[82%] w-auto max-w-[70%] object-contain object-bottom opacity-90"
        style={{
          maskImage:
            'linear-gradient(90deg, transparent 0%, black 25%, black 92%, transparent 100%)',
          WebkitMaskImage:
            'linear-gradient(90deg, transparent 0%, black 25%, black 92%, transparent 100%)',
        }}
      />
      <svg
        className="login-glass-mark pointer-events-none absolute left-[-18%] top-1/2 z-10 h-[88%] w-auto -translate-y-1/2"
        viewBox="0 0 447 447"
        role="img"
        aria-label="Emblema Q de QAPAQ"
        style={{
          filter:
            'drop-shadow(0 5px 14px rgb(0 0 0 / 62%)) drop-shadow(0 0 1px rgb(255 255 255 / 20%))',
        }}
      >
        <defs>
          <linearGradient id="qapaq-glass-fill" x1="0%" y1="52%" x2="100%" y2="45%">
            <stop offset="0%" stopColor="#d8dce0" stopOpacity="0.035" />
            <stop offset="42%" stopColor="#d8dce0" stopOpacity="0.06" />
            <stop offset="72%" stopColor="#f2dcb7" stopOpacity="0.13" />
            <stop offset="100%" stopColor="#fff0d1" stopOpacity="0.19" />
          </linearGradient>
          <linearGradient id="qapaq-glass-reflection" x1="24%" y1="100%" x2="82%" y2="0%">
            <stop offset="0%" stopColor="#fff8e9" stopOpacity="0" />
            <stop offset="54%" stopColor="#fff8e9" stopOpacity="0" />
            <stop offset="61%" stopColor="#fff8e9" stopOpacity="0.035" />
            <stop offset="65%" stopColor="#fff8e9" stopOpacity="0.15" />
            <stop offset="69%" stopColor="#fff8e9" stopOpacity="0.055" />
            <stop offset="75%" stopColor="#fff8e9" stopOpacity="0" />
            <stop offset="100%" stopColor="#fff8e9" stopOpacity="0" />
          </linearGradient>
          <mask
            id="qapaq-q-shape"
            x="0"
            y="0"
            width="447"
            height="447"
            maskUnits="userSpaceOnUse"
            style={{ maskType: 'alpha' }}
          >
            <image href={qapaqMask} width="447" height="447" preserveAspectRatio="none" />
          </mask>
        </defs>
        <rect width="447" height="447" fill="url(#qapaq-glass-fill)" mask="url(#qapaq-q-shape)" />
        <rect
          width="447"
          height="447"
          fill="url(#qapaq-glass-reflection)"
          mask="url(#qapaq-q-shape)"
        />
      </svg>
    </aside>
  );
}
