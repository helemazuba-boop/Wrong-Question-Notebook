// ruleid: tls-verification-disabled
process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
// ok: tls-verification-disabled
process.env.NODE_EXTRA_CA_CERTS = "/test-ca.pem";
// ruleid: tls-verification-disabled
new https.Agent({ rejectUnauthorized: false });
// ok: tls-verification-disabled
new https.Agent({ ca: certificate });
// ruleid: dynamic-code-execution
eval(untrusted);
// ruleid: dynamic-code-execution
new Function(untrusted);
// ok: dynamic-code-execution
JSON.parse(untrusted);
