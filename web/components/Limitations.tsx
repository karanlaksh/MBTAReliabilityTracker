import { readLimitations, splitBullet } from '@/lib/limitations';

/**
 * Visible on the page, not buried in a footer, and SOURCED FROM THE README rather
 * than duplicated. If the markers go missing the build fails rather than rendering
 * an empty section that implies there are no limitations.
 */
export default function Limitations() {
  const bullets = readLimitations().map(splitBullet);
  return (
    <ul className="space-y-3">
      {bullets.map((b, i) => (
        <li key={i} className="border-l-2 border-[var(--rule)] pl-4 text-sm leading-relaxed">
          {b.lead ? (
            <span className="font-semibold text-[var(--text-primary)]">{b.lead} </span>
          ) : null}
          <span className="text-[var(--text-secondary)]">{b.rest}</span>
        </li>
      ))}
    </ul>
  );
}
