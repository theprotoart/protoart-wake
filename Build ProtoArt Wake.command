#!/bin/bash
# Double-click to build "ProtoArt Wake.app" next to this file and open it.
#   --no-open   build only (used by "Make DMG for friends.command")
# Version 2 is a native Mac app (Swift + AppKit). It needs Apple's free Command Line Tools,
# which macOS offers to install the first time (or run: xcode-select --install).
cd "$(dirname "$0")"
ROOT="$(pwd)"
exec > >(tee "$ROOT/build-log.txt") 2>&1

APP_NAME="ProtoArt Wake"
BUNDLE_ID="local.protoart.wake"
APP="$ROOT/$APP_NAME.app"
VERSION="$(sed -n 's/.*"version": *"\([^"]*\)".*/\1/p' "$ROOT/package.json" | head -1)"
MIN_MACOS="12.0"
step() { printf '\n== %s\n' "$*"; }
fail() { printf '\nSTATUS: FAILED (%s)\n' "$*"; [ -t 0 ] && read -r -p "Press Return to close this window." _; exit 1; }

step "1/6 Checking"
[ "$(uname -s)" = "Darwin" ] || fail "this builds a Mac app, so it has to run on a Mac"
ls "$ROOT"/native/*.swift >/dev/null 2>&1 || fail "native source files missing"
[ -f "$ROOT/app/renderer/index.html" ] || fail "panel files missing"
SWIFTC="$(xcrun --find swiftc 2>/dev/null)"
if [ -z "$SWIFTC" ]; then
  xcode-select --install >/dev/null 2>&1 || true
  fail "Apple's Command Line Tools are needed. A window should have opened to install them; when it's done, double-click this file again"
fi
echo "Swift: $("$SWIFTC" --version 2>&1 | head -1)"
SDK="$(xcrun --sdk macosx --show-sdk-path 2>/dev/null)"

step "2/6 Compiling"
WORK="$(mktemp -d)"
FLAGS=(-O -swift-version 5 -sdk "$SDK" -module-name ProtoArtWake
       -framework AppKit -framework WebKit -framework IOKit -framework Carbon
       -framework ServiceManagement -framework UserNotifications)
ARCHS=()
for arch in arm64 x86_64; do
  if "$SWIFTC" "${FLAGS[@]}" -target "$arch-apple-macos$MIN_MACOS" "$ROOT"/native/*.swift -o "$WORK/wake-$arch" 2>"$WORK/err-$arch.txt"; then
    ARCHS+=("$WORK/wake-$arch"); echo "Compiled for $arch."
  else
    cat "$WORK/err-$arch.txt"
    [ "$arch" = "arm64" ] && fail "the Swift code didn't compile (see above)"
    echo "(Skipped $arch.)"
  fi
done
lipo -create "${ARCHS[@]}" -output "$WORK/wake" || fail "couldn't join the architectures"
echo "Runs on: $(lipo -archs "$WORK/wake")"

step "3/6 Self-test"
"$WORK/wake" --self-test || fail "the self-test failed"

step "4/6 App bundle"
osascript -e "tell application id \"$BUNDLE_ID\" to quit" >/dev/null 2>&1 || true
sleep 0.5
rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources/renderer" "$APP/Contents/Resources/Licenses"
cp "$WORK/wake" "$APP/Contents/MacOS/$APP_NAME"
for f in index.html base.css wake.css texture.js parts.js wake.js; do
  cp "$ROOT/app/renderer/$f" "$APP/Contents/Resources/renderer/" || fail "panel file $f missing"
done
cp "$ROOT"/app/assets/tray*Template*.png "$APP/Contents/Resources/"
cp "$ROOT/LICENSE" "$APP/Contents/Resources/Licenses/ProtoArt-Wake-LICENSE.txt"
cp "$ROOT/NOTICE" "$APP/Contents/Resources/Licenses/ProtoArt-Wake-NOTICE.txt"
cp "$ROOT/THIRD_PARTY_NOTICES.md" "$APP/Contents/Resources/Licenses/THIRD_PARTY_NOTICES.md"
if [ -f "$ROOT/app/build/icon.png" ]; then
  ICONSET="$WORK/icon.iconset"; mkdir -p "$ICONSET"
  for s in 16 32 128 256 512; do
    sips -z $s $s "$ROOT/app/build/icon.png" --out "$ICONSET/icon_${s}x${s}.png" >/dev/null
    sips -z $((s * 2)) $((s * 2)) "$ROOT/app/build/icon.png" --out "$ICONSET/icon_${s}x${s}@2x.png" >/dev/null
  done
  iconutil -c icns -o "$APP/Contents/Resources/icon.icns" "$ICONSET" && echo "Icon set."
fi
cat > "$APP/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleDevelopmentRegion</key><string>en</string>
  <key>CFBundleExecutable</key><string>$APP_NAME</string>
  <key>CFBundleIdentifier</key><string>$BUNDLE_ID</string>
  <key>CFBundleInfoDictionaryVersion</key><string>6.0</string>
  <key>CFBundleName</key><string>$APP_NAME</string>
  <key>CFBundleDisplayName</key><string>$APP_NAME</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>$VERSION</string>
  <key>CFBundleVersion</key><string>$VERSION</string>
  <key>CFBundleIconFile</key><string>icon</string>
  <key>LSMinimumSystemVersion</key><string>$MIN_MACOS</string>
  <key>LSApplicationCategoryType</key><string>public.app-category.utilities</string>
  <key>LSUIElement</key><true/>
  <key>NSHighResolutionCapable</key><true/>
  <key>NSHumanReadableCopyright</key><string>Apache-2.0 · ProtoArt Wake contributors</string>
  <key>CFBundleURLTypes</key>
  <array>
    <dict>
      <key>CFBundleURLName</key><string>$BUNDLE_ID</string>
      <key>CFBundleURLSchemes</key><array><string>protoart-wake</string></array>
    </dict>
  </array>
</dict>
</plist>
PLIST
plutil -lint "$APP/Contents/Info.plist" >/dev/null || fail "Info.plist is invalid"
echo "Bundle assembled ($(du -sh "$APP" | cut -f1))."

step "5/6 Signing"
xattr -cr "$APP" 2>/dev/null || true
codesign --force --options runtime --sign - "$APP" >"$ROOT/codesign-log.txt" 2>&1 || fail "couldn't sign the app (see codesign-log.txt)"
codesign --verify --strict "$APP" >/dev/null 2>&1 || fail "the signature didn't verify"
echo "Signed (ad hoc, hardened runtime) and verified."

step "6/6 Registering"
/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister -f "$APP" >/dev/null 2>&1 || true
touch "$APP"
rm -rf "$WORK"
echo
echo "STATUS: DONE"
[ "${1:-}" = "--no-open" ] || open "$APP"
