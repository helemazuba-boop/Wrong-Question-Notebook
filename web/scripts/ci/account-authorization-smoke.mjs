// Real PostgREST checks against an owned, disposable CI Supabase stack.
import { readFile } from 'node:fs/promises';
import { createHmac } from 'node:crypto';

const status = JSON.parse(await readFile(process.argv[2], 'utf8'));
if (
  !['127.0.0.1', 'localhost', '[::1]'].includes(
    new URL(status.API_URL).hostname
  )
) {
  throw new Error('Authorization smoke tests require an isolated local stack');
}
function client(key, token = key) {
  return async (path, method = 'GET', body) => {
    const response = await fetch(`${status.API_URL}${path}`, {
      method,
      headers: {
        apikey: key,
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        Prefer: 'return=representation',
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const data = await response.json();
    return {
      data: response.ok ? data : null,
      error: response.ok ? null : data,
    };
  };
}
const service = client(status.SERVICE_ROLE_KEY);
const created = [];
function check(okay, message) {
  if (!okay) throw new Error(message);
  console.log(`PASS: ${message}`);
}
function session(user) {
  const header = Buffer.from(
    JSON.stringify({ alg: 'HS256', typ: 'JWT' })
  ).toString('base64url');
  const claims = Buffer.from(
    JSON.stringify({
      sub: user.id,
      email: user.email,
      role: 'authenticated',
      aud: 'authenticated',
      exp: Math.floor(Date.now() / 1000) + 3600,
    })
  ).toString('base64url');
  const signature = createHmac('sha256', status.JWT_SECRET)
    .update(`${header}.${claims}`)
    .digest('base64url');
  return client(status.ANON_KEY, `${header}.${claims}.${signature}`);
}
try {
  const { data, error } = await service('/auth/v1/admin/users', 'POST', {
    email: `audit-${Date.now()}@example.invalid`,
    email_confirm: true,
  });
  if (error) throw error;
  created.push(data.id);
  const user = session(data);
  const role = await user(`/rest/v1/user_profiles?id=eq.${data.id}`, 'PATCH', {
    user_role: 'super_admin',
  });
  check(
    role.error?.code === '42501',
    'direct PostgREST role escalation is denied'
  );
  const active = await user(
    `/rest/v1/user_profiles?id=eq.${data.id}`,
    'PATCH',
    { is_active: false }
  );
  check(
    active.error?.code === '42501',
    'direct PostgREST account status mutation is denied'
  );
  const edit = await user(
    `/rest/v1/user_profiles?id=eq.${data.id}&select=bio`,
    'PATCH',
    { bio: 'ordinary edit' }
  );
  check(
    !edit.error && edit.data?.[0]?.bio === 'ordinary edit',
    'ordinary profile editing remains usable'
  );
  const deactivate = await service(
    `/rest/v1/user_profiles?id=eq.${data.id}`,
    'PATCH',
    { is_active: false }
  );
  if (deactivate.error) throw deactivate.error;
  const rpc = await user('/rest/v1/rpc/get_subjects_with_metadata', 'POST', {});
  check(
    rpc.error?.code === '42501',
    'existing JWT cannot bypass disablement through a definer RPC'
  );
  const inactiveEdit = await user(
    `/rest/v1/user_profiles?id=eq.${data.id}&select=bio`,
    'PATCH',
    { bio: 'inactive edit' }
  );
  check(
    !inactiveEdit.error && inactiveEdit.data?.length === 0,
    'existing JWT cannot update its inactive profile'
  );
} finally {
  for (const id of created) {
    const { error } = await service(`/auth/v1/admin/users/${id}`, 'DELETE');
    if (error) throw error;
  }
}
