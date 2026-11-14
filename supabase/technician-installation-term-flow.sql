-- Separa o registro da instalação do recebimento físico do termo.
-- Execute uma única vez no SQL Editor do Supabase antes de publicar o front-end.
-- Não reprocessa nem altera pendências, equipamentos ou movimentações já existentes.

begin;

alter table public.serial_items
  add column if not exists term_received_at timestamptz,
  add column if not exists term_received_by text;

alter table public.technician_pendencies
  add column if not exists term_received_at timestamptz,
  add column if not exists term_received_by text;

alter table public.serial_items
  drop constraint if exists serial_items_status_check;
alter table public.serial_items
  add constraint serial_items_status_check check (status in (
    'disponivel', 'com_colaborador', 'com_veiculo', 'instalado_cliente',
    'instalacao_termo_pendente', 'emprestado', 'aguardando_triagem',
    'laboratorio', 'manutencao', 'defeito', 'baixado'
  ));

alter table public.technician_pending_events
  drop constraint if exists technician_pending_events_event_type_check;
alter table public.technician_pending_events
  add constraint technician_pending_events_event_type_check check (event_type in (
    'retirada', 'transferencia', 'prorrogacao', 'devolucao', 'utilizacao',
    'termo_recebido'
  ));

create index if not exists technician_pendencies_open_installation_idx
  on public.technician_pendencies (resolution, installed_at)
  where resolution = 'aberta';

create or replace function public.register_integrated_pending_installation(
  p_operation_id uuid,
  p_pending_id uuid,
  p_customer_name text,
  p_work_order text,
  p_installed_at timestamptz default null,
  p_note text default null
) returns public.technician_pendencies
language plpgsql security definer set search_path = public as $$
declare
  pending public.technician_pendencies;
  saved_pending public.technician_pendencies;
  unit_record public.serial_items;
  saved_movement public.movements;
  saved_operation public.stock_operation_idempotency;
  claimed_id uuid;
  event_time timestamptz := coalesce(p_installed_at, now());
  linked_count integer;
  payload jsonb := jsonb_build_object(
    'pending_id', p_pending_id,
    'customer_name', p_customer_name,
    'work_order', p_work_order,
    'installed_at', p_installed_at,
    'note', p_note
  );
begin
  if auth.uid() is null or coalesce(public.current_user_role()::text, '') not in ('admin', 'operador') then
    raise exception 'Apenas administradores e operadores podem registrar instalações';
  end if;
  if p_operation_id is null then raise exception 'Identificador da operação não informado'; end if;
  if nullif(trim(coalesce(p_customer_name, '')), '') is null then raise exception 'Informe o nome do cliente'; end if;

  insert into public.stock_operation_idempotency(operation_id, operation_type, request_payload, created_by)
  values(p_operation_id, 'instalacao_termo_pendente', payload, auth.uid())
  on conflict(operation_id) do nothing
  returning operation_id into claimed_id;

  if claimed_id is null then
    select * into saved_operation from public.stock_operation_idempotency where operation_id = p_operation_id;
    if saved_operation.operation_type <> 'instalacao_termo_pendente'
      or saved_operation.created_by <> auth.uid()
      or saved_operation.request_payload <> payload then
      raise exception 'A identificação desta operação já foi utilizada com outros dados';
    end if;
    if saved_operation.result_id is null then raise exception 'A operação anterior ainda está sendo processada'; end if;
    select * into saved_pending from public.technician_pendencies where id = saved_operation.result_id;
    if not found then raise exception 'O resultado da operação anterior não foi encontrado'; end if;
    return saved_pending;
  end if;

  select * into pending from public.technician_pendencies where id = p_pending_id for update;
  if not found then raise exception 'Pendência não encontrada'; end if;
  if pending.resolution <> 'aberta' then raise exception 'Esta pendência já foi finalizada como %', pending.resolution; end if;
  if pending.installed_at is not null then raise exception 'A instalação desta pendência já foi registrada. Aguarde o recebimento do termo.'; end if;
  select count(*) into linked_count from public.technician_pending_items where pending_id = p_pending_id;
  if linked_count = 0 then raise exception 'Esta pendência não possui equipamento individual vinculado'; end if;

  for unit_record in
    select item.*
    from public.serial_items item
    join public.technician_pending_items link on link.serial_item_id = item.id
    where link.pending_id = p_pending_id
    for update
  loop
    if unit_record.status <> 'com_colaborador' then
      raise exception 'A unidade % não está disponível para registrar instalação. Situação atual: %',
        coalesce(unit_record.asset_tag, unit_record.mac_address, unit_record.serial_number), unit_record.status;
    end if;
    insert into public.serial_movements(
      serial_item_id, action, previous_status, new_status, from_location_id,
      recipient, customer_name, customer_reference, work_order, note,
      stock_impact, pending_id, created_by, created_at
    ) values (
      unit_record.id, 'instalacao', unit_record.status, 'instalacao_termo_pendente', unit_record.current_location_id,
      pending.technician_name, trim(p_customer_name), nullif(trim(coalesce(p_work_order, '')), ''),
      nullif(trim(coalesce(p_work_order, '')), ''), nullif(trim(coalesce(p_note, '')), ''),
      0, p_pending_id, auth.uid(), event_time
    );
    update public.serial_items
    set status = 'instalacao_termo_pendente',
        customer_name = trim(p_customer_name),
        customer_reference = nullif(trim(coalesce(p_work_order, '')), ''),
        installation_technician = pending.technician_name,
        installed_at = event_time,
        work_order = nullif(trim(coalesce(p_work_order, '')), ''),
        updated_at = now()
    where id = unit_record.id;
  end loop;

  update public.technician_pendencies
  set installed_at = event_time,
      installation_customer = trim(p_customer_name),
      installation_work_order = nullif(trim(coalesce(p_work_order, '')), ''),
      note = coalesce(nullif(trim(coalesce(p_note, '')), ''), note),
      updated_at = now()
  where id = p_pending_id
  returning * into saved_pending;

  insert into public.movements(
    product_id, movement_type, quantity, recipient, note, holder_type, work_order,
    field_usage, stock_impact, stock_before, stock_after, pending_id, created_by, created_at
  )
  select pending.product_id, 'saida', pending.quantity, pending.technician_name,
    coalesce(nullif(trim(coalesce(p_note, '')), ''), 'Instalação registrada — termo pendente'), 'tecnico',
    nullif(trim(coalesce(p_work_order, '')), ''), true, 0, products.stock, products.stock,
    pending.id, auth.uid(), event_time
  from public.products products
  where products.id = pending.product_id
  returning * into saved_movement;

  insert into public.technician_pending_events(
    pending_id, event_type, from_technician, customer_name, work_order, note, created_by, occurred_at
  ) values (
    p_pending_id, 'utilizacao', pending.technician_name, trim(p_customer_name),
    nullif(trim(coalesce(p_work_order, '')), ''), nullif(trim(coalesce(p_note, '')), ''), auth.uid(), event_time
  );

  update public.stock_operation_idempotency
  set result_id = saved_pending.id, completed_at = now()
  where operation_id = p_operation_id;
  return saved_pending;
