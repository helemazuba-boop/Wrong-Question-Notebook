function required(name) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function requiredOrigin(name) {
  const value = required(name);
  const endpoint = new URL(value);
  const origin = endpoint.origin;
  if (value.replace(/\/+$/, "") !== origin) {
    throw new Error(`${name} must be an origin without a path`);
  }
  if (!new Set(["http:", "https:"]).has(endpoint.protocol)) {
    throw new Error(`${name} must use HTTP or HTTPS`);
  }
  return origin;
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

const targetOrigin = requiredOrigin("SUPABASE_PUBLIC_URL");
const confirmedTargetOrigin = required("CONFIRM_SUPABASE_PUBLIC_ORIGIN");
const publishableKey = required("SUPABASE_PUBLISHABLE_KEY");

if (confirmedTargetOrigin !== targetOrigin) {
  throw new Error(
    `CONFIRM_SUPABASE_PUBLIC_ORIGIN must exactly equal ${targetOrigin}`,
  );
}
if (new URL(targetOrigin).protocol === "http:") {
  console.warn(
    "[target-infra-smoke] Target uses HTTP; continue only over an encrypted private network such as WireGuard",
  );
}

async function request(path, withApiKey = true) {
  const headers = withApiKey ? { apikey: publishableKey } : undefined;
  return fetch(`${targetOrigin}${path}`, {
    headers,
    redirect: "manual",
    signal: AbortSignal.timeout(15_000),
  });
}

const auth = await request("/auth/v1/health");
assert(auth.ok, `Auth health failed with HTTP ${auth.status}`);

const rest = await request("/rest/v1/");
assert(rest.ok, `REST health failed with HTTP ${rest.status}`);

const storage = await request("/storage/v1/status");
assert(storage.ok, `Storage health failed with HTTP ${storage.status}`);

const kongRoot = await request("/", false);
assert(
  kongRoot.status === 404,
  `Kong root must be hidden (got HTTP ${kongRoot.status})`,
);

if (typeof WebSocket !== "function") {
  throw new Error("Realtime smoke requires Node.js 22 or later");
}
const realtimeUrl = new URL("/realtime/v1/websocket", targetOrigin);
realtimeUrl.protocol = realtimeUrl.protocol === "https:" ? "wss:" : "ws:";
realtimeUrl.searchParams.set("apikey", publishableKey);
realtimeUrl.searchParams.set("vsn", "1.0.0");
await new Promise((resolve, reject) => {
  const socket = new WebSocket(realtimeUrl);
  const timeout = setTimeout(() => {
    socket.close();
    reject(new Error("Realtime WebSocket connection timed out"));
  }, 15_000);
  socket.addEventListener("open", () => {
    clearTimeout(timeout);
    socket.close(1000, "target infrastructure smoke complete");
    resolve();
  });
  socket.addEventListener("error", () => {
    clearTimeout(timeout);
    reject(new Error("Realtime WebSocket connection failed"));
  });
});

console.log(
  "[target-infra-smoke] PASS Auth/REST/Storage/Kong/Realtime over the explicit target origin",
);
