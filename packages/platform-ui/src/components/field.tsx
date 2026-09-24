import type { ReactElement, Ref } from "react";
import {
  FieldError,
  Label,
  Text,
  TextField,
  type TextFieldProps as AriaTextFieldProps,
} from "react-aria-components";
import { cn } from "../cn.js";
import { Input } from "./input.js";

/** Adapted from shadcn/ui's React Aria field composition; validation stays native to RAC. */
export type FieldProps = Omit<AriaTextFieldProps, "children" | "className" | "description" | "label"> & {
  className?: string;
  description?: string;
  errorMessage?: string;
  isInvalid?: boolean;
  label: string;
  ref?: Ref<HTMLInputElement>;
};

export function Field({ className, description, errorMessage, isInvalid, label, ref, ...props }: FieldProps): ReactElement {
  const resolvedInvalid = isInvalid ?? Boolean(errorMessage);

  return (
    <TextField {...props} className={cn("grid gap-[8px]", className)} data-slot="field" isInvalid={resolvedInvalid} validationBehavior="aria">
      <Label className="text-[12px] font-medium leading-4 text-ink" data-slot="field-label">{label}</Label>
      <Input {...(ref ? { ref } : {})} />
      {description ? <Text className="text-[12px] text-muted" data-slot="field-description" slot="description">{description}</Text> : null}
      {errorMessage ? <FieldError className="text-[12px] text-danger-text" data-slot="field-error">{errorMessage}</FieldError> : null}
    </TextField>
  );
}
