import pg from "pg";

const table = "orders";
export const query = `SELECT * FROM ${table}`;
export const client = pg;
