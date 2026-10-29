import {
  useEffect,
  useRef,
  useState,
  type ReactElement,
  type ReactNode,
  type RefObject,
} from "react";
import {
  Dialog as AriaDialog,
  Heading,
  Modal,
  ModalOverlay,
  type DialogProps as AriaDialogProps,
} from "react-aria-components";
import { Button } from "./button.js";

/** Adapted from shadcn/ui's React Aria dialog source with an explicit close policy. */
export type DialogCloseReason = "action" | "escape" | "outside";

export type DialogProps = Omit<AriaDialogProps, "children" | "className"> & {
  children: ReactNode;
  description?: string;
  defaultOpen?: boolean;
  footer?: ReactNode;
  initialFocusRef?: RefObject<HTMLElement | null>;
  isDismissable?: boolean;
  isKeyboardDismissDisabled?: boolean;
  isOpen?: boolean;
  onOpenChange?: (isOpen: boolean) => void;
  onRequestClose?: (reason: DialogCloseReason) => boolean;
  returnFocusRef?: RefObject<HTMLElement | null>;
  shouldCloseOnInteractOutside?: (element: Element) => boolean;
  title: string;
};

export function Dialog({
  children,
  defaultOpen = false,
  description,
  footer,
  initialFocusRef,
  isDismissable = false,
  isKeyboardDismissDisabled = false,
  isOpen,
  onOpenChange,
  onRequestClose,
  returnFocusRef,
  shouldCloseOnInteractOutside,
  title,
  ...props
}: DialogProps): ReactElement | null {
  const controlled = isOpen !== undefined;
  const [uncontrolledOpen, setUncontrolledOpen] = useState(defaultOpen);
  const open = controlled ? isOpen : uncontrolledOpen;
  const previousOpen = useRef(false);
  const closeReason = useRef<DialogCloseReason | null>(null);

  const canClose = (reason: DialogCloseReason): boolean =>
    onRequestClose?.(reason) !== false;
  const commitOpenChange = (nextOpen: boolean): void => {
    if (!controlled) setUncontrolledOpen(nextOpen);
    onOpenChange?.(nextOpen);
  };
  const close = (reason: DialogCloseReason): void => {
    if (!canClose(reason)) return;
    closeReason.current = reason;
    commitOpenChange(false);
  };
  const handleOpenChange = (nextOpen: boolean): void => {
    if (nextOpen) {
      closeReason.current = null;
      commitOpenChange(true);
      return;
    }

    const reason = closeReason.current ?? "escape";
    closeReason.current = null;
    if (!canClose(reason)) return;
    commitOpenChange(false);
  };
  const handleOutsideInteraction = (element: Element): boolean => {
    if (
      shouldCloseOnInteractOutside &&
      !shouldCloseOnInteractOutside(element)
    ) {
      closeReason.current = null;
      return false;
    }
    closeReason.current = "outside";
    return true;
  };

  useEffect(() => {
    if (open && !previousOpen.current) {
      closeReason.current = null;
      const target = initialFocusRef?.current;
      if (target) queueMicrotask(() => target.focus());
    }
    if (!open && previousOpen.current) returnFocusRef?.current?.focus();
    previousOpen.current = open;
  }, [initialFocusRef, open, returnFocusRef]);

  return (
    <ModalOverlay
      className="fixed inset-0 z-50 flex items-center justify-center bg-ink/45 p-4"
      data-slot="dialog-overlay"
      isDismissable={isDismissable}
      isKeyboardDismissDisabled={isKeyboardDismissDisabled}
      isOpen={open}
      onOpenChange={handleOpenChange}
      shouldCloseOnInteractOutside={handleOutsideInteraction}
    >
      <Modal
        className="max-h-[calc(100dvh-32px)] w-full max-w-[640px] overflow-y-auto rounded-panel border border-border bg-surface p-6 shadow-xl sm:max-h-[calc(100dvh-48px)] xl:max-h-[calc(100dvh-64px)]"
        data-slot="dialog-content"
      >
        <AriaDialog
          {...props}
          aria-label={title}
          className="grid gap-5 outline-none"
          data-slot="dialog"
        >
          <div>
            <Heading
              className="text-[20px] font-semibold leading-6 text-ink"
              data-slot="dialog-title"
              level={2}
              slot="title"
            >
              {title}
            </Heading>
            {description ? (
              <p
                className="mt-2 text-[14px] leading-5 text-muted"
                data-slot="dialog-description"
              >
                {description}
              </p>
            ) : null}
          </div>
          <div>{children}</div>
          <div
            className="flex min-h-[44px] flex-col-reverse items-stretch gap-3 sm:flex-row sm:items-center sm:justify-end"
            data-slot="dialog-footer"
          >
            {footer ?? (
              <Button
                onPress={() => close("action")}
                size="touch"
                variant="secondary"
              >
                Закрыть
              </Button>
            )}
          </div>
        </AriaDialog>
      </Modal>
    </ModalOverlay>
  );
}
