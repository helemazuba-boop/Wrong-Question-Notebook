# WQN validation workflow

The persistent integration lane is `validation/note4`; current development is
`fix/robustness-20261029`. Follow [the shared Note4 validation workflow](docs/engineering/NOTE4_VALIDATION_WORKFLOW.md).

Keep local checkpoint commits distinct from CI, deployed backend, device HIL
and production acceptance. Record unrun checks; never infer deployment from
source or host tests. Fixes found during integration need an explicit backport
record for the development lane. Freeze every device-test artifact by firmware
and cloud commit, embedded version, configuration and BIN/ELF hashes.

Do not disclose dotenv values or credentials. Paid provider capabilities remain
server-authoritative and disabled unless explicitly opted in. A local merge
or commit does not authorize push, PR, deployment, migrations, flashing or repair
of user data. Run the repository commit hooks and relevant type/tests/format gates.
