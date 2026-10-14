import { useState, type ReactElement } from "react";
import { Alert, Badge, Button, Dialog } from "@coffee-platform/ui";
import { NavLink, Outlet } from "react-router-dom";
import {
  dismissRecoveryDiscardedWarning,
  hasRecoveryDiscardedWarning,
  readPendingIntents,
} from "../api/idempotency.js";
import { ProblemAlert } from "../api/problem.js";
import { useLogout } from "../api/remote.js";
import { PendingRecovery } from "./PendingRecovery.js";
import { RealtimeFallback, RealtimeIndicator } from "./OrderRealtime.js";
import { useSession } from "./session.js";

const links = [
  { label: "Клиенты", to: "/app/customers" },
  { label: "Каталог", to: "/app/catalog" },
  { label: "Новый заказ", to: "/app/orders/new" },
] as const;

export function AppShell(): ReactElement {
  const session = useSession();
  const logout = useLogout();
  const [logoutOpen, setLogoutOpen] = useState(false);
  const [recoveryDiscarded, setRecoveryDiscarded] = useState(hasRecoveryDiscardedWarning);
  const pending = readPendingIntents();
  return (
    <main className="operator-shell" id="workspace">
      <a className="skip-link" href="#route-content">К основному содержимому</a>
      <aside aria-label="Боковая панель платформы" className="operator-sidebar">
        <NavLink aria-label="CoffeeOrderPlatform — клиенты" className="brand" to="/app/customers">
          <span aria-hidden="true" className="brand-mark">C</span>
          <span className="brand-copy"><strong>CoffeeOrder</strong><span>PLATFORM</span></span>
        </NavLink>
        <p className="sidebar-label">РАБОЧЕЕ ПРОСТРАНСТВО</p>
        <nav aria-label="Основная навигация" className="sidebar-nav">
          {links.map((link) => <NavLink className={({ isActive }) => `nav-item${isActive ? " nav-item-active" : ""}`} key={link.to} to={link.to}>{link.label}</NavLink>)}
        </nav>
        <div className="sidebar-profile"><span aria-hidden="true" className="profile-avatar">О</span><span><strong>Оператор</strong><small>{session.actorRef}</small></span></div>
      </aside>
      <div className="workspace-content">
        <header className="workspace-topbar">
          <div className="breadcrumb"><span>Операторская платформа</span><span aria-hidden="true">/</span><strong>Рабочая среда</strong></div>
          <nav aria-label="Мобильная навигация" className="mobile-nav">{links.map((link) => <NavLink key={link.to} to={link.to}>{link.label}</NavLink>)}</nav>
          <div className="session-actions">
            <RealtimeIndicator />
            <Badge tone="success">СЕССИЯ АКТИВНА</Badge>
            <Button onPress={() => setLogoutOpen(true)} size="compact" variant="quiet">Выйти</Button>
          </div>
        </header>
        {recoveryDiscarded ? <Alert title="Восстановление прежней сессии недоступно" tone="warning">
          <p>Локальные метаданные незавершённых команд другого оператора удалены. Не повторяйте действие без проверки результата у владельца данных.</p>
          <Button onPress={() => {
            dismissRecoveryDiscardedWarning();
            setRecoveryDiscarded(false);
          }} size="compact" variant="quiet">Понятно</Button>
        </Alert> : null}
        <RealtimeFallback />
        <PendingRecovery />
        {logout.isError ? <ProblemAlert error={logout.error} /> : null}
        <div className="route-content" id="route-content" tabIndex={-1}><Outlet /></div>
        <footer className="workspace-footer"><span>Данные подтверждаются сервером</span><span>Команды защищены от повторной отправки</span></footer>
      </div>
      <Dialog
        description={pending.corrupt || pending.items.length > 0
          ? "После выхода локальные данные восстановления незавершённых команд будут удалены. Сначала проверьте их результат или продолжите выход осознанно."
          : "Текущая серверная сессия будет завершена, а приватные данные — очищены из браузера."}
        footer={<><Button onPress={() => setLogoutOpen(false)} variant="quiet">Отмена</Button><Button isPending={logout.isPending} onPress={() => logout.mutate()} variant="danger">Завершить сессию</Button></>}
        isOpen={logoutOpen}
        onOpenChange={setLogoutOpen}
        title="Выйти из операторской платформы?"
      >
        {pending.corrupt || pending.items.length > 0
          ? <Alert title="Есть незавершённые команды" tone="warning">Их неизвестный результат не переносится в следующую сессию.</Alert>
          : <p>Для продолжения работы потребуется снова войти через защищённый контур.</p>}
      </Dialog>
    </main>
  );
}
