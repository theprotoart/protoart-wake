# Security

## Reporting a vulnerability

Please report security problems privately with GitHub's **Report a vulnerability** button on the
**Security** tab, not in a public issue. You should get a reply within a week.

## Security design

- **No privileges:** no helper tools, no admin password, no changes to system settings. The app only
  takes ordinary per-process power assertions through IOKit.
- **Can't get stuck:** macOS owns the assertions on behalf of the app's process and drops them if the app
  quits, crashes or is force-quit.
- **One helper, rarely:** `/usr/bin/pmset` runs only for LIGHTS OUT and, while the panel is open, once a
  minute to read sleep settings: a fixed absolute path, an argument array (never a shell), a minimal environment.
- **Local panel:** the panel is loaded from the app's own files in a non-persistent WebKit view; navigation to
  anything else is refused, the page has a strict Content-Security-Policy and no network access.
- **No network:** there's no telemetry, analytics or auto-update.
- **Narrow bridge:** messages from the panel are accepted only from its own page and validated against
  allowlists; the same validation applies to `protoart-wake://` links. Watched apps can only be added from
  apps the app itself saw running; drives must be under /Volumes.
- **Hardened runtime:** the app is signed with the hardened runtime.

## Known limitations

- Releases are signed ad hoc, not notarized; check the SHA-256 of a download against the release notes.
