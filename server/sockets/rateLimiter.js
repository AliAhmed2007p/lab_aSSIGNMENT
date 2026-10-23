'use strict';

// Sliding-window limiter. Create one per socket so every connection
// has its own budget: at most `max` actions in any `windowMs` period.
function createRateLimiter(options) {
  const max = options.max;
  const windowMs = options.windowMs;
  let timestamps = [];

  return {
    consume() {
      const now = Date.now();
      timestamps = timestamps.filter((t) => now - t < windowMs);

      if (timestamps.length >= max) {
        return {
          allowed: false,
          retryAfterMs: windowMs - (now - timestamps[0]),
        };
      }

      timestamps.push(now);
      return { allowed: true, retryAfterMs: 0 };
    },
  };
}

module.exports = { createRateLimiter };