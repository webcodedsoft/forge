import { useId } from "react";

/*
 * Forge's mark: a bold rounded F on the brand purple, with an orange spark in the F's open
 * corner (the spark from the anvil). The same drawing is the favicon (app/icon.svg) and the
 * home-screen icon (app/apple-icon.tsx); keep them in step.
 */

export const MARK_PATHS = {
  /** The F: stem, top bar and middle bar, with rounded ends. */
  f: "M20.5 14h21a4.5 4.5 0 0 1 0 9H29v7h10.5a4.5 4.5 0 0 1 0 9H29v10.5a4.25 4.25 0 0 1-8.5 0V18.5a4.5 4.5 0 0 1 4.5-4.5z",
  /** A four-point spark. */
  spark: "M46 37.5l2.4 6.1 6.1 2.4-6.1 2.4L46 54.5l-2.4-6.1-6.1-2.4 6.1-2.4z",
  /** A small second spark. */
  ember: "M54 30l1 2.5 2.5 1-2.5 1-1 2.5-1-2.5-2.5-1 2.5-1z",
};

export function ForgeMark({ size = 28, className = "", title }: { size?: number; className?: string; title?: string }) {
  const id = useId().replace(/:/g, "");
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 64 64"
      className={`shrink-0 ${className}`}
      role={title ? "img" : undefined}
      aria-label={title}
      aria-hidden={title ? undefined : true}
    >
      <defs>
        <linearGradient id={`${id}-bg`} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#7c4dff" />
          <stop offset="1" stopColor="#4a1fc4" />
        </linearGradient>
        <linearGradient id={`${id}-spark`} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#ffc46b" />
          <stop offset="1" stopColor="#ff6a2b" />
        </linearGradient>
      </defs>
      <rect width="64" height="64" rx="15" fill={`url(#${id}-bg)`} />
      <rect width="64" height="32" rx="15" fill="#fff" opacity="0.06" />
      <path d={MARK_PATHS.f} fill="#fff" />
      <path d={MARK_PATHS.spark} fill={`url(#${id}-spark)`} />
      <path d={MARK_PATHS.ember} fill="#ffb15c" opacity="0.9" />
    </svg>
  );
}
