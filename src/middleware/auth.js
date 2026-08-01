import jwt from "jsonwebtoken";
import { config } from "../core/config.js";
import { createUserRepository } from "../repositories/users.js";

/**
 * JWT proves identity; each request reloads CMS roles/permissions from DB.
 */
export function createAuth(pool) {
  const users = createUserRepository(pool);

  return async function requireAuth(req, res, next) {
    const header = req.headers.authorization || "";
    const tokenFromHeader = header.startsWith("Bearer ") ? header.slice(7) : null;
    const token = tokenFromHeader || req.cookies?.token;

    if (!token) {
      return res.status(401).json({ message: "Unauthorized" });
    }

    try {
      const claims = jwt.verify(token, config.jwtSecret);
      const user = await users.findById(claims.sub);
      if (
        !user ||
        !user.is_active ||
        !user.roles?.length ||
        user.shared_status === "suspended"
      ) {
        return res.status(401).json({ message: "Unauthorized" });
      }
      req.user = {
        sub: user.id,
        id: user.id,
        username: user.username,
        display_name: user.display_name,
        role: user.role,
        roles: user.roles,
        permissions: user.permissions,
        department: user.department || null,
      };
      return next();
    } catch {
      return res.status(401).json({ message: "Invalid or expired token" });
    }
  };
}
