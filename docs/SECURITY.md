# Security Architecture

## 1. Overview

Git Repository Forensics applies security controls across authentication, session management, API requests, database access, and repository processing.

The objective is to protect user accounts, prevent unauthorized access, validate repository inputs, and reduce risks associated with executing Git operations on user-supplied repositories.

## 2. Authentication

### Password Hashing

Passwords are hashed using bcrypt with a cost factor of 12.

Plaintext passwords are not stored in the database.

### Session Tokens

The application generates randomly generated 256-bit session tokens.

Only SHA-256 hashes of session tokens are stored in the database. This means a database leak does not directly expose reusable session tokens.

### Session Cookies

Authentication cookies use:

- `HttpOnly` to prevent direct JavaScript access to the cookie.
- `SameSite=Lax` to provide a baseline defense against cross-site request forgery.
- Secure cookie settings appropriate to the configured deployment environment.

## 3. Authorization and Roles

The application distinguishes administrator and analyst roles.

Administrative functionality is restricted to authorized users.

The database includes a `protect_last_admin` trigger that prevents the final active administrator from being removed or demoted.

Authorization should be enforced in server-side route handlers, not only by hiding interface elements.

## 4. API Protection

### Rate Limiting

Login and registration endpoints are rate-limited to reduce automated abuse and repeated authentication attempts.

Redis stores rate-limit counters with expiration times.

### Origin Validation

Mutating requests undergo origin validation. This helps prevent unauthorized cross-origin requests from changing application state.

### Parameterized SQL

Database queries use bound parameters rather than constructing SQL statements by concatenating untrusted input.

This reduces SQL injection risk.

### Audit Logging

Application activity is recorded in `audit_log`. The table stores structured JSONB details and is subject to a naming-format constraint.

## 5. Repository URL Validation

Repository URLs are user-controlled input and must be validated before Git operations begin.

The documented validation rules include:

- Remote repository sources must use HTTPS.
- Only configured Git hosting providers are allowed.
- Credentials embedded in URLs are rejected.
- IP literals are rejected.
- Explicit ports are rejected.
- Query strings are rejected.

The application is designed for public repositories. It does not store or use credentials to access private repositories.

## 6. Local Repository Path Validation

When local repositories are enabled, paths are validated against the configured `LOCAL_REPO_ROOT`.

This restricts local repository access to the configured directory rather than allowing arbitrary filesystem paths.

Branch names are also validated before they are passed to Git.

## 7. Safe Git Execution

Git commands are executed without shell interpolation.

Avoiding shell interpolation reduces the risk that user-controlled repository values or branch names will be interpreted as shell commands.

Inputs should be validated before being supplied as Git arguments.

## 8. Database Integrity as a Security Control

The database enforces important application rules independently of the interface.

Examples include:

- One active analysis job per repository.
- Valid job timestamp and status combinations.
- Protection of the last active administrator.
- Case-insensitive unique email addresses.
- Valid coupling-edge ordering.
- Cascading deletion of repository-dependent records.

These controls help prevent invalid states even if an application code path is changed or bypassed.

## 9. Secrets and Configuration

Credentials and environment-specific configuration belong in `.env.local`, not in source control.

The repository provides `.env.example` as a configuration template.

Recommended handling:

1. Keep `.env.local` out of Git.
2. Replace all placeholder values before running the application.
3. Use strong, unique passwords for database services.
4. Restrict access to production environment variables.
5. Rotate credentials if they are accidentally exposed.
6. Never paste real secrets into issues, commits, or screenshots.

## 10. Security Limitations

The documented implementation has several limitations:

- Private repository authentication is not supported.
- Bot detection is based on a regular expression and may miss unusual bot identities.
- Developer identity is based on email and may split one person into multiple records.
- API route, UI, and Neo4j query automated test coverage has gaps.

These limitations should be considered when deploying the system beyond a controlled academic demonstration.

## 11. Future Security Improvements

Potential enhancements include:

- Encrypted per-user deploy keys for private repository access.
- More comprehensive API authorization tests.
- Automated browser-based security and regression tests.
- Configurable bot-account management.
- Stronger monitoring and audit-log review.
- Deployment-specific secret management.
- More comprehensive security testing of repository processing.

## 12. Security Checklist

Before running or demonstrating the application:

- [X] `.env.local` is not committed.
- [X] All placeholder secrets have been replaced.
- [X] Database services use non-default credentials.
- [X] Administrator credentials are kept private.
- [X] Remote repository URL validation is enabled.
- [X] Local repository access is restricted to the configured root.
- [X] Protected API routes enforce authentication and authorization.
- [X] Git commands do not interpolate untrusted input into a shell.
- [X] Tests for database constraints and administrator protection pass.
