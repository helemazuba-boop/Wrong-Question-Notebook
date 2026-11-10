"""Run against an explicitly selected, isolated OAuth test database."""
import argparse
import json
import subprocess
import uuid


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--host", required=True)
    parser.add_argument("--port", required=True)
    parser.add_argument("--database", required=True)
    args = parser.parse_args()
    command = ["psql", "-XAtq", "-v", "ON_ERROR_STOP=1", "-h", args.host,
               "-p", args.port, "-d", args.database]

    def sql(statement):
        return subprocess.run(command, input=statement, text=True, capture_output=True,
                              check=True, timeout=10).stdout.strip()

    user = str(uuid.uuid4())
    client = "device_concurrency_" + uuid.uuid4().hex
    device_hash, user_hash = uuid.uuid4().hex * 2, uuid.uuid4().hex * 2

    def exchange(access, refresh):
        return ("select public.oauth_poll_device_authorization("
                f"'{device_hash}','{client}','https://wqn.example/api/mcp',"
                f"'{access}','{refresh}',3600,7776000);")

    try:
        sql(f"""insert into auth.users(id) values ('{user}');
          insert into public.oauth_clients(client_id,client_name,redirect_uris,grant_types,response_types)
          values ('{client}','Concurrent test','{{}}',array['urn:ietf:params:oauth:grant-type:device_code','refresh_token'],'{{}}');
          insert into public.oauth_device_authorizations(client_id,device_code_hash,user_code_hash,user_id,
          status,scope,resource,expires_at,next_poll_at) values ('{client}','{device_hash}','{user_hash}',
          '{user}','approved','mcp:all','https://wqn.example/api/mcp',now()+interval '10 minutes',now()-interval '1 second');""")
        first = subprocess.Popen(command, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                 stderr=subprocess.PIPE, text=True)
        first.stdin.write("begin;" + exchange(uuid.uuid4().hex * 2, uuid.uuid4().hex * 2) +
                          "select pg_sleep(0.4);commit;\n")
        first.stdin.close()
        # Reading the first result proves the transaction owns the row lock;
        # its deliberate hold lets the other process contend on that lock.
        issued = json.loads(first.stdout.readline())
        replay = json.loads(sql(exchange(uuid.uuid4().hex * 2, uuid.uuid4().hex * 2)))
        first.wait(timeout=10)
        assert first.returncode == 0, first.stderr.read()
        assert issued["scope"] == "mcp:all", issued
        assert replay["error"] == "invalid_grant", replay
        assert sql(f"select count(*) from public.oauth_tokens where client_id='{client}';") == "1"
        assert sql(f"select status from public.oauth_device_authorizations where client_id='{client}';") == "consumed"
        print("Concurrent device redemption passed: one issuance, one rejected replay, one token row.")
    finally:
        sql(f"delete from public.oauth_clients where client_id='{client}'; delete from auth.users where id='{user}';")


if __name__ == "__main__":
    main()
