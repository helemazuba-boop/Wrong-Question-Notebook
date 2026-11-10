"""Exercise the shipped CLI in fresh processes against an isolated HTTP peer."""
import importlib.util
import json
import os
from pathlib import Path
import socket
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

CLI = Path(__file__).resolve().parents[1] / "scripts/wqn.py"
SPEC = importlib.util.spec_from_file_location("wqn_cli", CLI)
wqn = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(wqn)
USER = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"


class Peer:
    def __init__(self):
        self.approved = False
        self.denied = False
        self.slow_down = False
        self.polls = self.refreshes = self.registrations = self.writes = self.status_queries = 0
        self.drop_refresh = self.drop_write = self.fail_revoke = self.sse = False
        self.drop_before_write = False
        self.hostile_metadata = False
        self.token_number = 1
        self.refresh_token = "wqn_rt_" + f"{self.token_number:064x}"
        fixture = self

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *_):
                pass

            def send(self, data, status=200, sse=False):
                raw = ("event: message\ndata: " + json.dumps(data) + "\n\n").encode() if sse else json.dumps(data).encode()
                self.send_response(status)
                self.send_header("Content-Type", "text/event-stream" if sse else "application/json")
                self.send_header("Content-Length", str(len(raw)))
                self.end_headers()
                self.wfile.write(raw)

            def drop(self):
                self.close_connection = True
                self.connection.shutdown(socket.SHUT_RDWR)
                self.connection.close()

            def do_GET(self):
                if self.path == "/.well-known/oauth-protected-resource":
                    return self.send({"resource": fixture.origin + "/api/mcp", "authorization_servers": [fixture.origin]})
                if self.path == "/.well-known/oauth-authorization-server":
                    return self.send({"issuer": fixture.origin, "grant_types_supported": [wqn.DEVICE_GRANT, "refresh_token"],
                                      "device_authorization_endpoint": "https://evil.example/steal" if fixture.hostile_metadata else fixture.origin + "/device",
                                      "registration_endpoint": fixture.origin + "/register", "token_endpoint": fixture.origin + "/token",
                                      "revocation_endpoint": fixture.origin + "/revoke"})
                self.send({}, 404)

            def do_POST(self):
                raw = self.rfile.read(int(self.headers.get("Content-Length", 0)))
                data = json.loads(raw) if "application/json" in self.headers.get("Content-Type", "") else dict(wqn.urllib.parse.parse_qsl(raw.decode()))
                if self.path == "/register":
                    fixture.registrations += 1
                    assert data["redirect_uris"] == []
                    return self.send({"client_id": "wqn_client_" + "c" * 32}, 201)
                if self.path == "/device":
                    return self.send({"device_code": "wqn_dc_" + "d" * 64, "user_code": "ABCD-EFGH",
                                      "verification_uri": fixture.origin + "/oauth/device",
                                      "verification_uri_complete": fixture.origin + "/oauth/device?user_code=ABCD-EFGH",
                                      "expires_in": 600, "interval": 5})
                if self.path == "/token":
                    if data["grant_type"] == wqn.DEVICE_GRANT:
                        fixture.polls += 1
                        if fixture.denied:
                            return self.send({"error": "access_denied"}, 400)
                        if fixture.slow_down:
                            return self.send({"error": "slow_down"}, 400)
                        if not fixture.approved:
                            return self.send({"error": "authorization_pending"}, 400)
                        return self.send(fixture.tokens())
                    fixture.refreshes += 1
                    if data["refresh_token"] != fixture.refresh_token:
                        return self.send({"error": "invalid_grant"}, 400)
                    fixture.token_number += 1
                    fixture.refresh_token = "wqn_rt_" + f"{fixture.token_number:064x}"
                    time.sleep(0.05)
                    if fixture.drop_refresh:
                        return self.drop()
                    response = fixture.tokens()
                    response.pop("user_id")  # Existing refresh endpoint keeps its wire contract.
                    return self.send(response)
                if self.path == "/revoke":
                    return self.send({}, 500 if fixture.fail_revoke else 200)
                if self.path == "/api/mcp":
                    assert self.headers.get("Authorization", "").startswith("Bearer wqn_oa_")
                    method = data["method"]
                    if method == "notifications/initialized":
                        return self.send(None, 202)
                    if method == "initialize":
                        result = {"protocolVersion": "2025-06-18", "capabilities": {"tools": {}}}
                    elif method == "tools/list":
                        result = {"tools": [
                            {"name": "get_workflow_guide", "description": "Guide", "inputSchema": {"properties": {}}, "annotations": {"readOnlyHint": True}},
                            {"name": "create_todo", "description": "Write", "inputSchema": {"properties": {"request_id": {}, "title": {}}}, "annotations": {"readOnlyHint": False}},
                        ]}
                    elif method == "tools/call":
                        name = data["params"]["name"]
                        if name == "create_todo":
                            if fixture.drop_before_write:
                                fixture.drop_before_write = False
                                return self.drop()
                            fixture.writes += 1
                            if fixture.drop_write:
                                fixture.drop_write = False
                                return self.drop()
                        if name == "get_operation_status":
                            fixture.status_queries += 1
                        result = {"structuredContent": {"status": "completed", "data": {"ok": True},
                                                        "operation": {"execution_state": "committed"} if name != "get_workflow_guide" else None}}
                        if name == "get_operation_status" and fixture.writes == 0:
                            result = {"structuredContent": {"status": "failed", "error": {"code": "operation_not_found"}, "operation": None}}
                    else:
                        return self.send({}, 400)
                    return self.send({"jsonrpc": "2.0", "id": data["id"], "result": result}, sse=fixture.sse)
                self.send({}, 404)

        self.http = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.origin = "http://127.0.0.1:" + str(self.http.server_port)
        self.thread = threading.Thread(target=self.http.serve_forever, daemon=True)
        self.thread.start()

    def tokens(self):
        return {"access_token": "wqn_oa_" + f"{self.token_number:064x}", "refresh_token": self.refresh_token,
                "token_type": "Bearer", "expires_in": 3600, "scope": "mcp:all", "user_id": USER}

    def close(self):
        self.http.shutdown()
        self.http.server_close()
        self.thread.join()


class CliTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.state_dir = Path(self.temporary.name) / "private"
        self.store = wqn.Store(self.state_dir)
        self.env = dict(os.environ, WQN_STATE_DIR=str(self.state_dir), PYTHONDONTWRITEBYTECODE="1")
        self.peer = Peer()
        self.run_cli("configure", "--server", self.peer.origin, "--allow-http-loopback")

    def tearDown(self):
        self.peer.close()
        self.temporary.cleanup()

    def run_cli(self, *args, success=True):
        process = subprocess.run([sys.executable, str(CLI), *args], env=self.env, capture_output=True, text=True, timeout=10)
        self.assertEqual(process.returncode, 0 if success else 1, process.stdout + process.stderr)
        self.assertNotRegex(process.stdout + process.stderr, r"wqn_(?:oa|rt|dc)_[0-9a-f]{64}")
        self.assertNotIn("Traceback", process.stderr)
        return json.loads(process.stdout)

    def mutate_state(self, mutate):
        with self.store.locked():
            state = self.store.read()
            mutate(state)
            self.store.write(state)

    def login(self):
        self.run_cli("auth", "start")
        self.peer.approved = True
        self.mutate_state(lambda state: state["pending"].update(next_poll_at=0))
        result = self.run_cli("auth", "wait", "--timeout", "0.3")
        self.assertEqual(result["status"], "authorized")
        self.assertEqual(result["user_id"], USER)

    def test_device_authorization_survives_process_boundaries(self):
        first = self.run_cli("auth", "start")
        self.assertEqual(first["status"], "pending")
        self.assertEqual(first["user_code"], "ABCD-EFGH")
        self.assertEqual(self.run_cli("auth", "start")["user_code"], first["user_code"])
        self.assertEqual(self.peer.registrations, 1)
        self.mutate_state(lambda state: state["pending"].update(next_poll_at=0))
        result = self.run_cli("auth", "wait", "--timeout", "0.1")
        self.assertEqual(result["status"], "pending")
        self.assertEqual(self.peer.polls, 1)
        self.assertGreater(self.store.read()["pending"]["next_poll_at"], time.time())
        self.peer.approved = True
        self.mutate_state(lambda state: state["pending"].update(next_poll_at=0))
        self.assertEqual(self.run_cli("auth", "wait", "--timeout", "0.2")["status"], "authorized")
        self.assertEqual(self.run_cli("auth", "status")["status"], "authorized")

    def test_slow_down_is_persisted(self):
        self.run_cli("auth", "start")
        self.peer.slow_down = True
        self.mutate_state(lambda state: state["pending"].update(next_poll_at=0))
        self.assertEqual(self.run_cli("auth", "wait", "--timeout", "0.1")["interval"], 10)
        self.assertEqual(self.store.read()["pending"]["interval"], 10)

    def test_denial_stops_polling_and_clears_pending_request(self):
        self.run_cli("auth", "start")
        self.peer.denied = True
        self.mutate_state(lambda state: state["pending"].update(next_poll_at=0))
        self.assertEqual(self.run_cli("auth", "wait", "--timeout", "0.2")["status"], "denied")
        self.assertNotIn("pending", self.store.read())
        self.assertEqual(self.run_cli("auth", "wait")["status"], "unauthorized")
        self.assertEqual(self.peer.polls, 1)

    def test_expiry_does_not_start_another_request(self):
        self.run_cli("auth", "start")
        self.mutate_state(lambda state: state["pending"].update(expires_at=0))
        self.assertEqual(self.run_cli("auth", "wait", "--timeout", "0.1")["status"], "expired")
        self.assertEqual(self.peer.polls, 0)

    def test_metadata_cannot_redirect_credentials_to_another_origin(self):
        self.peer.hostile_metadata = True
        result = self.run_cli("auth", "start", success=False)
        self.assertEqual(result["error"]["code"], "untrusted_endpoint")
        self.assertEqual(self.peer.registrations, 0)

    def test_state_is_private_and_not_written_inside_the_skill(self):
        self.login()
        self.assertEqual(self.state_dir.stat().st_mode & 0o777, 0o700)
        self.assertEqual((self.state_dir / "state.json").stat().st_mode & 0o777, 0o600)
        self.assertIn("credentials", self.store.read())

    def test_concurrent_commands_refresh_once_and_preserve_rotation(self):
        self.login()
        self.mutate_state(lambda state: state["credentials"].update(expires_at=0))
        processes = [subprocess.Popen([sys.executable, str(CLI), "tools", "list"], env=self.env,
                                      stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True) for _ in range(2)]
        for process in processes:
            out, err = process.communicate(timeout=10)
            self.assertEqual(process.returncode, 0, out + err)
            self.assertEqual(len(json.loads(out)["tools"]), 2)
            self.assertNotRegex(out + err, r"wqn_(?:oa|rt|dc)_[0-9a-f]{64}")
        self.assertEqual(self.peer.refreshes, 1)
        self.assertEqual(self.store.read()["credentials"]["refresh_token"], self.peer.refresh_token)
        self.assertNotIn("refresh_inflight", self.store.read())

    def test_lost_refresh_response_is_never_replayed(self):
        self.login()
        self.mutate_state(lambda state: state["credentials"].update(expires_at=0))
        self.peer.drop_refresh = True
        self.run_cli("tools", "list", success=False)
        self.assertTrue(self.store.read()["refresh_inflight"])
        result = self.run_cli("tools", "list", success=False)
        self.assertEqual(result["error"]["code"], "refresh_uncertain")
        self.assertEqual(self.peer.refreshes, 1)
        self.assertEqual(self.run_cli("auth", "status")["status"], "reauthorization_required")

    def test_saved_inflight_device_exchange_is_not_replayed(self):
        self.run_cli("auth", "start")
        self.mutate_state(lambda state: state["pending"].update(exchange_inflight=True))
        result = self.run_cli("auth", "wait", success=False)
        self.assertEqual(result["error"]["code"], "device_exchange_uncertain")
        self.assertEqual(self.peer.polls, 0)
        self.assertEqual(self.run_cli("auth", "status")["status"], "reauthorization_required")
        result = self.run_cli("auth", "logout", "--revoke", success=False)
        self.assertEqual(result["error"]["code"], "revocation_uncertain")
        self.assertIn("pending", self.store.read())

    def test_mcp_discovery_and_sse_results(self):
        self.login()
        self.peer.sse = True
        self.assertEqual(self.run_cli("tools", "schema", "create_todo")["name"], "create_todo")
        self.assertEqual(self.run_cli("call", "get_workflow_guide")["status"], "completed")

    def write_arguments(self, request_id=None, title="Buy milk"):
        path = Path(self.temporary.name) / "arguments.json"
        path.write_text(json.dumps({"request_id": request_id or "request_todo_00000001", "title": title}))
        return str(path)

    def test_lost_write_response_queries_receipt_instead_of_recreating_write(self):
        self.login()
        arguments = self.write_arguments()
        self.peer.drop_write = True
        result = self.run_cli("call", "create_todo", "--input-file", arguments, success=False)
        self.assertEqual(result["error"]["code"], "write_outcome_unknown")
        self.assertEqual(self.peer.writes, 1)
        self.assertEqual(self.run_cli("call", "create_todo", "--input-file", arguments)["status"], "completed")
        self.assertEqual(self.peer.writes, 1)
        self.assertEqual(self.peer.status_queries, 1)
        self.assertEqual(len(self.run_cli("operations", "list")["operations"]), 1)
        self.assertEqual(self.run_cli("operations", "status", "request_todo_00000001")["status"], "completed")

    def test_same_request_id_cannot_change_payload(self):
        self.login()
        self.run_cli("call", "create_todo", "--input-file", self.write_arguments())
        result = self.run_cli("call", "create_todo", "--input-file", self.write_arguments(title="Other"), success=False)
        self.assertEqual(result["error"]["code"], "request_id_reused")
        self.assertEqual(self.peer.writes, 1)

    def test_missing_receipt_allows_an_explicit_identical_retry_with_original_id(self):
        self.login()
        arguments = self.write_arguments()
        self.peer.drop_before_write = True
        self.run_cli("call", "create_todo", "--input-file", arguments, success=False)
        self.assertEqual(self.peer.writes, 0)
        result = self.run_cli("operations", "status", "request_todo_00000001")
        self.assertEqual(result["error"]["code"], "operation_not_found")
        self.assertEqual(self.run_cli("call", "create_todo", "--input-file", arguments)["status"], "completed")
        self.assertEqual(self.peer.writes, 1)
        self.assertEqual(self.run_cli("call", "create_todo", "--input-file", arguments)["status"], "completed")
        self.assertEqual(self.peer.writes, 1)

    def test_account_switch_cannot_reuse_a_previous_write(self):
        self.login()
        arguments = self.write_arguments()
        self.run_cli("call", "create_todo", "--input-file", arguments)
        self.mutate_state(lambda state: state["credentials"].update(user_id="bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"))
        result = self.run_cli("call", "create_todo", "--input-file", arguments, success=False)
        self.assertEqual(result["error"]["code"], "request_id_reused")
        self.assertEqual(self.peer.writes, 1)

    def test_revocation_failure_keeps_credentials_for_retry(self):
        self.login()
        self.peer.fail_revoke = True
        result = self.run_cli("auth", "logout", "--revoke", success=False)
        self.assertEqual(result["error"]["code"], "revocation_failed")
        self.assertIn("credentials", self.store.read())
        self.peer.fail_revoke = False
        self.assertEqual(self.run_cli("auth", "logout", "--revoke")["revocation"], "acknowledged")
        self.assertNotIn("credentials", self.store.read())

    def test_public_http_server_is_rejected_even_with_development_switch(self):
        for server in ("http://example.com", "https://user:password@example.com", "https://example.com/path"):
            with self.assertRaises(wqn.ClientError):
                wqn.Client.parse_server(server, allow_http=True)

    def test_sse_decoder_handles_multiline_data_and_notifications(self):
        raw = b'data: {"jsonrpc":"2.0","method":"ping"}\n\ndata: {"id":1,\ndata: "result":{"ok":true}}\n\n'
        self.assertEqual(wqn.Client.decode_sse(raw)["result"], {"ok": True})

    def test_sse_returns_matching_result_without_waiting_for_stream_to_close(self):
        def still_open():
            yield b'data: {"id":99,"result":{}}\n'
            yield b'\n'
            yield b'data: {"id":1,"result":{"ok":true}}\n'
            yield b'\n'
            raise AssertionError("Read past this request's response on an open stream")
        self.assertTrue(wqn.Client.read_sse(still_open(), expected_id=1)["result"]["ok"])

    def test_old_snapshot_cannot_reuse_a_rotated_refresh_token(self):
        self.login()
        self.mutate_state(lambda state: state["credentials"].update(expires_at=0))
        snapshot = self.store.read()
        self.run_cli("tools", "list")
        with self.store.locked():
            self.store.write(snapshot)
        result = self.run_cli("tools", "list", success=False)
        self.assertEqual(result["error"]["code"], "refresh_failed")
        self.assertEqual(self.run_cli("auth", "status")["status"], "reauthorization_required")


if __name__ == "__main__":
    unittest.main()
