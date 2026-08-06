-- Execute esta consulta uma única vez no Supabase: SQL Editor > New query > Run.
-- Ela adiciona o número da OS e identifica se a movimentação foi para técnico, veículo, cliente ou outro destino.

alter table public.movements
  add column if not exists holder_type text not null default 'cliente'
    check (holder_type in ('tecnico', 'veiculo', 'cliente', 'outro')),
  add column if not exists work_order text;

drop function if exists public.record_movement(uuid, public.movement_type, integer, text, text);

create function public.record_movement(
  p_product_id uuid,
  p_type public.movement_type,
  p_quantity integer,
  p_recipient text,
  p_note text default null,
  p_holder_type text default 'cliente',
  p_work_order text default null
) returns public.movements
language plpgsql
security definer
set search_path = public
as $$
declare
  movement public.movements;
  current_stock integer;
begin
  if auth.uid() is null then raise exception 'Usuário não autenticado'; end if;
  if p_quantity <= 0 then raise exception 'A quantidade deve ser maior que zero'; end if;
  if p_holder_type not in ('tecnico', 'veiculo', 'cliente', 'outro') then raise exception 'Destino inválido'; end if;

  select stock into current_stock from public.products where id = p_product_id for update;
  if not found then raise exception 'Produto não encontrado'; end if;
  if p_type = 'saida' and current_stock < p_quantity then raise exception 'Estoque insuficiente'; end if;

  update public.products
  set stock = stock + case when p_type = 'entrada' then p_quantity else -p_quantity end,
      updated_at = now()
  where id = p_product_id;

  insert into public.movements (product_id, movement_type, quantity, recipient, note, holder_type, work_order, created_by)
  values (p_product_id, p_type, p_quantity, p_recipient, p_note, p_holder_type, nullif(trim(p_work_order), ''), auth.uid())
  returning * into movement;

  return movement;
end;
$$;

grant execute on function public.record_movement(uuid, public.movement_type, integer, text, text, text, text) to authenticated;
