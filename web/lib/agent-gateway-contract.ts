/**
 * The pinned `schema_sha256` of `contracts/agent-gateway-v0/agent-gateway-v0.schema.json`.
 *
 * The firmware is the authority for this contract, and its build hashes the
 * schema on every configure against the same value recorded in its
 * `manifest.json`. This constant is the cloud's copy of that pin: the mirror in
 * `contracts/agent-gateway-v0/` is only real if the schema, the manifest and
 * this number agree, so a schema edit must land in all three places or
 * `agent-gateway-contract.test.ts` fails.
 *
 * There is no runtime schema here on purpose. The device contract is small and
 * the routes already answer it; a second implementation of the same shape in
 * zod would be a second thing to keep in sync, which is the problem this test
 * exists to catch.
 */
export const AGENT_GATEWAY_SCHEMA_SHA256 =
  '8409050fbfa8d1452c9897f857ceba03c9e972f790bb710e9388fc041c1fd358';

/** Contract-relative path fragments, so the test reads from one place. */
export const AGENT_GATEWAY_CONTRACT_DIR = 'contracts/agent-gateway-v0';
