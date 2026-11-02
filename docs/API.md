# API Reference

## 1. Overview

Git Repository Forensics exposes JSON API route handlers through its Next.js application.

The API supports authentication, repository management, background analysis jobs, analytics reports, and administration.

Protected endpoints require a valid application session cookie. Authentication endpoints are used to establish or end a session.

> This document summarizes the endpoints listed in the project documentation. Confirm exact request and response schemas from the corresponding route handlers before integrating an external client.

## 2. Base URL

Development:

```text
http://localhost:3000
```

All paths below are relative to the application base URL.

## 3. Authentication

| Method | Endpoint | Description |
|---|---|---|
| POST | `/api/auth/register` | Register a user |
| POST | `/api/auth/login` | Authenticate a user |
| POST | `/api/auth/logout` | End the current session |

### Register

```http
POST /api/auth/register
Content-Type: application/json
```

Creates a user account. The application hashes the password before storing it.

### Login

```http
POST /api/auth/login
Content-Type: application/json
```

Authenticates a user and establishes a session.

### Logout

```http
POST /api/auth/logout
```

Ends the current session.

## 4. Repository Management

| Method | Endpoint | Description |
|---|---|---|
| GET | `/api/repositories` | List repositories |
| POST | `/api/repositories` | Register a repository |
| GET | `/api/repositories/:id` | Retrieve repository details |
| DELETE | `/api/repositories/:id` | Delete a repository and dependent data |
| POST | `/api/repositories/:id/analyze` | Queue repository re-analysis |

### List Repositories

```http
GET /api/repositories
```

Returns repositories accessible to the authenticated user, subject to the application's authorization rules.

### Register a Repository

```http
POST /api/repositories
Content-Type: application/json
```

Registers a repository and creates an analysis job. The documented workflow creates the repository record, queued job, and audit record in one transaction.

### Get Repository Details

```http
GET /api/repositories/:id
```

Retrieves information about a registered repository.

### Delete a Repository

```http
DELETE /api/repositories/:id
```

Deletes the repository. Database foreign-key cascades remove dependent repository data.

### Queue Re-analysis

```http
POST /api/repositories/:id/analyze
```

Queues a new analysis for the specified repository.

## 5. Analytics Reports

Reports are retrieved through the repository report endpoint.

```http
GET /api/repositories/:id/report?kind=summary
```

Supported report kinds documented by the project:

| `kind` | Description |
|---|---|
| `summary` | Repository overview and summary metrics |
| `monthly` | Monthly activity |
| `developers` | Developer contribution information |
| `hotspots` | Frequently modified files |
| `coupling` | File change-coupling results |
| `commits` | Commit history and search |
| `similar` | Similar commit-message results |
| `collaboration` | Collaboration relationships |
| `silos` | Potential knowledge silos |

Examples:

```http
GET /api/repositories/2/report?kind=summary
GET /api/repositories/2/report?kind=hotspots
GET /api/repositories/2/report?kind=coupling
GET /api/repositories/2/report?kind=developers
GET /api/repositories/2/report?kind=similar
```

The `id` in these examples is illustrative. Use a repository ID returned by the application.

## 6. Analysis Job Management

| Method | Endpoint | Description |
|---|---|---|
| GET | `/api/jobs/:id` | Retrieve job status and progress |
| POST | `/api/jobs/:id/cancel` | Cancel an active job |

### Get Job Status

```http
GET /api/jobs/:id
```

Returns the status and progress information for a job.

### Cancel a Job

```http
POST /api/jobs/:id/cancel
```

Requests cancellation of an active analysis job.

## 7. Administration

| Method | Endpoint | Description |
|---|---|---|
| PATCH | `/api/admin/users/:id` | Update a user's role or active status |

This endpoint is intended for authorized administrators.

The database also protects the last active administrator through a trigger.

## 8. Authentication and Security Expectations

- Protected endpoints require a valid session.
- Passwords are stored as bcrypt hashes.
- Session tokens are stored as SHA-256 hashes.
- Login and registration are rate-limited.
- Mutating requests undergo origin validation.
- SQL queries use bound parameters.
- Administrative operations are restricted by role.

## 9. Background Processing

Repository analysis is asynchronous.

A typical sequence is:

1. The client submits a repository registration or re-analysis request.
2. The API creates or queues an analysis job.
3. A background worker claims the job.
4. The client can retrieve job progress through `GET /api/jobs/:id`.
5. When processing completes, the application exposes updated reports.

The worker uses PostgreSQL row locking with `SKIP LOCKED` to coordinate job claims.

## 10. Finding the Exact Request and Response Schemas

The endpoint list above does not specify every JSON field, validation error, or response status. Those details should be verified in the implementation.

Useful locations in the repository include:

- `app/api/` — route handlers.
- `lib/queries.ts` — database-backed report queries.
- `lib/auth.ts` — authentication logic.
- `workers/` — background job processing.

When adding or changing an endpoint, update this document with its request body, successful response, validation errors, and authorization requirements.
