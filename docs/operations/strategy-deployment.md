# Safe strategy deployment

1. Deploy only a new immutable strategy/configuration version with a unique deployment ID. Never edit an
   existing version in place.
2. Acquire the deployment lease and persist the planned release. Record current scheduler and entry
   state; do not stop or reset the scheduler.
3. Enter only-close for new work. Allow already-persisted executor intents to finish; never cancel them as
   a deployment shortcut.
4. Confirm every open position's originating version is still packaged and registered. Old versions move
   to `RETIRING`, not deleted, and continue managing only their positions.
5. Validate that existing bracket/OCO/stop/target state can be deserialized and managed by the retained
   version after restart.
6. Activate the new version atomically. It becomes the only version allowed to open new positions.
7. Run full broker reconciliation. Entries remain blocked until orders, fills, positions, cash, equity,
   buying power, and protection groups match.
8. On success, restore the exact pre-deployment entry state. Scheduler state was never replaced.
9. On failure, mark the new version disabled, reactivate the previous version for new entries, keep all
   historical code/configuration, and leave entries blocked pending operator review.

Rollback is a deployment state transition, not a source-code deletion. After process restart, the
position binding table selects the originating version and recovery restores its compatible protection
state before any scheduler resume.
