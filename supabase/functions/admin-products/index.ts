import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'DELETE, OPTIONS',
  'Content-Type': 'application/json; charset=utf-8',
};

function response(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: corsHeaders });
}

function getConfig() {
  const url = Deno.env.get('SUPABASE_URL');
  const anonKey = Deno.env.get('SUPABASE_ANON_KEY') || Deno.env.get('SUPABASE_PUBLISHABLE_KEY');
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  if (!url || !anonKey || !serviceKey) throw new Error('Configuração segura do Supabase ausente.');
  return { url, anonKey, serviceKey };
}

Deno.serve(async (request) => {
  if (request.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  if (request.method !== 'DELETE') return response({ error: 'Método não permitido.' }, 405);

  try {
    const { url, anonKey, serviceKey } = getConfig();
    const token = request.headers.get('Authorization')?.replace(/^Bearer\s+/i, '');
    let id = new URL(request.url).searchParams.get('id');
    if (!id) {
      try { id = (await request.json()).id || null; } catch { /* body is optional */ }
    }
    if (!token || !id) return response({ error: 'Dados inválidos.' }, 400);

    const sessionClient = createClient(url, anonKey, {
      global: { headers: { Authorization: `Bearer ${token}` } },
    });
    const { data: { user }, error: userError } = await sessionClient.auth.getUser(token);
    if (userError || !user) return response({ error: 'Sessão inválida. Entre novamente no sistema.' }, 401);

    const { data: profile, error: profileError } = await sessionClient
      .from('profiles')
      .select('role')
      .eq('id', user.id)
      .single();
    if (profileError || profile?.role !== 'admin') {
      return response({ error: 'Apenas administradores podem remover produtos.' }, 403);
    }

    const { data, error: archiveError } = await sessionClient
      .rpc('delete_or_archive_product', { p_product_id: id });
    if (archiveError) throw archiveError;

    if (data?.action === 'deleted' && data.image_path) {
      const admin = createClient(url, serviceKey);
      const { error: imageError } = await admin.storage.from('product-images').remove([data.image_path]);
      if (imageError) console.warn('Não foi possível remover a foto do produto:', imageError.message);
    }

    return response(data || { action: 'deleted' });
  } catch (caught) {
    const message = caught instanceof Error ? caught.message : 'Não foi possível remover o produto.';
    return response({ error: message }, 500);
  }
});
