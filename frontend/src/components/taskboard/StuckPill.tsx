import { useEffect, useState } from 'react';

// Surfaces "stuck Nm/Nh" on conflict cards once a resolver Claude has been
// running long enough that it might be hung. Hidden for the first 3
// minutes so we don't cry wolf on normal resolutions.
export function StuckPill({ since }: { since: number }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(id);
  }, []);
  const minutes = Math.floor((now - since) / 60_000);
  if (minutes < 3) return null;
  const label = minutes < 60 ? `${minutes}m` : `${Math.floor(minutes / 60)}h`;
  return (
    <span
      className="task-card-stuck-pill"
      title={`Resolver has been working for ${label} — may be stuck`}
    >
      stuck {label}
    </span>
  );
}
