const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

export const withRetry = async (operation, {
  attempts = 4,
  baseDelayMs = 500,
  onRetry = () => {},
} = {}) => {
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      if (attempt === attempts) throw error;
      const backoffMs = baseDelayMs * 2 ** (attempt - 1);
      onRetry({ attempt, attempts, error, backoffMs });
      await delay(backoffMs);
    }
  }
};
