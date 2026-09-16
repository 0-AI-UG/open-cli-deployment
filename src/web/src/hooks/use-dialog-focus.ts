import { useEffect, type RefObject } from "react";

const focusable = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';
let openDialogs = 0;
let originalOverflow = "";

/** Keep keyboard focus inside the topmost dialog and return it to its trigger. */
export function useDialogFocus(open: boolean, dialogRef: RefObject<HTMLElement | null>) {
  useEffect(() => {
    if (!open) return;
    const dialog = dialogRef.current;
    if (!dialog) return;
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    if (openDialogs++ === 0) {
      originalOverflow = document.body.style.overflow;
      document.body.style.overflow = "hidden";
    }

    const first = dialog.querySelector<HTMLElement>(focusable);
    (first ?? dialog).focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Tab" || !dialog.isConnected) return;
      const items = Array.from(dialog.querySelectorAll<HTMLElement>(focusable)).filter((item) => item.getClientRects().length > 0);
      if (items.length === 0) {
        event.preventDefault();
        dialog.focus();
        return;
      }
      const firstItem = items[0];
      const lastItem = items[items.length - 1];
      if (event.shiftKey && (document.activeElement === firstItem || !dialog.contains(document.activeElement))) {
        event.preventDefault();
        lastItem.focus();
      } else if (!event.shiftKey && (document.activeElement === lastItem || !dialog.contains(document.activeElement))) {
        event.preventDefault();
        firstItem.focus();
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      if (--openDialogs === 0) document.body.style.overflow = originalOverflow;
      previousFocus?.focus();
    };
  }, [open, dialogRef]);
}
