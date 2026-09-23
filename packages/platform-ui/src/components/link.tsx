import type { ReactElement, ReactNode } from "react";
import { Link as AriaLink, type LinkProps as AriaLinkProps } from "react-aria-components";
import { cn } from "../cn.js";

export type LinkProps = Omit<AriaLinkProps, "children" | "className"> & {
  children: ReactNode;
  className?: string;
};

export function Link({ children, className, ...props }: LinkProps): ReactElement {
  return (
    <AriaLink
      {...props}
      className={cn(
        "inline-flex min-h-9 items-center rounded-control text-[var(--cos-action-primary-soft-text)] underline decoration-primary/40 underline-offset-4 hover:decoration-primary focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus",
        className,
      )}
    >
      {children}
    </AriaLink>
  );
}
