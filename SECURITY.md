# Security

Report vulnerabilities privately using [GitHub's security advisory form](https://github.com/Graindevue/sandy/security/advisories/new).
Do not put tokens, private keys, customer data, or private source excerpts in public
issues, pull requests, or CI artifacts. Include the affected commit, a minimal
reproduction with fake credentials, and the expected boundary.

## Before committing or publishing

Install the pinned, checksum-verified Gitleaks binary locally, then scan staged
changes before committing and all fetched history before pushing:

```bash
pnpm security:setup
pnpm security:scan:staged
git fetch --all --tags
pnpm security:scan
pnpm security:audit
```

The installer supports macOS and Linux on x64 and arm64. It stores Gitleaks under
the ignored `.sandy/tools/` directory and does not change global Git hooks or
system packages. `GITLEAKS_BIN` can point at another locally installed Gitleaks.
`security:scan:staged` checks the index, including newly staged files; the full
history scan checks every locally fetched ref. Unstaged and untracked files are
not included until staged. A failed or missing scanner blocks the command.

For an optional local pre-commit hook, add `pnpm security:scan:staged` to an
existing hook, or create a hook containing the following if none exists:

```sh
#!/bin/sh
exec pnpm security:scan:staged
```

Place it at the path printed by `git rev-parse --git-path hooks/pre-commit` and
make it executable. Preserve any existing hook's checks. Hooks are optional and
local; GitHub push protection and required CI checks are the shared enforcement.

Environment files, `auth.json`, and private-key files are ignored. Only the
explicitly named `.env.example`, `.env.*.example`, `*.example.pem`, and
`*.example.key` patterns are exceptions; samples must contain clearly fake values.
Git ignore rules do not protect files already committed. Never bypass a scanner
with an inline allow comment, a broad allowlist, or an unreviewed baseline.
The four `.gitleaksignore` fingerprints cover two reviewed nonsecret benchmark
cache identifiers in the original commit and its rebase. Exceptions must identify the exact commit,
file, rule and line, with a documented nonsecret use; never ignore a whole path
or rule. A later credential at the same location must still fail scanning.

## Repository controls

The Security workflow scans full Git history with Gitleaks and audits all locked
dependencies on integration/release PRs, pushes, and a weekly schedule. Findings
are fully redacted; raw secret reports are not uploaded. Both jobs run with
read-only repository permissions and require no repository secrets, including
for fork PRs. CI actions are pinned to reviewed commit SHAs, and Dependabot opens
weekly dependency and Actions updates against `staging`.

The `Native Linux sandbox` check installs the same pinned Codex CLI and scoped
bubblewrap/AppArmor prerequisites as the review action. It runs a hostile npm
lifecycle fixture through the real `codex sandbox` command using dummy
credentials, checking credential files, parent process access, environment
isolation, and read-only shared Git metadata. It makes no LLM request and needs
no login or consumer repository access. A skipped probe fails the check.

Keep GitHub secret scanning, push protection, dependency alerts, and automatic
security updates enabled in repository settings. Keep branch rules requiring PR
review and all four checks: `Lint, type-check & test`, `Secret scanning`,
`Dependency audit`, and `Native Linux sandbox`. Prevent force pushes and branch
deletion; administrator bypass should apply only through a PR. Require full
commit SHA pins in the Actions repository policy, and allow only GitHub-owned
actions and `pnpm/action-setup`. Older branches must adopt these workflows and
pins before their PRs can satisfy the checks. Security updates
for the default branch still need a release through the integration workflow;
do not leave a fixed version only on an unmerged branch.

## Responding to an exposure

Revoke or rotate the credential at its provider first, then update the protected
runtime secret and verify that the old credential no longer works. Deleting a
file or making the repository private does not invalidate a credential already
copied. Check provider usage logs and the affected application's audit logs for
unexpected access. Remove private data from the current tree, and coordinate
any Git history rewrite with maintainers after preserving necessary incident
evidence. Never paste the exposed value into a public report.
