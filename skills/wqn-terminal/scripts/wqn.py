#!/usr/bin/env python3
"""WQN terminal client. Python 3.10+, Linux/macOS; no third-party packages."""

import argparse
import contextlib
import fcntl
import json
import os
from pathlib import Path
import re
import stat
import sys
import tempfile
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid

DEVICE_GRANT = "urn:ietf:params:oauth:grant-type:device_code"
PROTOCOLS = ("2025-06-18", "2025-03-26")
SECRET_PATTERN = re.compile(r"wqn_(?:oa|rt|dc)_[0-9a-f]{64}")
REQUEST_ID = re.compile(r"^[A-Za-z0-9_-]{16,64}$")
MAX_RESPONSE = 16 * 1024 * 1024


class ClientError(Exception):
    def __init__(self, code, **details):
        self.code, self.details = code, details
        super().__init__(code)


def redact(value):
    if isinstance(value, dict):
        return {k: ("[REDACTED]" if k in ("access_token", "refresh_token", "device_code")
                    else redact(v)) for k, v in value.items()}
    if isinstance(value, list):
        return [redact(v) for v in value]
    return SECRET_PATTERN.sub("[REDACTED]", value) if isinstance(value, str) else value


def emit(value):
    print(json.dumps(redact(value), ensure_ascii=False))


