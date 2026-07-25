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
    dateStrings: true,
    charset: "utf8mb4",
  });
}
