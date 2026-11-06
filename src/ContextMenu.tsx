import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

// confirm: a destructive item asks once more in its own place before it acts.
export type MenuItem = { label: string; icon?: ReactNode; action: () => void; disabled?: boolean; confirm?: string };

// A right-click menu in the drop-downs' material. It opens at the pointer, moves inside the window when it would
// leave it, and closes on a press outside, scroll, resize, Escape or when the window loses focus.
export function ContextMenu({ at, title, items, close }: { at: { x: number; y: number }; title?: string; items: MenuItem[]; close: () => void }) {
  const root = useRef<HTMLDivElement>(null);
  const [place, setPlace] = useState<{ left: number; top: number } | null>(null);
  const [armed, setArmed] = useState('');
  useLayoutEffect(() => {
    const r = root.current!.getBoundingClientRect();
    setPlace({ left: Math.max(8, Math.min(at.x, window.innerWidth - r.width - 8)), top: Math.max(8, Math.min(at.y, window.innerHeight - r.height - 8)) });
  }, [at.x, at.y]);
  useEffect(() => { if (place) root.current?.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus(); }, [!!place]);
  useEffect(() => {
    const outside = (e: PointerEvent) => { if (!root.current?.contains(e.target as Node)) close(); };
    document.addEventListener('pointerdown', outside, true);
    window.addEventListener('resize', close); window.addEventListener('blur', close); document.addEventListener('scroll', close, true);
    return () => { document.removeEventListener('pointerdown', outside, true); window.removeEventListener('resize', close); window.removeEventListener('blur', close); document.removeEventListener('scroll', close, true); };
  }, [close]);
  const keys = (e: KeyboardEvent) => {
    const buttons = [...root.current!.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')];
    const i = buttons.indexOf(document.activeElement as HTMLButtonElement);
    if (e.key === 'Escape' || e.key === 'Tab') { e.preventDefault(); e.stopPropagation(); close(); }
    else if (e.key === 'ArrowDown') { e.preventDefault(); buttons[(i + 1) % buttons.length]?.focus(); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); buttons[(i - 1 + buttons.length) % buttons.length]?.focus(); }
  };
  return createPortal(<div ref={root} className="context-menu" role="menu" aria-label={title} onKeyDown={keys} onContextMenu={(e) => e.preventDefault()}
    style={place ? { left: place.left, top: place.top } : { left: at.x, top: at.y, visibility: 'hidden' }}>
    {title && <div className="context-title">{title}</div>}
    {items.map((item) => <button key={item.label} role="menuitem" className={`context-item ${item.confirm ? 'danger' : ''} ${armed === item.label ? 'armed' : ''}`} disabled={item.disabled}
      onClick={() => { if (item.confirm && armed !== item.label) { setArmed(item.label); return; } close(); item.action(); }}>{item.icon}<span>{armed === item.label ? item.confirm : item.label}</span></button>)}
  </div>, document.body);
}
