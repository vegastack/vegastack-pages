import type * as React from "react";
import { forwardRef } from "react";
import { cn } from "../../lib/cn";

export const Input = forwardRef<
  HTMLInputElement,
  React.InputHTMLAttributes<HTMLInputElement>
>(({ className, ...props }, ref) => (
  <input ref={ref} className={cn("vpg-input", className)} {...props} />
));
Input.displayName = "Input";
