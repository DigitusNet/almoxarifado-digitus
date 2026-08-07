-- Fotos opcionais dos produtos.
-- Execute este arquivo inteiro no SQL Editor do Supabase.

alter table public.products
  add column if not exists image_path text;

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'product-images',
  'product-images',
  true,
  5242880,
  array['image/jpeg', 'image/png', 'image/webp']
)
on conflict (id) do update
set public = excluded.public,
    file_size_limit = excluded.file_size_limit,
    allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists "Anyone can view product images" on storage.objects;
create policy "Anyone can view product images"
  on storage.objects for select
  using (bucket_id = 'product-images');

drop policy if exists "Managers can upload product images" on storage.objects;
create policy "Managers can upload product images"
  on storage.objects for insert to authenticated
  with check (
    bucket_id = 'product-images'
    and public.current_user_role() in ('admin', 'operador')
  );

drop policy if exists "Managers can delete product images" on storage.objects;
create policy "Managers can delete product images"
  on storage.objects for delete to authenticated
  using (
    bucket_id = 'product-images'
    and public.current_user_role() in ('admin', 'operador')
  );
