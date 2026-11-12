import type { CSSProperties, ReactNode } from "react";

/*
 * Loading pieces (styles in globals.css, "Loading"):
 *   <Spinner />                 inline ring; inherits the text colour
 *   <BusyLabel busy={x}>Save</BusyLabel>   spinner + label while working (use inside .btn with aria-busy)
 *   <Skeleton className="h-4 w-40" />      shimmering placeholder
 *   <SkeletonRows n={4} />      a list's worth of placeholder rows
 *   <ForgeLoader label="…" />   the animated Forge mark, for page-level waits
 *   <RouteBar />                thin progress bar at the top of the window
 */

export function Spinner({ size = 14, className = "", label }: { size?: number; className?: string; label?: string }) {
  return (
    <span
      className={`spinner ${className}`}
      style={{ width: size, height: size }}
      role={label ? "status" : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
    />
  );
}

/** Button content: the spinner appears in front of the label while `busy`. */
export function BusyLabel({ busy, children, busyText }: { busy: boolean; children: ReactNode; busyText?: ReactNode }) {
  return (
    <>
      {busy && <Spinner size={13} />}
      <span className="inline-flex items-center gap-1.5 whitespace-nowrap">{busy && busyText ? busyText : children}</span>
    </>
  );
}

export function Skeleton({ className = "", style }: { className?: string; style?: CSSProperties }) {
  return <span className={`skel ${className}`} style={style} aria-hidden />;
}

/** Placeholder rows for a list or table that's loading (with an accessible status). */
export function SkeletonRows({ n = 4, avatar = false, className = "" }: { n?: number; avatar?: boolean; className?: string }) {
  return (
    <div className={`flex flex-col ${className}`} role="status" aria-label="Loading">
      {Array.from({ length: n }, (_, i) => (
        <div key={i} className="flex items-center gap-3 px-4 py-3">
          {avatar && <Skeleton className="size-8 shrink-0 rounded-full" />}
          <div className="flex min-w-0 flex-1 flex-col gap-1.5">
            <Skeleton className="skel-line" style={{ width: `${55 + ((i * 17) % 35)}%` }} />
            <Skeleton className="skel-line h-[0.65em] opacity-70" style={{ width: `${30 + ((i * 23) % 30)}%` }} />
          </div>
          <Skeleton className="h-6 w-16 shrink-0 rounded-full" />
        </div>
      ))}
    </div>
  );
}

/** Skeleton cards for a grid or a stack of cards. */
export function SkeletonCards({ n = 3, className = "" }: { n?: number; className?: string }) {
  return (
    <div className={`flex flex-col gap-2.5 ${className}`} role="status" aria-label="Loading">
      {Array.from({ length: n }, (_, i) => (
        <div key={i} className="card flex flex-col gap-2 p-3.5">
          <Skeleton className="skel-line w-2/5" />
          <Skeleton className="skel-line h-[0.7em]" style={{ width: `${70 + ((i * 13) % 25)}%` }} />
          <Skeleton className="skel-line h-[0.7em] w-1/3 opacity-70" />
        </div>
      ))}
    </div>
  );
}

/** The animated Forge mark with a short message, centred. For page-level waits. */
export function ForgeLoader({ label = "Loading…", sub, className = "" }: { label?: string; sub?: string; className?: string }) {
  return (
    <div className={`fade-in flex flex-col items-center justify-center gap-4 text-center ${className}`} role="status" aria-live="polite">
      <div className="forge-mark" aria-hidden>
        <span className="core" />
        <span className="spark" />
        <span className="spark" />
        <span className="spark" />
      </div>
      <div>
        <p className="font-semibold text-ink">{label}</p>
        {sub && <p className="mt-1 text-[13px] text-ink-2">{sub}</p>}
      </div>
    </div>
  );
}

export function RouteBar() {
  return <div className="route-bar" role="progressbar" aria-label="Loading the page" />;
}
