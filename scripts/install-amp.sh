#!/bin/sh
set -e

# AMP Installer (trazyn/oh-my-pi fork)
# Usage: curl -fsSL https://raw.githubusercontent.com/trazyn/oh-my-pi/main/scripts/install-amp.sh | sh
#
# Installs the latest prebuilt binary from the fork's rolling `amp-latest`
# GitHub Release as `amp` (default: ~/.local/bin/amp), verified against the
# release's SHA256SUMS.
#
# Published platforms: macOS (arm64, x86_64) and Linux (x86_64, glibc).
# Binaries are ad-hoc signed on macOS; curl downloads carry no quarantine
# attribute, so Gatekeeper does not block them.
#
# Environment overrides:
#   AMP_INSTALL_DIR  install directory (default: $HOME/.local/bin)
#   AMP_RELEASE_TAG  release tag to install from (default: amp-latest)
#   AMP_FORK_REPO    owner/repo hosting the release (default: trazyn/oh-my-pi)

REPO="${AMP_FORK_REPO:-trazyn/oh-my-pi}"
TAG="${AMP_RELEASE_TAG:-amp-latest}"
INSTALL_DIR="${AMP_INSTALL_DIR:-$HOME/.local/bin}"

OS="$(uname -s)"
ARCH="$(uname -m)"
ASSET=""
case "$OS" in
    Darwin)
        # A Rosetta session reports x86_64 on Apple Silicon; prefer the native build.
        if [ "$ARCH" = "x86_64" ] && [ "$(sysctl -n hw.optional.arm64 2>/dev/null || echo 0)" = "1" ]; then
            ARCH="arm64"
        fi
        case "$ARCH" in
            arm64)  ASSET="amp-darwin-arm64" ;;
            x86_64) ASSET="amp-darwin-x64" ;;
        esac
        ;;
    Linux)
        case "$ARCH" in
            x86_64|amd64) ASSET="amp-linux-x64" ;;
        esac
        ;;
esac
if [ -z "$ASSET" ]; then
    echo "install-amp: no prebuilt binary for ${OS}/${ARCH}" >&2
    echo "install-amp: published platforms are macOS (arm64, x86_64) and Linux (x86_64, glibc)." >&2
    echo "install-amp: build from source instead: git clone https://github.com/${REPO} && bun run setup" >&2
    exit 1
fi

BASE_URL="https://github.com/${REPO}/releases/download/${TAG}"
TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT INT TERM HUP

hash_of() {
    if command -v sha256sum >/dev/null 2>&1; then
        sha256sum "$1" | awk '{ print $1 }'
    else
        shasum -a 256 "$1" | awk '{ print $1 }'
    fi
}

echo "Downloading ${ASSET} (${TAG}) ..."
if ! curl -fsSL "$BASE_URL/$ASSET" -o "$TMP_DIR/$ASSET"; then
    echo "install-amp: download failed: $BASE_URL/$ASSET" >&2
    echo "install-amp: has the 'Build binaries' workflow published '${TAG}' yet?" >&2
    exit 1
fi

# Best-effort integrity check against the release's SHA256SUMS list.
if curl -fsSL "$BASE_URL/SHA256SUMS" -o "$TMP_DIR/SHA256SUMS" 2>/dev/null; then
    EXPECTED="$(awk -v name="$ASSET" '$2 == name { print $1 }' "$TMP_DIR/SHA256SUMS")"
    if [ -n "$EXPECTED" ] && [ "$EXPECTED" != "$(hash_of "$TMP_DIR/$ASSET")" ]; then
        echo "install-amp: checksum mismatch for ${ASSET}" >&2
        exit 1
    fi
fi

mkdir -p "$INSTALL_DIR"
mv "$TMP_DIR/$ASSET" "$INSTALL_DIR/amp"
chmod +x "$INSTALL_DIR/amp"
# Defensive: curl downloads carry no quarantine bit, but strip one if present.
if [ "$OS" = "Darwin" ] && command -v xattr >/dev/null 2>&1; then
    xattr -d com.apple.quarantine "$INSTALL_DIR/amp" 2>/dev/null || true
fi

VERSION="$("$INSTALL_DIR/amp" --version)" || {
    echo "install-amp: the installed binary failed to run on this machine" >&2
    exit 1
}
echo "Installed ${VERSION} -> ${INSTALL_DIR}/amp"
case ":$PATH:" in
    *":$INSTALL_DIR:"*) ;;
    *) echo "Add ${INSTALL_DIR} to PATH: export PATH=\"${INSTALL_DIR}:\$PATH\"" ;;
esac
