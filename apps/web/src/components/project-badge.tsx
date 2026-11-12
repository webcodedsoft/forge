/** Fixed palette (white text passes contrast on each); a project always gets the same colour. */
const COLORS = ["#c2410c", "#0e7490", "#7c3aed", "#15803d", "#be185d", "#2563eb", "#a16207", "#4b5563"];

export function projectColor(id: string) {
  let h = 0;
  for (const ch of id) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return COLORS[h % COLORS.length]!;
}

/** The coloured letter tile that stands for a project (as Flowkite does for apps). */
export function ProjectBadge({ id, name, size = 28 }: { id: string; name: string; size?: number }) {
  return (
    <span
      aria-hidden
      className="inline-flex shrink-0 items-center justify-center rounded-md font-bold text-white"
      style={{ width: size, height: size, background: projectColor(id), fontSize: Math.round(size * 0.46) }}
    >
      {(name.trim()[0] ?? "?").toUpperCase()}
    </span>
  );
}

/** A teammate's initials in a coloured circle. */
export function Avatar({ name, size = 26, ring = true }: { name: string; size?: number; ring?: boolean }) {
  const initials = name
    .split(/\s+/)
    .map((p) => p[0])
    .join("")
    .slice(0, 2)
    .toUpperCase();
  return (
    <span
      title={name}
      className={`inline-flex shrink-0 items-center justify-center rounded-full font-semibold text-white ${ring ? "border-2 border-surface" : ""}`}
      style={{ width: size, height: size, background: projectColor(name), fontSize: Math.round(size * 0.4) }}
    >
      {initials || "?"}
    </span>
  );
}
