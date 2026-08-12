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
    if (profileError || profile?.role !== 'admin') return res.status(403).json({ error: 'Apenas administradores podem remover produtos.' });

    const admin = createClient(url, serviceKey);
    const { data, error } = await sessionClient.rpc('delete_or_archive_product', { p_product_id: id });
    if (error) throw error;

    if (data?.action === 'deleted' && data.image_path) {
      const { error: imageError } = await admin.storage.from('product-images').remove([data.image_path]);
      if (imageError) console.warn('Não foi possível remover a foto do produto:', imageError.message);
    }

    return res.status(200).json(data || { action: 'deleted' });
  } catch (error) {
    return res.status(500).json({ error: error.message || 'Não foi possível remover o produto.' });
  }
}
