import { triggerDeploy, WORKFLOW_FILE } from './deploy.js';

// Dispatches the Pages workflow on its own — the same thing `upload --deploy`
// does at the end of an upload, for when there is nothing to upload (after
// `favorite`, `set-cover`, `r2 mv`, or a deploy that was skipped or forgotten).
try {
  console.log(`Triggering ${WORKFLOW_FILE}...`);
  console.log(`  ${await triggerDeploy()}`);
} catch (error) {
  console.error(`Publish not triggered: ${error.message}`);
  process.exitCode = 1;
}
