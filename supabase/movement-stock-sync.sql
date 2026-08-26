-- Correção definitiva da sincronização entre movimentações e estoque.
-- Execute este arquivo inteiro no SQL Editor do Supabase.
-- Não recalcula nem altera movimentações ou saldos já existentes.

alter table public.movements
  add column if not exists stock_impact numeric(12,3),
  add column if not exists stock_before numeric(12,3),
  add column if not exists stock_after numeric(12,3);

alter table public.movements
  drop constraint if exists movements_stock_impact_check;

alter table public.movements
  add constraint movements_stock_impact_check
  check (stock_impact is null or stock_impact = 0 or stock_impact = quantity or stock_impact = -quantity);

-- Remove todas as assinaturas antigas para impedir que o PostgREST escolha
-- uma versão desatualizada da função conforme o formato da quantidade.
drop function if exists public.record_movement(uuid, public.movement_type, integer, text, text);
drop function if exists public.record_movement(uuid, public.movement_type, integer, text, text, text, text);
drop function if exists public.record_movement(uuid, public.movement_type, integer, text, text, text, text, boolean);
drop function if exists public.record_movement(uuid, public.movement_type, numeric, text, text);
drop function if exists public.record_movement(uuid, public.movement_type, numeric, text, text, text, text);
drop function if exists public.record_movement(uuid, public.movement_type, numeric, text, text, text, text, boolean);

create function public.record_movement(
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
  saved_movement public.movements;
  current_stock numeric(12,3);
  next_stock numeric(12,3);
  movement_impact numeric(12,3);
  technician_stock numeric(12,3);
begin
  if auth.uid() is null then raise exception 'Usuário não autenticado'; end if;
  if p_quantity is null or p_quantity <= 0 then raise exception 'A quantidade deve ser maior que zero'; end if;
  if nullif(trim(coalesce(p_recipient, '')), '') is null then raise exception 'Informe o responsável ou destino'; end if;
  if p_holder_type not in ('tecnico', 'veiculo', 'cliente', 'outro') then raise exception 'Destino inválido'; end if;
  if p_field_usage and (p_type <> 'saida' or p_holder_type <> 'tecnico') then
    raise exception 'Uso em OS deve ser registrado para um técnico';
  end if;
  if p_field_usage and nullif(trim(coalesce(p_work_order, '')), '') is null then
    raise exception 'Informe o número da OS';
  end if;

  -- O bloqueio evita duas movimentações simultâneas calcularem o mesmo saldo.
  select stock into current_stock
  from public.products
  where id = p_product_id and coalesce(is_active, true) = true
  for update;
  if not found then raise exception 'Produto não encontrado ou arquivado'; end if;

  if p_field_usage then
    -- Uso em OS consome o saldo que já estava com o técnico; não representa
    -- nova saída física do almoxarifado e, portanto, tem impacto zero nele.
    select coalesce(sum(
      case
        when coalesce(field_usage, false) then -quantity
        when movement_type = 'saida' then quantity
        else -quantity
      end
    ), 0)
    into technician_stock
    from public.movements
    where product_id = p_product_id
      and holder_type = 'tecnico'
      and lower(trim(recipient)) = lower(trim(p_recipient));

    if technician_stock < p_quantity then
      raise exception 'Saldo insuficiente com este técnico. Disponível: % unidade(s)', technician_stock;
    end if;
    movement_impact := 0;
    next_stock := current_stock;
  else
    movement_impact := case when p_type = 'entrada' then p_quantity else -p_quantity end;
    next_stock := current_stock + movement_impact;
    if next_stock < 0 then
      raise exception 'Estoque insuficiente. Saldo atual: % unidade(s)', current_stock;
    end if;

    update public.products
    set stock = next_stock,
        updated_at = now()
    where id = p_product_id;

    if not found then raise exception 'Não foi possível persistir o novo saldo do produto'; end if;
  end if;

  insert into public.movements (
    product_id, movement_type, quantity, recipient, note, holder_type,
    work_order, field_usage, stock_impact, stock_before, stock_after, created_by
  ) values (
    p_product_id, p_type, p_quantity, trim(p_recipient), nullif(trim(p_note), ''), p_holder_type,
    nullif(trim(p_work_order), ''), p_field_usage, movement_impact, current_stock, next_stock, auth.uid()
  ) returning * into saved_movement;

  return saved_movement;
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
  saved_movement public.movements;
  current_stock numeric(12,3);
  reverse_impact numeric(12,3);
  next_stock numeric(12,3);
begin
  if auth.uid() is null or coalesce(public.current_user_role()::text, '') <> 'admin' then
    raise exception 'Apenas administradores podem apagar movimentações';
  end if;

  select * into saved_movement from public.movements where id = p_movement_id for update;
  if not found then raise exception 'Movimentação não encontrada'; end if;

  select stock into current_stock from public.products where id = saved_movement.product_id for update;
  if not found then raise exception 'Produto não encontrado'; end if;

  reverse_impact := -coalesce(
    saved_movement.stock_impact,
    case
      when coalesce(saved_movement.field_usage, false) then 0
      when saved_movement.movement_type = 'entrada' then saved_movement.quantity
      else -saved_movement.quantity
    end
  );
  next_stock := current_stock + reverse_impact;
  if next_stock < 0 then
    raise exception 'Não é possível apagar esta movimentação porque o estoque ficaria negativo';
  end if;

  update public.products set stock = next_stock, updated_at = now() where id = saved_movement.product_id;
  delete from public.movements where id = p_movement_id;
end;
$$;

grant execute on function public.delete_movement(uuid) to authenticated;
