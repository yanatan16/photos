// Comparators for ISO date strings that may be null. A photo with no date
// (no EXIF, no object modification time) always sorts to the end, whichever
// direction the rest of the list runs in.
const withNullsLast = (compare) => (a, b) => {
  if (!a) return b ? 1 : 0;
  if (!b) return -1;
  return compare(a, b);
};

export const byDateAscending = withNullsLast((a, b) => Date.parse(a) - Date.parse(b));

export const byDateDescending = withNullsLast((a, b) => Date.parse(b) - Date.parse(a));
