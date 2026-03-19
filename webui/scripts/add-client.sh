#!/bin/bash
set -euo pipefail

# Generate a new client certificate signed by the NanoClaw CA.
# Usage: ./webui/scripts/add-client.sh <name> [--force]
# Run from the project root.

NAME="${1:-}"
FORCE="${2:-}"

if [ -z "$NAME" ]; then
  echo "Usage: $0 <name> [--force]"
  echo "  e.g.: $0 phone"
  exit 1
fi

TLS_DIR="data/tls"
CLIENTS_DIR="$TLS_DIR/clients"
CA_CERT="$TLS_DIR/ca-cert.pem"
CA_KEY="$TLS_DIR/ca-key.pem"

if [ ! -f "$CA_CERT" ] || [ ! -f "$CA_KEY" ]; then
  echo "Error: CA not found at $TLS_DIR/. Run the web UI first to generate certificates."
  exit 1
fi

CLIENT_CERT="$CLIENTS_DIR/${NAME}-cert.pem"
CLIENT_KEY="$CLIENTS_DIR/${NAME}-key.pem"
CLIENT_P12="$CLIENTS_DIR/${NAME}.p12"
CSR="$CLIENTS_DIR/${NAME}.csr"

if [ -f "$CLIENT_P12" ] && [ "$FORCE" != "--force" ]; then
  echo "Error: Client certificate '$NAME' already exists at $CLIENT_P12"
  echo "  Pass --force to regenerate."
  exit 1
fi

mkdir -p "$CLIENTS_DIR"

echo "Generating client certificate for '$NAME'..."

openssl genrsa -out "$CLIENT_KEY" 2048 2>/dev/null
chmod 600 "$CLIENT_KEY"

openssl req -new -key "$CLIENT_KEY" -subj "/CN=$NAME" -out "$CSR" 2>/dev/null

openssl x509 -req -in "$CSR" \
  -CA "$CA_CERT" -CAkey "$CA_KEY" -CAcreateserial \
  -days 365 -sha256 \
  -out "$CLIENT_CERT" 2>/dev/null

# Standard .p12 with password (for Linux/Firefox)
# Try -legacy first (OpenSSL 3.x), fall back without
if ! openssl pkcs12 -export -legacy \
  -out "$CLIENT_P12" \
  -inkey "$CLIENT_KEY" -in "$CLIENT_CERT" \
  -certfile "$CA_CERT" -passout pass:nanoclaw 2>/dev/null; then
  openssl pkcs12 -export \
    -out "$CLIENT_P12" \
    -inkey "$CLIENT_KEY" -in "$CLIENT_CERT" \
    -certfile "$CA_CERT" -passout pass:nanoclaw 2>/dev/null
fi

# Passwordless .p12 for macOS (avoids repeated Keychain prompts)
CLIENT_P12_NOPASS="$CLIENTS_DIR/${NAME}-nopass.p12"
if ! openssl pkcs12 -export -legacy \
  -out "$CLIENT_P12_NOPASS" \
  -inkey "$CLIENT_KEY" -in "$CLIENT_CERT" \
  -certfile "$CA_CERT" -passout pass: 2>/dev/null; then
  openssl pkcs12 -export \
    -out "$CLIENT_P12_NOPASS" \
    -inkey "$CLIENT_KEY" -in "$CLIENT_CERT" \
    -certfile "$CA_CERT" -passout pass: 2>/dev/null
fi

rm -f "$CSR"

echo ""
echo "Client certificate generated:"
echo ""
echo "  macOS: Import $CLIENT_P12_NOPASS into LOGIN keychain (not System)"
echo "         Leave password blank. Set to 'Always Trust'."
echo ""
echo "  Linux/Firefox: Import $CLIENT_P12 (password: nanoclaw)"
