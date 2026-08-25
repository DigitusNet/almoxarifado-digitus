-- Fluxo físico de equipamentos rastreáveis.
-- Execute este arquivo inteiro no SQL Editor do Supabase.
-- Esta migração NÃO recalcula nem altera saldos ou registros existentes.

alter table public.serial_movements
  add column if not exists stock_impact smallint;

update public.serial_movements
set stock_impact = case
  when previous_status = 'disponivel' and new_status <> 'disponivel' then -1
  when previous_status <> 'disponivel' and new_status = 'disponivel' then 1
  else 0
end
where stock_impact is null;

alter table public.serial_movements
  alter column stock_impact set default 0,
  alter column stock_impact set not null;

alter table public.serial_movements
  drop constraint if exists serial_movements_stock_impact_check;

alter table public.serial_movements
  add constraint serial_movements_stock_impact_check
  check (stock_impact in (-1, 0, 1));

create or replace function public.set_serial_movement_stock_impact()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  new.stock_impact := case
    when new.previous_status = 'disponivel' and new.new_status <> 'disponivel' then -1
    when new.previous_status <> 'disponivel' and new.new_status = 'disponivel' then 1
    else 0
  end;
  return new;
end;
$$;

drop trigger if exists set_serial_movement_stock_impact on public.serial_movements;
create trigger set_serial_movement_stock_impact
before insert or update of previous_status, new_status on public.serial_movements
for each row execute function public.set_serial_movement_stock_impact();

alter table public.serial_movements
  drop constraint if exists serial_movements_action_check;

alter table public.serial_movements
  add constraint serial_movements_action_check
  check (action in (
    'transferencia', 'instalacao', 'laboratorio', 'retorno', 'baixa',
    'manutencao', 'defeito', 'emprestimo_cliente', 'devolucao_cliente'
  ));

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
  movement_impact smallint := 0;
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
      target_status := 'com_colaborador'; recipient_name := collaborator_name; action_name := 'transferencia';

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
      target_status := 'com_veiculo'; recipient_name := vehicle_name; action_name := 'transferencia';

    when 'instalar' then
      if nullif(trim(coalesce(p_customer_name, '')), '') is null then raise exception 'Informe o cliente para concluir a instalação'; end if;
      target_status := 'instalado_cliente'; target_location_id := null;
      recipient_name := trim(p_customer_name); action_name := 'instalacao';

    when 'laboratorio' then
      if p_location_id is null then raise exception 'Selecione o local de oficina'; end if;
      select name into location_name from public.stock_locations where id = p_location_id and location_type = 'laboratorio' and active = true;
      if location_name is null then raise exception 'Local de oficina não encontrado ou inativo'; end if;
      target_status := 'laboratorio'; target_location_id := p_location_id;
      recipient_name := location_name; action_name := 'laboratorio';

    when 'retornar' then
      select id, name into target_location_id, location_name from public.stock_locations where location_type = 'central' and active = true order by created_at limit 1;
      if target_location_id is null then raise exception 'Almoxarifado central não encontrado'; end if;
      target_status := 'disponivel'; recipient_name := location_name; action_name := 'retorno';

    when 'baixar' then
      target_status := 'baixado'; target_location_id := null;
      recipient_name := 'Baixa / sucata'; action_name := 'baixa';

    else raise exception 'Ação de movimentação inválida';
  end case;

  if p_action in ('colaborador', 'veiculo') and current_item.status <> 'disponivel' then
    raise exception 'Para retirar para colaborador ou veículo, o equipamento precisa estar no almoxarifado';
  end if;
  if p_action = 'instalar' and current_item.status not in ('disponivel', 'com_colaborador', 'com_veiculo') then
    raise exception 'Este equipamento não pode ser instalado a partir do status atual: %', current_item.status;
  end if;
  if p_action = 'retornar' and current_item.status = 'disponivel' then
    raise exception 'Este equipamento já está disponível no almoxarifado';
  end if;

  if current_item.status = 'disponivel' and target_status <> 'disponivel' then
    select stock into current_stock from public.products where id = current_item.product_id for update;
    if coalesce(current_stock, 0) < 1 then raise exception 'O saldo do item não permite retirar esta unidade do estoque'; end if;
    update public.products set stock = stock - 1, updated_at = now() where id = current_item.product_id;
    movement_impact := -1;
  elsif current_item.status <> 'disponivel' and target_status = 'disponivel' then
    update public.products set stock = stock + 1, updated_at = now() where id = current_item.product_id;
    movement_impact := 1;
  end if;

  insert into public.serial_movements (
    serial_item_id, action, previous_status, new_status, from_location_id, to_location_id,
    recipient, customer_name, customer_reference, work_order, note, stock_impact, created_by
  ) values (
    current_item.id, action_name, current_item.status, target_status, current_item.current_location_id, target_location_id,
    recipient_name,
    case when p_action = 'instalar' then nullif(trim(p_customer_name), '') else null end,
    case when p_action = 'instalar' then nullif(trim(p_customer_reference), '') else null end,
    nullif(trim(p_work_order), ''), nullif(trim(p_note), ''), movement_impact, auth.uid()
  );

  update public.serial_items
  set status = target_status, current_location_id = target_location_id,
      customer_name = case when p_action = 'instalar' then nullif(trim(p_customer_name), '') else null end,
      customer_reference = case when p_action = 'instalar' then nullif(trim(p_customer_reference), '') else null end,
      updated_at = now()
  where id = current_item.id returning * into updated_item;
  return updated_item;
