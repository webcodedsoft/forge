"use client";

import { Check, ChevronDown } from "lucide-react";
import { type ReactNode, useId, useRef, useState } from "react";
import ReactSelect, {
  components,
  type DropdownIndicatorProps,
  type OptionProps,
  type SingleValue,
} from "react-select";

/*
 * Forge's dropdown (react-select, styled with Forge's tokens). Use it instead of <select>.
 *
 *   <Select ariaLabel="Role" value={role} onChange={setRole}
 *           options={[{ value: "admin", label: "Admin", hint: "Everything" }]} />
 *
 * Options can have an icon and a hint (a second, smaller line). Menus are rendered in <body> (or in
 * the open <dialog>, which sits above everything), so no parent's overflow, transform or animation
 * can clip or misplace them. Turn on `searchable` for long lists.
 */

export type SelectOption<V extends string = string> = {
  value: V;
  label: string;
  hint?: string;
  icon?: ReactNode;
  disabled?: boolean;
  /** A small tag on the right of the option in the menu (e.g. "Chat only"). */
  tag?: { label: string; tone?: "pri" | "muted" };
};

/** Tallest a menu gets (px), and the space kept to the window's edge. */
const MENU_MAX = 288;
const MENU_GAP = 12;
/** The menu's margin (6), padding (8) and border (2) around the list. */
const MENU_CHROME = 16;

const SIZES = {
  sm: "min-h-8 text-[13px]",
  md: "min-h-9 text-[13.5px]",
  lg: "min-h-10 text-[14px]",
};

function Indicator<V extends string>(
  props: DropdownIndicatorProps<SelectOption<V>, false>,
) {
  return (
    <components.DropdownIndicator {...props}>
      <ChevronDown
        size={15}
        className={`transition-transform ${props.selectProps.menuIsOpen ? "rotate-180" : ""}`}
        aria-hidden
      />
    </components.DropdownIndicator>
  );
}

function Option<V extends string>(props: OptionProps<SelectOption<V>, false>) {
  const o = props.data;
  return (
    <components.Option {...props}>
      <span className="flex items-start gap-2.5">
        {o.icon && (
          <span
            className={`mt-0.5 shrink-0 ${props.isSelected ? "text-primary" : "text-ink-3"}`}
          >
            {o.icon}
          </span>
        )}
        <span className="min-w-0 flex-1">
          <span className="block truncate">{o.label}</span>
          {o.hint && (
            <span className="mt-0.5 block text-[12px] font-normal leading-snug text-ink-3">
              {o.hint}
            </span>
          )}
        </span>
        {o.tag && (
          <span
            className={`mt-0.5 shrink-0 whitespace-nowrap rounded px-1.5 py-px text-[10.5px] font-medium ${
              o.tag.tone === "pri" ? "bg-primary-weak text-primary" : "bg-surface-2 text-ink-2"
            }`}
          >
            {o.tag.label}
          </span>
        )}
        {props.isSelected && (
          <Check
            size={14}
            className="mt-0.5 shrink-0 text-primary"
            aria-hidden
          />
        )}
      </span>
    </components.Option>
  );
}

