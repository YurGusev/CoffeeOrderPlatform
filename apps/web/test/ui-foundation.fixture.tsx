import { StrictMode, useRef, useState, type ReactElement } from "react";
import { createRoot } from "react-dom/client";
import {
  Alert,
  Badge,
  Button,
  Dialog,
  Empty,
  Field,
  Icon,
  Link,
  Loading,
} from "@coffee-platform/ui";
import "../src/browser/styles.css";

const longDialogRows = Array.from({ length: 32 }, (_, index) => `Строка проверяемого содержимого dialog ${index + 1}`);

export function UiFoundationFixture(): ReactElement {
  const [dialogOpen, setDialogOpen] = useState(false);
  const [dialogDirty, setDialogDirty] = useState(false);
  const [dialogPending, setDialogPending] = useState(false);
  const [outsideCloseRequests, setOutsideCloseRequests] = useState(0);
  const [fieldInvalid, setFieldInvalid] = useState(false);
  const [saved, setSaved] = useState(false);
  const dialogInputRef = useRef<HTMLInputElement>(null);
  const dialogTriggerRef = useRef<HTMLButtonElement>(null);
  const operatorInputRef = useRef<HTMLInputElement>(null);

  return (
    <main className="min-h-screen bg-background px-4 py-8 text-ink sm:px-8" data-testid="foundation-test-fixture" id="foundation">
      <div className="mx-auto grid max-w-5xl gap-8">
        <header className="grid gap-3">
          <Badge tone="info">UI foundation test fixture</Badge>
          <h1 className="max-w-3xl text-[20px] font-semibold leading-6 tracking-tight">
            Проверяемая browser surface CoffeeOrderPlatform
          </h1>
          <p className="max-w-2xl text-[14px] leading-5 text-muted">
            Test-only harness для presentation primitives; production App не содержит этих сценарных controls.
          </p>
          <div className="flex flex-wrap items-center gap-3">
            <Button onPress={() => setSaved((value) => !value)} startIcon={<Icon name="add" />}>
              {saved ? "Сохранено локально" : "Проверить действие"}
            </Button>
            <Button ref={dialogTriggerRef} onPress={() => setDialogOpen(true)} variant="secondary">
              Открыть диалог
            </Button>
            <output data-testid="outside-close-requests">{outsideCloseRequests}</output>
            <Link href="#states">К состояниям</Link>
          </div>
        </header>

        <section aria-labelledby="targets-title" className="grid gap-3 rounded-panel border border-border bg-surface p-5">
          <h2 className="text-[20px] font-semibold leading-6" id="targets-title">Размеры интерактивных целей</h2>
          <div className="flex flex-wrap items-center gap-3">
            <Button size="compact" variant="secondary">Малая 36</Button>
            <Button size="default" variant="secondary">Средняя 40</Button>
            <Button size="touch" variant="secondary">Большая 44</Button>
          </div>
        </section>

        <section aria-labelledby="status-title" className="grid gap-4 sm:grid-cols-2" id="states">
          <h2 className="sr-only" id="status-title">Состояния foundation</h2>
          <Alert title="Сценарный state ещё не подключён" tone="info">
            Эта поверхность демонстрирует только проверяемые локальные состояния UI.
          </Alert>
          <Loading label="Демонстрация loading state" />
        </section>

        <section className="grid gap-4 rounded-panel border border-border bg-surface p-5 shadow-sm sm:grid-cols-2">
          <div className="grid content-start gap-3">
            <h2 className="text-[20px] font-semibold leading-6">Поля и фокус</h2>
            <p className="text-[14px] leading-5 text-muted">
              Invalid, disabled, description и first-invalid focus принадлежат presentation boundary.
            </p>
            <Field
              ref={operatorInputRef}
              defaultValue="operator@example.test"
              description="Только локальная демонстрация"
              errorMessage={fieldInvalid ? "Введите корректный адрес" : ""}
              isInvalid={fieldInvalid}
              label="Email оператора"
            />
            <Field defaultValue="Недоступное значение" isDisabled label="Disabled field" />
            <Button onPress={() => { setFieldInvalid(true); queueMicrotask(() => operatorInputRef.current?.focus()); }} size="compact" variant="quiet">
              Фокусировать первое invalid поле
            </Button>
          </div>
          <Empty
            action={<Button onPress={() => setSaved(true)} variant="quiet">Создать локальный пример</Button>}
            description="Здесь появятся server-owned items после реализации #9."
            title="Пока ничего нет"
          />
        </section>

        <footer className="text-[12px] leading-4 text-muted">
          <span>React Aria · Tailwind CSS v4 · Inter / Manrope · test harness</span>
        </footer>
      </div>

      <Dialog
        description="Escape, safe-close policy и возврат фокуса проверяются React Aria harness-ом."
        initialFocusRef={dialogInputRef}
        isDismissable
        isKeyboardDismissDisabled={dialogPending}
        isOpen={dialogOpen}
        onOpenChange={(nextOpen) => {
          setDialogOpen(nextOpen);
          if (!nextOpen) {
            setDialogDirty(false);
            setDialogPending(false);
          }
        }}
        onRequestClose={(reason) => {
          if (reason === "outside") setOutsideCloseRequests((count) => count + 1);
          return reason === "action" || (!dialogDirty && !dialogPending);
        }}
        returnFocusRef={dialogTriggerRef}
        title="Foundation dialog test fixture"
      >
        <div className="grid gap-4">
          <Field
            ref={dialogInputRef}
            defaultValue="Локальный пример"
            description="Изменение блокирует Escape и outside-close до явного action."
            isInvalid={dialogDirty}
            label="Данные dialog"
            onChange={() => setDialogDirty(true)}
          />
          <p className="text-[14px] leading-5 text-muted">
            Здесь нет mutation, fetch или production route — только проверяемый primitive boundary.
          </p>
          <div className="flex flex-wrap gap-2">
            <Button onPress={() => setDialogDirty(false)} size="compact" variant="quiet">Сбросить изменения</Button>
            <Button isPending={dialogPending} onPress={() => setDialogPending(true)} size="compact" variant="secondary">
              {dialogPending ? "Операция выполняется" : "Включить pending"}
            </Button>
            {dialogPending ? <Button onPress={() => setDialogPending(false)} size="compact" variant="quiet">Снять pending</Button> : null}
          </div>
          <div className="grid gap-2" data-testid="dialog-long-content">
            {longDialogRows.map((row) => <p className="text-[14px] leading-5 text-muted" key={row}>{row}</p>)}
          </div>
        </div>
      </Dialog>
    </main>
  );
}

const root = document.getElementById("root");
if (!root) throw new Error("UI foundation fixture root is missing");
createRoot(root).render(
  <StrictMode>
    <UiFoundationFixture />
  </StrictMode>,
);
