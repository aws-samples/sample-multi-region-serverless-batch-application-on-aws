import { github } from 'projen';
import { GitHubProject } from 'projen/lib/github';

const project = new GitHubProject({
  name: 'sample-multi-region-serverless-batch-application-on-aws',
  githubOptions: {
    pullRequestLintOptions: {
      semanticTitleOptions: {
        types: ['feat', 'fix', 'chore', 'docs', 'refactor', 'test', 'ci'],
      },
    },
  },
});

project.gitignore.exclude(
  '.idea',
  '.vscode',
  '**/.DS_Store',
  '**/__pycache__/',
  '*.pyc',
  '.claude/',
  '.kiro/',
  '.env',
  '.env.*',
  '.aws-sam/',
);

new github.Stale(project.github!, {
  pullRequest: { daysBeforeStale: 30, daysBeforeClose: 14 },
  issues: { daysBeforeStale: 60, daysBeforeClose: 30 },
});

// ─── Dependabot ────────────────────────────────────────────────────────────────
const dep = project.github!.addDependabot({
  scheduleInterval: github.DependabotScheduleInterval.WEEKLY,
  ignoreProjen: false,
});

const WEEKLY_SCHEDULE = { interval: 'weekly' };
const NON_MAJOR_GROUP = {
  'all-minor-and-patch': { 'update-types': ['minor', 'patch'] },
};

dep.config.updates[0].groups = NON_MAJOR_GROUP;
dep.config.updates[0]['open-pull-requests-limit'] = 5;

// Each Lambda function has its own requirements.txt
const PIP_DIRS = [
  '/source/active-region-monitor',
  '/source/custom-resource',
  '/source/get-data',
  '/source/merge-s3-files',
  '/source/mrap-routing',
  '/source/read-file',
  '/source/reconciliation',
  '/source/reconciliation-trigger',
  '/source/region-writer',
  '/source/s3-lambda-notification',
  '/source/send-email',
  '/source/split-ip-file',
  '/source/validate-data',
  '/source/write-output-chunk',
];

dep.config.updates.push(
  ...PIP_DIRS.map((directory) => ({
    'package-ecosystem': 'pip',
    directory,
    schedule: WEEKLY_SCHEDULE,
    'open-pull-requests-limit': 5,
    groups: NON_MAJOR_GROUP,
  })),
  {
    'package-ecosystem': 'github-actions',
    directory: '/',
    schedule: WEEKLY_SCHEDULE,
    'open-pull-requests-limit': 5,
    groups: NON_MAJOR_GROUP,
  },
);

// ─── Auto-merge for Dependabot patch PRs ───────────────────────────────────────
const autoMerge = project.github!.addWorkflow('dependabot-auto-merge');
autoMerge.on({ pullRequest: {} });
autoMerge.addJob('auto-merge', {
  runsOn: ['ubuntu-latest'],
  permissions: {
    contents: github.workflows.JobPermission.WRITE,
    pullRequests: github.workflows.JobPermission.WRITE,
  },
  if: "github.actor == 'dependabot[bot]' && github.event.pull_request.user.login == 'dependabot[bot]'",
  steps: [
    {
      name: 'Fetch Dependabot metadata',
      id: 'metadata',
      uses: 'dependabot/fetch-metadata@v2',
      with: { 'github-token': '${{ secrets.GITHUB_TOKEN }}' },
    },
    {
      name: 'Approve patch updates',
      if: "steps.metadata.outputs.update-type == 'version-update:semver-patch'",
      run: 'gh pr review --approve "$PR_URL"',
      env: {
        PR_URL: '${{ github.event.pull_request.html_url }}',
        GH_TOKEN: '${{ secrets.GITHUB_TOKEN }}',
      },
    },
    {
      name: 'Enable auto-merge for patch updates',
      if: "steps.metadata.outputs.update-type == 'version-update:semver-patch'",
      run: 'gh pr merge --auto --squash "$PR_URL"',
      env: {
        PR_URL: '${{ github.event.pull_request.html_url }}',
        GH_TOKEN: '${{ secrets.GITHUB_TOKEN }}',
      },
    },
  ],
});

