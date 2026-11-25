import type { ReactElement, Ref } from "react";
import {
  Input as AriaInput,
  type InputProps as AriaInputProps,
} from "react-aria-components";
import { cn } from "./cn.js";

/** Adapted from shadcn/ui's React Aria input source. */
export type InputProps = Omit<AriaInputProps, "className"> & {
  className?: string;
  ref?: Ref<HTMLInputElement>;
};

export function Input({ className, ref, ...props }: InputProps): ReactElement {
  return (
    <AriaInput
      {...props}
      ref={ref}
      data-slot="input"
      className={cn(
        "min-h-[40px] w-full min-w-0 rounded-control border border-border bg-background px-3 py-2 text-sm text-ink shadow-sm outline-none transition-colors placeholder:text-muted disabled:cursor-not-allowed disabled:opacity-50 focus-visible:border-focus focus-visible:outline-2 focus-visible:outline-focus data-[invalid]:border-danger-border",
        className,
      )}
    />
  );
}
