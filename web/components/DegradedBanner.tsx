/**
 * An honest failure state. A degraded or unreachable Worker shows this, never a
 * spinner that spins forever and never a crash. The page still renders whatever
 * data it did get.
 */
export default function DegradedBanner({ messages }: { messages: string[] }) {
  if (!messages.length) return null;
  return (
    <div
      role="status"
      className="mb-8 rounded-lg border border-[var(--warning)] bg-[#fffaf0] px-4 py-3 text-sm"
    >
      <div className="font-semibold text-[var(--text-primary)]">Some data could not be loaded</div>
      <ul className="mt-1 list-disc space-y-0.5 pl-5 text-[var(--text-secondary)]">
        {messages.map((m) => (
          <li key={m}>{m}</li>
        ))}
      </ul>
      <p className="mt-2 text-xs text-[var(--text-muted)]">
        Figures shown may be stale or incomplete. The collector and the site are separate services,
        so collection may well be continuing normally.
      </p>
    </div>
  );
}
