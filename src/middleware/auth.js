import jwt from "jsonwebtoken";
import { config } from "../core/config.js";

export function createAuth() {
  return function requireAuth(req, res, next) {
    const header = req.headers.authorization || "";
    const tokenFromHeader = header.startsWith("Bearer ") ? header.slice(7) : null;
    const token = tokenFromHeader || req.cookies?.token;

    if (!token) {
      return res.status(401).json({ message: "Unauthorized" });
    }

    try {
      req.user = jwt.verify(token, config.jwtSecret);
      return next();
    } catch {
      return res.status(401).json({ message: "Invalid or expired token" });
    }
  };
}
