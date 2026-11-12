import { Check } from "lucide-react";
import type { ReactNode } from "react";

/**
 * A choice shown as a card (role, data source type…). The selected one is unmistakable:
 * primary border and ring, tinted background, and a check mark. Use inside role="radiogroup".
 */
export function OptionCard({
  selected,
  onSelect,
  title,
  text,
  icon,
  disabled,
  badge,
}: {
  selected: boolean;
  onSelect: () => void;
  title: string;
  text?: ReactNode;
  icon?: ReactNode;
  disabled?: boolean;
  badge?: ReactNode;
}) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={selected}
      disabled={disabled}
      onClick={onSelect}
      className={`relative flex h-full flex-col items-start gap-1 rounded-[10px] border p-3 text-left transition-colors disabled:cursor-not-allowed disabled:opacity-55 ${
        selected
          ? "border-primary bg-primary-weak shadow-[0_0_0_1px_var(--primary)]"
          : "border-line-2 bg-surface hover:border-ink-3 hover:bg-surface-2"
      }`}
    >
      <span className="flex w-full items-center gap-2 pr-6">
        {icon && <span className={selected ? "text-primary" : "text-ink-3"}>{icon}</span>}
        <span className={`text-[13.5px] font-semibold ${selected ? "text-primary" : "text-ink"}`}>{title}</span>
        {badge}
      </span>
      {text && <span className="text-[12px] leading-snug text-ink-2">{text}</span>}
      <span
        aria-hidden
        className={`absolute right-2.5 top-2.5 grid size-[18px] place-items-center rounded-full border transition-colors ${
          selected ? "border-primary bg-primary text-primary-fg" : "border-line-2 bg-surface"
        }`}
      >
        {selected && <Check size={12} strokeWidth={3} />}
      </span>
    </button>
  );
}
