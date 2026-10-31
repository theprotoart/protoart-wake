# Privacy

**ProtoArt Wake makes no network connections** and has no account, telemetry or update check.

- **Running apps:** it reads macOS's list of open apps, to show them and to check the ones you chose. The list isn't stored; only the
  apps you click to watch are saved (their name and location).
- **Downloads:** with AUTO: DOWNLOADS on, it reads the names and dates of partial downloads in your
  Downloads folder (never their contents). macOS may ask you to allow access to Downloads.
- **Settings** are saved in `~/Library/Application Support/ProtoArt Wake/settings.json` (only readable by you).
- **Drives:** it lists mounted drives so you can pick them. With Drive Alive on, it writes one tiny hidden
  file, `.protoart-wake-alive`, to the drives you chose, once a minute during a session.
- **Notifications** are local; macOS asks once whether to allow them.
- No logs are written.

To remove everything, delete the app and `~/Library/Application Support/ProtoArt Wake/`.
