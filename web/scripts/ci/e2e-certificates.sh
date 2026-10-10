#!/usr/bin/env bash
set -euo pipefail
repo_root=$(cd "$(dirname "$0")/../../.." && pwd)
directory="$repo_root/.ci-local/certs"
mkdir -p "$directory"
umask 077
openssl req -x509 -newkey rsa:2048 -nodes -days 2 -subj '/CN=WQN ephemeral test CA' \
  -keyout "$directory/ca.key" -out "$directory/ca.crt" 2>/dev/null
openssl req -new -newkey rsa:2048 -nodes -subj '/CN=wqn.e2e.test' \
  -keyout "$directory/server.key" -out "$directory/server.csr" 2>/dev/null
cat > "$directory/extensions.cnf" <<'EOF'
subjectAltName=DNS:wqn.e2e.test,DNS:supabase.e2e.test
basicConstraints=CA:FALSE
keyUsage=digitalSignature,keyEncipherment
extendedKeyUsage=serverAuth
EOF
openssl x509 -req -in "$directory/server.csr" -CA "$directory/ca.crt" -CAkey "$directory/ca.key" \
  -CAcreateserial -days 2 -extfile "$directory/extensions.cnf" -out "$directory/server.crt" 2>/dev/null
if [[ "${1:-}" == trust ]]; then
  sudo cp "$directory/ca.crt" /usr/local/share/ca-certificates/wqn-e2e.crt
  sudo update-ca-certificates
  mkdir -p "$HOME/.pki/nssdb"
  if [[ ! -f "$HOME/.pki/nssdb/cert9.db" ]]; then
    certutil -N -d "sql:$HOME/.pki/nssdb" --empty-password
  fi
  certutil -A -d "sql:$HOME/.pki/nssdb" -n wqn-e2e -t 'C,,' -i "$directory/ca.crt"
  echo '127.0.0.1 wqn.e2e.test supabase.e2e.test' | sudo tee -a /etc/hosts > /dev/null
fi
