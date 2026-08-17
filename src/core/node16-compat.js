/**
 * Small helpers for Node 16.20 runtime gaps (native fetch / Object.hasOwn).
 * Safe no-ops on newer Node where these already exist.
 */
import fetchImpl from "node-fetch";

if (typeof globalThis.fetch !== "function") {
  globalThis.fetch = fetchImpl;
}

if (typeof Object.hasOwn !== "function") {
  Object.hasOwn = (object, property) =>
    Object.prototype.hasOwnProperty.call(Object(object), property);
}

export function timeoutSignal(ms) {
  if (typeof AbortSignal !== "undefined" && typeof AbortSignal.timeout === "function") {
    return AbortSignal.timeout(ms);
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  if (typeof timer.unref === "function") timer.unref();
  return controller.signal;
}
