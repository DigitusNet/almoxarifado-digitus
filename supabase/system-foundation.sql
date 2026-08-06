-- Fundação do almoxarifado ISP Digitus Net.
-- Execute este arquivo inteiro no SQL Editor do Supabase.
-- Ele preserva os produtos e as movimentações que já existem.

-- 1. O estoque passa a aceitar frações, como metragem de cabo ou fibra.
alter table public.products
  alter column stock type numeric(12,3) using stock::numeric,
  alter column minimum_stock type numeric(12,3) using minimum_stock::numeric;

alter table public.movements
  alter column quantity type numeric(12,3) using quantity::numeric;

-- 2. Informações completas do catálogo.
alter table public.products
  add column if not exists description text,
  add column if not exists brand text,
  add column if not exists model text,
  add column if not exists unit_of_measure text not null default 'unidade'
    check (unit_of_measure in ('unidade', 'metro', 'par', 'caixa')),
  add column if not exists tracking_mode text not null default 'quantidade'
    check (tracking_mode in ('quantidade', 'serializado')),
  add column if not exists requires_ca boolean not null default false,
  add column if not exists ca_number text,
  add column if not exists ca_expiry_date date,
  add column if not exists average_cost numeric(12,2);

-- Classifica os registros antigos que já tenham uma categoria correspondente.
update public.products
set tracking_mode = 'serializado'
where lower(trim(category)) in ('equipamento', 'equipamentos', 'patrimônio', 'patrimonio', 'ferramenta', 'ferramentas')
  and tracking_mode = 'quantidade';

-- 3. Pessoas que recebem materiais, sem necessidade de terem login no sistema.
create table if not exists public.collaborators (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  cpf text,
  job_title text,
  department text,
  phone text,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists collaborators_cpf_unique
  on public.collaborators (cpf) where cpf is not null;

-- 4. Veículos que podem possuir estoque móvel.
create table if not exists public.vehicles (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  plate text,
  responsible_id uuid references public.collaborators(id) on delete set null,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists vehicles_plate_unique
  on public.vehicles (upper(plate)) where plate is not null;

-- 5. Locais físicos ou lógicos que podem possuir materiais.
create table if not exists public.stock_locations (
  id uuid primary key default gen_random_uuid(),
  name text not null unique,
  location_type text not null check (location_type in ('central', 'colaborador', 'veiculo', 'cliente', 'laboratorio', 'outro')),
  collaborator_id uuid references public.collaborators(id) on delete set null,
  vehicle_id uuid references public.vehicles(id) on delete set null,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (
    (location_type <> 'colaborador' or collaborator_id is not null)
    and (location_type <> 'veiculo' or vehicle_id is not null)
  )
);

insert into public.stock_locations (name, location_type)
values ('Almoxarifado Central', 'central')
on conflict (name) do nothing;

-- 6. Unidades rastreáveis: ONU, roteador, ferramenta, patrimônio etc.
create table if not exists public.serial_items (
  id uuid primary key default gen_random_uuid(),
  product_id uuid not null references public.products(id) on delete restrict,
  serial_number text,
  mac_address text,
  asset_tag text,
  status text not null default 'disponivel'
    check (status in ('disponivel', 'com_colaborador', 'com_veiculo', 'instalado_cliente', 'emprestado', 'aguardando_triagem', 'laboratorio', 'manutencao', 'defeito', 'baixado')),
  current_location_id uuid references public.stock_locations(id) on delete set null,
  customer_name text,
  customer_reference text,
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (serial_number is not null or mac_address is not null or asset_tag is not null)
);

create unique index if not exists serial_items_serial_unique
  on public.serial_items (lower(serial_number)) where serial_number is not null;
create unique index if not exists serial_items_mac_unique
  on public.serial_items (lower(mac_address)) where mac_address is not null;
create unique index if not exists serial_items_asset_tag_unique
  on public.serial_items (lower(asset_tag)) where asset_tag is not null;

-- 7. Atualização segura das funções atuais para movimentações fracionadas.
drop function if exists public.record_movement(uuid, public.movement_type, integer, text, text, text, text, boolean);

create or replace function public.record_movement(
  p_product_id uuid,
  p_type public.movement_type,
  p_quantity numeric,
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
  current_stock numeric;
  technician_stock numeric;
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

grant execute on function public.record_movement(uuid, public.movement_type, numeric, text, text, text, text, boolean) to authenticated;

create or replace function public.delete_movement(p_movement_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  movement public.movements;
  current_stock numeric;
  adjusted_stock numeric;
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

-- 8. Permissões para os cadastros-base.
alter table public.collaborators enable row level security;
alter table public.vehicles enable row level security;
alter table public.stock_locations enable row level security;
alter table public.serial_items enable row level security;

drop policy if exists "Authenticated users can view collaborators" on public.collaborators;
create policy "Authenticated users can view collaborators" on public.collaborators for select to authenticated using (true);
drop policy if exists "Admins and operators manage collaborators" on public.collaborators;
create policy "Admins and operators manage collaborators" on public.collaborators for all to authenticated using (public.current_user_role() in ('admin', 'operador')) with check (public.current_user_role() in ('admin', 'operador'));

drop policy if exists "Authenticated users can view vehicles" on public.vehicles;
create policy "Authenticated users can view vehicles" on public.vehicles for select to authenticated using (true);
drop policy if exists "Admins and operators manage vehicles" on public.vehicles;
create policy "Admins and operators manage vehicles" on public.vehicles for all to authenticated using (public.current_user_role() in ('admin', 'operador')) with check (public.current_user_role() in ('admin', 'operador'));

drop policy if exists "Authenticated users can view stock locations" on public.stock_locations;
create policy "Authenticated users can view stock locations" on public.stock_locations for select to authenticated using (true);
drop policy if exists "Admins and operators manage stock locations" on public.stock_locations;
create policy "Admins and operators manage stock locations" on public.stock_locations for all to authenticated using (public.current_user_role() in ('admin', 'operador')) with check (public.current_user_role() in ('admin', 'operador'));

drop policy if exists "Authenticated users can view serial items" on public.serial_items;
create policy "Authenticated users can view serial items" on public.serial_items for select to authenticated using (true);
drop policy if exists "Admins and operators manage serial items" on public.serial_items;
create policy "Admins and operators manage serial items" on public.serial_items for all to authenticated using (public.current_user_role() in ('admin', 'operador')) with check (public.current_user_role() in ('admin', 'operador'));
