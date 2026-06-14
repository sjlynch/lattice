Analyze this codebase specifically for security vulnerabilities, and file every concrete finding as a task on the Lattice board for this active project. Work like an application-security reviewer doing a first-pass audit of an unfamiliar repo: map the attack surface before judging individual lines, prioritize exploitable issues over theoretical ones, and make every finding reproducible and actionable.

## Step 1 — Map the attack surface

Before reviewing code, understand where untrusted input enters and where the trust boundaries are. Read entry points (HTTP/RPC routes, CLI args, message/queue consumers, file/upload handlers, webhooks, env/config loading), then trace where that input flows. Read recent git history for security-relevant churn. Identify what the system protects (secrets, user data, money, infrastructure) and the realistic attackers (unauthenticated remote, authenticated low-privilege, malicious dependency).

## Step 2 — Dependency & supply-chain CVEs

Enumerate dependencies and their *exact pinned versions* from every manifest/lockfile present (e.g. `package-lock.json`/`yarn.lock`/`pnpm-lock.yaml`, `requirements.txt`/`poetry.lock`, `go.mod`/`go.sum`, `Cargo.lock`, `pom.xml`/`build.gradle`, `Gemfile.lock`, `composer.lock`). Distinguish direct from transitive dependencies.

- Run whichever ecosystem scanners are available and treat their output as a starting point, not the final answer: `npm audit`, `pip-audit`, `osv-scanner`, `govulncheck`, `cargo audit`, `bundler-audit`.
- Confirm and enrich each candidate against the **official vulnerability sources** — fetch and read the advisory page, and cite its id and URL: the GitHub Advisory Database (github.com/advisories), OSV.dev (osv.dev), the NVD / NIST CVE database (nvd.nist.gov), CISA's Known Exploited Vulnerabilities catalog (cisa.gov/known-exploited-vulnerabilities-catalog), and the upstream project's own security advisories. Do not rely on memory for whether a version is vulnerable — verify against these sources.
- For each vulnerable package report: the CVE/GHSA id and link, the installed version, the fixed version, CVSS severity, direct vs transitive, whether the vulnerable code path is actually reachable from this codebase, and whether it appears on CISA KEV. Prioritize reachable and KEV-listed issues.

## Step 3 — Code-level review (across these classes)

Review for the vulnerability classes that generalize across languages and frameworks; for each, identify the language/framework-idiomatic form and follow tainted input to a dangerous sink:

- **Injection** — SQL/NoSQL, OS command, path traversal, SSRF, XXE, LDAP, template injection, unsafe deserialization.
- **AuthN / AuthZ** — missing or inconsistent access checks, IDOR / broken object-level authorization, privilege escalation, weak or spoofable session/token handling, auth enforced only on the client.
- **Secrets & credentials** — hardcoded keys/tokens/passwords/private keys, secrets committed in code or `.env`, secrets written to logs, and secrets present in git history.
- **Crypto** — weak/deprecated algorithms, ECB mode, static IVs/salts, non-cryptographic randomness for security purposes, missing TLS/cert validation, JWT `alg:none` or unverified signatures.
- **Web** — reflected/stored/DOM XSS, CSRF on state-changing routes, open redirects, permissive CORS, missing security headers, cookie flags (HttpOnly/Secure/SameSite).
- **Sensitive data & privacy** — PII/credential leakage in logs, errors, or responses; insecure storage; data sent over plaintext transport.
- **Configuration & hardening** — debug mode or stack traces exposed in production, default/weak credentials, overly broad file or cloud-IAM permissions, exposed admin/debug endpoints.
- **Denial of service** — unbounded input, missing rate limits on expensive paths, ReDoS in regexes over untrusted input.

## Step 4 — File findings to the Lattice board

For each confirmed issue, create a task. Include: a specific title naming the vulnerability and location with a severity tag (e.g. `[Critical] Command injection in scan handler`), the exact file/line or dependency, the vulnerability class (with CWE/CVE id where applicable), realistic severity, a concrete exploit scenario (how an attacker reaches and abuses it), and a specific remediation (fixed version, the safe API, the missing check).

File mainly issues you have evidence are exploitable, plus known CVEs in used dependencies. Mention low-severity hardening or defense-in-depth gaps only briefly, and only when they compound a real issue — do not flood the board with speculative lint. Check the existing board first and do not file duplicates. Where you are genuinely uncertain whether something is exploitable, file it but say so explicitly rather than overstating it.