export function Select<V extends string = string>({
  value,
  onChange,
  options,
  ariaLabel,
  id,
  placeholder = "Choose…",
  disabled = false,
  searchable = false,
  clearable = false,
  size = "md",
  className = "",
  menuWidth,
}: {
  value: V | "" | null;
  onChange: (value: V) => void;
  options: SelectOption<V>[];
  ariaLabel?: string;
  /** For a <label htmlFor>. */
  id?: string;
  placeholder?: string;
  disabled?: boolean;
  searchable?: boolean;
  clearable?: boolean;
  size?: keyof typeof SIZES;
  className?: string;
  /** Wider menu than the control, e.g. "18rem". */
  menuWidth?: string;
}) {
  const instanceId = useId();
  const selected = options.find((o) => o.value === value) ?? null;
  const box = useRef<HTMLSpanElement>(null);
  // Where the menu is rendered: the modal this select is in (the top layer), else <body>.
  const [portal, setPortal] = useState<HTMLElement | null>(null);
  // Open up or down, whichever has room, and fit the list to that space. (react-select's own
  // "auto" can't measure once the menu is rendered outside its parent, so we do it here.)
  const [place, setPlace] = useState<{ side: "top" | "bottom"; max: number }>({ side: "bottom", max: MENU_MAX });
  const measure = () => {
    const r = (box.current?.firstElementChild as HTMLElement | null)?.getBoundingClientRect();
    if (!r) return;
    // Room for the list itself: the gap to the window edge, the menu's margin, padding and border.
    const below = window.innerHeight - r.bottom - MENU_GAP - MENU_CHROME;
    const above = r.top - MENU_GAP - MENU_CHROME;
    // Down when the full menu fits (or it's the roomier side), otherwise up.
    const side = below >= MENU_MAX || below >= above ? "bottom" : "top";
    setPlace({ side, max: Math.max(96, Math.min(MENU_MAX, side === "bottom" ? below : above)) });
  };
  return (
    <span ref={box} className="contents">
      <ReactSelect<SelectOption<V>, false>
        onMenuOpen={() => {
          setPortal(box.current?.closest("dialog") ?? document.body);
          measure();
        }}
        maxMenuHeight={place.max}
        menuPortalTarget={portal}
      // The menu doesn't follow the page, so close it when the page (not the menu) scrolls.
      closeMenuOnScroll={(e) => !(e.target instanceof Element && e.target.closest(".forge-select-menu"))}
        instanceId={instanceId}
        inputId={id}
        aria-label={ariaLabel}
        className={className}
        unstyled
        isDisabled={disabled}
        isSearchable={searchable}
        isClearable={clearable}
        isOptionDisabled={(o) => Boolean(o.disabled)}
        options={options}
        value={selected}
        placeholder={placeholder}
        onChange={(o: SingleValue<SelectOption<V>>) => o && onChange(o.value)}
        menuPosition="fixed"
        menuPlacement={place.side}
        noOptionsMessage={() => "Nothing matches"}
        components={{
          DropdownIndicator: Indicator<V>,
          Option: Option<V>,
          IndicatorSeparator: null,
        }}
        formatOptionLabel={(o, meta) =>
          meta.context === "value" ? (
            <span className="flex min-w-0 items-center gap-2">
              {o.icon && <span className="shrink-0 text-ink-3">{o.icon}</span>}
              <span className="truncate">{o.label}</span>
            </span>
          ) : (
            o.label
          )
        }
        styles={{
          menu: (base) => ({
            ...base,
            ...(menuWidth ? { width: menuWidth, minWidth: "100%" } : {}),
          }),
          menuPortal: (base) => ({ ...base, zIndex: 100 }),
        }}
        classNames={{
          control: (s) =>
            `${SIZES[size]} rounded-md border bg-surface px-2.5 transition-[border-color,box-shadow] ${
              s.isFocused
                ? "border-primary shadow-[0_0_0_3px_var(--primary-ring)]"
                : "border-line-2 hover:border-ink-3"
            } ${s.isDisabled ? "cursor-not-allowed opacity-55" : "cursor-pointer"}`,
          valueContainer: () => "gap-1 py-0.5",
          singleValue: () => "text-ink",
          placeholder: () => "text-ink-3",
          input: () => "text-ink",
          indicatorsContainer: () => "gap-1 pl-1 text-ink-3",
          clearIndicator: () =>
            "rounded p-0.5 hover:bg-surface-2 hover:text-ink",
          dropdownIndicator: (s) => (s.isFocused ? "text-ink" : ""),
          menu: () => `forge-select-menu pop ${place.side === "top" ? "mb-1.5" : "mt-1.5"} overflow-hidden p-1 text-[13.5px] z-[100]`,
          option: (s) =>
            `rounded-md px-2.5 py-2 ${s.isDisabled ? "cursor-not-allowed opacity-50" : "cursor-pointer"} ${
              s.isSelected
                ? "bg-primary-weak font-semibold text-primary"
                : s.isFocused
                  ? "bg-surface-2 text-ink"
                  : "text-ink"
            }`,
          noOptionsMessage: () => "px-2.5 py-2 text-ink-3",
        }}
      />
    </span>
  );
}
