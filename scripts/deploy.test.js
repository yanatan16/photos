import { test } from 'node:test';
import assert from 'node:assert/strict';
import { workflowUrl, describeGhFailure, triggerDeploy, WORKFLOW_FILE } from './deploy.js';

// A stub `gh` that records what it was asked to do and replies from a script
// of canned responses keyed by the subcommand.
const stubGh = (responses = {}) => {
  const calls = [];
  const run = async (command, args) => {
    calls.push({ command, args });
    const reply = responses[args[0]];
    if (reply instanceof Error) throw reply;
    return { stdout: reply ?? '', stderr: '' };
  };
  return { run, calls };
};

const ghError = (properties) => Object.assign(new Error('gh failed'), properties);

// ── workflowUrl ───────────────────────────────────────────────────────────────

test('workflowUrl points at the workflow page for the repo', () => {
  assert.equal(
    workflowUrl('yanatan16/photos'),
    'https://github.com/yanatan16/photos/actions/workflows/deploy.yml',
  );
});

// ── triggerDeploy ─────────────────────────────────────────────────────────────

test('triggerDeploy dispatches the deploy workflow and returns its URL', async () => {
  const { run, calls } = stubGh({ repo: 'yanatan16/photos\n' });

  const url = await triggerDeploy({ run });

  assert.equal(url, 'https://github.com/yanatan16/photos/actions/workflows/deploy.yml');
  assert.deepEqual(calls.map(call => call.args), [
    ['repo', 'view', '--json', 'nameWithOwner', '-q', '.nameWithOwner'],
    ['workflow', 'run', WORKFLOW_FILE],
  ]);
  assert.ok(calls.every(call => call.command === 'gh'));
});

// Resolving the repo first is a pre-flight check: it proves gh is installed,
// authenticated, and inside the repo before anything is dispatched.
test('triggerDeploy resolves the repo before dispatching anything', async () => {
  const { run, calls } = stubGh({ repo: ghError({ stderr: 'not logged into any GitHub hosts' }) });

  await assert.rejects(() => triggerDeploy({ run }));

  assert.equal(calls.length, 1, 'must not dispatch a workflow after the pre-flight fails');
});

test('triggerDeploy surfaces a dispatch failure', async () => {
  const { run } = stubGh({
    repo: 'yanatan16/photos\n',
    workflow: ghError({ stderr: 'HTTP 403: Resource not accessible' }),
  });

  await assert.rejects(() => triggerDeploy({ run }), /Resource not accessible/);
});

// ── describeGhFailure ─────────────────────────────────────────────────────────

test('describeGhFailure explains a missing gh CLI', () => {
  const message = describeGhFailure(ghError({ code: 'ENOENT' }));

  assert.match(message, /gh/);
  assert.match(message, /brew install gh/);
});

test('describeGhFailure explains an unauthenticated gh', () => {
  const message = describeGhFailure(ghError({ stderr: 'not logged into any GitHub hosts' }));

  assert.match(message, /gh auth login/);
});

test('describeGhFailure passes through an unrecognised stderr', () => {
  const message = describeGhFailure(ghError({ stderr: 'HTTP 500: upstream exploded\n' }));

  assert.match(message, /HTTP 500: upstream exploded/);
});

test('describeGhFailure falls back to the error message when stderr is empty', () => {
  assert.match(describeGhFailure(ghError({})), /gh failed/);
});
