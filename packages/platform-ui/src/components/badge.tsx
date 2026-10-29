import type { ReactElement, ReactNode } from "react";
import { cn } from "../cn.js";

export interface BadgeProps {
  children: ReactNode;
  className?: string;
  tone?: "neutral" | "info" | "success" | "warning" | "danger";
}

const toneClasses: Record<NonNullable<BadgeProps["tone"]>, string> = {
  danger: "bg-danger-bg text-ink",
  info: "bg-primary/10 text-[var(--cos-action-primary-soft-text)]",
  neutral: "bg-surface-muted text-muted",
  success: "bg-success-bg text-success-text",
  warning: "bg-warning-bg text-warning-text",
};

export function Badge({
  children,
  className,
  tone = "neutral",
}: BadgeProps): ReactElement {
  return (
    <span
      className={cn(
        "inline-flex min-h-7 items-center rounded-full px-2.5 text-xs font-semibold",
        toneClasses[tone],
        className,
      )}
    >
      {children}
    </span>
  );
}
