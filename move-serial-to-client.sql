-- Permite instalar uma unidade diretamente a partir de um colaborador ou veículo.
-- Execute este arquivo inteiro uma vez no SQL Editor do Supabase.
-- A unidade fica como "Instalado no cliente" e não mexe novamente no estoque,
-- pois já tinha saído do almoxarifado ao ser entregue ao colaborador/veículo.

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

  -- Para entregar a colaborador/veículo, a unidade precisa estar no almoxarifado.
  if p_action in ('colaborador', 'veiculo') and current_item.status <> 'disponivel' then
    raise exception 'Este equipamento não está disponível no almoxarifado. Status atual: %', current_item.status;
  end if;

  -- Instalação pode sair do almoxarifado, de um colaborador ou de um veículo.
  if p_action = 'instalar' and current_item.status not in ('disponivel', 'com_colaborador', 'com_veiculo') then
    raise exception 'Este equipamento não pode ser instalado a partir do status atual: %', current_item.status;
  end if;

  if p_action = 'retornar' and current_item.status = 'disponivel' then
    raise exception 'Este equipamento já está disponível no almoxarifado';
  end if;

  -- Só desconta ao sair do saldo disponível e só soma ao retornar a ele.
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
