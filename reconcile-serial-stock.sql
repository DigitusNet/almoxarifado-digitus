-- Reconciliação de saldo dos produtos controlados por Serial / MAC.
-- Execute este arquivo inteiro UMA vez no SQL Editor do Supabase.
-- O saldo de cada produto rastreável passa a ser igual ao número de unidades
-- com status "disponivel" no Almoxarifado Central.

create or replace function public.sync_serial_product_stock(p_product_id uuid)
returns numeric
language plpgsql
security definer
set search_path = public
as $$
declare
  synced_stock numeric(12,3);
begin
  update public.products product
  set stock = (
        select count(*)::numeric(12,3)
        from public.serial_items serial_item
        where serial_item.product_id = product.id
          and serial_item.status = 'disponivel'
      ),
      updated_at = now()
  where product.id = p_product_id
    and product.tracking_mode = 'serializado'
  returning stock into synced_stock;

  return synced_stock;
end;
$$;

-- Corrige agora todos os produtos rastreáveis já cadastrados.
do $$
declare
  product_row record;
begin
  for product_row in
    select id from public.products where tracking_mode = 'serializado'
  loop
    perform public.sync_serial_product_stock(product_row.id);
  end loop;
end;
$$;

-- A edição serve apenas para corrigir identificadores e o produto vinculado.
-- Status e local devem continuar sendo mudados em "Mover", para manter o saldo correto.
create or replace function public.edit_serial_item(
  p_serial_item_id uuid,
  p_product_id uuid,
  p_serial_number text default null,
  p_mac_address text default null,
  p_asset_tag text default null,
  p_notes text default null
) returns public.serial_items
language plpgsql
security definer
set search_path = public
as $$
declare
  current_item public.serial_items;
  updated_item public.serial_items;
begin
  if auth.uid() is null or coalesce(public.current_user_role()::text, '') not in ('admin', 'operador') then
    raise exception 'Apenas administradores e operadores podem editar unidades';
  end if;

  if nullif(trim(coalesce(p_serial_number, '')), '') is null
    and nullif(trim(coalesce(p_mac_address, '')), '') is null
    and nullif(trim(coalesce(p_asset_tag, '')), '') is null then
    raise exception 'Informe pelo menos o serial, MAC ou código patrimonial';
  end if;

  select * into current_item
  from public.serial_items
  where id = p_serial_item_id
  for update;
  if not found then raise exception 'Unidade Serial/MAC não encontrada'; end if;

  if not exists (
    select 1 from public.products
    where id = p_product_id and tracking_mode = 'serializado' and is_active = true
  ) then
    raise exception 'Selecione um item rastreável ativo';
  end if;

  update public.serial_items
  set product_id = p_product_id,
      serial_number = nullif(trim(p_serial_number), ''),
      mac_address = nullif(trim(p_mac_address), ''),
      asset_tag = nullif(trim(p_asset_tag), ''),
      notes = nullif(trim(p_notes), ''),
      updated_at = now()
  where id = p_serial_item_id
  returning * into updated_item;

  -- Se a unidade foi corrigida para outro produto, os dois saldos são recalculados.
  perform public.sync_serial_product_stock(current_item.product_id);
  if current_item.product_id <> p_product_id then
    perform public.sync_serial_product_stock(p_product_id);
  end if;

  return updated_item;
end;
$$;

-- Ao excluir uma unidade, também recalcula o saldo do produto dela.
create or replace function public.delete_serial_item(p_serial_item_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  target_item public.serial_items;
begin
  if auth.uid() is null or coalesce(public.current_user_role()::text, '') <> 'admin' then
    raise exception 'Apenas administradores podem excluir unidades';
  end if;

  select * into target_item
  from public.serial_items
  where id = p_serial_item_id
  for update;
  if not found then raise exception 'Unidade Serial/MAC não encontrada'; end if;

  if exists (select 1 from public.tool_loans where serial_item_id = p_serial_item_id and returned_at is null)
     or exists (select 1 from public.client_loans where serial_item_id = p_serial_item_id and returned_at is null) then
    raise exception 'Não é possível excluir uma unidade com empréstimo em aberto. Registre a devolução primeiro.';
  end if;

  delete from public.tool_loans where serial_item_id = p_serial_item_id;
  delete from public.client_loans where serial_item_id = p_serial_item_id;
  delete from public.serial_movements where serial_item_id = p_serial_item_id;
  delete from public.serial_items where id = p_serial_item_id;

  perform public.sync_serial_product_stock(target_item.product_id);
end;
$$;

-- As alterações de unidades devem acontecer pelas funções acima, nunca por edição direta.
drop policy if exists "Admins and operators manage serial items" on public.serial_items;

revoke all on function public.sync_serial_product_stock(uuid) from public;
grant execute on function public.edit_serial_item(uuid, uuid, text, text, text, text) to authenticated;
grant execute on function public.delete_serial_item(uuid) to authenticated;

-- Conferência final: esta lista mostra o saldo salvo após a correção e a
-- quantidade de unidades que estão realmente disponíveis para cada produto.
select
  product.name as produto,
  product.code as codigo,
  product.stock as estoque_corrigido,
  count(serial_item.id) filter (where serial_item.status = 'disponivel') as unidades_disponiveis
from public.products product
left join public.serial_items serial_item on serial_item.product_id = product.id
where product.tracking_mode = 'serializado'
group by product.id, product.name, product.code, product.stock
order by product.name;
