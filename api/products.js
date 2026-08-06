import { createClient } from '@supabase/supabase-js';

export default async function handler(req, res) {
  if (req.method !== 'DELETE') {
    res.setHeader('Allow', 'DELETE');
    return res.status(405).json({ error: 'Método não permitido.' });
  }
  try {
    const url = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL;
    const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
    const publicKey = process.env.SUPABASE_PUBLISHABLE_KEY || process.env.VITE_SUPABASE_PUBLISHABLE_KEY;
    const token = req.headers.authorization?.replace(/^Bearer\s+/i, '');
    const id = req.query.id;
    if (!url || !serviceKey || !publicKey) throw new Error('Configuração segura do Supabase ausente.');
    if (!token || !id) return res.status(400).json({ error: 'Dados inválidos.' });

    const sessionClient = createClient(url, publicKey, { global: { headers: { Authorization: `Bearer ${token}` } } });
    const { data: { user }, error: sessionError } = await sessionClient.auth.getUser(token);
    if (sessionError || !user) return res.status(401).json({ error: 'Sessão inválida.' });

    const { data: profile, error: profileError } = await sessionClient.from('profiles').select('role').eq('id', user.id).single();
    if (profileError || profile?.role !== 'admin') return res.status(403).json({ error: 'Apenas administradores podem apagar produtos.' });
    const admin = createClient(url, serviceKey);

    const { count, error: countError } = await admin.from('movements').select('id', { count: 'exact', head: true }).eq('product_id', id);
    if (countError) throw countError;
    if (count > 0) return res.status(409).json({ error: 'Este produto possui movimentações registradas e não pode ser apagado.' });

    const { error: deleteError } = await admin.from('products').delete().eq('id', id);
    if (deleteError) throw deleteError;
    return res.status(204).end();
  } catch (error) {
    return res.status(500).json({ error: error.message || 'Não foi possível apagar o produto.' });
  }
}
