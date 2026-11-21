# TraceBrief

When a Playwright test fails, TraceBrief puts the failing assertion, its location and one suggested next check on the pull request. A developer can open the workflow run, jump to the test and follow an uploaded artifact link from the same comment.

> **Checkout sends signed-in customers to payment.** The assertion expected `/payment` and received `/sign-in`. This test passed in the supplied baseline. Check whether a redirect or session fixture sent the test to the sign-in route.

This example condenses the output from the included checkout suite. [Actual generated comment](demo/sample-comment.md) · [Three annotated public failures](demo/public-examples.md) · [Request a supported pilot](PILOT.md)

## Try the demo

From the extracted release or a clone of this repository, run the following with Node.js 24 or newer. The CLI and Action use only Node built-ins.

```sh
node src/run.mjs demo/checkout-report.json --baseline demo/baseline.json
```

The report includes two failed tests, one test that passed on retry and one ordinary pass. A separate baseline captured both failing tests passing. Both reports came from a local Playwright 1.62.1 run against deliberately seeded checkout logic. Machine-specific paths were normalized and local attachment references were removed.

To generate fresh reports, go to `demo/reproduce`, run `npm install` and then `npm test`. The demonstration intentionally exits with two failures. Set `DEMO_BASELINE=1` in the environment and run it again for the baseline. Each run writes `checkout-report.json` in that directory. Save the first file before running the second. The demo uses Playwright assertions and needs no browser download.

## Add it to an existing workflow

1. Copy `action.yml` and the `src` directory into `.github/actions/tracebrief/` in the repository that runs Playwright. Alternatively, once using the published repository, reference its Action by full commit SHA in the workflow's `uses` field.
2. Add the JSON reporter alongside the reporters the team already uses, for example `reporter: [['list'], ['json', { outputFile: 'playwright-report.json' }]]`. Place the triage step in the same job after the test command. The condition below lets it run after a test failure and refresh the comment after a clean rerun.
3. For same-repository PR comments, use the ordinary `pull_request` event, grant the job `contents: read` and `pull-requests: write`, and serialize runs by workflow and PR. Fork PRs receive a job summary. To use summaries only, set `comment: 'false'` and grant read access.

```yaml
- name: Explain Playwright results
  if: ${{ !cancelled() && hashFiles('playwright-report.json') != '' }}
  uses: ./.github/actions/tracebrief
  with:
    report: playwright-report.json
```

The complete [customer workflow](examples/playwright.yml) installs dependencies, runs Playwright, uploads available failure artifacts and invokes TraceBrief. Adapt the install and test commands to the team's project. For a sharded suite, merge the reports first and run a single commenting step per workflow job.

| Optional input | When to use it |
| --- | --- |
| `baseline` | Path to a second Playwright JSON file already present in the workspace. A note appears when the project, file, suite path and test title match a passing baseline test. The caller chooses and obtains the revision. |
| `artifact-url` | Pass the artifact URL output by the upload step for the current run. TraceBrief links the archive. Its analysis reads JSON evidence. |
| `openai-api-key` | Supply a GitHub Actions secret to enable AI suggestions for trusted runs. The default uses local checks. |
| `model` | Select an OpenAI chat model supporting JSON responses. The default is `gpt-4o-mini`. |
| `token` | Uses the job's built-in GitHub token by default for PR comments. |

The Action exposes `failure-count` and `flaky-count`. It shows up to five findings and counts all reported failures. A recovered test contributes to the failure count when the report enables Playwright's `failOnFlakyTests`. A malformed or missing input produces an error. The original Playwright step controls the test result.

## AI suggestions and data handling

For the CLI, set `OPENAI_API_KEY` through your usual secret manager and explicitly pass `--ai`. For GitHub Actions, supply `openai-api-key: ${{ secrets.OPENAI_API_KEY }}` only in a workflow whose authors and executed code you trust. Your provider account pays for usage.

```sh
node src/run.mjs demo/checkout-report.json --ai --output triage.md
```

AI mode sends one request to OpenAI per report containing eligible findings. It includes selected error lines after common credential patterns, emails and URLs have been filtered. Error text may still include business data. Each AI suggestion must cite a phrase in the supplied evidence. This verifies the quotation. The developer still needs to verify the suggested diagnosis. Provider timeouts and invalid output fall back to local checks.

The tool does not open screenshots or traces, execute suggested commands, or fetch a previous run automatically. GitHub summaries and comments inherit the repository's visibility. Each input JSON file is limited to 64 MiB.

## Development

```sh
node --test tests/*.test.mjs
```

The self-check workflow runs the tests, processes the included report through both entry points and checks the counts. [Playwright JSON reporter](https://playwright.dev/docs/test-reporters#json-reporter) · [GitHub JavaScript actions](https://docs.github.com/en/actions/tutorials/create-actions/create-a-javascript-action)
