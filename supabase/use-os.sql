-- Execute esta consulta uma única vez no Supabase: SQL Editor > New query > Run.
-- Adiciona "Uso em OS": o material é baixado do saldo do técnico, sem alterar novamente o estoque do almoxarifado.

alter table public.movements
  add column if not exists holder_type text not null default 'cliente'
    check (holder_type in ('tecnico', 'veiculo', 'cliente', 'outro')),
  add column if not exists work_order text,
  add column if not exists field_usage boolean not null default false;

drop function if exists public.record_movement(uuid, public.movement_type, integer, text, text);
drop function if exists public.record_movement(uuid, public.movement_type, integer, text, text, text, text);
drop function if exists public.record_movement(uuid, public.movement_type, integer, text, text, text, text, boolean);

create function public.record_movement(
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
    where product_id = p_product_id
      and holder_type = 'tecnico'
      and lower(trim(recipient)) = lower(trim(p_recipient));
    if technician_stock < p_quantity then
      raise exception 'Saldo insuficiente com este técnico. Disponível: % unidade(s)', technician_stock;
    end if;
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
