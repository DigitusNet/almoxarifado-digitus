-- Inventário rotativo do almoxarifado.
-- Execute este arquivo inteiro no SQL Editor do Supabase.
-- O inventário é administrativo e registra todo ajuste no histórico de movimentações.

create table if not exists public.inventory_sessions (
  id uuid primary key default gen_random_uuid(),
  title text not null,
  category text,
  status text not null default 'aberto' check (status in ('aberto', 'finalizado')),
  started_by uuid references public.profiles(id) on delete set null,
  started_at timestamptz not null default now(),
  closed_by uuid references public.profiles(id) on delete set null,
  closed_at timestamptz,
  final_note text
);

create unique index if not exists inventory_one_open_session
  on public.inventory_sessions (status)
  where status = 'aberto';

create table if not exists public.inventory_counts (
  id uuid primary key default gen_random_uuid(),
  inventory_id uuid not null references public.inventory_sessions(id) on delete restrict,
  product_id uuid not null references public.products(id) on delete restrict,
  product_name text not null,
  product_code text not null,
  unit_of_measure text not null default 'unidade',
  expected_stock numeric(12,3) not null check (expected_stock >= 0),
  counted_stock numeric(12,3) check (counted_stock >= 0),
  note text,
  counted_at timestamptz,
  adjustment_applied boolean not null default false,
  created_at timestamptz not null default now(),
  unique (inventory_id, product_id)
);

alter table public.inventory_sessions enable row level security;
alter table public.inventory_counts enable row level security;

drop policy if exists "Authenticated users can view inventory sessions" on public.inventory_sessions;
create policy "Authenticated users can view inventory sessions"
  on public.inventory_sessions for select to authenticated using (true);

drop policy if exists "Authenticated users can view inventory counts" on public.inventory_counts;
create policy "Authenticated users can view inventory counts"
  on public.inventory_counts for select to authenticated using (true);

create or replace function public.start_inventory(
  p_title text,
  p_category text default null
) returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  session_id uuid;
  count_total integer;
begin
  if auth.uid() is null or coalesce(public.current_user_role()::text, '') not in ('admin', 'operador') then
    raise exception 'Apenas administradores e operadores podem iniciar uma conferência';
  end if;

  if nullif(trim(coalesce(p_title, '')), '') is null then
    raise exception 'Informe um nome para o inventário';
  end if;

  if exists (select 1 from public.inventory_sessions where status = 'aberto') then
    raise exception 'Já existe um inventário em aberto. Finalize-o antes de iniciar outro.';
  end if;

  insert into public.inventory_sessions (title, category, started_by)
  values (trim(p_title), nullif(trim(p_category), ''), auth.uid())
  returning id into session_id;

  insert into public.inventory_counts (
    inventory_id, product_id, product_name, product_code, unit_of_measure, expected_stock
  )
  select
    session_id, id, name, code, unit_of_measure, stock
  from public.products
  where nullif(trim(p_category), '') is null or category = trim(p_category);

  get diagnostics count_total = row_count;
  if count_total = 0 then
    raise exception 'Não há itens para conferir neste filtro';
  end if;

  return session_id;
end;
$$;

grant execute on function public.start_inventory(text, text) to authenticated;

create or replace function public.save_inventory_counts(
  p_inventory_id uuid,
  p_counts jsonb
) returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  item jsonb;
  product_uuid uuid;
  actual_stock numeric(12,3);
  item_note text;
begin
  if auth.uid() is null or coalesce(public.current_user_role()::text, '') not in ('admin', 'operador') then
    raise exception 'Apenas administradores e operadores podem registrar a contagem';
  end if;

  if not exists (
    select 1 from public.inventory_sessions where id = p_inventory_id and status = 'aberto'
  ) then
    raise exception 'Este inventário não está aberto';
  end if;

  if jsonb_typeof(p_counts) <> 'array' then
    raise exception 'Contagens inválidas';
  end if;

  for item in select value from jsonb_array_elements(p_counts)
  loop
    product_uuid := (item ->> 'product_id')::uuid;
    actual_stock := (item ->> 'counted_stock')::numeric;
    item_note := nullif(trim(item ->> 'note'), '');

    if actual_stock < 0 then
      raise exception 'A quantidade contada não pode ser negativa';
    end if;

    update public.inventory_counts
    set counted_stock = actual_stock,
        note = item_note,
        counted_at = now()
    where inventory_id = p_inventory_id
      and product_id = product_uuid;

    if not found then
      raise exception 'Um dos itens não pertence a este inventário';
    end if;
  end loop;
end;
$$;

grant execute on function public.save_inventory_counts(uuid, jsonb) to authenticated;

create or replace function public.finish_inventory(
  p_inventory_id uuid,
  p_final_note text
) returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  inventory public.inventory_sessions;
  item public.inventory_counts;
  current_stock numeric(12,3);
  adjustment numeric(12,3);
begin
  if auth.uid() is null or coalesce(public.current_user_role()::text, '') not in ('admin', 'operador') then
    raise exception 'Apenas administradores e operadores podem finalizar uma conferência';
  end if;

  select * into inventory
  from public.inventory_sessions
  where id = p_inventory_id and status = 'aberto'
  for update;

  if not found then
    raise exception 'Inventário não encontrado ou já finalizado';
  end if;

  if exists (
    select 1 from public.inventory_counts
    where inventory_id = p_inventory_id and counted_stock is null
  ) then
    raise exception 'Informe a quantidade física de todos os itens antes de finalizar';
  end if;

  for item in
    select * from public.inventory_counts
    where inventory_id = p_inventory_id
    order by product_name
    for update
  loop
    select stock into current_stock from public.products where id = item.product_id for update;
    if not found then
      raise exception 'O item % não existe mais no catálogo', item.product_name;
    end if;

    adjustment := item.counted_stock - current_stock;

    if adjustment <> 0 then
      update public.products
      set stock = item.counted_stock,
          updated_at = now()
      where id = item.product_id;

      insert into public.movements (
        product_id, movement_type, quantity, recipient, note, holder_type, field_usage, created_by
      ) values (
        item.product_id,
        case when adjustment > 0 then 'entrada'::public.movement_type else 'saida'::public.movement_type end,
        abs(adjustment),
        'Inventário: ' || inventory.title,
        'Ajuste de inventário. ' || coalesce(nullif(trim(p_final_note), ''), 'Contagem física confirmada.'),
        'outro',
        false,
        auth.uid()
      );
    end if;

    update public.inventory_counts
    set adjustment_applied = true
    where id = item.id;
  end loop;

  update public.inventory_sessions
  set status = 'finalizado',
      closed_by = auth.uid(),
      closed_at = now(),
      final_note = nullif(trim(p_final_note), '')
  where id = p_inventory_id;
end;
$$;

grant execute on function public.finish_inventory(uuid, text) to authenticated;
