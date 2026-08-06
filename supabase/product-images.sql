-- Execute esta consulta uma única vez no Supabase: SQL Editor > New query > Run.
-- Cria o espaço seguro para as fotos opcionais dos produtos.

alter table public.products add column if not exists image_path text;

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('product-images', 'product-images', true, 5242880, array['image/jpeg', 'image/png', 'image/webp']::text[])
on conflict (id) do update
set public = true,
    file_size_limit = 5242880,
    allowed_mime_types = array['image/jpeg', 'image/png', 'image/webp']::text[];

drop policy if exists "Authenticated users can view product images" on storage.objects;
create policy "Authenticated users can view product images"
on storage.objects for select to authenticated
using (bucket_id = 'product-images');

drop policy if exists "Admins and operators can upload product images" on storage.objects;
create policy "Admins and operators can upload product images"
on storage.objects for insert to authenticated
with check (bucket_id = 'product-images' and public.current_user_role() in ('admin', 'operador'));

drop policy if exists "Admins and operators can delete product images" on storage.objects;
create policy "Admins and operators can delete product images"
on storage.objects for delete to authenticated
using (bucket_id = 'product-images' and public.current_user_role() in ('admin', 'operador'));