// ─── PR Validation ─────────────────────────────────────────────────────────────
const PYTHON_VERSION = '3.12';
const PR_VALIDATION_PATHS = ['source/**', 'deployment/**', '.github/workflows/pr-validation.yml'];

const prValidation = project.github!.addWorkflow('pr-validation');
prValidation.on({
  pullRequest: { branches: ['main'], paths: PR_VALIDATION_PATHS },
  workflowDispatch: {},
});
prValidation.addJobs({
  'cfn-lint': {
    runsOn: ['ubuntu-latest'],
    permissions: { contents: github.workflows.JobPermission.READ },
    steps: [
      { uses: 'actions/checkout@v4' },
      { uses: 'actions/setup-python@v5', with: { 'python-version': PYTHON_VERSION } },
      { name: 'Install cfn-lint', run: 'pip install cfn-lint' },
      {
        name: 'Run cfn-lint',
        run: 'cfn-lint deployment/**/*.yaml deployment/**/*.yml --ignore-templates deployment/github-oidc-role.yaml --ignore-checks W3005,W2001,W8001,W1020,W7001,W1031,E1029,E3030',
      },
    ],
  },
  pytest: {
    runsOn: ['ubuntu-latest'],
    permissions: { contents: github.workflows.JobPermission.READ },
    steps: [
      { uses: 'actions/checkout@v4' },
      { uses: 'actions/setup-python@v5', with: { 'python-version': PYTHON_VERSION } },
      { name: 'Install test deps', run: 'pip install pytest hypothesis moto aws-xray-sdk && find source -name requirements.txt -exec pip install -r {} \\;' },
      { name: 'Run tests', run: 'pytest source/ -v --tb=short' },
    ],
  },
});

// ─── E2E Workflow ──────────────────────────────────────────────────────────────
const E2E_PATHS = ['source/**', 'deployment/**', '.github/workflows/e2e.yml'];

