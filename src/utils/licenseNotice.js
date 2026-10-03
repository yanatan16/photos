export const LICENSE_NOTICE_KEY = 'licenseNoticeShownOn';

const localDay = (now) =>
  [now.getFullYear(), now.getMonth() + 1, now.getDate()]
    .map(n => String(n).padStart(2, '0'))
    .join('-');

const safely = (fallback, fn) => {
  try {
    return fn();
  } catch {
    return fallback;
  }
};

export const wasShownToday = (storage, now = new Date()) =>
  safely(false, () => storage.getItem(LICENSE_NOTICE_KEY) === localDay(now));

export const markShownToday = (storage, now = new Date()) =>
  safely(undefined, () => storage.setItem(LICENSE_NOTICE_KEY, localDay(now)));
