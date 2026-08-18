import jwt from "jsonwebtoken";
import { config } from "../core/config.js";
import { readTokenFromRequest } from "../core/session-cookie.js";
import { createUserRepository } from "../repositories/users.js";

/**
 * JWT proves identity; CMS roles/permissions come from DB (short TTL in users repo).
 * Accepts Portal cookie `lfb_token` (claim `sub` or `id`) as well as the legacy `token` cookie.
 */
export function createAuth(pool) {
  const users = createUserRepository(pool);

  return async function requireAuth(req, res, next) {
    const token = readTokenFromRequest(req);

    if (!token) {
      return res.status(401).json({ message: "Unauthorized" });
    }

    try {
      const claims = jwt.verify(token, config.jwtSecret);
      const userId = claims.sub ?? claims.id;
      if (userId == null || userId === "") {
        return res.status(401).json({ message: "Unauthorized" });
      }
      const user = await users.findById(userId);
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
        first_name: user.first_name || null,
        last_name: user.last_name || null,
        email: user.email || null,
        telegram_id: user.telegram_id || null,
        telegram_chat_id: user.telegram_chat_id || null,
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
