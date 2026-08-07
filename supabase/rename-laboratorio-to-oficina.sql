-- Atualiza os textos já instalados no banco para o nome "Oficina".
-- Execute este arquivo uma única vez no SQL Editor do Supabase.
-- Os valores internos "laboratorio" são mantidos para não afetar os registros existentes.

create or replace function public.move_serial_item(
  p_serial_item_id uuid,
  p_action text,
  p_collaborator_id uuid default null,
  p_vehicle_id uuid default null,
  p_location_id uuid default null,
  p_customer_name text default null,
  p_customer_reference text default null,
  p_work_order text default null,
  p_note text default null
) returns public.serial_items
language plpgsql
security definer
set search_path = public
as $$
declare
  current_item public.serial_items;
  updated_item public.serial_items;
  target_status text;
  target_location_id uuid;
  recipient_name text;
  action_name text;
  collaborator_name text;
  vehicle_name text;
  location_name text;
  current_stock numeric;
begin
  if auth.uid() is null or coalesce(public.current_user_role()::text, '') not in ('admin', 'operador') then
    raise exception 'Apenas administradores e operadores podem movimentar equipamentos rastreáveis';
  end if;

  select * into current_item from public.serial_items where id = p_serial_item_id for update;
  if not found then raise exception 'Equipamento não encontrado'; end if;
  if current_item.status = 'baixado' then raise exception 'Um equipamento baixado não pode ser movimentado'; end if;

  case p_action
    when 'colaborador' then
      if p_collaborator_id is null then raise exception 'Selecione o colaborador que receberá o equipamento'; end if;
      select name into collaborator_name from public.collaborators where id = p_collaborator_id and active = true;
      if collaborator_name is null then raise exception 'Colaborador não encontrado ou inativo'; end if;
      select id into target_location_id from public.stock_locations where location_type = 'colaborador' and collaborator_id = p_collaborator_id limit 1;
      if target_location_id is null then
        insert into public.stock_locations (name, location_type, collaborator_id)
        values ('Colaborador: ' || collaborator_name, 'colaborador', p_collaborator_id)
        returning id into target_location_id;
      end if;
      target_status := 'com_colaborador';
      recipient_name := collaborator_name;
      action_name := 'transferencia';

    when 'veiculo' then
      if p_vehicle_id is null then raise exception 'Selecione o veículo que receberá o equipamento'; end if;
      select name into vehicle_name from public.vehicles where id = p_vehicle_id and active = true;
      if vehicle_name is null then raise exception 'Veículo não encontrado ou inativo'; end if;
      select id into target_location_id from public.stock_locations where location_type = 'veiculo' and vehicle_id = p_vehicle_id limit 1;
      if target_location_id is null then
        insert into public.stock_locations (name, location_type, vehicle_id)
        values ('Veículo: ' || vehicle_name, 'veiculo', p_vehicle_id)
        returning id into target_location_id;
      end if;
      target_status := 'com_veiculo';
      recipient_name := vehicle_name;
      action_name := 'transferencia';

    when 'instalar' then
      if nullif(trim(coalesce(p_customer_name, '')), '') is null then raise exception 'Informe o cliente para concluir a instalação'; end if;
      target_status := 'instalado_cliente';
      target_location_id := null;
      recipient_name := trim(p_customer_name);
      action_name := 'instalacao';

    when 'laboratorio' then
      if p_location_id is null then raise exception 'Selecione o local de oficina'; end if;
      select name into location_name from public.stock_locations where id = p_location_id and location_type = 'laboratorio' and active = true;
      if location_name is null then raise exception 'Local de oficina não encontrado ou inativo'; end if;
      target_status := 'laboratorio';
      target_location_id := p_location_id;
      recipient_name := location_name;
      action_name := 'laboratorio';

    when 'retornar' then
      select id, name into target_location_id, location_name from public.stock_locations where location_type = 'central' and active = true order by created_at limit 1;
      if target_location_id is null then raise exception 'Almoxarifado central não encontrado'; end if;
      target_status := 'disponivel';
      recipient_name := location_name;
      action_name := 'retorno';

    when 'baixar' then
      target_status := 'baixado';
      target_location_id := null;
      recipient_name := 'Baixa / sucata';
      action_name := 'baixa';

    else
      raise exception 'Ação de movimentação inválida';
  end case;

  if p_action in ('colaborador', 'veiculo', 'instalar') and current_item.status <> 'disponivel' then
    raise exception 'Este equipamento não está disponível no almoxarifado. Status atual: %', current_item.status;
  end if;
  if p_action = 'retornar' and current_item.status = 'disponivel' then
    raise exception 'Este equipamento já está disponível no almoxarifado';
  end if;

  if current_item.status = 'disponivel' and target_status <> 'disponivel' then
    select stock into current_stock from public.products where id = current_item.product_id for update;
    if current_stock < 1 then raise exception 'O saldo do item não permite retirar esta unidade do estoque'; end if;
    update public.products set stock = stock - 1, updated_at = now() where id = current_item.product_id;
  elsif current_item.status <> 'disponivel' and target_status = 'disponivel' then
    update public.products set stock = stock + 1, updated_at = now() where id = current_item.product_id;
  end if;

  insert into public.serial_movements (
    serial_item_id, action, previous_status, new_status, from_location_id, to_location_id,
    recipient, customer_name, customer_reference, work_order, note, created_by
  ) values (
    current_item.id, action_name, current_item.status, target_status, current_item.current_location_id, target_location_id,
    recipient_name,
    case when p_action = 'instalar' then nullif(trim(p_customer_name), '') else null end,
    case when p_action = 'instalar' then nullif(trim(p_customer_reference), '') else null end,
    nullif(trim(p_work_order), ''), nullif(trim(p_note), ''), auth.uid()
  );

  update public.serial_items
  set status = target_status,
      current_location_id = target_location_id,
      customer_name = case when p_action = 'instalar' then nullif(trim(p_customer_name), '') else null end,
      customer_reference = case when p_action = 'instalar' then nullif(trim(p_customer_reference), '') else null end,
      updated_at = now()
  where id = current_item.id
  returning * into updated_item;

  return updated_item;
