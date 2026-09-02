import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const WORKFLOW_PATH = resolve(REPO_ROOT, '.github/workflows/status-labels.yml');
const workflow = await readFile(WORKFLOW_PATH, 'utf8');
const AsyncFunction = Object.getPrototypeOf(async function asyncFunction() {}).constructor;

function embeddedScript(source) {
  const marker = '          script: |\n';
  const markerIndex = source.indexOf(marker);
  assert.notEqual(markerIndex, -1, 'workflow must contain an embedded github-script');
  const lines = source.slice(markerIndex + marker.length).split('\n');
  return lines
    .filter((line) => line.length === 0 || line.startsWith('            '))
    .map((line) => line.slice(12))
    .join('\n');
}

const script = embeddedScript(workflow);
const execute = new AsyncFunction('github', 'context', 'core', script);

async function runScenario({ eventName, payload, closingIssues = [], reviewDecision, issues }) {
  const updates = [];
  const messages = { info: [], warning: [] };
  const github = {
    graphql: async (query) => query.includes('closingIssuesReferences')
      ? { repository: { pullRequest: { closingIssuesReferences: { nodes: closingIssues.map((number) => ({ number })) } } } }
      : { repository: { pullRequest: { reviewDecision } } },
    rest: {
      issues: {
        get: async ({ issue_number: issueNumber }) => {
          if (!issues.has(issueNumber)) {
            const error = new Error('not found');
            error.status = 404;
            throw error;
          }
          return { data: issues.get(issueNumber) };
        },
        setLabels: async (input) => updates.push(input),
      },
    },
  };
  const core = {
    info: (message) => messages.info.push(message),
    warning: (message) => messages.warning.push(message),
  };
  const context = {
    eventName,
    payload,
    repo: { owner: 'YurGusev', repo: 'CoffeeOrderPlatform' },
  };

  await execute(github, context, core);
  return { updates, messages };
}

function issue(labels = ['type:platform', 'status:ready']) {
  return { labels: labels.map((name) => ({ name })) };
}

void test('workflow has trusted events, least privileges and a pinned action', () => {
  assert.match(workflow, /^on:\n  create:\n  issues:/m);
  assert.match(workflow, /pull_request_target:/);
  assert.match(workflow, /pull_request_review:/);
  assert.match(workflow, /contents: read\n  issues: write\n  pull-requests: read/);
  assert.match(workflow, /actions\/github-script@ed597411d8f924073f98dfc5c65a23a2325f34cd # v8/);
  assert.doesNotMatch(workflow, /actions\/checkout/);
  assert.ok(script.length > 1000);
});

void test('branch creation starts work and preserves non-status labels', async () => {
  const result = await runScenario({
    eventName: 'create',
    payload: { ref: 'feature/23-status-label-automation', ref_type: 'branch' },
    issues: new Map([[23, issue(['type:platform', 'priority:P1', 'status:blocked'])]]),
  });
  assert.deepEqual(result.updates, [{
    owner: 'YurGusev',
    repo: 'CoffeeOrderPlatform',
    issue_number: 23,
    labels: ['type:platform', 'priority:P1', 'status:in-progress'],
  }]);
});

void test('an unrelated branch is ignored', async () => {
  const result = await runScenario({
    eventName: 'create',
    payload: { ref: 'release/2026-09', ref_type: 'branch' },
    issues: new Map(),
  });
  assert.deepEqual(result.updates, []);
  assert.match(result.messages.info[0], /не соответствует формату/);
});

void test('issue close and reopen select done and ready', async () => {
  for (const [action, expected] of [['closed', 'status:done'], ['reopened', 'status:ready']]) {
    const result = await runScenario({
      eventName: 'issues',
      payload: { action, issue: { number: 23 } },
      issues: new Map([[23, issue(['area:quality', 'status:review'])]]),
    });
    assert.deepEqual(result.updates[0].labels, ['area:quality', expected]);
  }
});

void test('PR branch and closing references update every related issue', async () => {
  const result = await runScenario({
    eventName: 'pull_request_target',
    payload: {
      action: 'opened',
      pull_request: { number: 24, head: { ref: 'feature/23-status-label-automation' }, draft: false, merged: false },
    },
    closingIssues: [24],
    issues: new Map([[23, issue()], [24, issue(['bug', 'status:in-progress'])]]),
  });
  assert.deepEqual(result.updates.map(({ issue_number: number, labels }) => ({ number, labels })), [
    { number: 23, labels: ['type:platform', 'status:review'] },
    { number: 24, labels: ['bug', 'status:review'] },
  ]);
});

void test('draft, review decision and merge transitions are deterministic', async () => {
  const scenarios = [
    ['pull_request_target', 'converted_to_draft', true, false, undefined, 'status:in-progress'],
    ['pull_request_review', 'submitted', false, false, 'APPROVED', 'status:testing'],
    ['pull_request_review', 'submitted', false, false, 'CHANGES_REQUESTED', 'status:in-progress'],
    ['pull_request_target', 'closed', false, true, undefined, 'status:done'],
    ['pull_request_target', 'closed', false, false, undefined, 'status:in-progress'],
  ];

  for (const [eventName, action, draft, merged, reviewDecision, expected] of scenarios) {
    const result = await runScenario({
      eventName,
      payload: {
        action,
        pull_request: { number: 24, head: { ref: 'feature/23-status-label-automation' }, draft, merged },
      },
      reviewDecision,
      issues: new Map([[23, issue(['type:platform', 'status:review'])]]),
    });
    assert.deepEqual(result.updates[0].labels, ['type:platform', expected]);
  }
});