end $$;

create or replace function public.confirm_integrated_pending_term(
  p_pending_id uuid,
  p_received_by text,
  p_received_at timestamptz default null,
  p_note text default null
) returns public.technician_pendencies
language plpgsql security definer set search_path = public as $$
declare
  pending public.technician_pendencies;
  saved_pending public.technician_pendencies;
  unit_record public.serial_items;
  event_time timestamptz := coalesce(p_received_at, now());
begin
  if auth.uid() is null or coalesce(public.current_user_role()::text, '') not in ('admin', 'operador') then
    raise exception 'Apenas administradores e operadores podem confirmar termos';
  end if;
  if nullif(trim(coalesce(p_received_by, '')), '') is null then raise exception 'Informe quem recebeu o termo'; end if;
  select * into pending from public.technician_pendencies where id = p_pending_id for update;
  if not found then raise exception 'Pendência não encontrada'; end if;
  if pending.resolution <> 'aberta' then
    if pending.resolution = 'utilizado' and pending.term_received_at is not null then return pending; end if;
    raise exception 'Esta pendência já foi finalizada como %', pending.resolution;
  end if;
  if pending.installed_at is null then raise exception 'Registre a instalação antes de confirmar o recebimento do termo'; end if;

  for unit_record in
    select item.*
    from public.serial_items item
    join public.technician_pending_items link on link.serial_item_id = item.id
    where link.pending_id = p_pending_id
    for update
  loop
    if unit_record.status <> 'instalacao_termo_pendente' then
      raise exception 'A unidade % não está aguardando termo. Situação atual: %',
        coalesce(unit_record.asset_tag, unit_record.mac_address, unit_record.serial_number), unit_record.status;
    end if;
    insert into public.serial_movements(
      serial_item_id, action, previous_status, new_status, from_location_id,
      recipient, customer_name, customer_reference, work_order, note,
      stock_impact, pending_id, created_by, created_at
    ) values (
      unit_record.id, 'termo_recebido', unit_record.status, 'instalado_cliente', unit_record.current_location_id,
      trim(p_received_by), unit_record.customer_name, unit_record.customer_reference, unit_record.work_order,
      nullif(trim(coalesce(p_note, '')), ''), 0, p_pending_id, auth.uid(), event_time
    );
    update public.serial_items
    set status = 'instalado_cliente',
        current_location_id = null,
        current_technician = null,
        due_at = null,
        term_received_at = event_time,
        term_received_by = trim(p_received_by),
        updated_at = now()
    where id = unit_record.id;
  end loop;

  update public.technician_pendencies
  set resolution = 'utilizado',
      finalized_at = event_time,
      term_received_at = event_time,
      term_received_by = trim(p_received_by),
      note = coalesce(nullif(trim(coalesce(p_note, '')), ''), note),
      updated_at = now()
  where id = p_pending_id
  returning * into saved_pending;

  insert into public.technician_pending_events(
    pending_id, event_type, from_technician, customer_name, work_order, note, created_by, occurred_at
  ) values (
    p_pending_id, 'termo_recebido', pending.technician_name, pending.installation_customer,
    pending.installation_work_order, concat('Termo recebido por ', trim(p_received_by),
      case when nullif(trim(coalesce(p_note, '')), '') is null then '' else ': ' || trim(p_note) end),
    auth.uid(), event_time
  );
  return saved_pending;
end $$;

grant execute on function public.register_integrated_pending_installation(uuid,uuid,text,text,timestamptz,text) to authenticated;
grant execute on function public.confirm_integrated_pending_term(uuid,text,timestamptz,text) to authenticated;

commit;
