-- Controle de equipamentos por Serial, MAC e Patrimônio.
-- O cadastro de uma unidade não altera o saldo do produto.
-- Execute este arquivo inteiro no SQL Editor do Supabase após system-foundation.sql.

-- As unidades rastreáveis serão alteradas somente pelas funções seguras abaixo.
drop policy if exists "Admins and operators manage serial items" on public.serial_items;

create or replace function public.register_serial_item(
  p_product_id uuid,
  p_serial_number text default null,
  p_mac_address text default null,
  p_asset_tag text default null,
  p_status text default 'disponivel',
  p_location_id uuid default null,
  p_customer_name text default null,
  p_customer_reference text default null,
  p_notes text default null,
  p_add_to_stock boolean default false
) returns public.serial_items
language plpgsql
security definer
set search_path = public
as $$
declare
  serial_item public.serial_items;
  product_tracking text;
  resolved_location_id uuid;
begin
  if auth.uid() is null or coalesce(public.current_user_role()::text, '') not in ('admin', 'operador') then
    raise exception 'Apenas administradores e operadores podem cadastrar equipamentos rastreáveis';
  end if;

  if nullif(trim(coalesce(p_serial_number, '')), '') is null
    and nullif(trim(coalesce(p_mac_address, '')), '') is null
    and nullif(trim(coalesce(p_asset_tag, '')), '') is null then
    raise exception 'Informe pelo menos o serial, MAC ou código patrimonial';
  end if;

  select tracking_mode into product_tracking from public.products where id = p_product_id for update;
  if not found then raise exception 'Item não encontrado'; end if;
  if product_tracking <> 'serializado' then
    raise exception 'Este item está configurado para controle por quantidade. Edite-o e escolha "Por serial / MAC" antes de cadastrar unidades.';
  end if;

  resolved_location_id := p_location_id;
  if resolved_location_id is null and p_status = 'disponivel' then
    select id into resolved_location_id
    from public.stock_locations
    where location_type = 'central' and active = true
    order by created_at
    limit 1;
  end if;

  insert into public.serial_items (
    product_id, serial_number, mac_address, asset_tag, status, current_location_id,
    customer_name, customer_reference, notes
  ) values (
    p_product_id,
    nullif(trim(p_serial_number), ''),
    nullif(trim(p_mac_address), ''),
    nullif(trim(p_asset_tag), ''),
    p_status,
    resolved_location_id,
    nullif(trim(p_customer_name), ''),
    nullif(trim(p_customer_reference), ''),
    nullif(trim(p_notes), '')
  ) returning * into serial_item;

  return serial_item;
end;
$$;

grant execute on function public.register_serial_item(uuid, text, text, text, text, uuid, text, text, text, boolean) to authenticated;
