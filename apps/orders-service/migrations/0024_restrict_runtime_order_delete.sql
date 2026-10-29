-- Current Orders runtime has no parent-order DELETE path; item deletion remains owner-authorized.
REVOKE DELETE ON TABLE orders.orders FROM coffee_orders_service_rw;
