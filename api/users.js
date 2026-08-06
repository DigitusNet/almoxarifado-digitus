import { createClient } from '@supabase/supabase-js';

const allowedRoles = new Set(['admin', 'operador', 'tecnico']);

function config() {
  const url = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const publicKey = process.env.SUPABASE_PUBLISHABLE_KEY || process.env.VITE_SUPABASE_PUBLISHABLE_KEY;
  if (!url || !serviceKey || !publicKey) throw new Error('Configuração segura do Supabase ausente.');
  return { url, serviceKey, publicKey };
}

export default async function handler(req, res) {
  try {
    const { url, serviceKey, publicKey } = config();
    const token = req.headers.authorization?.replace(/^Bearer\s+/i, '');
    if (!token) return res.status(401).json({ error: 'Sessão não encontrada.' });

    const sessionClient = createClient(url, publicKey, { global: { headers: { Authorization: `Bearer ${token}` } } });
    const { data: { user }, error: sessionError } = await sessionClient.auth.getUser(token);
    if (sessionError || !user) return res.status(401).json({ error: 'Sessão inválida.' });

    const { data: requester, error: requesterError } = await sessionClient.from('profiles').select('role').eq('id', user.id).single();
    if (requesterError || requester?.role !== 'admin') return res.status(403).json({ error: 'Apenas administradores podem gerenciar usuários.' });
    const admin = createClient(url, serviceKey);

    if (req.method === 'GET') {
      const [{ data: authData, error: authError }, { data: profiles, error: profileError }] = await Promise.all([
        admin.auth.admin.listUsers({ page: 1, perPage: 1000 }),
        admin.from('profiles').select('id, full_name, role')
      ]);
      if (authError || profileError) throw authError || profileError;
      const profileById = new Map(profiles.map(profile => [profile.id, profile]));
      return res.status(200).json(authData.users.map(account => ({
        id: account.id,
        email: account.email,
        name: profileById.get(account.id)?.full_name || '',
        role: profileById.get(account.id)?.role || 'tecnico',
        active: !account.banned_until
      })));
    }

    if (req.method === 'POST') {
      const { name, email, password, role } = req.body || {};
      if (!name?.trim() || !email?.trim() || !password || !allowedRoles.has(role)) return res.status(400).json({ error: 'Preencha todos os campos corretamente.' });
      if (password.length < 8) return res.status(400).json({ error: 'A senha precisa ter pelo menos 8 caracteres.' });
      const { data, error } = await admin.auth.admin.createUser({ email: email.trim(), password, email_confirm: true });
      if (error) return res.status(400).json({ error: error.message });
      const { error: profileError } = await admin.from('profiles').insert({ id: data.user.id, full_name: name.trim(), role });
      if (profileError) {
        await admin.auth.admin.deleteUser(data.user.id);
        throw profileError;
      }
      return res.status(201).json({ id: data.user.id });
    }

    if (req.method === 'DELETE') {
      const id = req.query.id;
      if (!id) return res.status(400).json({ error: 'Usuário inválido.' });
      if (id === user.id) return res.status(400).json({ error: 'Você não pode remover a própria conta.' });

      const { data: target, error: targetError } = await admin.from('profiles').select('role').eq('id', id).single();
      if (targetError) throw targetError;
      if (target.role === 'admin') {
        const { count, error: countError } = await admin.from('profiles').select('id', { count: 'exact', head: true }).eq('role', 'admin');
        if (countError) throw countError;
        if (count <= 1) return res.status(409).json({ error: 'O último administrador não pode ser removido.' });
      }
      const { error } = await admin.auth.admin.deleteUser(id);
      if (error) throw error;
      return res.status(204).end();
    }

    res.setHeader('Allow', 'GET, POST, DELETE');
    return res.status(405).json({ error: 'Método não permitido.' });
  } catch (error) {
    return res.status(500).json({ error: error.message || 'Não foi possível concluir a operação.' });
  }
}