const e2e = new github.GithubWorkflow(project.github!, 'e2e', {
  limitConcurrency: true,
  concurrencyOptions: {
    group: 'e2e-${{ github.head_ref || github.ref_name }}',
    cancelInProgress: true,
  },
});
e2e.on({
  push: { branches: ['main'], paths: E2E_PATHS },
  pullRequest: { branches: ['main'], paths: E2E_PATHS },
  workflowDispatch: {},
});
e2e.addJob('e2e', {
  name: 'Build, Deploy, Test, Teardown',
  runsOn: ['ubuntu-latest'],
  timeoutMinutes: 120,
  permissions: {
    idToken: github.workflows.JobPermission.WRITE,
    contents: github.workflows.JobPermission.READ,
  },
  env: {
    AWS_REGION: 'us-east-1',
    SECONDARY_REGION: 'us-west-2',
  },
  steps: [
    { name: 'Checkout', uses: 'actions/checkout@v4' },
    {
      name: 'Set ENV to short sha',
      run: 'echo "ENV=-${GITHUB_SHA:0:7}" >> $GITHUB_ENV',
    },
    {
      name: 'Configure AWS credentials',
      uses: 'aws-actions/configure-aws-credentials@v4',
      with: {
        'role-to-assume': '${{ secrets.E2E_ROLE_ARN }}',
        'aws-region': '${{ env.AWS_REGION }}',
        'role-duration-seconds': 28800,
      },
    },
    {
      name: 'Install dependencies',
      run: [
        'sudo apt-get update -qq && sudo apt-get install -y -qq jq',
        'pip3 install boto3 aws-sam-cli --quiet',
      ].join('\n'),
    },
    {
      name: 'Pre-deploy cleanup (tear down any leftover stacks for this SHA)',
      workingDirectory: 'deployment',
      run: 'make destroy-all ENV=${{ env.ENV }} || true',
    },
    {
      name: 'Deploy (full multi-region)',
      workingDirectory: 'deployment',
      run: 'make deploy ENV=${{ env.ENV }}',
    },
    {
      name: 'Capture failure diagnostics',
      if: 'failure()',
      run: [
        'set +e',
        'echo "::group::Failed stacks (both regions)"',
        'for region in ${{ env.AWS_REGION }} ${{ env.SECONDARY_REGION }}; do',
        '  echo "=== $region ==="',
        '  aws cloudformation list-stacks --region "$region" --no-cli-pager \\',
        '    --query "StackSummaries[?StackStatus==\'CREATE_FAILED\' || StackStatus==\'ROLLBACK_COMPLETE\' || StackStatus==\'ROLLBACK_FAILED\'].[StackName, StackStatus]" \\',
        '    --output text',
        '  # Per-stack events for our ENV',
        '  STACKS=$(aws cloudformation list-stacks --region "$region" --no-cli-pager \\',
        '    --query "StackSummaries[?(StackStatus==\'CREATE_FAILED\' || StackStatus==\'ROLLBACK_COMPLETE\') && contains(StackName, \'${{ env.ENV }}\')].StackName" \\',
        '    --output text)',
        '  for stack in $STACKS; do',
        '    echo "--- $stack ---"',
        '    aws cloudformation describe-stack-events --stack-name "$stack" --region "$region" --no-cli-pager \\',
        '      --max-items 20 --query "StackEvents[?contains(ResourceStatus, \'FAILED\')].[Timestamp,LogicalResourceId,ResourceStatus,ResourceStatusReason]" --output text 2>&1 | head -20 || true',
        '  done',
        'done',
        'echo "::endgroup::"',
      ].join('\n'),
    },
    {
      name: 'Smoke test',
      workingDirectory: 'deployment',
      run: [
        '# 1. Get the Main Orchestrator Step Function ARN from the batch stack',
        'SFN_ARN=$(aws cloudformation describe-stack-resource --stack-name batch${{ env.ENV }} \\',
        '  --logical-resource-id BlogBatchMainOrchestrator --region ${{ env.AWS_REGION }} \\',
        '  --query "StackResourceDetail.PhysicalResourceId" --output text)',
        'echo "Main Orchestrator SFN: $SFN_ARN"',
        '',
        '# 2. Get the MRAP alias and construct full ARN (s3 cp requires arn:aws:s3::<account>:accesspoint/<alias>)',
        'ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)',
        'MRAP_ALIAS=$(aws cloudformation describe-stacks --stack-name global-routing${{ env.ENV }} \\',
        '  --region ${{ env.AWS_REGION }} --query "Stacks[0].Outputs[?contains(OutputKey,\'MRAP\') || contains(OutputKey,\'Mrap\') || contains(OutputKey,\'AccessPoint\')].OutputValue" --output text)',
        '# Fallback: query S3 control API directly',
        'if [ -z "$MRAP_ALIAS" ]; then',
        '  MRAP_ALIAS=$(aws s3control get-multi-region-access-point --account-id $ACCOUNT_ID \\',
        '    --name source-bucket-mrap${{ env.ENV }} --region us-west-2 \\',
        '    --query "AccessPoint.Alias" --output text)',
        'fi',
        '# Strip any arn: prefix if stack output was a full ARN already',
        'if [[ "$MRAP_ALIAS" == arn:* ]]; then',
        '  MRAP_ARN="$MRAP_ALIAS"',
        'else',
        '  MRAP_ARN="arn:aws:s3::${ACCOUNT_ID}:accesspoint/${MRAP_ALIAS}"',
        'fi',
        'echo "MRAP: $MRAP_ARN"',
        '',
        '# 3. Upload test file to trigger the batch',
        'TIMESTAMP=$(date +%s)',
        'aws s3 cp ../assets/testfile.csv "s3://${MRAP_ARN}/input/testfile-${TIMESTAMP}.csv"',
        'echo "Uploaded test file, waiting for Step Function execution..."',
        '',
        '# 4. Poll for Step Function execution to complete (max 10 min)',
        'for i in $(seq 1 20); do',
        '  sleep 30',
        '  EXEC=$(aws stepfunctions list-executions --state-machine-arn "$SFN_ARN" \\',
        '    --status-filter SUCCEEDED --max-results 1 --no-cli-pager \\',
        '    --query "executions[0].startDate" --output text 2>/dev/null)',
        '  if [ "$EXEC" != "None" ] && [ -n "$EXEC" ]; then',
        '    echo "Step Function execution SUCCEEDED"',
        '    break',
        '  fi',
        '  # Check for completion (FAILED is acceptable if it reached the email step)',
        '  FAILED=$(aws stepfunctions list-executions --state-machine-arn "$SFN_ARN" \\',
        '    --status-filter FAILED --max-results 1 --no-cli-pager \\',
        '    --query "executions[0].executionArn" --output text 2>/dev/null)',
        '  if [ "$FAILED" != "None" ] && [ -n "$FAILED" ]; then',
        '    echo "Step Function execution completed with FAILED status"',
        '    # Check if failure was at the email step (SES not verified in e2e account)',
        '    CAUSE=$(aws stepfunctions get-execution-history --execution-arn "$FAILED" \\',
        '      --reverse-order --max-results 5 --no-cli-pager \\',
        '      --query "events[?type==\'TaskFailed\' || type==\'ExecutionFailed\'].taskFailedEventDetails.cause" --output text 2>/dev/null || true)',
        '    if echo "$CAUSE" | grep -qi "ses\\|email\\|SendEmail\\|MessageRejected"; then',
        '      echo "Failure was at email step (SES identity not verified) -- acceptable in e2e ✓"',
        '      EXEC="$FAILED"',
        '      break',
        '    else',
        '      echo "Step Function failed at unexpected step:"',
        '      aws stepfunctions get-execution-history --execution-arn "$FAILED" \\',
        '        --reverse-order --max-results 10 --no-cli-pager',
        '      exit 1',
        '    fi',
        '  fi',
        '  echo "  Attempt $i: execution not complete yet..."',
        'done',
        '# Fail if loop exhausted without completion',
        'if [ -z "$EXEC" ] || [ "$EXEC" = "None" ]; then',
        '  echo "ERROR: Step Function execution did not complete within 10 minutes"',
        '  aws stepfunctions list-executions --state-machine-arn "$SFN_ARN" --max-results 3 --no-cli-pager',
        '  exit 1',
        'fi',
        '',
        '# 5. Verify CloudWatch dashboard exists',
        'echo "Checking CloudWatch dashboard..."',
        'aws cloudwatch get-dashboard --dashboard-name "MultiRegionBatchDashboard${{ env.ENV }}" \\',
        '  --region ${{ env.AWS_REGION }} --no-cli-pager > /dev/null',
        'echo "CloudWatch dashboard exists ✓"',
        '',
        '# 6. Verify Step Function metrics are populated',
        'echo "Checking CloudWatch metrics..."',
        'END_TIME=$(date -u +%Y-%m-%dT%H:%M:%SZ)',
        'START_TIME=$(date -u -d "15 minutes ago" +%Y-%m-%dT%H:%M:%SZ)',
        'DATAPOINTS=$(aws cloudwatch get-metric-statistics \\',
        '  --namespace AWS/States --metric-name ExecutionsSucceeded \\',
        '  --dimensions Name=StateMachineArn,Value="$SFN_ARN" \\',
        '  --start-time "$START_TIME" --end-time "$END_TIME" \\',
        '  --period 300 --statistics Sum \\',
        '  --region ${{ env.AWS_REGION }} --no-cli-pager \\',
        '  --query "Datapoints | length(@)" --output text)',
        'if [ "$DATAPOINTS" -gt 0 ]; then',
        '  echo "Step Function metrics populated ✓ ($DATAPOINTS datapoints)"',
        'else',
        '  echo "WARNING: No metric datapoints yet (may need more time to propagate)"',
        'fi',
      ].join('\n'),
    },
    {
      name: 'Teardown',
      if: 'always()',
      workingDirectory: 'deployment',
      run: [
        'echo "Cleaning up e2e environment..."',
        'make destroy-all ENV=${{ env.ENV }} || true',
        'echo "Teardown complete"',
      ].join('\n'),
    },
  ],
});

project.synth();
