import type { ReactElement } from "react";
import { Alert, Badge, Button, Empty, Icon, Link, Loading } from "@coffee-platform/ui";

const navigation = [
  "Заказы",
  "Каталог",
  "Рабочий центр",
];

export function App(): ReactElement {
  return (
    <main className="operator-shell" id="workspace">
      <aside aria-label="Боковая панель платформы" className="operator-sidebar">
        <a aria-label="CoffeeOrderPlatform — главная" className="brand" href="#workspace">
          <span aria-hidden="true" className="brand-mark">C</span>
          <span className="brand-copy">
            <strong>CoffeeOrder</strong>
            <span>PLATFORM</span>
          </span>
        </a>
        <p className="sidebar-label">РАБОЧЕЕ ПРОСТРАНСТВО</p>
        <div aria-label="Будущие разделы" className="sidebar-nav" role="group">
          {navigation.map((label) => (
            <span aria-disabled="true" className="nav-item nav-item-unavailable" key={label}>
              <span aria-hidden="true" className="nav-dot" />{label}<span className="nav-soon">СКОРО</span>
            </span>
          ))}
        </div>
        <div className="sidebar-profile">
          <span aria-hidden="true" className="profile-avatar">О</span>
          <span><strong>Оператор</strong><small>Рабочая среда</small></span>
        </div>
      </aside>

      <div className="workspace-content">
        <header className="workspace-topbar">
          <div className="breadcrumb"><span>Рабочее пространство</span><span aria-hidden="true">/</span><strong>Обзор</strong></div>
          <Badge className="foundation-badge" tone="info">ОСНОВА</Badge>
        </header>

        <section aria-labelledby="page-title" className="page-intro">
          <div>
            <p className="eyebrow">ОПЕРАЦИОННАЯ ПЛАТФОРМА</p>
            <h1 id="page-title">Рабочее пространство</h1>
            <p className="page-description">Единая среда для операционных процессов CoffeeOrderPlatform.</p>
          </div>
          <Button isDisabled size="default" variant="secondary"><Icon name="search" />Поиск</Button>
        </section>

        <section aria-label="Карточки будущих разделов" className="workspace-cards">
          <article className="workspace-card workspace-card-muted">
            <div className="card-heading"><span aria-hidden="true" className="card-icon">◇</span><Badge className="foundation-badge" tone="neutral">ОСНОВА</Badge></div>
            <h2>Заказы</h2>
            <p>Рабочая область заказов</p>
            <span className="card-caption">Раздел появится после реализации</span>
          </article>
          <article className="workspace-card workspace-card-muted">
            <div className="card-heading"><span aria-hidden="true" className="card-icon">◇</span><Badge className="foundation-badge" tone="neutral">ОСНОВА</Badge></div>
            <h2>Каталог</h2>
            <p>Компоненты готовы к подключению</p>
            <span className="card-caption">Раздел появится после реализации</span>
          </article>
          <article className="workspace-card workspace-card-muted">
            <div className="card-heading"><span aria-hidden="true" className="card-icon">⌁</span><Badge className="foundation-badge" tone="neutral">ОСНОВА</Badge></div>
            <h2>Рабочий центр</h2>
            <p>Состояния и действия операторов</p>
            <span className="card-caption">Раздел появится после реализации</span>
          </article>
        </section>

        <section aria-labelledby="state-title" className="status-panel">
          <div className="status-panel-heading">
            <div><p className="eyebrow">СОСТОЯНИЕ ПОВЕРХНОСТИ</p><h2 id="state-title">Состояния интерфейса</h2></div>
            <Link href="#workspace">К началу <span aria-hidden="true">↑</span></Link>
          </div>
          <div className="state-grid">
            <Alert className="foundation-alert" title="Данные сервера не подключены" tone="info">
              Эта оболочка показывает только основу интерфейса — без переходов, данных и серверных запросов.
            </Alert>
            <div className="loading-card"><Loading className="foundation-loading" label="Демонстрация состояния загрузки" /></div>
            <Empty className="empty-card" description="Здесь появится содержимое после подключения owner-контракта." title="Нет подключённых данных" />
          </div>
        </section>

        <footer className="workspace-footer">
          <span>React Aria <i>·</i> Tailwind CSS v4</span>
          <span>Локальная основа интерфейса</span>
        </footer>
      </div>
    </main>
  );
}
