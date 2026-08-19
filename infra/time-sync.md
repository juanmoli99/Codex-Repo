# Time synchronization

All persisted timestamps use UTC. Exchange schedules are interpreted with the IANA timezone
`America/New_York`; the operator timezone is presentation-only.

Production hosts must run an NTP-synchronized clock. On Windows, verify the Windows Time Service
with `scripts/check-time-sync.ps1`. The application also compares its clock with the broker clock and
blocks new entries when the configured maximum drift is exceeded.

Use `pnpm check:clock` as a development diagnostic. This command is not a substitute for host-level
NTP.