end;
$$;

grant execute on function public.move_serial_item(uuid, text, uuid, uuid, uuid, text, text, text, text) to authenticated;

create or replace function public.create_client_loan(
  p_serial_item_id uuid,
  p_customer_name text,
  p_customer_document text default null,
  p_customer_phone text default null,
  p_customer_address text default null,
  p_customer_reference text default null,
  p_note text default null
) returns public.client_loans
language plpgsql
security definer
set search_path = public
as $$
declare
  current_item public.serial_items;
  created_loan public.client_loans;
  current_stock numeric;
  movement_impact smallint := 0;
begin
  if auth.uid() is null or coalesce(public.current_user_role()::text, '') not in ('admin', 'operador') then
    raise exception 'Apenas administradores e operadores podem registrar comodatos';
  end if;
  if nullif(trim(coalesce(p_customer_name, '')), '') is null then raise exception 'Informe o nome do cliente'; end if;

  select * into current_item from public.serial_items where id = p_serial_item_id for update;
  if not found then raise exception 'Equipamento não encontrado'; end if;
  if current_item.status not in ('disponivel', 'com_colaborador', 'com_veiculo') then
    raise exception 'O equipamento precisa estar no almoxarifado, com um técnico ou em um veículo para registrar o comodato';
  end if;
  if exists (select 1 from public.tool_loans where serial_item_id = p_serial_item_id and returned_at is null)
     or exists (select 1 from public.client_loans where serial_item_id = p_serial_item_id and returned_at is null) then
    raise exception 'Esta unidade já possui um empréstimo em aberto';
  end if;

  if current_item.status = 'disponivel' then
    select stock into current_stock from public.products where id = current_item.product_id for update;
    if coalesce(current_stock, 0) < 1 then raise exception 'O saldo do item não permite retirar esta unidade do estoque'; end if;
    update public.products set stock = stock - 1, updated_at = now() where id = current_item.product_id;
    movement_impact := -1;
  end if;

  insert into public.client_loans (
    serial_item_id, customer_name, customer_document, customer_phone, customer_address,
    customer_reference, note, issued_by
  ) values (
    p_serial_item_id, trim(p_customer_name), nullif(trim(p_customer_document), ''), nullif(trim(p_customer_phone), ''),
    nullif(trim(p_customer_address), ''), nullif(trim(p_customer_reference), ''), nullif(trim(p_note), ''), auth.uid()
  ) returning * into created_loan;

  insert into public.serial_movements (
    serial_item_id, action, previous_status, new_status, from_location_id,
    recipient, customer_name, customer_reference, note, stock_impact, created_by
  ) values (
    current_item.id, 'emprestimo_cliente', current_item.status, 'emprestado', current_item.current_location_id,
    trim(p_customer_name), trim(p_customer_name), nullif(trim(p_customer_reference), ''),
    nullif(trim(p_note), ''), movement_impact, auth.uid()
  );

  update public.serial_items
  set status = 'emprestado', current_location_id = null, customer_name = trim(p_customer_name),
      customer_reference = nullif(trim(p_customer_reference), ''), updated_at = now()
  where id = current_item.id;
  return created_loan;
end;
$$;

grant execute on function public.create_client_loan(uuid, text, text, text, text, text, text) to authenticated;

create or replace function public.return_client_loan(
  p_loan_id uuid,
  p_return_note text default null
) returns public.client_loans
language plpgsql
security definer
set search_path = public
as $$
declare
  loan public.client_loans;
  current_item public.serial_items;
  central_location_id uuid;
  closed_loan public.client_loans;
begin
  if auth.uid() is null or coalesce(public.current_user_role()::text, '') not in ('admin', 'operador') then
    raise exception 'Apenas administradores e operadores podem registrar devoluções';
  end if;
  select * into loan from public.client_loans where id = p_loan_id and returned_at is null for update;
  if not found then raise exception 'Comodato não encontrado ou já devolvido'; end if;
  select * into current_item from public.serial_items where id = loan.serial_item_id for update;
  if not found then raise exception 'Equipamento não encontrado'; end if;
  select id into central_location_id from public.stock_locations where location_type = 'central' and active = true order by created_at limit 1;
  if central_location_id is null then raise exception 'Almoxarifado central não encontrado'; end if;

  update public.client_loans set returned_at = now(), returned_by = auth.uid(), return_note = nullif(trim(p_return_note), '')
  where id = loan.id returning * into closed_loan;
  perform set_config('app.returning_client_loan', 'true', true);
  update public.serial_items set status = 'disponivel', current_location_id = central_location_id,
    customer_name = null, customer_reference = null, updated_at = now() where id = current_item.id;
  update public.products set stock = stock + 1, updated_at = now() where id = current_item.product_id;

  insert into public.serial_movements (
    serial_item_id, action, previous_status, new_status, from_location_id, to_location_id,
    recipient, customer_name, note, stock_impact, created_by
  ) values (
    current_item.id, 'devolucao_cliente', current_item.status, 'disponivel', current_item.current_location_id,
    central_location_id, 'Almoxarifado Central', loan.customer_name, nullif(trim(p_return_note), ''), 1, auth.uid()
  );
  return closed_loan;
end;
$$;

grant execute on function public.return_client_loan(uuid, text) to authenticated;
