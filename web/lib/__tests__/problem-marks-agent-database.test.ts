import { beforeAll, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
const transport = vi.hoisted(() => ({ execute: vi.fn() }));
vi.mock('@/lib/supabase-utils', () => ({
  createServiceClient: () => ({ rpc: transport.execute }),
}));
import { POST } from '@/app/api/mcp/mark/route';
import { agentRpc, taskToken } from '@/lib/problem-marks/agent-service';

const db = process.env.WQN_AGENT_TEST_DB;
const container = process.env.WQN_AGENT_TEST_CONTAINER;
const literal = (value: string) => "'" + value.replaceAll("'", "''") + "'";
function sql(statement: string) {
  if (
    !db?.startsWith('wqn_agent_mark_validation_') ||
    !container?.startsWith('supabase_db_')
  )
    throw new Error('Disposable validation database required');
  return execFileSync(
    'docker',
    [
      'exec',
      container,
      'psql',
      '-U',
      'supabase_admin',
      '-d',
      db,
      '-v',
      'ON_ERROR_STOP=1',
      '-Atq',
      '-c',
      statement,
    ],
    { encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 }
  ).trim();
}
const secret = 'isolated-mark-smoke-credential-000000000000';
const problem = 'c2600000-0000-4000-8000-000000000001';
describe.skipIf(!db || !container)(
  'Actual marking MCP to PostgreSQL integration',
  () => {
    beforeAll(() => {
      vi.stubEnv('PROBLEM_MARKING_AGENT_SECRET', secret);
      const bundle = JSON.parse(
        readFileSync('agent-marking.bundle.json', 'utf8')
      );
      const lock = JSON.parse(
        readFileSync('knowledge-registry.lock.json', 'utf8')
      );
      const artifact = JSON.stringify(bundle.registry, null, 2) + '\n';
      sql(`select public.sync_knowledge_registry_revision('https://example.invalid/agent-integration',${literal(lock.source_sha)},1,${literal(lock.content_sha256)},${literal(artifact)});
      insert into auth.users(id,aud,role,email,encrypted_password,raw_app_meta_data,raw_user_meta_data,created_at,updated_at) values('a2600000-0000-4000-8000-000000000001','authenticated','authenticated','agent-integration@example.invalid','','{}','{}',now(),now());
      insert into public.subjects(id,user_id,name,color,icon,canonical_subject_key) values('b2600000-0000-4000-8000-000000000001','a2600000-0000-4000-8000-000000000001','物理','blue','Atom','physics');
      insert into public.problems(id,user_id,subject_id,title,content,assets,solution_assets,status,parts,source,is_optional) values('${problem}','a2600000-0000-4000-8000-000000000001','b2600000-0000-4000-8000-000000000001','Integration fixture','已知三个物理量，求第四个。','[]','[]','needs_review','[{"index":1,"type":"short_answer","content":"求第四个物理量"}]','{}',false);`);
      transport.execute.mockImplementation(
        async (
          name: string,
          args: { p_action: string; p_payload: unknown }
        ) => {
          expect(name).toBe('agent_mark_control_v1');
          return {
            data: JSON.parse(
              sql(
                `select public.agent_mark_control_v1(${literal(args.p_action)},${literal(JSON.stringify(args.p_payload))}::jsonb)`
              )
            ),
            error: null,
          };
        }
      );
    });
    it('validates real evidence, commits one receipt and replays without duplicating methods', async () => {
      const bundle = JSON.parse(
        readFileSync('agent-marking.bundle.json', 'utf8')
      );
      const lock = JSON.parse(
        readFileSync('knowledge-registry.lock.json', 'utf8')
      );
      const task = (await agentRpc('claim', {
        worker_id: 'integration',
        allow_new: true,
        registry_source_sha: lock.source_sha,
        registry_content_sha256: lock.content_sha256,
        bundle_sha256: lock.agent_marking.artifact_sha256,
        skill_version: bundle.skill_version,
      })) as { run_id: string };
      const auth = { run_id: task.run_id, task_token: taskToken(task.run_id) };
      const call = async (name: string, args: unknown) => {
        const response = await POST(
          new Request('http://wqn/api/mcp/mark', {
            method: 'POST',
            headers: { Authorization: `Bearer ${secret}` },
            body: JSON.stringify({
              jsonrpc: '2.0',
              id: 1,
              method: 'tools/call',
              params: { name, arguments: args },
            }),
          })
        );
        return (await response.json()).result;
      };
      const context = await call('get_mark_context', auth);
      expect(context.isError).toBe(false);
      expect(context.structuredContent.data.problem_id).toBe(problem);
      const doc = bundle.documents[0];
      const result = {
        assignments: [],
        methods: [
          {
            mark_key: doc.stable_key,
            part_index: 1,
            preference: 'recommended',
            evidence: {
              problem_field: 'parts.1.content',
              problem_quote: '求第四个物理量',
              document_key: doc.stable_key,
              section_id: doc.sections[0].id,
              document_quote: doc.sections[0].text.slice(0, 30),
              rationale:
                'Engineering fixture; educational correctness is evaluated separately.',
            },
          },
        ],
        unresolved: [],
      };
      const invalid = structuredClone(result);
      invalid.methods[0].evidence.document_quote = 'fabricated quotation';
      expect(
        (await call('submit_mark_result', { ...auth, result: invalid })).isError
      ).toBe(true);
      const accepted = await call('submit_mark_result', { ...auth, result });
      expect(accepted.isError).toBe(false);
      expect(accepted.structuredContent.data.accepted).toBe(true);
      expect(
        (await call('submit_mark_result', { ...auth, result }))
          .structuredContent.data
      ).toEqual(accepted.structuredContent.data);
      expect(
        (await call('get_mark_receipt', auth)).structuredContent.data.receipt
          .accepted
      ).toBe(true);
      expect(
        sql(
          `select count(*) from public.problem_mark_methods where problem_id='${problem}'`
        )
      ).toBe('1');
      expect(
        sql(
          `select objective_snapshot_hash is not null from public.problem_mark_annotation_runs where id='${task.run_id}'`
        )
      ).toBe('t');
    }, 30000);
  }
);
