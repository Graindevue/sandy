# Public repository security audit — 2026-10-09

No confirmed credential leak was found in the audited public contents. The review did find a high-priority backend authorization vulnerability, a reproducible host file-read race, vulnerable dependency versions, and published personal/deployment metadata. These findings do not establish that anyone has exploited the service.

The most urgent remaining action is to release and activate the prepared Convex authorization fix. Making the GitHub repository private again would not fix an independently reachable Convex backend.

## Remediation follow-up

The fixes are prepared from public `main` at `c1eaf919e7f0704335516c579f35ea59599c0422`, which includes the guidance changes merged after the original audit snapshot. The evidence and findings below describe the original audit; they are preserved for comparison.

| Finding | Prepared fix | Activation |
| --- | --- | --- |
| F1 | All 38 remaining public functions share an OIDC identity guard; two cron-only helpers are internal. The caller uses short-lived tokens bound to its immutable repository ID, trusted workflow, signed environment, event and initial attempt. | The active deployment's three trust settings are configured. Backend deployment, caller workflow adoption and source pin change must be coordinated after release review. |
| F2 | Manifest, bot rules and agent selection read immutable Git blobs at each pinned repository SHA. Context capture finishes before dependency scripts execute. File and ancestor swap regressions pass. | Active after the caller adopts the corrected Sandy revision. |
| F3 | Direct and transitive packages are patched. Full and production dependency audits report zero advisories. | Active in checkouts using the updated lockfile; release the source pin to update reviews. |
| F4 | Live GitHub secret scanning, push protection, dependency alerts, security updates and private vulnerability reporting are enabled. New CI scans full history with a checksum-verified scanner and audits dependencies; local staged scanning and credential ignores are added. | Repository settings are active. CI and Dependabot configuration activate when merged. GitHub's additional non-provider and validity flags remain disabled: repository updates ignored them, and organization configuration required an unavailable `admin:org` token scope. Gitleaks supplies an independent generic-secret check. |
| F6 | An active ruleset requires PR review and all four CI/security checks for main and staging, and prevents force pushes and deletion. Administrator bypass is limited to PRs. Repository Actions policy enforces full SHA pins and permits only GitHub-owned actions and `pnpm/action-setup`. | Settings are active and verified through the API. Older branches must adopt the new workflows and pins before their PRs can satisfy the gates. |

