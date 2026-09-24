import type { ReactElement, ReactNode, Ref } from "react";
import { Button as AriaButton, type ButtonProps as AriaButtonProps } from "react-aria-components";
import { cn } from "../cn.js";

/** Adapted from shadcn/ui's React Aria button source; tokens stay package-owned. */

export type ButtonVariant = "primary" | "secondary" | "danger" | "quiet";
export type ButtonSize = "compact" | "default" | "touch";

export type ButtonProps = Omit<AriaButtonProps, "children" | "className"> & {
  children: ReactNode;
  className?: string;
  endIcon?: ReactNode;
  ref?: Ref<HTMLButtonElement>;
  size?: ButtonSize;
  startIcon?: ReactNode;
  variant?: ButtonVariant;
};

const variantClasses: Record<ButtonVariant, string> = {
  danger: "bg-danger-bg text-danger-text hover:bg-danger-bg/80",
  primary: "bg-primary text-on-primary hover:bg-primary/90",
  secondary: "border border-border bg-surface text-ink hover:bg-surface-muted",
  quiet: "bg-transparent text-ink hover:bg-surface-muted",
};

const sizeClasses: Record<ButtonSize, string> = {
  compact: "min-h-[36px] px-3 text-sm",
  default: "min-h-[40px] px-4 text-sm",
  touch: "min-h-[44px] px-5 text-base",
};

export function Button({
  children,
  className,
  endIcon,
  ref,
  size = "default",
  startIcon,
  variant = "primary",
  ...props
}: ButtonProps): ReactElement {
  return (
    <span aria-busy={props.isPending || undefined}>
      <AriaButton
        {...props}
        ref={ref}
        data-size={size}
        data-slot="button"
        data-variant={variant}
        className={cn(
          "inline-flex items-center justify-center gap-2 rounded-control font-medium transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus disabled:cursor-not-allowed disabled:opacity-50 data-[pending]:cursor-wait data-[pending]:opacity-70",
          variantClasses[variant],
          sizeClasses[size],
          className,
        )}
      >
        {startIcon}
        <span>{children}</span>
        {endIcon}
      </AriaButton>
    </span>
  );
}
