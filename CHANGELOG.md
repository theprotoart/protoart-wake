# Changelog

## 2.0.2

- Finer duration knob: ∞, 5, 10, 15, 20, 30, 45 minutes, 1, 1½, 2, 3, 4, 6, 8, 12 hours, SET. Your saved choice
  carries over.
- The knob follows your hand: grab its edge and turn; it no longer snaps back while you hold it, and the
  choice is sent once when you let go. Trackpad scrolling moves one stop per notch.
- Countdown you can see: TIME LEFT and AWAKE FOR show minutes and seconds under an hour, and an amber ring
  around the knob drains back toward ∞ as the time runs out.

## 2.0.1

- "Also awake for" lists only apps, not macOS's own background services.
- The drive lists leave out opened disk images (read-only volumes).
- The Operator's Card is titled PW-2.
- README: screenshots.

## 2.0.0

- Rebuilt as a native Mac app (Swift + AppKit) instead of Electron: about 1 MB instead of ~250 MB, no
  processor use in standby, no helper processes (`caffeinate`, `ps`, `pmset` and `ioreg` no longer run
  every 5 seconds). The tube-amp panel is unchanged and only exists while open.
- New from Amphetamine: Extend Session (menu and reminder notifications), triggers for a schedule, the
  power adapter, an external display, a drive and a busy processor; end a session on low battery (now
  adjustable), unplugging, forced sleep or user switch; start at launch or after wake; let the display sleep
  while locked; menu-bar time format, dimming and left-click choice; Drive Alive; statistics; sounds;
  `protoart-wake://` links for Shortcuts and scripts.
- New SETUP card on the panel for all of the above. Settings from 1.0 carry over.
- Runs on Intel Macs and macOS 12 as well.

## 1.0.0

- First release: menu-bar keep-awake with a duration knob (presets + SET: custom length, until a clock
  time, while an app runs, while a file downloads), an Amphetamine-style right-click menu, an ABOUT card, DISPLAY + MAC / MAC ONLY, screen saver
  blocking, AUTO (apps, audio, downloads, at login), ⌃⌥⌘W hotkey, macOS-verified HELD lamp, sleep report, LIGHTS OUT,
  low-battery safety, quick timers on right-click.
