/**
 * Limit how many async tasks run at once (per gate instance).
 */
export function createConcurrencyGate(max = 4) {
  const limit = Math.max(1, Number(max) || 4);
  let active = 0;
  const queue = [];

  function pump() {
    while (active < limit && queue.length) {
      const job = queue.shift();
      active += 1;
      Promise.resolve()
        .then(job.fn)
        .then(job.resolve, job.reject)
        .finally(() => {
          active -= 1;
          pump();
        });
    }
  }

  return function enqueue(fn) {
    return new Promise((resolve, reject) => {
      queue.push({ fn, resolve, reject });
      pump();
    });
  };
}