Reviewable changes are in [Sandy PR #7](https://github.com/Graindevue/sandy/pull/7) and [the caller's OIDC permission PR #739](https://github.com/Graindevue/graindevue/pull/739), both targeting `staging`. The caller change adds job-scoped `id-token: write`; it does not update the active Sandy source pin. The maintainer-reviewed release required by `AGENTS.md` remains the activation gate. No backend code has been redeployed and the current caller still uses the audited source revision, so the live F1/F2 vulnerabilities remain until the coordinated rollout.

Deployment discovery found **40 public functions on the linked development deployment**, whose URL matches the local worker configuration. The project's production deployment has no functions. Do not blindly deploy with `--prod`: first confirm which endpoint the caller's encrypted `CONVEX_URL` actually selects. Deployment identifiers and URLs are intentionally omitted here.

A read-only review of 500 recent backend execution records covered 2026-10-08 23:30 UTC through 2026-10-09 12:33 UTC. All were successful executions of known Sandy functions, including internal crons. Every record reported an unknown identity, so these records cannot establish caller legitimacy or rule out prior unauthorized access. No private payloads or credentials are included in this report.

F5 privacy/history changes are outside the requested high, medium, dependency and prevention remediation. No history rewrite or credential rotation was performed.

Remediation validation:

- Lint, type checks and the worker/shared-types/manifest TypeScript builds pass.
- **393 Vitest tests** and **17 Actions/scanner tests** pass locally. Two native Linux tests are skipped on macOS. All four Ubuntu CI checks pass, including actual execution of the hostile credential-fixture probe through the native sandbox and its never-skip gate. Fresh-checkout CI also verifies tests without prebuilt local package output.
- Both full and production `pnpm audit` report **zero advisories**.
- An isolated Convex push regenerated the committed types. Actual HTTP calls verified anonymous denial, authorized reads and writes, and rejection of wrong audience, expired or invalid signatures, repository/workflow/environment mismatches, wrong events and retries. Signed test tokens used a disposable local JWKS, then the real GitHub provider was restored and pushed again. No production data was used.
- Staged files and all locally fetched history pass completely redacted Gitleaks scans.

For activation, first confirm the caller's encrypted `CONVEX_URL`, let active reviews finish, release both reviewed changes, and coordinate the authenticated backend deployment with the caller's new immutable Sandy source pin. Verify anonymous HTTP rejection and one authorized review against the actual endpoint before considering F1/F2 closed in operation.

## Scope and evidence

The public repository is **Graindevue/sandy**. This workspace's `origin` is **tony-co/sandy**, which GitHub still reports as private and which has an older default-branch revision. Runtime findings below refer to the public revision, with links pinned to its commit, rather than assuming this workspace matches production.

- Public `main`: `c4efea8a823e9ac2b9a05487716d2c6ba156c642`.
- Snapshot refreshed through **2026-10-09 12:13 UTC**. Another branch and PR appeared during the audit and were included in the final secret scan.
- Four published branches, four PR head refs, the available PR merge ref, and workflow-referenced revisions.
- **212 reachable commits; 1,266 distinct file blobs; 238 tracked files on main.**
- **1,478 complete file/commit objects, approximately 10.64 MB**, scanned independently of Git diff hunks.
- Public issue and PR bodies, review records, comments, and all **20 available Actions runs**: 53 downloaded log files, approximately 1.17 MB. Empty comment/review collections were checked too.
- No published tags, releases, Actions artifacts, or wiki were available when checked.
- GitHub repository security settings, workflow permissions, branch protection, and rulesets.
- The lockfile and the paths handling requests, authentication files, GitHub tokens, clones, dependency scripts, agent execution, context extraction, and Convex state.

Gitleaks **8.30.1** was downloaded from its official release and its binary archive's SHA-256 was verified. Scans used complete redaction, ignored inline allow comments, and included recursive decoding. Full-object scans included commit messages and author/committer metadata, supplementing the all-history diff scan. Independent pattern checks covered provider tokens, JWTs, private-key markers, Convex deploy keys, embedded URL credentials, secret assignments, deployment URLs, emails, and filesystem paths.

The audit used an isolated local mirror. No production database requests, credential validation against providers, credential revocations, history rewrites, repository-setting changes, commits, or pushes were performed.

## Findings, ordered by remediation priority

| ID | Priority | Finding | Verification |
| --- | --- | --- | --- |
| F1 | High | Convex public functions have no caller authentication or authorization | Public registration confirmed; anonymous handler calls reproduced with fixture data |
| F2 | Medium | Host context readers can follow a symlink outside the checkout after their containment check | Both readers reproduced returning an outside sentinel during concurrent file swaps |
| F3 | Medium | The lockfile contains published security advisories | Registry audit: 12 affected-package entries, including 6 high |
| F4 | Medium | Secret prevention is not configured comprehensively | GitHub API settings and ignore behavior checked |
| F5 | Low / privacy | A personal Gmail address and deployment-specific details are public | Commit metadata and documentation reviewed |
| F6 | Low / hardening | Main has no protection/ruleset; ordinary CI actions use floating tags | GitHub settings and CI workflow inspected |

### F1 — Unauthenticated access to private review state

The backend has **40 public entry points: 27 mutations, 12 queries, and one action**. Their generated registration helpers are direct aliases to Convex's public helpers. There is no `auth.config.ts`, no server-side identity check in the function modules, and no authentication configured on the Actions `ConvexHttpClient`.

A caller who knows the deployment URL can obtain valid document IDs rather than needing to guess opaque IDs:

1. [`pullRequests.ensureRepo`](https://github.com/Graindevue/sandy/blob/c4efea8a823e9ac2b9a05487716d2c6ba156c642/packages/convex-backend/convex/pullRequests.ts#L16) returns an existing repo ID for an owner/name.
2. [`pullRequests.get`](https://github.com/Graindevue/sandy/blob/c4efea8a823e9ac2b9a05487716d2c6ba156c642/packages/convex-backend/convex/pullRequests.ts#L78) returns a PR document for that ID and a PR number.
3. [`findings.listForPr`](https://github.com/Graindevue/sandy/blob/c4efea8a823e9ac2b9a05487716d2c6ba156c642/packages/convex-backend/convex/findings.ts#L73) returns stored findings, including evidence/code excerpts.
4. [`reviewJobs.subscribePending`](https://github.com/Graindevue/sandy/blob/c4efea8a823e9ac2b9a05487716d2c6ba156c642/packages/convex-backend/convex/reviewJobs.ts#L114) accepts no arguments and exposes pending job documents. Other queries expose running-job and product context.

Write access is similarly unrestricted. Examples include [`reviewJobs.markSuperseded`](https://github.com/Graindevue/sandy/blob/c4efea8a823e9ac2b9a05487716d2c6ba156c642/packages/convex-backend/convex/reviewJobs.ts#L300), `products.syncProduct`, finding-recording mutations, and `archetypes.updateSuppressionWeight`. This permits state tampering and disruption, in addition to confidentiality loss.

**Validation:** a fixture context reporting an anonymous identity successfully returned repo/PR/finding data, superseded a running job, and wrote product data. The five tested exports had `isPublic === true`; **zero authentication checks** occurred. This was a handler-level demonstration using dummy IDs/data, not a live HTTP exploit.

The deployment URL was not discovered in the audited public material; matched URLs were placeholders. That limits evidence of present exploitation, but does not provide an authorization boundary. Convex documents that public functions are accessible to clients and require explicit protection. [Convex internal functions](https://docs.convex.dev/functions/internal-functions), [authentication in functions](https://docs.convex.dev/auth/functions-auth).

**Fix:** enforce an authenticated service identity or narrowly scoped service credential on every worker-facing entry point; authorize access to the relevant product and resources. Convert server-only helpers to internal functions where appropriate, with an authenticated entry point for Actions. Configure the worker client accordingly, test anonymous rejection and cross-product denial, and deploy the change to the real backend. Review backend logs and stored state for unexplained calls or changes.

### F2 — Context reads have a check/use race

[`readRepoText`](https://github.com/Graindevue/sandy/blob/c4efea8a823e9ac2b9a05487716d2c6ba156c642/packages/manifest-builder/src/fs-utils.ts#L27) resolves and checks containment, calls `stat`, then separately opens the pathname through `readFile`. [`readOptionalBotFile`](https://github.com/Graindevue/sandy/blob/c4efea8a823e9ac2b9a05487716d2c6ba156c642/packages/bot-worker/src/config/bot-config-reader.ts#L77) uses the same pattern.

A concurrently writable checkout can replace the checked file or one of its parent directories between those operations. The trusted host reader then follows the replacement symlink outside the checkout. Its file access occurs outside the agent sandbox.

This matters particularly because [manifest building and reviewed dependency installation run concurrently](https://github.com/Graindevue/sandy/blob/c4efea8a823e9ac2b9a05487716d2c6ba156c642/packages/bot-worker/src/worker/review-executor.ts#L381). Dependency lifecycle scripts can modify the same worktree while host context extraction reads it.

**Validation:** a local worker alternated a regular `.bot/rules.md` and a symlink to a dummy file outside the repo. The real bot-config reader returned the outside content 14 times; the real manifest file reader returned it four times. No actual credential was read.

This confirms a boundary defect. End-to-end extraction of a real credential through a complete Linux Actions review was not tested; downstream parsers and execution timing affect what could be disclosed. Bot rules, when returned, become raw agent context. The medium rating reflects these exploitability limits.

**Fix:** build context from immutable Git blobs at the pinned SHA or from a separate checkout that reviewed code cannot write. Snapshot rules and manifests before executing reviewed scripts. For any remaining host filesystem reads, validate and read the same securely opened file descriptor, including ancestor safety. `O_NOFOLLOW` on only the final component does not protect against a replaced parent directory.

### F3 — Dependency advisories

`pnpm audit --json` reported **12 affected-package advisory entries: six high, five moderate, and one low**, representing 11 distinct advisories. The duplicate advisory affects both Vitest and its mocker package.

`pnpm audit --prod --json` reported **three entries: one high, one moderate, and one low**. These affect `ws` through Convex and `esbuild` through the manifest builder's `tsx` dependency.

| Installed package | Installed version | Minimum version addressing the reported advisories | Advisory |
| --- | --- | --- | --- |
| ws | 8.18.0 | 8.21.0 | [Fragment memory exhaustion](https://github.com/websockets/ws/security/advisories/GHSA-96hv-2xvq-fx4p), [uninitialized memory](https://github.com/websockets/ws/security/advisories/GHSA-58qx-3vcg-4xpx) |
| esbuild | 0.28.0 | 0.28.1 | [Windows development-server traversal](https://github.com/advisories/GHSA-g7r4-m6w7-qqqr) |
| vite | 8.0.14 | 8.0.16 | [Windows deny bypass](https://github.com/advisories/GHSA-fx2h-pf6j-xcff), [Windows NTLM disclosure](https://github.com/advisories/GHSA-v6wh-96g9-6wx3) |
| postcss | 8.5.15 | 8.5.23 | [Source-map disclosure](https://github.com/advisories/GHSA-r28c-9q8g-f849), [incomplete fix](https://github.com/advisories/GHSA-fxqj-rqcc-2cmp) |
| nanoid | 3.3.12 | 3.3.18 | [Negative-size loop](https://github.com/advisories/GHSA-28wg-ghj8-5hjv), [zero-size loop](https://github.com/advisories/GHSA-2v37-7h3g-55p8) |
| vitest / @vitest/mocker | 4.1.7 | 4.1.11 | [Redirect-mock file read](https://github.com/vitest-dev/vitest/security/advisories/GHSA-82fw-gwwq-j7x9) |
| source-map-js | 1.2.1 | 1.2.2 | [Indexed-map denial of service](https://github.com/advisories/GHSA-68fv-2mgg-jv7q) |

These are vulnerable versions, not proof of reachable exploitation in Sandy. Several advisories require Windows, an exposed development server, or specific API misuse. The current Actions entry point uses HTTP Convex calls rather than creating an application WebSocket server.

**Fix:** update direct packages and the resolved transitive versions, check the new lockfile, rerun the audit and project checks, and enable dependency alerts/security updates. These audit results do not cover the separately installed native Codex CLI, global opensrc tool, or operating-system packages.

### F4 — Secret prevention gaps

The GitHub repository API reports owner secret scanning, non-provider scanning, push protection, validity checks, and Dependabot security updates as **disabled**. The secret-scanning alerts endpoint explicitly returned a disabled-feature error; this is not an empty set of clean alerts.

No Gitleaks/TruffleHog CI check or local scanner configuration is committed. [GitHub documents configuring secret scanning alerts for public repositories](https://docs.github.com/en/code-security/how-tos/secure-your-secrets/detect-secret-leaks/enable-secret-scanning).

[The ignore rules](https://github.com/Graindevue/sandy/blob/c4efea8a823e9ac2b9a05487716d2c6ba156c642/.gitignore#L21) protect `.env`, `.env.local`, and `*.env.local`. They do **not** ignore `.env.production`, `.env.development`, a root `auth.json`, or a PEM key downloaded into the root. `.config/` is protected, except its intentional example.

**Fix:** enable repository secret scanning alerts and push protection; add a redacted secret-scanning CI gate that covers history. Broaden ignores for environment variants and credential files, with explicit exceptions for safe templates. Ignore rules do not remove already tracked material.

No real sensitive file covered by these missing patterns was found in this audit.

### F5 — Published personal and deployment metadata

One non-noreply **Gmail address appears as an author or committer in 193 audited commits**. Its full value is intentionally omitted here. An example is [commit 01b4f6b](https://github.com/Graindevue/sandy/commit/01b4f6b096f326ff993d4365697255ab5aef6684). GitHub-generated noreply addresses are separate and are not classified as personal-email exposure.

Documentation also publishes the private caller repository's name, GitHub App name and numeric ID, auth-environment name, paths, and a real private PR number with operational review counts. Examples: [GitHub App setup](https://github.com/Graindevue/sandy/blob/c4efea8a823e9ac2b9a05487716d2c6ba156c642/docs/setup/github-app.md#L43), [Actions setup](https://github.com/Graindevue/sandy/blob/c4efea8a823e9ac2b9a05487716d2c6ba156c642/docs/setup/github-actions.md#L14), [manual-trigger ADR](https://github.com/Graindevue/sandy/blob/c4efea8a823e9ac2b9a05487716d2c6ba156c642/docs/adr/0017-manual-only-review-triggering.md#L16).

An App ID is an identifier, not a credential. These disclosures do not establish access to the private repository. The matched home paths and infrastructure URLs were generic examples or test fixtures; no actual deployed Convex endpoint or credential-bearing config was confirmed.

**Fix if this metadata was intended to remain private:** use the GitHub noreply address for future commits and replace deployment-specific documentation with generic examples. Changing Git configuration affects future commits; existing metadata remains in history. [GitHub commit-email documentation](https://docs.github.com/en/account-and-profile/how-tos/email-preferences/setting-your-commit-email-address). Historical removal would require a separately coordinated rewrite.

### F6 — Repository integrity hardening

GitHub reports `main` as unprotected and lists no rulesets. The ordinary [CI workflow](https://github.com/Graindevue/sandy/blob/c4efea8a823e9ac2b9a05487716d2c6ba156c642/.github/workflows/ci.yml#L23) uses action version tags, while the review template/composite action pins its third-party actions to full SHAs.

**Fix:** require review and passing checks for main, constrain bypasses, and pin ordinary CI actions to reviewed commit SHAs with a controlled update process. The existing read-only workflow token limits the current CI job's privilege.

## Secret-scan outcome and controls that held

Every Gitleaks scan returned **zero findings**: public main files, full Git history, complete file/commit objects, and downloaded public GitHub material. Supplemental candidates were inspected and classified as test strings, templates, paths, or dynamically constructed credential URLs rather than committed credential values.

No confirmed API key, access/refresh token, webhook secret, private key, Convex deploy key, real `.env`, real instance config, database dump, or customer-data export was found. No binary file blobs were present in the scanned history.

The review workflow has useful protections: human write-permission checks before consuming review credentials, private same-repo PR checks, trusted source SHA validation, checkout credential removal, environment-based auth storage, token masking, credential cleanup, and filtered subprocess environments. It does not use a `pull_request_target` trigger to execute arbitrary PR code with review secrets. These controls do not protect the separately public Convex API or eliminate the host-read race.

Validation completed:

- **14 Actions authorization/authentication/checkout tests passed.**
- **70 focused runner, dependency-install, clone, bot-config, and manifest tests passed.**
- Two opt-in native Linux sandbox tests were skipped on this macOS host.
- The anonymous Convex fixture and both host-reader race demonstrations reproduced the findings.

## Recommended next steps and incident-assessment limits

1. Protect and redeploy the Convex API, then inspect its logs and state.
2. Remove the host-reader race before executing potentially hostile dependency scripts alongside context extraction.
3. Enable secret scanning/push protection and update vulnerable dependencies.
4. Decide whether the exposed email and deployment details need historical removal.

No exposed credential was identified that this audit establishes needs rotation. If an independently confirmed credential exposure is found, revoke/rotate it before considering history removal; GitHub cautions that rewrites cannot remove copies already cloned elsewhere. [GitHub sensitive-data removal guidance](https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/removing-sensitive-data-from-a-repository).

This is a repository exposure and code audit, not proof that no breach occurred. The original audit did not inspect production Convex access logs, private caller runtime logs, GitHub App activity, or identity-provider credential-use logs. The remediation follow-up inspected the limited backend execution records described above; they do not identify callers. Deleted/unreferenced GitHub caches, third-party clones, masked log values, and secrets in unusual encodings can also escape the available evidence. Runtime findings apply to the pinned public main revision; deployments pinned to a different revision need matching validation.
