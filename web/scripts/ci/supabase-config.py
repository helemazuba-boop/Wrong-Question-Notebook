#!/usr/bin/env python3
"""Create and identify an owned local CI stack; never touch developer stacks."""
import argparse
import contextlib
import json
import pathlib
import re
import socket
import tomllib
import uuid

PORTS = {
    'api': 'port', 'db': 'port', 'db.pooler': 'port', 'studio': 'port',
    'inbucket': 'port', 'edge_runtime': 'inspector_port', 'analytics': 'port',
}


def free_ports(count):
    # Keep every socket open while allocating so the kernel cannot reuse a port.
    with contextlib.ExitStack() as stack:
        sockets = [stack.enter_context(socket.socket()) for _ in range(count)]
        for sock in sockets:
            sock.bind(('0.0.0.0', 0))
        return [sock.getsockname()[1] for sock in sockets]


def prepare(source, workdir):
    config = workdir / 'supabase/config.toml'
    if config.exists() or (workdir / 'ownership.json').exists():
        raise ValueError(f'Refusing to overwrite an existing CI stack: {workdir}')
    project = f'wqn-ci-{uuid.uuid4().hex[:16]}'
    text = source.read_text()
    text = re.sub(r'^project_id = .*$', f'project_id = "{project}"', text, flags=re.M)
    ports = iter(free_ports(len(PORTS) + 1))
    section = ''
    lines = []
    for line in text.splitlines():
        if line.startswith('['):
            section = line.strip('[]')
        key = line.split('=', 1)[0].strip()
        if PORTS.get(section) == key or (section == 'db' and key == 'shadow_port'):
            line = f'{key} = {next(ports)}'
        elif section == 'db.seed' and key == 'enabled':
            line = 'enabled = false'
        lines.append(line)
    text = '\n'.join(lines) + '\n'
    tomllib.loads(text)  # Reject invalid output before writing anything.
    config.parent.mkdir(parents=True, exist_ok=True)
    with config.open('x') as handle:
        handle.write(text)
    with (workdir / 'ownership.json').open('x') as handle:
        json.dump({'project_id': project}, handle)


def owned_project(workdir):
    config = tomllib.loads((workdir / 'supabase/config.toml').read_text())
    owner = json.loads((workdir / 'ownership.json').read_text())
    project = config['project_id']
    if not re.fullmatch(r'wqn-ci-[0-9a-f]{16}', project) or owner['project_id'] != project:
        raise ValueError('Refusing to operate on an unowned Supabase stack')
    return project, config


def preflight(workdir):
    _, config = owned_project(workdir)
    with contextlib.ExitStack() as stack:
        for section, key in [*PORTS.items(), ('db', 'shadow_port')]:
            value = config
            for part in section.split('.'):
                value = value[part]
            port = value[key]
            sock = stack.enter_context(socket.socket())
            try:
                sock.bind(('0.0.0.0', port))
            except OSError as error:
                raise ValueError(f'CI Supabase port {port} ({section}.{key}) is occupied; '
                                 'prepare a fresh stack directory') from error


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('action', choices=['prepare', 'preflight', 'project'])
    parser.add_argument('workdir', type=pathlib.Path)
    parser.add_argument('--source', type=pathlib.Path)
    args = parser.parse_args()
    try:
        if args.action == 'prepare':
            prepare(args.source, args.workdir)
        elif args.action == 'preflight':
            preflight(args.workdir)
        else:
            print(owned_project(args.workdir)[0])
    except (OSError, ValueError, KeyError) as error:
        parser.exit(1, f'{error}\n')
