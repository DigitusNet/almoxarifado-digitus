-- Almoxarifado Digitus Net: execute este arquivo no SQL Editor do Supabase.
-- O script pode ser executado uma única vez em um projeto novo.

do $$ begin
  create type public.user_role as enum ('admin', 'operador', 'tecnico');
exception when duplicate_object then null;
end $$;

do $$ begin
  create type public.movement_type as enum ('entrada', 'saida');
exception when duplicate_object then null;
end $$;

create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  full_name text not null default '',
  role public.user_role not null default 'tecnico',
  created_at timestamptz not null default now()
);

create table if not exists public.products (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  code text not null unique,
  category text not null,
  image_path text,
  stock integer not null default 0 check (stock >= 0),
  minimum_stock integer not null default 0 check (minimum_stock >= 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.movements (
  id uuid primary key default gen_random_uuid(),
  product_id uuid not null references public.products(id) on delete restrict,
  movement_type public.movement_type not null,
  quantity integer not null check (quantity > 0),
  recipient text not null,
  note text,
  holder_type text not null default 'cliente' check (holder_type in ('tecnico', 'veiculo', 'cliente', 'outro')),
  work_order text,
  field_usage boolean not null default false,
  created_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now()
);

alter table public.profiles enable row level security;
alter table public.products enable row level security;
alter table public.movements enable row level security;

create or replace function public.current_user_role()
returns public.user_role
language sql
stable
security definer
set search_path = public
as $$ select role from public.profiles where id = auth.uid() $$;

drop policy if exists "Authenticated users can view profiles" on public.profiles;
create policy "Authenticated users can view profiles" on public.profiles
  for select to authenticated using (true);
drop policy if exists "Users can update their own profile name" on public.profiles;
create policy "Users can update their own profile name" on public.profiles
  for update to authenticated using (id = auth.uid()) with check (id = auth.uid());
drop policy if exists "Authenticated users can view products" on public.products;
create policy "Authenticated users can view products" on public.products
  for select to authenticated using (true);
drop policy if exists "Admins and operators can add products" on public.products;
create policy "Admins and operators can add products" on public.products
  for insert to authenticated with check (public.current_user_role() in ('admin', 'operador'));
drop policy if exists "Admins and operators can edit products" on public.products;
create policy "Admins and operators can edit products" on public.products
  for update to authenticated using (public.current_user_role() in ('admin', 'operador')) with check (public.current_user_role() in ('admin', 'operador'));
drop policy if exists "Admins can delete products" on public.products;
create policy "Admins can delete products" on public.products
  for delete to authenticated using (public.current_user_role() = 'admin');
drop policy if exists "Authenticated users can view movements" on public.movements;
create policy "Authenticated users can view movements" on public.movements
  for select to authenticated using (true);

create or replace function public.record_movement(
  p_product_id uuid,
  p_type public.movement_type,
  p_quantity integer,
  p_recipient text,
  p_note text default null,
  p_holder_type text default 'cliente',
  p_work_order text default null,
  p_field_usage boolean default false
) returns public.movements
language plpgsql
security definer
set search_path = public
as $$
declare
  movement public.movements;
  current_stock integer;
  technician_stock integer;
begin
  if auth.uid() is null then raise exception 'Usuário não autenticado'; end if;
  if p_quantity <= 0 then raise exception 'A quantidade deve ser maior que zero'; end if;
  if p_holder_type not in ('tecnico', 'veiculo', 'cliente', 'outro') then raise exception 'Destino inválido'; end if;
  if p_field_usage and (p_type <> 'saida' or p_holder_type <> 'tecnico') then raise exception 'Uso em OS deve ser uma saída registrada para um técnico'; end if;
  if p_field_usage and nullif(trim(coalesce(p_work_order, '')), '') is null then raise exception 'Informe o número da OS'; end if;
  select stock into current_stock from public.products where id = p_product_id for update;
  if not found then raise exception 'Produto não encontrado'; end if;
  if p_field_usage then
    select coalesce(sum(case when coalesce(field_usage, false) then -quantity when movement_type = 'saida' then quantity else -quantity end), 0)
    into technician_stock
    from public.movements
    where product_id = p_product_id and holder_type = 'tecnico' and lower(trim(recipient)) = lower(trim(p_recipient));
    if technician_stock < p_quantity then raise exception 'Saldo insuficiente com este técnico. Disponível: % unidade(s)', technician_stock; end if;
  else
    if p_type = 'saida' and current_stock < p_quantity then raise exception 'Estoque insuficiente'; end if;
    update public.products
    set stock = stock + case when p_type = 'entrada' then p_quantity else -p_quantity end,
        updated_at = now()
    where id = p_product_id;
  end if;

  insert into public.movements (product_id, movement_type, quantity, recipient, note, holder_type, work_order, field_usage, created_by)
  values (p_product_id, p_type, p_quantity, p_recipient, p_note, p_holder_type, nullif(trim(p_work_order), ''), p_field_usage, auth.uid())
  returning * into movement;
  return movement;
end;
$$;

grant execute on function public.record_movement(uuid, public.movement_type, integer, text, text, text, text, boolean) to authenticated;

create or replace function public.delete_movement(p_movement_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  movement public.movements;
  current_stock integer;
  adjusted_stock integer;
begin
  if auth.uid() is null or coalesce(public.current_user_role()::text, '') <> 'admin' then
    raise exception 'Apenas administradores podem apagar movimentações';
  end if;

  select * into movement from public.movements where id = p_movement_id for update;
  if not found then raise exception 'Movimentação não encontrada'; end if;

  if coalesce(movement.field_usage, false) then
    delete from public.movements where id = p_movement_id;
    return;
  end if;

  select stock into current_stock from public.products where id = movement.product_id for update;
  if not found then raise exception 'Produto não encontrado'; end if;

  adjusted_stock := current_stock + case when movement.movement_type = 'saida' then movement.quantity else -movement.quantity end;
  if adjusted_stock < 0 then raise exception 'Não é possível apagar esta entrada porque o estoque atual ficaria negativo'; end if;

  update public.products set stock = adjusted_stock, updated_at = now() where id = movement.product_id;
  delete from public.movements where id = p_movement_id;
end;
$$;

grant execute on function public.delete_movement(uuid) to authenticated;

-- Após criar seu primeiro usuário pelo menu Authentication > Users,
-- substitua o e-mail abaixo pelo e-mail do administrador e execute esta linha:
-- insert into public.profiles (id, full_name, role)
-- select id, 'Administrador Digitus', 'admin' from auth.users where email = 'admin@empresa.com';
