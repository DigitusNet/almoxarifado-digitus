-- Fluxo de triagem e laboratório para equipamentos rastreáveis.
-- Execute este arquivo inteiro no SQL Editor do Supabase.

alter table public.serial_movements
  drop constraint if exists serial_movements_action_check;

alter table public.serial_movements
  add constraint serial_movements_action_check
  check (action in ('transferencia', 'instalacao', 'laboratorio', 'retorno', 'baixa', 'manutencao', 'defeito'));

create or replace function public.process_laboratory_item(
  p_serial_item_id uuid,
  p_action text,
  p_note text default null
) returns public.serial_items
language plpgsql
security definer
set search_path = public
as $$
declare
  current_item public.serial_items;
  updated_item public.serial_items;
  current_location_type text;
  target_location_id uuid;
  target_status text;
  movement_action text;
  current_stock numeric;
begin
  if auth.uid() is null or coalesce(public.current_user_role()::text, '') not in ('admin', 'operador') then
    raise exception 'Apenas administradores e operadores podem processar itens no laboratório';
  end if;

  select * into current_item
  from public.serial_items
  where id = p_serial_item_id
  for update;

  if not found then raise exception 'Equipamento não encontrado'; end if;

  select location_type into current_location_type
  from public.stock_locations
  where id = current_item.current_location_id;

  if current_location_type <> 'laboratorio' then
    raise exception 'Este item não está vinculado a um local de laboratório';
  end if;

  if current_item.status not in ('laboratorio', 'manutencao', 'defeito', 'aguardando_triagem') then
    raise exception 'O status atual deste item não permite processamento no laboratório';
  end if;

  if p_action in ('manutencao', 'defeito', 'baixar')
    and nullif(trim(coalesce(p_note, '')), '') is null then
    raise exception 'Informe uma observação para registrar este resultado';
  end if;

  target_location_id := current_item.current_location_id;

  case p_action
    when 'aprovar' then
      select id into target_location_id
      from public.stock_locations
      where location_type = 'central' and active = true
      order by created_at
      limit 1;
      if target_location_id is null then raise exception 'Almoxarifado central não encontrado'; end if;
      target_status := 'disponivel';
      movement_action := 'retorno';

    when 'manutencao' then
      target_status := 'manutencao';
      movement_action := 'manutencao';

    when 'defeito' then
      target_status := 'defeito';
      movement_action := 'defeito';

    when 'baixar' then
      target_location_id := null;
      target_status := 'baixado';
      movement_action := 'baixa';

    else
      raise exception 'Ação de laboratório inválida';
  end case;

  if target_status = 'disponivel' then
    select stock into current_stock from public.products where id = current_item.product_id for update;
    if not found then raise exception 'Produto não encontrado'; end if;
    update public.products
    set stock = stock + 1, updated_at = now()
    where id = current_item.product_id;
  end if;

  insert into public.serial_movements (
    serial_item_id, action, previous_status, new_status, from_location_id, to_location_id,
    recipient, note, created_by
  ) values (
    current_item.id,
    movement_action,
    current_item.status,
    target_status,
    current_item.current_location_id,
    target_location_id,
    case when target_status = 'disponivel' then 'Almoxarifado Central' else 'Laboratório' end,
    nullif(trim(p_note), ''),
    auth.uid()
  );

  update public.serial_items
  set status = target_status,
      current_location_id = target_location_id,
      customer_name = null,
      customer_reference = null,
      updated_at = now()
  where id = current_item.id
  returning * into updated_item;

  return updated_item;
end;
$$;

grant execute on function public.process_laboratory_item(uuid, text, text) to authenticated;