end;
$$;

grant execute on function public.move_serial_item(uuid, text, uuid, uuid, uuid, text, text, text, text) to authenticated;

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
    raise exception 'Apenas administradores e operadores podem processar itens na oficina';
  end if;

  select * into current_item from public.serial_items where id = p_serial_item_id for update;
  if not found then raise exception 'Equipamento não encontrado'; end if;

  select location_type into current_location_type from public.stock_locations where id = current_item.current_location_id;
  if current_location_type <> 'laboratorio' then raise exception 'Este item não está vinculado a um local de oficina'; end if;
  if current_item.status not in ('laboratorio', 'manutencao', 'defeito', 'aguardando_triagem') then raise exception 'O status atual deste item não permite processamento na oficina'; end if;
  if p_action in ('manutencao', 'defeito', 'baixar') and nullif(trim(coalesce(p_note, '')), '') is null then raise exception 'Informe uma observação para registrar este resultado'; end if;

  target_location_id := current_item.current_location_id;
  case p_action
    when 'aprovar' then
      select id into target_location_id from public.stock_locations where location_type = 'central' and active = true order by created_at limit 1;
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
      raise exception 'Ação de oficina inválida';
  end case;

  if target_status = 'disponivel' then
    select stock into current_stock from public.products where id = current_item.product_id for update;
    if not found then raise exception 'Produto não encontrado'; end if;
    update public.products set stock = stock + 1, updated_at = now() where id = current_item.product_id;
  end if;

  insert into public.serial_movements (
    serial_item_id, action, previous_status, new_status, from_location_id, to_location_id,
    recipient, note, created_by
  ) values (
    current_item.id, movement_action, current_item.status, target_status,
    current_item.current_location_id, target_location_id,
    case when target_status = 'disponivel' then 'Almoxarifado Central' else 'Oficina' end,
    nullif(trim(p_note), ''), auth.uid()
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

update public.stock_locations
set name = regexp_replace(name, 'laboratório', 'Oficina', 'gi')
where location_type = 'laboratorio' and name ~* 'laboratório';

update public.serial_movements
set recipient = regexp_replace(recipient, 'laboratório', 'Oficina', 'gi')
where recipient ~* 'laboratório';
