const buckets = new Map();

function prune(now) {
  for (const [key, entry] of buckets) {
    if (entry.resetAt <= now) buckets.delete(key);
  }
}

/**
 * Simple in-memory rate limit for public auth endpoints.
 * @param {{ limit?: number, windowMs?: number }} options
 */
export function authRateLimit({ limit = 5, windowMs = 15 * 60 * 1000 } = {}) {
  return (req, res, next) => {
    const now = Date.now();
    if (buckets.size > 5000) prune(now);

    const ip = req.ip || req.socket?.remoteAddress || "unknown";
    const key = `${req.method}:${req.path}:${ip}`;
    let entry = buckets.get(key);
    if (!entry || entry.resetAt <= now) {
      entry = { count: 0, resetAt: now + windowMs };
      buckets.set(key, entry);
    }
    entry.count += 1;
    if (entry.count > limit) {
      return res.status(429).json({
        message: "คำขอมากเกินไป กรุณาลองใหม่ภายหลัง",
      });
    }
    return next();
  };
}
