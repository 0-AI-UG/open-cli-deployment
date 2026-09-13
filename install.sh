#!/bin/sh
set -eu

REPOSITORY="0-AI-UG/open-cli-deployment"
VERSION="${OCD_VERSION:-latest}"

case "$(uname -s)" in
  Linux*) OS="linux" ;;
  Darwin*) OS="darwin" ;;
  *) echo "Unsupported operating system: $(uname -s)" >&2; exit 1 ;;
esac

case "$(uname -m)" in
  x86_64|amd64) ARCH="x64" ;;
  arm64|aarch64) ARCH="arm64" ;;
  *) echo "Unsupported architecture: $(uname -m)" >&2; exit 1 ;;
esac

ASSET="ocd-${OS}-${ARCH}"
if [ "$VERSION" = "latest" ]; then
  RELEASE_URL="https://github.com/${REPOSITORY}/releases/latest/download"
else
  RELEASE_URL="https://github.com/${REPOSITORY}/releases/download/${VERSION}"
fi

TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT HUP INT TERM

echo "Downloading OCD CLI ${VERSION} for ${OS}/${ARCH}..."
curl -fsSL "${RELEASE_URL}/${ASSET}" -o "${TMP_DIR}/${ASSET}"
curl -fsSL "${RELEASE_URL}/SHA256SUMS" -o "${TMP_DIR}/SHA256SUMS"

EXPECTED="$(awk -v asset="$ASSET" '$2 == asset { print $1 }' "${TMP_DIR}/SHA256SUMS")"
if [ -z "$EXPECTED" ]; then
  echo "No checksum was published for ${ASSET}" >&2
  exit 1
fi

if command -v sha256sum >/dev/null 2>&1; then
  ACTUAL="$(sha256sum "${TMP_DIR}/${ASSET}" | awk '{print $1}')"
else
  ACTUAL="$(shasum -a 256 "${TMP_DIR}/${ASSET}" | awk '{print $1}')"
fi

if [ "$EXPECTED" != "$ACTUAL" ]; then
  echo "Checksum verification failed for ${ASSET}" >&2
  exit 1
fi

INSTALL_DIR="${OCD_INSTALL_DIR:-$HOME/.local/bin}"
mkdir -p "$INSTALL_DIR"
chmod +x "${TMP_DIR}/${ASSET}"
mv "${TMP_DIR}/${ASSET}" "$INSTALL_DIR/ocd"

echo "Installed ocd to ${INSTALL_DIR}/ocd"
case ":$PATH:" in
  *":${INSTALL_DIR}:"*) ;;
  *) echo "Add ${INSTALL_DIR} to PATH: export PATH=\"${INSTALL_DIR}:\$PATH\"" ;;
esac
echo "Run 'ocd bootstrap' to create a panel."
