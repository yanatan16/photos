import { formatBytes, formatRate, formatDuration } from './format.js';

// ── constants ─────────────────────────────────────────────────────────────────

const TASK_BAR_WIDTH = 14;
const TOTAL_BAR_WIDTH = 21;
const REDRAW_MS = 100;
const MAX_ROWS = 8;

const HIDE_CURSOR = '\x1b[?25l';
const SHOW_CURSOR = '\x1b[?25h';
const CLEAR_BELOW = '\x1b[0J';

// ── pure renderers ────────────────────────────────────────────────────────────

export const renderBar = (fraction, width) => {
  const clamped = Number.isNaN(fraction) ? 0 : Math.min(1, Math.max(0, fraction));
  const filled = Math.round(clamped * width);
  return `[${'█'.repeat(filled)}${'░'.repeat(width - filled)}]`;
};

const renderTaskDetail = (task) => {
  if (task.state === 'active' && task.total > 0) {
    const fraction = task.loaded / task.total;
    const percent = String(Math.round(Math.min(1, fraction) * 100)).padStart(3);
    const bytes = `${formatBytes(task.loaded)} / ${formatBytes(task.total)}`;
    const detail = task.note ? `${bytes}  ${task.note}` : bytes;
    return `${renderBar(fraction, TASK_BAR_WIDTH)}  ${percent}%   ${detail}`;
  }

  const detail = task.note ?? (task.state === 'queued' ? 'queued' : 'working');
  return `${renderBar(0, TASK_BAR_WIDTH)}   —    ${detail}`;
};

export const renderDisplay = (state) => {
  const {
    label, total, completed, failed,
    bytesDone, bytesTotal, startedAt, now,
    tasks, maxRows = MAX_ROWS,
  } = state;

  const active = tasks.filter(task => task.state === 'active');
  const queued = tasks.filter(task => task.state === 'queued');
  const visible = [...active, ...queued].slice(0, maxRows);
  const nameWidth = visible.reduce((width, task) => Math.max(width, task.name.length), 0);

  const elapsedMs = Math.max(0, now - startedAt);
  const rate = elapsedMs > 0 ? (bytesDone / elapsedMs) * 1000 : 0;
  const fraction = bytesTotal > 0
    ? bytesDone / bytesTotal
    : (total > 0 ? completed / total : 0);
  const etaMs = rate > 0 && bytesTotal > 0
    ? ((bytesTotal - bytesDone) / rate) * 1000
    : Infinity;

  const summary = [`${completed}/${total}`, formatRate(rate), `eta ${formatDuration(etaMs)}`];
  if (failed > 0) summary.push(`${failed} failed`);

  return [
    label,
    '',
    ...visible.map(task => `  ${task.name.padEnd(nameWidth)}  ${renderTaskDetail(task)}`),
    '',
    `  total  ${renderBar(fraction, TOTAL_BAR_WIDTH)}  ${summary.join('  •  ')}`,
  ];
};

// ── terminal shell ────────────────────────────────────────────────────────────

const visibleLength = (line) => line.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '').length;

export const createProgressDisplay = ({
  label,
  items,
  stream = process.stdout,
  clock = Date.now,
  redrawMs = REDRAW_MS,
  maxRows = MAX_ROWS,
}) => {
  const tasks = new Map(items.map(item => [item.id, {
    name: item.name,
    total: item.totalBytes ?? null,
    loaded: 0,
    state: 'queued',
    note: null,
  }]));

  const bytesTotal = items.reduce((sum, item) => sum + (item.totalBytes ?? 0), 0);
  const startedAt = clock();
  const isTTY = Boolean(stream.isTTY);

  let completed = 0;
  let failed = 0;
  let lastLineCount = 0;
  let timer = null;

  const snapshot = () => ({
    label,
    total: items.length,
    completed,
    failed,
    bytesDone: [...tasks.values()].reduce((sum, task) => sum + task.loaded, 0),
    bytesTotal,
    startedAt,
    now: clock(),
    maxRows,
    tasks: [...tasks.values()],
  });

  const truncate = (line) => {
    const width = stream.columns ?? 80;
    return visibleLength(line) > width ? `${line.slice(0, width - 1)}…` : line;
  };

  const paint = () => {
    const lines = renderDisplay(snapshot()).map(truncate);
    const moveUp = lastLineCount > 0 ? `\x1b[${lastLineCount}A` : '';
    stream.write(`${moveUp}${CLEAR_BELOW}${lines.join('\n')}\n`);
    lastLineCount = lines.length;
  };

  const patch = (id, changes) => {
    const task = tasks.get(id);
    if (task) Object.assign(task, changes);
  };

  if (isTTY) {
    stream.write(HIDE_CURSOR);
    paint();
    timer = setInterval(paint, redrawMs);
    timer.unref?.();
  } else {
    stream.write(`${label}\n`);
  }

  return {
    startTask: (id) => patch(id, { state: 'active', note: null }),
    updateTask: (id, loaded) => patch(id, { loaded }),
    noteTask: (id, note) => patch(id, { note }),

    finishTask: (id, { error } = {}) => {
      const task = tasks.get(id);
      if (!task) return;

      if (error) {
        failed += 1;
        Object.assign(task, { state: 'failed', note: error.message });
      } else {
        completed += 1;
        Object.assign(task, { state: 'done', loaded: task.total ?? task.loaded, note: null });
      }

      if (!isTTY) {
        stream.write(error ? `  ✗ ${task.name} — ${error.message}\n` : `  ✓ ${task.name}\n`);
      }
    },

    counts: () => ({ completed, failed }),

    stop: () => {
      if (timer) clearInterval(timer);
      timer = null;
      if (isTTY) {
        paint();
        stream.write(SHOW_CURSOR);
      }
    },
  };
};
