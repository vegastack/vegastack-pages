import * as TooltipPrimitive from "@radix-ui/react-tooltip";
import type * as React from "react";
import { cn } from "../../lib/cn";

/**
 * Tooltip primitives. Wrap the app with `<TooltipProvider delayDuration={N}>`
 * if you want a shared timing baseline; otherwise the default 700ms is fine.
 */
export const TooltipProvider = TooltipPrimitive.Provider;
export const Tooltip = TooltipPrimitive.Root;
export const TooltipTrigger = TooltipPrimitive.Trigger;

export function TooltipContent({
  sideOffset = 4,
  className,
  ...props
}: React.ComponentPropsWithoutRef<typeof TooltipPrimitive.Content>) {
  return (
    <TooltipPrimitive.Portal>
      <TooltipPrimitive.Content
        sideOffset={sideOffset}
        className={cn("vpg-tooltip-content", className)}
        {...props}
      />
    </TooltipPrimitive.Portal>
  );
}