class Store:
    def __init__(self, root=None):
        self.root = Path(root or os.environ.get("WQN_STATE_DIR") or
                         Path(os.environ.get("XDG_STATE_HOME", Path.home() / ".local/state")) /
                         "wqn-terminal").expanduser().absolute()

    @contextlib.contextmanager
    def locked(self):
        self.root.mkdir(parents=True, exist_ok=True, mode=0o700)
        info = self.root.lstat()
        if not stat.S_ISDIR(info.st_mode) or info.st_uid != os.getuid():
            raise ClientError("unsafe_state_directory")
        os.chmod(self.root, 0o700)
        fd = os.open(self.root / ".lock", os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
        deadline = time.monotonic() + 5
        try:
            while True:
                try:
                    fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
                    break
                except BlockingIOError:
                    if time.monotonic() >= deadline:
                        raise ClientError("state_busy") from None
                    time.sleep(0.1)
            yield
        finally:
            os.close(fd)

    def read(self, name="state"):
        path = self.root / (name + ".json")
        try:
            fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
        except FileNotFoundError:
            return {}
        with os.fdopen(fd) as stream:
            info = os.fstat(stream.fileno())
            if info.st_uid != os.getuid() or info.st_mode & 0o077:
                raise ClientError("unsafe_state_file")
            try:
                data = json.load(stream)
            except (ValueError, UnicodeError):
                raise ClientError("state_corrupt") from None
        if not isinstance(data, dict):
            raise ClientError("state_corrupt")
        return data

    def write(self, data, name="state"):
        fd, temporary = tempfile.mkstemp(dir=self.root, prefix=".save-")
        try:
            with os.fdopen(fd, "w") as stream:
                json.dump(data, stream, ensure_ascii=False)
                stream.flush()
                os.fsync(stream.fileno())
            os.replace(temporary, self.root / (name + ".json"))
            directory = os.open(self.root, os.O_RDONLY | os.O_DIRECTORY)
            try:
                os.fsync(directory)
            finally:
                os.close(directory)
        finally:
            if os.path.exists(temporary):
                os.unlink(temporary)


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


class Client:
    def __init__(self, store):
        self.store = store
        self.state = store.read()
        self.opener = urllib.request.build_opener(NoRedirect)
        self.session_id = None
        self.protocol = PROTOCOLS[0]
        self.rpc_id = 0

    def save(self):
        self.store.write(self.state)

    @staticmethod
    def parse_server(value, allow_http=False):
        try:
            url = urllib.parse.urlsplit(value)
            port = url.port
        except ValueError:
            raise ClientError("invalid_server") from None
        if (not url.hostname or url.username or url.password or url.query or url.fragment or
                url.path not in ("", "/") or
                (url.scheme != "https" and not (allow_http and url.scheme == "http" and
                                                url.hostname in ("127.0.0.1", "::1")))):
            raise ClientError("invalid_server")
        # Keep IPv6 brackets, remove a default port, and normalize host case.
        hostname = f"[{url.hostname}]" if ":" in url.hostname else url.hostname
        netloc = hostname if port in (None, 443 if url.scheme == "https" else 80) else f"{hostname}:{port}"
        return f"{url.scheme}://{netloc}"

    def configure(self, server, name, allow_http=False):
        server = self.parse_server(server, allow_http)
        if self.state.get("server") not in (None, server):
            raise ClientError("server_already_configured", message="Use a separate WQN_STATE_DIR for another server.")
        if not 1 <= len(name.strip()) <= 100:
            raise ClientError("invalid_client_name")
        self.state.update(server=server, client_name=name.strip(), allow_http=allow_http)
        self.save()
        return {"status": "configured", "server": server,
                "state_directory": str(self.store.root), "persistence": "host_managed"}

    def endpoint(self, value, query=False):
        server = self.state.get("server")
        if not server:
            raise ClientError("configuration_required")
        try:
            url = urllib.parse.urlsplit(value)
            origin = self.parse_server(f"{url.scheme}://{url.netloc}", self.state.get("allow_http", False))
        except (ValueError, ClientError):
            raise ClientError("untrusted_endpoint") from None
        if origin != server or url.fragment or (url.query and not query):
            raise ClientError("untrusted_endpoint")
        return value

    def request(self, url, *, form=None, payload=None, bearer=None, timeout=30):
        self.endpoint(url)
        headers = {"Accept": "application/json, text/event-stream", "User-Agent": "wqn-terminal/1.0"}
        body = None
        if form is not None:
            headers["Content-Type"] = "application/x-www-form-urlencoded"
            body = urllib.parse.urlencode(form).encode()
        elif payload is not None:
            headers["Content-Type"] = "application/json"
            body = json.dumps(payload).encode()
        if bearer:
            headers["Authorization"] = "Bearer " + bearer
            headers["MCP-Protocol-Version"] = self.protocol
            if self.session_id:
                headers["Mcp-Session-Id"] = self.session_id
        request = urllib.request.Request(url, data=body, headers=headers)
        try:
            response = self.opener.open(request, timeout=max(0.1, timeout))
        except urllib.error.HTTPError as error:
            response = error
        except (OSError, urllib.error.URLError):
            raise ClientError("network_error") from None
        with response:
            status = response.code
            if bearer and response.headers.get("Mcp-Session-Id"):
                self.session_id = response.headers["Mcp-Session-Id"]
            if 300 <= status < 400:
                raise ClientError("redirect_refused")
            try:
                if "text/event-stream" in response.headers.get("Content-Type", ""):
                    # A POST stream may stay open after its response. Stop at
                    # this RPC's result rather than waiting for connection EOF.
                    data = self.read_sse(iter(lambda: response.readline(MAX_RESPONSE + 1), b""),
                                         payload.get("id") if isinstance(payload, dict) else None)
                else:
                    raw = response.read(MAX_RESPONSE + 1)
                    if len(raw) > MAX_RESPONSE:
                        raise ClientError("response_too_large")
                    data = json.loads(raw) if raw else None
            except (ValueError, UnicodeError):
                raise ClientError("invalid_response", http_status=status) from None
        return status, data

    @staticmethod
    def decode_sse(raw):
        return Client.read_sse((raw.replace(b"\r\n", b"\n") + b"\n\n").splitlines(keepends=True))

    @staticmethod
    def read_sse(lines, expected_id=None):
        fields = []
        total = 0
        for raw_line in lines:
            total += len(raw_line)
            if total > MAX_RESPONSE:
                raise ClientError("response_too_large")
            line = raw_line.decode().rstrip("\r\n")
            if line.startswith("data:"):
                fields.append(line[5:].lstrip(" "))
            elif not line and fields:
                event = json.loads("\n".join(fields))
                if (isinstance(event, dict) and "id" in event and
                        (expected_id is None or event["id"] == expected_id) and
                        ("result" in event or "error" in event)):
                    return event
                fields = []
        raise ClientError("invalid_mcp_response")

    def discover(self):
        server = self.state.get("server")
        if not server:
            raise ClientError("configuration_required")
        status, resource = self.request(server + "/.well-known/oauth-protected-resource")
        if status != 200 or not isinstance(resource, dict) or resource.get("resource") != server + "/api/mcp" or server not in resource.get("authorization_servers", []):
            raise ClientError("invalid_resource_metadata")
        status, metadata = self.request(server + "/.well-known/oauth-authorization-server")
        if status != 200 or not isinstance(metadata, dict) or metadata.get("issuer") != server:
            raise ClientError("invalid_issuer_metadata")
        if DEVICE_GRANT not in metadata.get("grant_types_supported", []):
            raise ClientError("device_flow_unsupported")
        for name in ("device_authorization_endpoint", "token_endpoint", "registration_endpoint", "revocation_endpoint"):
            self.endpoint(metadata.get(name, ""))
        return metadata

    def auth_status(self):
        credentials = self.state.get("credentials", {})
        valid = credentials.get("expires_at", 0) > time.time() + 60
        usable = bool(credentials.get("access_token") and valid) or bool(credentials.get("refresh_token"))
        return {
            "status": "reauthorization_required" if (self.state.get("refresh_inflight") or
                                                      self.state.get("pending", {}).get("exchange_inflight")) else
                      "authorized" if usable else "pending" if self.state.get("pending", {}).get("expires_at", 0) > time.time() else "unauthorized",
            "server": self.state.get("server"),
            "user_id": credentials.get("user_id"),
            "scope": credentials.get("scope"),
            "expires_at": credentials.get("expires_at"),
            "refresh_needed": bool(usable and not valid),
            "state_directory": str(self.store.root),
            "persistence": "host_managed",
        }

    def start(self):
        if self.auth_status()["status"] == "authorized":
            return self.auth_status()
        pending = self.state.get("pending", {})
        if pending.get("expires_at", 0) > time.time() and not pending.get("exchange_inflight"):
            return self.public_pending(pending)
        metadata = self.discover()
        self.state["metadata"] = metadata
        if not self.state.get("client_id"):
            status, registered = self.request(metadata["registration_endpoint"], payload={
                "client_name": self.state.get("client_name", "WQN Terminal"),
                "redirect_uris": [], "grant_types": [DEVICE_GRANT, "refresh_token"], "response_types": [],
            })
            if status != 201 or not isinstance(registered, dict) or not re.fullmatch(r"wqn_client_[0-9a-f]{32}", registered.get("client_id", "")):
                raise ClientError("registration_failed", http_status=status)
            self.state["client_id"] = registered["client_id"]
            self.save()
        status, response = self.request(metadata["device_authorization_endpoint"], form={
            "client_id": self.state["client_id"], "scope": "mcp:all", "resource": self.state["server"] + "/api/mcp",
        })
        if status != 200 or not isinstance(response, dict):
            raise ClientError("device_authorization_failed", http_status=status)
        try:
            self.endpoint(response["verification_uri"])
            complete = response.get("verification_uri_complete")
            if complete:
                self.endpoint(complete, query=True)
            ttl = int(response["expires_in"])
            interval = max(5, int(response.get("interval", 5)))
            if ttl <= 0 or not re.fullmatch(r"wqn_dc_[0-9a-f]{64}", response["device_code"]) or not re.fullmatch(r"[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}", response["user_code"]):
                raise ValueError()
        except (KeyError, TypeError, ValueError):
            raise ClientError("invalid_device_authorization") from None
        pending = {"device_code": response["device_code"], "user_code": response["user_code"],
                   "verification_uri": response["verification_uri"], "verification_uri_complete": complete,
                   "expires_at": time.time() + ttl, "interval": interval, "next_poll_at": time.time() + interval}
        self.state["pending"] = pending
        self.save()
        return self.public_pending(pending)

    @staticmethod
    def public_pending(pending):
        return {"status": "pending", **{k: pending[k] for k in
                ("user_code", "verification_uri", "verification_uri_complete", "expires_at", "interval")}}

    def save_credentials(self, response, *, fresh=False):
        previous = self.state.get("credentials", {})
        try:
            user = response.get("user_id", None if fresh else previous.get("user_id"))
            if response.get("token_type", "").lower() != "bearer" or response.get("scope") != "mcp:all" or not user:
                raise ValueError()
            uuid.UUID(user)
            if not re.fullmatch(r"wqn_oa_[0-9a-f]{64}", response["access_token"]) or not re.fullmatch(r"wqn_rt_[0-9a-f]{64}", response["refresh_token"]):
                raise ValueError()
            expires = int(response["expires_in"])
            if expires <= 0 or (not fresh and previous.get("user_id") != user):
                raise ValueError()
        except (KeyError, TypeError, ValueError, AttributeError):
            raise ClientError("invalid_token_response") from None
        self.state["credentials"] = {"access_token": response["access_token"],
                                     "refresh_token": response["refresh_token"],
                                     "user_id": user, "scope": response["scope"],
                                     "expires_at": time.time() + expires}
        self.state.pop("refresh_inflight", None)
        self.state.pop("pending", None)
        self.save()

    def wait(self, timeout):
        deadline = time.monotonic() + min(max(timeout, 0), 45)
        pending = self.state.get("pending")
        if not pending:
            return self.auth_status()
        if pending.get("exchange_inflight"):
            raise ClientError("device_exchange_uncertain", message="Start a new authorization request.")
        while time.monotonic() < deadline:
            if pending["expires_at"] <= time.time():
                self.state.pop("pending", None)
                self.save()
                return {"status": "expired"}
            sleep_for = min(max(0, pending["next_poll_at"] - time.time()), deadline - time.monotonic())
            if sleep_for > 0:
                time.sleep(sleep_for)
            if time.monotonic() >= deadline:
                break
            # A process death or lost success response must not replay a
            # potentially consumed device code on a subsequent invocation.
            pending["exchange_inflight"] = True
            self.save()
            status, response = self.request(self.state["metadata"]["token_endpoint"], form={
                "grant_type": DEVICE_GRANT, "device_code": pending["device_code"],
                "client_id": self.state["client_id"], "resource": self.state["server"] + "/api/mcp",
            }, timeout=min(30, max(0.1, deadline - time.monotonic())))
            if status == 200 and isinstance(response, dict):
                self.save_credentials(response, fresh=True)
                return self.auth_status()
            error = response.get("error") if isinstance(response, dict) else None
            if status == 400 and error in ("authorization_pending", "slow_down"):
                pending.pop("exchange_inflight", None)
                if error == "slow_down":
                    pending["interval"] += 5
                pending["next_poll_at"] = time.time() + pending["interval"]
                self.save()
                continue
            if status == 400 and error in ("access_denied", "expired_token", "invalid_grant"):
                self.state.pop("pending", None)
                self.save()
                return {"status": "denied" if error == "access_denied" else "expired"}
            raise ClientError("device_exchange_uncertain", http_status=status)
        return self.public_pending(pending)

    def access_token(self):
        if self.state.get("refresh_inflight"):
            raise ClientError("refresh_uncertain", message="Reauthorize; do not replay the previous refresh token.")
        credentials = self.state.get("credentials", {})
        if credentials.get("access_token") and credentials.get("expires_at", 0) > time.time() + 60:
            return credentials["access_token"]
        if not credentials.get("refresh_token"):
            raise ClientError("authorization_required")
        self.state["refresh_inflight"] = True
        self.save()
        status, response = self.request(self.state["metadata"]["token_endpoint"], form={
            "grant_type": "refresh_token", "refresh_token": credentials["refresh_token"],
            "client_id": self.state["client_id"], "resource": self.state["server"] + "/api/mcp",
        })
        if status != 200 or not isinstance(response, dict):
            raise ClientError("refresh_failed", http_status=status, reauthorization_required=True)
        self.save_credentials(response)
        return self.state["credentials"]["access_token"]

    def logout(self):
        credentials = self.state.get("credentials", {})
        if self.state.get("refresh_inflight") or self.state.get("pending", {}).get("exchange_inflight"):
            raise ClientError("revocation_uncertain", message="Revoke this client in WQN; credentials may have been issued.")
        if not credentials:
            self.state.pop("pending", None)
            self.save()
            return {"status": "signed_out", "revocation": "no_credentials"}
        # Keep credentials until both revocation requests are acknowledged.
        for name in ("refresh_token", "access_token"):
            if credentials.get(name):
                status, _ = self.request(self.state["metadata"]["revocation_endpoint"], form={
                    "token": credentials[name], "token_type_hint": name, "client_id": self.state["client_id"],
                })
                if status != 200:
                    raise ClientError("revocation_failed", http_status=status)
        self.state.pop("credentials", None)
        self.state.pop("pending", None)
        self.save()
        return {"status": "signed_out", "revocation": "acknowledged"}

    def rpc(self, method, params=None, notification=False):
        token = self.access_token()
        self.rpc_id += 1
        payload = {"jsonrpc": "2.0", "method": method, "params": params or {}}
        if not notification:
            payload["id"] = self.rpc_id
        status, result = self.request(self.state["server"] + "/api/mcp", payload=payload, bearer=token)
        if notification and status in (200, 202, 204):
            return None
        if status in (401, 403):
            raise ClientError("authorization_rejected", http_status=status)
        if status != 200 or not isinstance(result, dict) or result.get("id") != self.rpc_id:
            raise ClientError("mcp_transport_error", http_status=status)
        if "error" in result:
            error = result["error"]
            raise ClientError("mcp_rpc_error", rpc_code=error.get("code") if isinstance(error, dict) else None)
        if not isinstance(result.get("result"), dict):
            raise ClientError("invalid_mcp_response")
        return result["result"]

    def initialize(self):
        result = self.rpc("initialize", {"protocolVersion": PROTOCOLS[0], "capabilities": {},
                                         "clientInfo": {"name": "wqn-terminal", "version": "1.0.0"}})
        if result.get("protocolVersion") not in PROTOCOLS:
            raise ClientError("unsupported_mcp_protocol")
        self.protocol = result["protocolVersion"]
        self.rpc("notifications/initialized", notification=True)

    def tools(self):
        tools, seen, cursor = [], set(), None
        for _ in range(100):
            response = self.rpc("tools/list", {"cursor": cursor} if cursor else {})
            page = response.get("tools")
            if not isinstance(page, list) or any(not isinstance(tool, dict) for tool in page):
                raise ClientError("invalid_tool_schema")
            tools.extend(page)
            cursor = response.get("nextCursor")
            if not cursor:
                return tools
            if not isinstance(cursor, str) or cursor in seen:
                break
            seen.add(cursor)
        raise ClientError("invalid_tool_pagination")

    def tool(self, name):
        for tool in self.tools():
            if tool.get("name") == name:
                return tool
        raise ClientError("unknown_tool", tool_name=name)

    def call_result(self, name, arguments):
        result = self.rpc("tools/call", {"name": name, "arguments": arguments})
        envelope = result.get("structuredContent")
        if envelope is None:
            for item in result.get("content", []):
                if item.get("type") == "text":
                    try:
                        envelope = json.loads(item["text"])
                        break
                    except (ValueError, KeyError):
                        continue
        if not isinstance(envelope, dict) or envelope.get("status") not in ("completed", "requires_user_action", "in_progress", "failed", "unknown"):
            raise ClientError("invalid_tool_result")
        return envelope

    def call(self, name, arguments):
        tool = self.tool(name)
        needs_id = "request_id" in tool.get("inputSchema", {}).get("properties", {})
        journal, key = None, None
        if needs_id:
            request_id = arguments.get("request_id", "")
            if not isinstance(request_id, str) or not REQUEST_ID.fullmatch(request_id):
                raise ClientError("request_id_required")
            key = "operation-" + request_id
            journal = self.store.read(key)
            actor = self.state["credentials"]["user_id"]
            if journal and (journal["server"] != self.state["server"] or journal["user_id"] != actor or journal["tool_name"] != name or journal["arguments"] != arguments):
                raise ClientError("request_id_reused", request_id=request_id)
            if journal and journal["state"] != "not_found":
                result = self.call_result("get_operation_status", {"tool_name": name, "request_id": request_id})
                self.record_outcome(journal, key, result)
                return result
            journal = {"server": self.state["server"], "user_id": actor, "tool_name": name,
                       "arguments": arguments, "request_id": request_id, "state": "sending"}
            self.store.write(journal, key)
        try:
            result = self.call_result(name, arguments)
        except ClientError as error:
            if journal:
                if error.code == "mcp_rpc_error" and error.details.get("rpc_code") in (-32600, -32601, -32602):
                    journal["state"] = "failed"
                    self.store.write(journal, key)
                    raise
                journal["state"] = "unknown"
                self.store.write(journal, key)
                raise ClientError("write_outcome_unknown", tool_name=name, request_id=journal["request_id"],
                                  next_tool="get_operation_status") from None
            raise
        if journal:
            self.record_outcome(journal, key, result)
        return result

    def record_outcome(self, journal, key, result):
        error = result.get("error")
        journal["state"] = "not_found" if (isinstance(error, dict) and
                                           error.get("code") == "operation_not_found") else result["status"]
        journal["operation"] = result.get("operation")
        self.store.write(journal, key)

    def operations(self, request_id=None):
        if request_id is None:
            return {"operations": [{k: item.get(k) for k in ("tool_name", "request_id", "state", "operation")}
                                   for path in sorted(self.store.root.glob("operation-*.json"))
                                   if (item := self.store.read(path.stem)) and
                                   item.get("server") == self.state.get("server") and
                                   item.get("user_id") == self.state.get("credentials", {}).get("user_id")]}
        if not REQUEST_ID.fullmatch(request_id):
            raise ClientError("invalid_request_id")
        item = self.store.read("operation-" + request_id)
        if not item or item.get("server") != self.state.get("server") or item.get("user_id") != self.state.get("credentials", {}).get("user_id"):
            raise ClientError("operation_not_found")
        result = self.call_result("get_operation_status", {"tool_name": item["tool_name"], "request_id": request_id})
        self.record_outcome(item, "operation-" + request_id, result)
        return result


def parser():
    root = argparse.ArgumentParser(description=__doc__)
    commands = root.add_subparsers(dest="command", required=True)
    configure = commands.add_parser("configure")
    configure.add_argument("--server", required=True)
    configure.add_argument("--client-name", default="WQN Terminal")
    configure.add_argument("--allow-http-loopback", action="store_true", help="Local development only")
    auth = commands.add_parser("auth").add_subparsers(dest="action", required=True)
    leaves = [configure]
    for action in ("status", "start", "wait", "logout"):
        leaf = auth.add_parser(action)
        if action == "wait":
            leaf.add_argument("--timeout", type=float, default=45)
        if action == "logout":
            leaf.add_argument("--revoke", action="store_true", required=True)
        leaves.append(leaf)
    tools = commands.add_parser("tools").add_subparsers(dest="action", required=True)
    leaves.append(tools.add_parser("list"))
    schema = tools.add_parser("schema")
    schema.add_argument("tool")
    leaves.append(schema)
    call = commands.add_parser("call")
    call.add_argument("tool")
    call.add_argument("--input-file", type=Path)
    leaves.append(call)
    leaves.append(commands.add_parser("request-id"))
    operations = commands.add_parser("operations").add_subparsers(dest="action", required=True)
    leaves.append(operations.add_parser("list"))
    operation_status = operations.add_parser("status")
    operation_status.add_argument("request_id")
    leaves.append(operation_status)
    for leaf in leaves:
        leaf.add_argument("--json", action="store_true", help="All output is JSON, including without this flag")
    return root


def main(argv=None):
    args = parser().parse_args(argv)
    try:
        if args.command == "request-id":
            emit({"request_id": str(uuid.uuid4())})
            return 0
        store = Store()
        with store.locked():
            client = Client(store)
            if args.command == "configure":
                output = client.configure(args.server, args.client_name, args.allow_http_loopback)
            elif args.command == "auth":
                output = {"status": client.auth_status, "start": client.start,
                          "wait": lambda: client.wait(args.timeout), "logout": client.logout}[args.action]()
            else:
                client.initialize()
                if args.command == "tools":
                    output = client.tool(args.tool) if args.action == "schema" else {"tools": [
                        {k: tool.get(k) for k in ("name", "description", "annotations")} for tool in client.tools()]}
                elif args.command == "operations":
                    output = client.operations(getattr(args, "request_id", None))
                else:
                    try:
                        arguments = json.loads(args.input_file.read_text()) if args.input_file else {}
                    except (ValueError, OSError):
                        raise ClientError("invalid_arguments_file") from None
                    if not isinstance(arguments, dict):
                        raise ClientError("invalid_arguments_file")
                    output = client.call(args.tool, arguments)
            emit(output)
        return 0
    except ClientError as error:
        emit({"status": "failed", "error": {"code": error.code, **error.details}})
        return 1
    except (OSError, ValueError, KeyError, TypeError, AttributeError, OverflowError):
        # Never print a traceback, HTTP body, request headers, or state data.
        emit({"status": "failed", "error": {"code": "client_state_or_io_error"}})
        return 1


if __name__ == "__main__":
    sys.exit(main())
