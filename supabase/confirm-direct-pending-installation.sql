-- Confirma diretamente a instalação após o recebimento físico do termo.
-- Execute uma única vez no SQL Editor do Supabase.
-- Não altera pendências, unidades ou movimentações já existentes.

begin;

create or replace function public.confirm_integrated_pending_installation(
  p_operation_id uuid,
  p_pending_id uuid,
  p_customer_name text default null,
  p_note text default null
) returns public.technician_pendencies
language plpgsql security definer set search_path = public as $$
declare
  pending public.technician_pendencies;
  saved_pending public.technician_pendencies;
  unit_record public.serial_items;
  saved_operation public.stock_operation_idempotency;
  claimed_id uuid;
  event_time timestamptz := now();
  linked_count integer;
  payload jsonb := jsonb_build_object(
    'pending_id', p_pending_id,
    'customer_name', p_customer_name,
    'note', p_note
  );
begin
  if auth.uid() is null or coalesce(public.current_user_role()::text, '') not in ('admin', 'operador') then
    raise exception 'Apenas administradores e operadores podem confirmar instalações';
  end if;
  if p_operation_id is null then raise exception 'Identificador da operação não informado'; end if;

  insert into public.stock_operation_idempotency(operation_id, operation_type, request_payload, created_by)
  values(p_operation_id, 'confirmacao_instalacao', payload, auth.uid())
  on conflict(operation_id) do nothing
  returning operation_id into claimed_id;

  if claimed_id is null then
    select * into saved_operation from public.stock_operation_idempotency where operation_id = p_operation_id;
    if saved_operation.operation_type <> 'confirmacao_instalacao'
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
  select count(*) into linked_count from public.technician_pending_items where pending_id = p_pending_id;
  if linked_count = 0 then raise exception 'Esta pendência não possui equipamento individual vinculado'; end if;

  for unit_record in
    select item.*
    from public.serial_items item
    join public.technician_pending_items link on link.serial_item_id = item.id
    where link.pending_id = p_pending_id
    for update
  loop
    if unit_record.status not in ('com_colaborador', 'instalacao_termo_pendente') then
      raise exception 'A unidade % não está com o técnico. Situação atual: %',
        coalesce(unit_record.asset_tag, unit_record.mac_address, unit_record.serial_number), unit_record.status;
    end if;
    insert into public.serial_movements(
      serial_item_id, action, previous_status, new_status, from_location_id,
      recipient, customer_name, customer_reference, work_order, note,
      stock_impact, pending_id, created_by, created_at
    ) values (
      unit_record.id, 'instalacao', unit_record.status, 'instalado_cliente', unit_record.current_location_id,
      pending.technician_name, nullif(trim(coalesce(p_customer_name, '')), ''),
      nullif(trim(coalesce(p_customer_name, '')), ''), unit_record.work_order,
      nullif(trim(coalesce(p_note, '')), ''), 0, p_pending_id, auth.uid(), event_time
    );
    update public.serial_items
    set status = 'instalado_cliente',
        current_location_id = null,
        current_technician = null,
        installation_technician = pending.technician_name,
        installed_at = event_time,
        customer_name = coalesce(nullif(trim(coalesce(p_customer_name, '')), ''), customer_name),
        customer_reference = coalesce(nullif(trim(coalesce(p_customer_name, '')), ''), customer_reference),
        due_at = null,
        updated_at = now()
    where id = unit_record.id;
  end loop;

  update public.technician_pendencies
  set resolution = 'utilizado',
      finalized_at = event_time,
      installed_at = event_time,
      installation_customer = coalesce(nullif(trim(coalesce(p_customer_name, '')), ''), installation_customer),
      note = coalesce(nullif(trim(coalesce(p_note, '')), ''), note),
      updated_at = now()
  where id = p_pending_id
  returning * into saved_pending;

  if not exists (
    select 1 from public.technician_pending_events
    where pending_id = p_pending_id and event_type = 'utilizacao'
  ) then
    insert into public.technician_pending_events(
      pending_id, event_type, from_technician, customer_name, note, created_by, occurred_at
    ) values (
      p_pending_id, 'utilizacao', pending.technician_name,
      nullif(trim(coalesce(p_customer_name, '')), ''), nullif(trim(coalesce(p_note, '')), ''), auth.uid(), event_time
    );
  end if;

  update public.stock_operation_idempotency
  set result_id = saved_pending.id, completed_at = now()
  where operation_id = p_operation_id;
  return saved_pending;
end $$;

grant execute on function public.confirm_integrated_pending_installation(uuid,uuid,text,text) to authenticated;
revoke execute on function public.register_integrated_pending_installation(uuid,uuid,text,text,timestamptz,text) from authenticated;
revoke execute on function public.confirm_integrated_pending_term(uuid,text,timestamptz,text) from authenticated;

commit;
