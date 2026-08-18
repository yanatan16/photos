import { execFile } from 'child_process';
import { promisify } from 'util';

// execFile, not exec: arguments are passed as a list to the process rather than
// through a shell, so nothing here can be interpreted as shell syntax.
const execFileAsync = promisify(execFile);

export const WORKFLOW_FILE = 'deploy.yml';

export const workflowUrl = (nameWithOwner) =>
  `https://github.com/${nameWithOwner}/actions/workflows/${WORKFLOW_FILE}`;

export const describeGhFailure = (error) => {
  if (error.code === 'ENOENT') {
    return 'gh CLI not found — install it with `brew install gh`, or deploy from the Actions tab.';
  }

  const stderr = (error.stderr ?? '').trim();
  if (/not logged in|authentication|auth login/i.test(stderr)) {
    return 'gh is not authenticated — run `gh auth login`.';
  }

  return stderr || error.message;
};

// Dispatches the Pages workflow and returns the URL of its Actions page.
//
// Photos never enter git, so there is nothing to commit first: the workflow
// rebuilds main and re-reads R2, which is exactly what publishing an upload
// means here.
//
// `gh workflow run` does not report the run it queued, and listing runs straight
// afterwards is racy — the newest run may still be the *previous* one. The
// workflow's own page sidesteps that entirely and shows the new run at the top.
export const triggerDeploy = async ({ run = execFileAsync } = {}) => {
  const gh = async (...args) => {
    try {
      return await run('gh', args);
    } catch (error) {
      throw new Error(describeGhFailure(error));
    }
  };

  // Resolved first as a pre-flight: it proves gh is installed, authenticated,
  // and inside the repo before any workflow is dispatched.
  const { stdout } = await gh('repo', 'view', '--json', 'nameWithOwner', '-q', '.nameWithOwner');
  await gh('workflow', 'run', WORKFLOW_FILE);

  return workflowUrl(stdout.trim());
};
