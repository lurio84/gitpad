import { useEffect, useLayoutEffect, useRef, useState } from "react";

export interface MenuItem {
  label: string;
  onSelect: () => void;
  /** Acción que descarta trabajo o historial: se pinta en rojo. */
  danger?: boolean;
  disabled?: boolean;
  /** Por qué está deshabilitada; sale como tooltip. */
  title?: string;
}

export interface MenuState {
  x: number;
  y: number;
  /** Rótulo pequeño sobre las opciones: sobre qué se está actuando. */
  heading: string;
  items: MenuItem[];
}

/**
 * Menú contextual (clic derecho), en la posición del puntero pero sin salirse
 * de la ventana. Se cierra con Escape, con un clic fuera, al hacer scroll o al
 * perder el foco la ventana. Cada opción es un `button`, así que se alcanza con
 * Tab y se activa con Enter/Espacio; el foco entra en la primera opción.
 */
export function ContextMenu({ menu, onClose }: { menu: MenuState; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ x: menu.x, y: menu.y });

  // Encajar en la ventana una vez medido (ancho/alto reales del menú).
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const { width, height } = el.getBoundingClientRect();
    setPos({
      x: Math.max(4, Math.min(menu.x, window.innerWidth - width - 4)),
      y: Math.max(4, Math.min(menu.y, window.innerHeight - height - 4)),
    });
    el.querySelector<HTMLButtonElement>("button:not(:disabled)")?.focus();
  }, [menu]);

  useEffect(() => {
    const away = (e: Event) => {
      if (!ref.current?.contains(e.target as Node)) onClose();
    };
    const key = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("mousedown", away, true);
    window.addEventListener("contextmenu", away, true);
    window.addEventListener("keydown", key);
    window.addEventListener("blur", onClose);
    window.addEventListener("wheel", onClose, { passive: true });
    return () => {
      window.removeEventListener("mousedown", away, true);
      window.removeEventListener("contextmenu", away, true);
      window.removeEventListener("keydown", key);
      window.removeEventListener("blur", onClose);
      window.removeEventListener("wheel", onClose);
    };
  }, [onClose]);

  return (
    <div
      className="ctx-menu"
      ref={ref}
      style={{ left: pos.x, top: pos.y }}
      role="menu"
      onContextMenu={(e) => e.preventDefault()}
    >
      <div className="ctx-heading">{menu.heading}</div>
      {menu.items.map((it) => (
        <button
          key={it.label}
          role="menuitem"
          className={it.danger ? "danger" : undefined}
          disabled={it.disabled}
          title={it.title}
          onClick={() => {
            onClose();
            it.onSelect();
          }}
        >
          {it.label}
        </button>
      ))}
    </div>
  );
}
