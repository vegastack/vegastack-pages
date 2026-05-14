import * as DialogPrimitive from "@radix-ui/react-dialog";
import { X } from "lucide-react";
import type * as React from "react";
import { cn } from "../../lib/cn";
import { Button } from "./button";

/**
 * Side panel built on Radix Dialog. Slides in from a configurable edge.
 * Distinct from `Dialog` (centered modal) — use Sheet for full-height
 * drawers like the comments panel or a mobile sidebar overlay.
 */
export const Sheet = DialogPrimitive.Root;
export const SheetTrigger = DialogPrimitive.Trigger;
export const SheetClose = DialogPrimitive.Close;
export const SheetPortal = DialogPrimitive.Portal;

export function SheetOverlay({
  className,
  ...props
}: React.ComponentPropsWithoutRef<typeof DialogPrimitive.Overlay>) {
  return (
    <DialogPrimitive.Overlay
      className={cn("vpg-sheet-overlay", className)}
      {...props}
    />
  );
}

type Side = "left" | "right" | "top" | "bottom";

export interface SheetContentProps extends React.ComponentPropsWithoutRef<
  typeof DialogPrimitive.Content
> {
  /** Edge the sheet anchors to. Defaults to right. */
  side?: Side;
  showClose?: boolean;
  /**
   * Optional class to apply to the overlay (in addition to .vpg-sheet-overlay).
   * Useful when a consumer wants its own backdrop animation/styling.
   */
  overlayClassName?: string;
}

export function SheetContent({
  children,
  className,
  side = "right",
  showClose = true,
  overlayClassName,
  ...props
}: SheetContentProps) {
  return (
    <SheetPortal>
      <SheetOverlay className={overlayClassName} />
      <DialogPrimitive.Content
        data-side={side}
        className={cn("vpg-sheet-content", className)}
        {...props}
      >
        {children}
        {showClose ? (
          <DialogPrimitive.Close asChild>
            <Button
              aria-label="Close"
              className="vpg-sheet-close"
              size="icon"
              type="button"
              variant="ghost"
            >
              <X size={15} aria-hidden="true" />
            </Button>
          </DialogPrimitive.Close>
        ) : null}
      </DialogPrimitive.Content>
    </SheetPortal>
  );
}

export function SheetHeader({
  className,
  ...props
}: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("vpg-sheet-header", className)} {...props} />;
}

export function SheetTitle({
  className,
  ...props
}: React.ComponentPropsWithoutRef<typeof DialogPrimitive.Title>) {
  return (
    <DialogPrimitive.Title
      className={cn("vpg-sheet-title", className)}
      {...props}
    />
  );
}

export function SheetDescription({
  className,
  ...props
}: React.ComponentPropsWithoutRef<typeof DialogPrimitive.Description>) {
  return (
    <DialogPrimitive.Description
      className={cn("vpg-sheet-description", className)}
      {...props}
    />
  );
}
