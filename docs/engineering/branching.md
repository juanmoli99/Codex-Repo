# Branch and commit convention

- `main` is protected and must remain releasable.
- Work branches use `feat/<topic>`, `fix/<topic>`, `chore/<topic>`, or `release/<version>`.
- Commits follow Conventional Commits (`feat:`, `fix:`, `docs:`, `test:`, `refactor:`, `chore:`).
- Database migrations and their application code are committed together.
- Releases are immutable annotated tags and are built from the lockfile.
