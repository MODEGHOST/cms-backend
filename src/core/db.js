import mysql from "mysql2/promise";
import { config } from "./config.js";

export function createPool() {
  return mysql.createPool({
    host: config.db.host,
    port: config.db.port,
    user: config.db.user,
    password: config.db.password,
    database: config.db.database,
    waitForConnections: true,
    connectionLimit: config.db.connectionLimit,
    // Cap waiting requests so the process does not grow an unbounded queue under load.
    // Default is high enough that normal CMS traffic should never hit it.
    queueLimit: config.db.queueLimit,
    enableKeepAlive: true,
    keepAliveInitialDelay: 10_000,
    dateStrings: true,
    charset: "utf8mb4",
  });
}
