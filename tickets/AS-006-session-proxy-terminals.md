# AS-006: Proxy terminals for single-session logins

**Status:** Not started

## Why this matters (Aron, 2026-10-27)

> Some logins only have one session, so we need a bunch of proxy terminals which sit there in order
> to consume signets with that specific slice of behavior. Queries can go out over those, and you can
> have many logged-in sessions at once, effectively.

> I think maybe it's just something to sort of bolt signets onto. I think something like that, right?
> Maybe it belongs in agent session or something like that.

## Goal

- A login that allows only one live session is held by one long-lived **proxy terminal**.
- Queries go out over the proxy terminal, so many callers effectively have the login at once.
- The proxy terminal is something Signets bolt onto: each Signet carries a specific slice of that
  login's behavior.

## Related

- [docs/transports-pools-routing.md](../docs/transports-pools-routing.md): a pool instance is one
  login with a `concurrencyLimit`; sessions are opened on it through a lease.
- Kingdom `docs/SIGNETS.md` § Admission and one-time use: a session-use (one bounded session with its
  own expiry, concurrency and operation limits) is distinct from an operation-use, and "session-use
  requires a distinct reservation path before it is advertised."
- Kingdom `docs/SUBSCRIPTION-CAPACITY.md` § Design constraints: "There is no Kingdom proxy for
  subscription inference, and nothing impersonates Claude Code or Codex."

## Open questions

1. Which logins does this cover: third-party service logins (one web/API session per account), the
   Claude/Codex subscription logins, or both? If subscription logins are in scope, how does it sit
   with the SUBSCRIPTION-CAPACITY constraint above?
2. Is a query over a proxy terminal an operation-use admission under the caller's Signet, with the
   proxy terminal's own hold on the login a session-use?
