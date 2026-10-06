import type { ReactElement } from "react";
import { QueryClientProvider } from "@tanstack/react-query";
import { BrowserRouter, Navigate, Route, Routes } from "react-router-dom";
import { AppShell } from "./AppShell.js";
import { queryClient } from "./query-client.js";
import { SessionBoundary } from "./session.js";
import { CustomersPage } from "../routes/CustomersPage.js";
import { CatalogPage } from "../routes/CatalogPage.js";
import { NewOrderPage } from "../routes/NewOrderPage.js";
import { OrderCardPage } from "../routes/OrderCardPage.js";
import { NotFoundPage } from "../routes/NotFoundPage.js";

export function App(): ReactElement {
  return (
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <SessionBoundary>
          <Routes>
            <Route element={<Navigate replace to="/app/customers" />} path="/" />
            <Route element={<AppShell />} path="/app">
              <Route element={<Navigate replace to="/app/customers" />} index />
              <Route element={<CustomersPage />} path="customers" />
              <Route element={<CatalogPage />} path="catalog" />
              <Route element={<NewOrderPage />} path="orders/new" />
              <Route element={<OrderCardPage />} path="orders/:orderRef" />
            </Route>
            <Route element={<NotFoundPage />} path="*" />
          </Routes>
        </SessionBoundary>
      </BrowserRouter>
    </QueryClientProvider>
  );
}
