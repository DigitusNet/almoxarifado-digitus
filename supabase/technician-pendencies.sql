-- Pendências de materiais retirados por técnicos.
-- Execute este arquivo uma única vez no SQL Editor do Supabase.

create table if not exists public.technician_pendencies (
  id uuid primary key default gen_random_uuid(),
  movement_id uuid not null unique references public.movements(id) on delete restrict,
  product_id uuid not null references public.products(id) on delete restrict,
  quantity numeric not null check (quantity > 0),
  technician_name text not null,
  withdrawn_at timestamptz not null,
  due_at timestamptz not null,
  work_order text,
  mac_address text,
  serial_number text,
  asset_tag text,
  note text,
  resolution text not null default 'aberta' check (resolution in ('aberta','utilizado','devolvido')),
  finalized_at timestamptz,
  created_by uuid not null references auth.users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.technician_pending_events (
  id uuid primary key default gen_random_uuid(),
  pending_id uuid not null references public.technician_pendencies(id) on delete cascade,
  event_type text not null check (event_type in ('retirada','transferencia','prorrogacao','devolucao','utilizacao')),
  from_technician text,
  to_technician text,
  previous_due_at timestamptz,
  new_due_at timestamptz,
  note text,
  created_by uuid not null references auth.users(id),
  created_at timestamptz not null default now()
);

create index if not exists technician_pendencies_open_due_idx on public.technician_pendencies (resolution, due_at);
create index if not exists technician_pending_events_pending_idx on public.technician_pending_events (pending_id, created_at);

alter table public.technician_pendencies enable row level security;
alter table public.technician_pending_events enable row level security;
drop policy if exists "Authenticated users view technician pendencies" on public.technician_pendencies;
create policy "Authenticated users view technician pendencies" on public.technician_pendencies for select to authenticated using (true);
drop policy if exists "Authenticated users view technician pending events" on public.technician_pending_events;
create policy "Authenticated users view technician pending events" on public.technician_pending_events for select to authenticated using (true);

create or replace function public.record_timed_technician_movement(
  p_product_id uuid,
  p_quantity numeric,
  p_technician text,
  p_withdrawn_at timestamptz,
  p_due_at timestamptz,
  p_work_order text default null,
  p_note text default null,
  p_mac_address text default null,
  p_serial_number text default null,
  p_asset_tag text default null
) returns public.technician_pendencies
language plpgsql security definer set search_path = public as $$
declare
  current_stock numeric;
  saved_movement public.movements;
  saved_pending public.technician_pendencies;
begin
  if auth.uid() is null or coalesce(public.current_user_role()::text, '') not in ('admin', 'operador') then
    raise exception 'Apenas administradores e operadores podem registrar retiradas';
  end if;
  if p_quantity <= 0 then raise exception 'A quantidade deve ser maior que zero'; end if;
  if nullif(trim(coalesce(p_technician,'')), '') is null then raise exception 'Informe o técnico responsável'; end if;
  if p_due_at <= p_withdrawn_at then raise exception 'O prazo limite deve ser posterior à retirada'; end if;

  select stock into current_stock from public.products where id = p_product_id for update;
  if not found then raise exception 'Produto não encontrado'; end if;
  if current_stock < p_quantity then raise exception 'Estoque insuficiente'; end if;

  update public.products set stock = stock - p_quantity, updated_at = now() where id = p_product_id;
  insert into public.movements (product_id, movement_type, quantity, recipient, note, holder_type, work_order, field_usage, stock_impact, stock_before, stock_after, created_by, created_at)
  values (p_product_id, 'saida', p_quantity, trim(p_technician), nullif(trim(coalesce(p_note,'')),''), 'tecnico', nullif(trim(coalesce(p_work_order,'')),''), false, -p_quantity, current_stock, current_stock-p_quantity, auth.uid(), p_withdrawn_at)
  returning * into saved_movement;

  insert into public.technician_pendencies (movement_id, product_id, quantity, technician_name, withdrawn_at, due_at, work_order, mac_address, serial_number, asset_tag, note, created_by)
  values (saved_movement.id, p_product_id, p_quantity, trim(p_technician), p_withdrawn_at, p_due_at, nullif(trim(coalesce(p_work_order,'')),''), nullif(trim(coalesce(p_mac_address,'')),''), nullif(trim(coalesce(p_serial_number,'')),''), nullif(trim(coalesce(p_asset_tag,'')),''), nullif(trim(coalesce(p_note,'')),''), auth.uid())
  returning * into saved_pending;

  insert into public.technician_pending_events (pending_id,event_type,to_technician,new_due_at,note,created_by)
  values (saved_pending.id,'retirada',saved_pending.technician_name,saved_pending.due_at,saved_pending.note,auth.uid());
  return saved_pending;
end $$;

create or replace function public.resolve_technician_pending(
  p_pending_id uuid,
  p_action text,
  p_technician text default null,
  p_due_at timestamptz default null,
  p_note text default null
) returns public.technician_pendencies
language plpgsql security definer set search_path = public as $$
declare
  pending public.technician_pendencies;
  old_technician text;
  old_due timestamptz;
  return_stock numeric;
begin
  if auth.uid() is null or coalesce(public.current_user_role()::text, '') not in ('admin', 'operador') then
    raise exception 'Apenas administradores e operadores podem resolver pendências';
  end if;
  select * into pending from public.technician_pendencies where id=p_pending_id for update;
  if not found then raise exception 'Pendência não encontrada'; end if;
  if pending.resolution <> 'aberta' then raise exception 'Esta pendência já foi finalizada'; end if;
  old_technician := pending.technician_name; old_due := pending.due_at;

  if p_action = 'utilizado' then
    update public.technician_pendencies set resolution='utilizado', finalized_at=now(), updated_at=now(), note=coalesce(nullif(trim(coalesce(p_note,'')),''),note) where id=p_pending_id returning * into pending;
    insert into public.technician_pending_events(pending_id,event_type,from_technician,note,created_by) values(p_pending_id,'utilizacao',old_technician,p_note,auth.uid());
  elsif p_action = 'devolvido' then
    select stock into return_stock from public.products where id=pending.product_id for update;
    if not found then raise exception 'Produto não encontrado'; end if;
    update public.products set stock=return_stock+pending.quantity,updated_at=now() where id=pending.product_id;
    insert into public.movements(product_id,movement_type,quantity,recipient,note,holder_type,field_usage,stock_impact,stock_before,stock_after,created_by) values(pending.product_id,'entrada',pending.quantity,old_technician,coalesce(nullif(trim(coalesce(p_note,'')),''),'Devolução de pendência de técnico'),'tecnico',false,pending.quantity,return_stock,return_stock+pending.quantity,auth.uid());
    update public.technician_pendencies set resolution='devolvido',finalized_at=now(),updated_at=now(),note=coalesce(nullif(trim(coalesce(p_note,'')),''),note) where id=p_pending_id returning * into pending;
    insert into public.technician_pending_events(pending_id,event_type,from_technician,note,created_by) values(p_pending_id,'devolucao',old_technician,p_note,auth.uid());
  elsif p_action = 'transferir' then
    if nullif(trim(coalesce(p_technician,'')),'') is null or p_due_at is null then raise exception 'Informe o novo técnico e o prazo'; end if;
    if p_due_at <= now() then raise exception 'O novo prazo deve estar no futuro'; end if;
    update public.technician_pendencies set technician_name=trim(p_technician),due_at=p_due_at,updated_at=now() where id=p_pending_id returning * into pending;
    insert into public.technician_pending_events(pending_id,event_type,from_technician,to_technician,previous_due_at,new_due_at,note,created_by) values(p_pending_id,'transferencia',old_technician,pending.technician_name,old_due,pending.due_at,p_note,auth.uid());
  elsif p_action = 'prorrogar' then
    if p_due_at is null then raise exception 'Informe o novo prazo'; end if;
    if p_due_at <= old_due then raise exception 'O novo prazo deve ser posterior ao prazo atual'; end if;
    update public.technician_pendencies set due_at=p_due_at,updated_at=now() where id=p_pending_id returning * into pending;
    insert into public.technician_pending_events(pending_id,event_type,from_technician,previous_due_at,new_due_at,note,created_by) values(p_pending_id,'prorrogacao',old_technician,old_due,pending.due_at,p_note,auth.uid());
  else raise exception 'Ação inválida'; end if;
  return pending;
end $$;

grant execute on function public.record_timed_technician_movement(uuid,numeric,text,timestamptz,timestamptz,text,text,text,text,text) to authenticated;
grant execute on function public.resolve_technician_pending(uuid,text,text,timestamptz,text) to authenticated;
