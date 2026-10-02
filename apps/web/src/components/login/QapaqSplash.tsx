import qapaqQMask from '../../assets/qapaq-q-mask.png';

export function QapaqSplash({
  waiting = false,
}: {
  readonly waiting?: boolean;
}): React.JSX.Element {
  return (
    <main className="auth-startup" aria-busy="true" aria-label="QAPAQ SecOps">
      <div className={`auth-splash${waiting ? ' auth-splash--waiting' : ''}`} aria-hidden="true">
        <span
          className="auth-splash-mark"
          style={{ maskImage: `url(${qapaqQMask})`, WebkitMaskImage: `url(${qapaqQMask})` }}
        />
      </div>
    </main>
  );
}
