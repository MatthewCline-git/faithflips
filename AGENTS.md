# Agent Engineering Instructions

This repository should optimize for the minimum total work over time. Prefer doing the right thing up front when it reduces future debugging, ambiguity, migration cost, or hidden state. Coding and test execution are cheap; unclear systems are expensive.

## Default Stack

- Use TypeScript for application code.
- Use strict TypeScript compiler settings. Do not weaken strictness to make an implementation pass.
- Do not use JavaScript for backend services.
- Use Zod, or an equivalent schema library with static type inference, for input validation at system boundaries.
- Use Vitest, or an equivalent fast TypeScript test runner, for unit and integration tests.
- Enforce ESLint and Prettier in CI.
- Use typed database tooling such as Prisma or Drizzle for models, migrations, and clients.
- Prefer Result-style error returns for expected domain and integration failures.
- Reserve thrown exceptions for programmer errors, impossible states, and truly unexpected failures.

## Design Philosophy

- Complexity is the enemy. Cognitive load is the enemy.
- Favor boring, explicit, locally understandable code.
- Add abstractions only when they remove real complexity, reduce meaningful duplication, or encode a stable domain concept.
- Avoid cleverness, hidden control flow, implicit global state, and broad conditional branching.
- Prefer small modules with clear inputs, outputs, and ownership.
- Make dependencies visible. Pass dependencies through factory functions instead of importing mutable singletons.
- Keep state minimal, explicit, and close to the behavior that owns it.
- Design code so an agent or human can inspect one module and understand what it is allowed to know.

## Architecture

- Use stateless HTTP APIs. Request handling must not depend on in-memory process state for correctness.
- Validate all external input at the boundary before it reaches business logic.
- Separate transport concerns from domain behavior.
- Separate read services from command services for each business domain.
- Keep read services optimized for querying and projection.
- Keep command services responsible for validation, state transitions, persistence, and side effects.
- Model integrations behind narrow clients or gateways.
- Keep workflow orchestration explicit. A workflow should reveal each step, dependency, retry, and side effect.
- Log explicitly at workflow boundaries and integration boundaries.
- Do not leak provider-specific details into domain services unless the provider is the domain.

## Dependency Injection

- Use factory functions to construct services, clients, repositories, and workflows.
- A factory should accept its dependencies as parameters and return a plain object or functions.
- Avoid module-level construction of clients with environment, network, clock, randomness, or database dependencies.
- Inject clocks, ID generators, queues, loggers, and external clients where they affect behavior.
- Tests should be able to replace every integration dependency without monkey patching.

## Domain Modeling

- Prefer explicit types for domain concepts instead of primitive strings and numbers when the distinction matters.
- Use discriminated unions for variants.
- Use exhaustive checks for domain branching.
- Lifecycle transitions must be explicitly modeled.
- Any lifecycle with more than trivial behavior must have a state transition matrix.
- State transition matrices should list current state, event or command, guard conditions, next state, side effects, and rejected transitions.
- Rejected transitions should return typed domain errors.
- Do not encode lifecycle rules only as scattered `if` statements.

## Error Handling

- Use typed domain errors for expected failure modes.
- Use typed integration errors for network, provider, timeout, rate limit, auth, and malformed response failures.
- Prefer `Result<T, E>` or an equivalent explicit result system for recoverable errors.
- Convert unknown errors into typed errors at boundaries.
- Include enough error context to debug without exposing secrets or personal data.
- Do not swallow errors. Either handle them, convert them, or return them.

## Database and Persistence

- Use typed database models and typed clients.
- Keep schema changes in migrations.
- Normalize relational data to at least Boyce-Codd normal form unless there is a documented performance reason not to.
- If denormalizing, document the source of truth, refresh path, and consistency expectation.
- Enforce invariants with database constraints when possible.
- Keep persistence models separate from domain models when database shape and domain shape diverge.
- Prefer repositories or query modules that expose intention-revealing methods over ad hoc SQL spread through services.
- Tests that depend on database behavior should run against a real database in Docker or an equivalent isolated environment.

## Testing

- Write an abundance of tests. The target is confidence and lower lifetime maintenance cost, not minimum test count.
- Unit test domain logic, state transitions, parsers, validators, error mapping, and pure workflows.
- Integration test service composition, persistence behavior, HTTP routes, auth boundaries, and integration adapters.
- Add dockerized tests for database behavior, migrations, queues, and any infrastructure-dependent path.
- Prefer deterministic tests with injected clocks, IDs, and fake external clients.
- Every lifecycle state transition matrix should have exhaustive tests for allowed and rejected transitions.
- Every bug fix should include a regression test that fails without the fix.
- Do not rely only on snapshot tests for behavior.
- Keep tests readable. Test names should describe behavior, not implementation details.
- Avoid over-mocking domain behavior. Mock external systems, time, randomness, and infrastructure boundaries.

## HTTP APIs

- Validate params, query strings, headers, and bodies with schemas.
- Return stable, typed error responses.
- Keep handlers thin. They should parse input, call services, map results, and return responses.
- Make idempotency explicit for commands that can be retried.
- Avoid request-scoped mutation outside the request lifecycle.
- Include correlation or request IDs in logs where available.

## Logging and Observability

- Log workflow start, workflow completion, and workflow failure.
- Log integration request attempts, retries, terminal failures, and provider correlation IDs when available.
- Logs must include stable identifiers needed for debugging.
- Logs must not include secrets, tokens, credentials, or unnecessary personal data.
- Prefer structured logs over interpolated strings for operational events.
- Metrics and traces should be added around queues, retries, external calls, and slow workflows when the system needs operational visibility.

## Configuration and Secrets

- Validate environment configuration at startup with schemas.
- Fail fast when required configuration is missing or invalid.
- Keep secrets out of source control, logs, test fixtures, and snapshots.
- Prefer explicit configuration objects passed into factories.
- Avoid reading environment variables deep inside business logic.

## Agent Workflow

- Read existing code and tests before changing behavior.
- Preserve local conventions unless they conflict with these instructions.
- Keep changes scoped to the task.
- Do not introduce broad refactors unless they are required for correctness or clearly reduce complexity.
- Update tests and documentation when behavior changes.
- Run the relevant format, lint, typecheck, and test commands before finishing when the repo provides them.
- If a command cannot be run, state exactly what was not run and why.

## Review Checklist

Before considering work complete, verify:

- Types are strict and meaningful.
- Inputs are validated at boundaries.
- Business behavior lives outside HTTP handlers.
- Reads and commands are separated where the domain is nontrivial.
- Dependencies are injected through factories.
- Expected errors are typed and explicit.
- Lifecycle transitions are modeled and tested exhaustively.
- Database schema preserves normalization and constraints.
- Unit, integration, and dockerized tests cover the risk of the change.
- Logs exist at workflow and integration boundaries.
- CI enforces typecheck, lint, formatting, and tests.
