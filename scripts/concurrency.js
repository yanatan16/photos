export const mapWithConcurrency = async (items, limit, worker) => {
  const results = new Array(items.length);
  let nextIndex = 0;

  const runWorker = async () => {
    while (nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;
      const item = items[index];
      try {
        results[index] = { item, value: await worker(item, index) };
      } catch (error) {
        results[index] = { item, error };
      }
    }
  };

  const workerCount = Math.max(0, Math.min(limit, items.length));
  await Promise.all(Array.from({ length: workerCount }, runWorker));

  return results;
};

export const parseConcurrencyFlag = (args) => {
  const index = args.indexOf('--concurrency');
  if (index === -1) return { concurrency: null, rest: args };

  const raw = args[index + 1];
  const value = Number(raw);
  if (raw === undefined || !Number.isInteger(value) || value < 1) {
    throw new Error('--concurrency requires a positive integer');
  }

  return {
    concurrency: value,
    rest: [...args.slice(0, index), ...args.slice(index + 2)],
  };
};
