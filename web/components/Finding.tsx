import { fmtInt, fmtSigned, type HorizonSeries } from '@/lib/api';

/**
 * The headline, generated from the data rather than written by hand.
 *
 * The LEAD IS THE MODE COMPARISON, not the monotonic curve. A rider in Boston has
 * an opinion about whether the bus is less trustworthy than the Orange Line; that
 * is the claim worth putting at the top. The curve rising with horizon mostly
 * demonstrates that the matcher works — real but supporting.
 */
export default function Finding({ series }: { series: HorizonSeries[] }) {
  const pick = (routeId: string) => series.find((s) => s.route_id === routeId);
  const at = (s: HorizonSeries | undefined, bucket: string) =>
    s?.points.find((p) => p.bucket === bucket);

  const bus = pick('39');
  const orange = pick('Orange');
  const busNear = at(bus, '~1.5 min');
  const orangeNear = at(orange, '~1.5 min');
  const orangeFar = at(orange, '~16 min');

  if (!busNear || !orangeNear || busNear.n < 20 || orangeNear.n < 20) {
    return (
      <p className="text-lg text-[var(--text-secondary)]">
        Not enough graded predictions yet to state a finding.
      </p>
    );
  }

  const ratio = Math.round((busNear.median_sec ?? 0) / Math.max(1, orangeNear.median_sec ?? 1));

  return (
    <div>
      <p className="text-xl leading-snug text-[var(--text-primary)] sm:text-2xl">
        When the countdown says <strong>about a minute and a half</strong>, the Orange Line is
        typically <strong>{fmtSigned(orangeNear.median_sec)}</strong> off — but Bus 39 is{' '}
        <strong>{fmtSigned(busNear.median_sec)}</strong> off
        {Number.isFinite(ratio) && ratio > 1 ? <>, roughly {ratio}× worse</> : null}. The bus
        prediction you can see the bus for is the one you should trust least.
      </p>
      <p className="mt-3 text-sm text-[var(--text-secondary)]">
        Error grows with how far ahead the prediction was made — the Orange Line goes from{' '}
        {fmtSigned(orangeNear.median_sec)} at ~1.5 min to {fmtSigned(orangeFar?.median_sec)} at ~16
        min — which is the expected shape and mostly a sign the measurement is sound.
        Sample sizes: {fmtInt(orangeNear.n)} graded Orange Line predictions and{' '}
        {fmtInt(busNear.n)} for Bus 39 at that point.
      </p>
      <p className="mt-3 text-sm text-[var(--text-muted)]">
        Positive numbers mean the vehicle arrived <strong>later</strong> than predicted.
      </p>
    </div>
  );
}
