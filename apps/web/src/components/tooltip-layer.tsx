"use client";

import { useEffect, useRef, useState } from "react";

/*
 * Tooltips for the whole app, in one place (like Flowkite's Tooltip, without wrapping every
 * button). Shown after a short delay on hover or keyboard focus, for:
 *   - elements with data-tip="…" (explicit help text),
 *   - elements with a title="…" (taken over, so the browser's plain tooltip doesn't also show),
 *   - icon-only buttons and links: their aria-label, when they have no visible text.
 * Escape, scrolling, clicking or leaving hides it.
 */

const DELAY_MS = 350;
const INTERACTIVE = "button, a[href], [role='tab'], [role='menuitem'], [role='switch'], [role='separator'], summary";

function tipFor(el: Element): { target: Element; text: string } | null {
  // The nearest element that explains itself.
  let node: Element | null = el;
  while (node && node !== document.body) {
    if (node instanceof HTMLElement) {
      if (node.dataset.tip) return { target: node, text: node.dataset.tip };
      const title = node.getAttribute("title");
      if (title) {
        // Take over the native tooltip.
        node.dataset.tip = title;
        node.removeAttribute("title");
        return { target: node, text: title };
      }
      if (node.matches(INTERACTIVE)) {
        const label = node.getAttribute("aria-label");
        const visible = (node.innerText || "").trim();
        if (label && !visible) return { target: node, text: label };
        return null; // a labelled control with visible text needs no tooltip
      }
    }
    node = node.parentElement;
  }
  return null;
}

export function TooltipLayer() {
  const [tip, setTip] = useState<{ text: string; x: number; y: number; below: boolean } | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const current = useRef<Element | null>(null);
  const bubble = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const hide = () => {
      clearTimeout(timer.current);
      current.current = null;
      setTip(null);
    };
    const show = (el: Element) => {
      const found = tipFor(el);
      if (!found) return hide();
      if (found.target === current.current) return;
      clearTimeout(timer.current);
      current.current = found.target;
      timer.current = setTimeout(() => {
        if (!found.target.isConnected) return;
        const r = found.target.getBoundingClientRect();
        const below = r.top < 44;
        setTip({ text: found.text, x: r.left + r.width / 2, y: below ? r.bottom + 8 : r.top - 8, below });
      }, DELAY_MS);
    };
    const over = (e: Event) => e.target instanceof Element && show(e.target);
    const out = (e: PointerEvent) => {
      if (current.current && !(e.relatedTarget instanceof Node && current.current.contains(e.relatedTarget))) hide();
    };
    const focus = (e: FocusEvent) => {
      if (e.target instanceof Element && e.target.matches(":focus-visible")) show(e.target);
    };
    const key = (e: KeyboardEvent) => e.key === "Escape" && hide();
    document.addEventListener("pointerover", over, true);
    document.addEventListener("pointerout", out, true);
    document.addEventListener("focusin", focus, true);
    document.addEventListener("focusout", hide, true);
    document.addEventListener("pointerdown", hide, true);
    document.addEventListener("keydown", key, true);
    window.addEventListener("scroll", hide, true);
    window.addEventListener("blur", hide);
    return () => {
      document.removeEventListener("pointerover", over, true);
      document.removeEventListener("pointerout", out, true);
      document.removeEventListener("focusin", focus, true);
      document.removeEventListener("focusout", hide, true);
      document.removeEventListener("pointerdown", hide, true);
      document.removeEventListener("keydown", key, true);
      window.removeEventListener("scroll", hide, true);
      window.removeEventListener("blur", hide);
      clearTimeout(timer.current);
    };
  }, []);

  // Keep the bubble on screen.
  const [shift, setShift] = useState(0);
  useEffect(() => {
    const b = bubble.current;
    if (!b || !tip) return;
    const r = b.getBoundingClientRect();
    const over = r.right > window.innerWidth - 8 ? r.right - (window.innerWidth - 8) : r.left < 8 ? r.left - 8 : 0;
    if (over) setShift((s) => s - over);
  }, [tip]);

  if (!tip) return null;
  return (
    <div
      ref={bubble}
      role="tooltip"
      className="pointer-events-none fixed z-[100] w-max max-w-xs whitespace-pre-line rounded-md bg-ink px-2 py-1 text-xs font-medium leading-snug text-paper shadow-[var(--shadow-pop)]"
      style={{
        left: tip.x + shift,
        top: tip.y,
        transform: `translate(-50%, ${tip.below ? "0" : "-100%"})`,
      }}
    >
      {tip.text}
    </div>
  );
}
