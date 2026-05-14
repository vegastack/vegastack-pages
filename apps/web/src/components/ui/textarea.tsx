import { forwardRef } from "react";
import type * as React from "react";
import { cn } from "../../lib/cn";

export const Textarea = forwardRef<
  HTMLTextAreaElement,
  React.TextareaHTMLAttributes<HTMLTextAreaElement>
>(({ className, ...props }, ref) => {
  return (
    <textarea ref={ref} className={cn("vpg-textarea", className)} {...props} />
  );
});
Textarea.displayName = "Textarea";
