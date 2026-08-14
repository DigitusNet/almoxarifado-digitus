import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const allowedRoles = new Set(['admin', 'operador', 'tecnico']);
const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
  'Content-Type': 'application/json; charset=utf-8',
};

function response(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: corsHeaders });
}

function error(message: string, status = 400) {
  return response({ error: message }, status);
}

function environmentKey(legacyName: string, collectionName: string) {
  const legacyKey = Deno.env.get(legacyName);
  if (legacyKey) return legacyKey;

  const rawKeys = Deno.env.get(collectionName);
  if (!rawKeys) return null;
  try {
    const keys = JSON.parse(rawKeys) as Record<string, string>;
    return keys.default || Object.values(keys)[0] || null;
  } catch {
    return null;
  }
}

function getConfig() {
  const url = Deno.env.get('SUPABASE_URL');
  const anonKey = environmentKey('SUPABASE_ANON_KEY', 'SUPABASE_PUBLISHABLE_KEYS');
  const serviceKey = environmentKey('SUPABASE_SERVICE_ROLE_KEY', 'SUPABASE_SECRET_KEYS');
  if (!url || !anonKey || !serviceKey) throw new Error('Configuração segura do Supabase ausente.');
  return { url, anonKey, serviceKey };
}

async function requireAdmin(request: Request) {
  const { url, anonKey } = getConfig();
  const token = request.headers.get('Authorization')?.replace(/^Bearer\s+/i, '');
  if (!token) throw { message: 'Sessão não encontrada.', status: 401 };

  const sessionClient = createClient(url, anonKey, {
    global: { headers: { Authorization: `Bearer ${token}` } },
  });
  const { data: { user }, error: userError } = await sessionClient.auth.getUser(token);
  if (userError || !user) throw { message: 'Sessão inválida. Entre novamente no sistema.', status: 401 };

  const { data: profile, error: profileError } = await sessionClient
    .from('profiles')
    .select('role')
    .eq('id', user.id)
    .single();
  if (profileError || profile?.role !== 'admin') {
    throw { message: 'Apenas administradores podem gerenciar usuários.', status: 403 };
  }

  return { user, sessionClient };
}

Deno.serve(async (request) => {
  if (request.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });

  try {
    const { user } = await requireAdmin(request);
    const { url, serviceKey } = getConfig();
    const admin = createClient(url, serviceKey);

    if (request.method === 'GET') {
      const [{ data: authData, error: authError }, { data: profiles, error: profileError }] = await Promise.all([
        admin.auth.admin.listUsers({ page: 1, perPage: 1000 }),
        admin.from('profiles').select('id, full_name, role'),
      ]);
      if (authError || profileError) throw authError || profileError;

      const profileById = new Map((profiles || []).map((profile) => [profile.id, profile]));
      return response({
        users: (authData.users || []).map((account) => ({
          id: account.id,
          email: account.email || '',
          name: profileById.get(account.id)?.full_name || '',
          role: profileById.get(account.id)?.role || 'tecnico',
          active: !account.banned_until,
        })),
      });
    }

    if (request.method === 'POST') {
      const { name, email, password, role } = await request.json();
      if (!name?.trim() || !email?.trim() || !password || !allowedRoles.has(role)) {
        return error('Preencha todos os campos corretamente.');
      }
      if (password.length < 8) return error('A senha precisa ter pelo menos 8 caracteres.');

      const { data, error: createError } = await admin.auth.admin.createUser({
        email: email.trim(),
        password,
        email_confirm: true,
      });
      if (createError || !data.user) return error(createError?.message || 'Não foi possível criar o usuário.');

      const { error: profileError } = await admin
        .from('profiles')
        .insert({ id: data.user.id, full_name: name.trim(), role });
      if (profileError) {
        await admin.auth.admin.deleteUser(data.user.id);
        throw profileError;
      }
      return response({ id: data.user.id }, 201);
    }

    if (request.method === 'DELETE') {
      let id = new URL(request.url).searchParams.get('id');
      if (!id) {
        try { id = (await request.json()).id || null; } catch { /* body is optional */ }
      }
      if (!id) return error('Usuário inválido.');
      if (id === user.id) return error('Você não pode remover a própria conta.');

      const { data: target, error: targetError } = await admin
        .from('profiles')
        .select('role')
        .eq('id', id)
        .single();
      if (targetError || !target) throw targetError || new Error('Usuário não encontrado.');
      if (target.role === 'admin') {
        const { count, error: countError } = await admin
          .from('profiles')
          .select('id', { count: 'exact', head: true })
          .eq('role', 'admin');
        if (countError) throw countError;
        if ((count || 0) <= 1) return error('O último administrador não pode ser removido.', 409);
      }

      const { error: deleteError } = await admin.auth.admin.deleteUser(id);
      if (deleteError) throw deleteError;
      return response({ deleted: true });
    }

    return error('Método não permitido.', 405);
  } catch (caught) {
    const known = caught as { message?: string; status?: number };
    return error(known.message || 'Não foi possível concluir a operação.', known.status || 500);
  }
});
