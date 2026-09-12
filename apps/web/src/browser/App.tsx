import type { ReactElement } from "react";
import { Alert, Badge, Button, Empty, Field, Icon, Link, Loading } from "@coffee-platform/ui";

export function App(): ReactElement {
  return (
    <main className="min-h-screen bg-background px-4 py-8 text-ink sm:px-8" id="foundation">
      <div className="mx-auto grid max-w-5xl gap-8">
        <header className="grid gap-3">
          <Badge tone="info">UI foundation</Badge>
          <h1 className="max-w-3xl text-[20px] font-semibold leading-6 tracking-tight">
            Операторская foundation для CoffeeOrderPlatform
          </h1>
          <p className="max-w-2xl text-[14px] leading-5 text-muted">
            Нейтральная browser surface без маршрутов, транспорта и серверного состояния.
          </p>
          <div className="flex flex-wrap items-center gap-3">
            <Icon label="Пакетные иконки" name="search" />
            <Link href="#states">К состояниям foundation</Link>
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
          <Alert title="Серверный state ещё не подключён" tone="info">
            Эта поверхность демонстрирует только семантику и локальные состояния UI.
          </Alert>
          <Loading label="Демонстрация loading state" />
        </section>

        <section className="grid gap-4 rounded-panel border border-border bg-surface p-5 shadow-sm sm:grid-cols-2">
          <div className="grid content-start gap-3">
            <h2 className="text-[20px] font-semibold leading-6">Поля и фокус</h2>
            <p className="text-[14px] leading-5 text-muted">
              Ошибки, description и keyboard focus принадлежат presentation boundary; сценарные
              invalid/dirty/pending states проверяются только в browser test harness.
            </p>
            <Field
              defaultValue="operator@example.test"
              description="Только локальная демонстрация"
              label="Email оператора"
            />
          </div>
          <Empty
            description="Здесь появятся server-owned items после реализации #9."
            title="Пока ничего нет"
          />
        </section>

        <footer className="text-[12px] leading-4 text-muted">
          <span>React Aria · Tailwind CSS v4 · IBM Plex Sans</span>
        </footer>
      </div>
    </main>
  );
}
