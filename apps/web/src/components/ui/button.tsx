import { Slot } from "@radix-ui/react-slot";
import { cva, type VariantProps } from "class-variance-authority";
import type * as React from "react";
import { forwardRef } from "react";
import { cn } from "../../lib/cn";

const buttonVariants = cva("vpg-button", {
  variants: {
    variant: {
      default: "vpg-button-default",
      primary: "vpg-button-primary",
      ghost: "vpg-button-ghost",
      subtle: "vpg-button-subtle",
      destructive: "vpg-button-destructive",
    },
    size: {
      sm: "vpg-button-sm",
      md: "vpg-button-md",
      icon: "vpg-button-icon",
    },
  },
  defaultVariants: {
    variant: "default",
    size: "md",
  },
});

export type ButtonProps = React.ButtonHTMLAttributes<HTMLButtonElement> &
  VariantProps<typeof buttonVariants> & {
    asChild?: boolean;
  };

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(
  ({ asChild, className, size, variant, ...props }, ref) => {
    const Comp = asChild ? Slot : "button";
    return (
      <Comp
        ref={ref}
        className={cn(buttonVariants({ size, variant }), className)}
        {...props}
      />
    );
  },
);

Button.displayName = "Button";

export { buttonVariants };
