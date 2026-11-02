import { useEffect, useId, useLayoutEffect, useRef, useState, type KeyboardEvent } from 'react';
import { Check, ChevronDown } from './icons';

export type Option<T> = { value: T; label: string; disabled?: boolean };

// A drop-down in the app's own material instead of the system one. The menu is fixed to the viewport, so a scrolling
// settings panel cannot clip it, opens below or above wherever it fits, and closes on scroll, outside press or Escape.
export function Select<T extends string | number>({ label, value, options, disabled, change }: { label: string; value: T; options: Option<T>[]; disabled?: boolean; change: (value: T) => void }) {
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const [place, setPlace] = useState<{ top?: number; bottom?: number; right: number; minWidth: number; up: boolean } | null>(null);
  const root = useRef<HTMLDivElement>(null), button = useRef<HTMLButtonElement>(null);
  const id = useId();
  const current = options.find((o) => o.value === value);
  const enabled = (i: number) => !!options[i] && !options[i].disabled;
  const step = (from: number, delta: number) => {
    for (let i = from + delta, n = 0; n < options.length; i += delta, n++) {
      const j = (i + options.length) % options.length;
      if (enabled(j)) return j;
    }
    return from;
  };
  const show = () => { const at = options.findIndex((o) => o.value === value); setActive(enabled(at) ? at : step(-1, 1)); setOpen(true); };
  const close = (focus = true) => { setOpen(false); if (focus) button.current?.focus(); };
  const pick = (i: number) => { if (!enabled(i)) return; close(); if (options[i].value !== value) change(options[i].value); };

  useLayoutEffect(() => {
    if (!open || !button.current) return;
    const r = button.current.getBoundingClientRect(), height = options.length * 36 + 10;
    const up = r.bottom + 6 + height > window.innerHeight - 8 && r.top > height + 14;
    setPlace({ ...(up ? { bottom: window.innerHeight - r.top + 6 } : { top: r.bottom + 6 }), right: window.innerWidth - r.right, minWidth: r.width, up });
  }, [open, options.length]);
  useEffect(() => {
    if (!open) return;
    const outside = (e: PointerEvent) => { if (!root.current?.contains(e.target as Node)) close(false); };
    const away = () => close(false);
    document.addEventListener('pointerdown', outside);
    window.addEventListener('resize', away);
    document.addEventListener('scroll', away, true);
    return () => { document.removeEventListener('pointerdown', outside); window.removeEventListener('resize', away); document.removeEventListener('scroll', away, true); };
  }, [open]);

  const keys = (e: KeyboardEvent<HTMLButtonElement>) => {
    if (!open) { if (['ArrowDown', 'ArrowUp', 'Enter', ' '].includes(e.key)) { e.preventDefault(); show(); } return; }
    const moves: Record<string, () => void> = {
      ArrowDown: () => setActive((a) => step(a, 1)), ArrowUp: () => setActive((a) => step(a, -1)),
      Home: () => setActive(step(-1, 1)), End: () => setActive(step(options.length, -1)),
      Enter: () => pick(active), ' ': () => pick(active), Escape: () => close(),
    };
    if (e.key === 'Tab') { close(false); return; }
    if (moves[e.key]) { e.preventDefault(); e.stopPropagation(); moves[e.key](); }
  };

  return <div className="select" ref={root}>
    <button ref={button} type="button" role="combobox" className="select-button" aria-label={label} aria-haspopup="listbox" aria-expanded={open} aria-controls={`${id}-list`}
      aria-activedescendant={open ? `${id}-${active}` : undefined} disabled={disabled} onClick={() => (open ? close() : show())} onKeyDown={keys}>
      <span>{current?.label ?? ''}</span><ChevronDown size={14} className={open ? 'flipped' : ''} />
    </button>
    {open && place && <div className={`select-menu ${place.up ? 'up' : ''}`} id={`${id}-list`} role="listbox" aria-label={label}
      style={{ top: place.top, bottom: place.bottom, right: place.right, minWidth: place.minWidth }}>
      {options.map((o, i) => <div key={String(o.value)} id={`${id}-${i}`} role="option" aria-selected={o.value === value} aria-disabled={o.disabled || undefined}
        className={`select-option ${i === active ? 'active' : ''}`} onPointerEnter={() => enabled(i) && setActive(i)} onClick={() => pick(i)}>
        <span>{o.label}</span>{o.value === value && <Check size={14} />}
      </div>)}
    </div>}
  </div>;
}
