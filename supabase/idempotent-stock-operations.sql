begin;

create table if not exists public.stock_operation_idempotency (
  operation_id uuid primary key,
  operation_type text not null,
  request_payload jsonb not null,
  result_id uuid,
  created_by uuid not null,
  created_at timestamptz not null default now(),
  completed_at timestamptz
);

alter table public.stock_operation_idempotency enable row level security;
revoke all on public.stock_operation_idempotency from public, anon, authenticated;

create or replace function public.record_movement_idempotent(
  p_operation_id uuid,
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
  claimed_id uuid;
  saved_operation public.stock_operation_idempotency;
  saved_movement public.movements;
  payload jsonb := jsonb_build_object(
    'product_id', p_product_id,
    'type', p_type,
    'quantity', p_quantity,
    'recipient', p_recipient,
    'note', p_note,
    'holder_type', p_holder_type,
    'work_order', p_work_order,
    'field_usage', p_field_usage
  );
begin
  if auth.uid() is null then raise exception 'Usuário não autenticado'; end if;
  if p_operation_id is null then raise exception 'Identificador da operação não informado'; end if;

  insert into public.stock_operation_idempotency (
    operation_id, operation_type, request_payload, created_by
  ) values (
    p_operation_id, 'movimentacao', payload, auth.uid()
  )
  on conflict (operation_id) do nothing
  returning operation_id into claimed_id;

  if claimed_id is null then
    select * into saved_operation
    from public.stock_operation_idempotency
    where operation_id = p_operation_id;

    if saved_operation.operation_type <> 'movimentacao'
       or saved_operation.created_by <> auth.uid()
       or saved_operation.request_payload <> payload then
      raise exception 'A identificação desta operação já foi utilizada com outros dados';
    end if;
    if saved_operation.result_id is null then
      raise exception 'A operação anterior ainda está sendo processada';
    end if;

    select * into saved_movement
    from public.movements
    where id = saved_operation.result_id;
    if not found then raise exception 'O resultado da operação anterior não foi encontrado'; end if;
    return saved_movement;
  end if;

  saved_movement := public.record_movement(
    p_product_id, p_type, p_quantity, p_recipient, p_note,
    p_holder_type, p_work_order, p_field_usage
  );

  update public.stock_operation_idempotency
  set result_id = saved_movement.id, completed_at = now()
  where operation_id = p_operation_id;

  return saved_movement;
end;
$$;

create or replace function public.record_receipt_idempotent(
  p_operation_id uuid,
  p_supplier text,
  p_invoice_number text default null,
  p_note text default null,
  p_items jsonb default '[]'::jsonb
) returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  claimed_id uuid;
  saved_operation public.stock_operation_idempotency;
  receipt_id uuid;
  payload jsonb := jsonb_build_object(
    'supplier', p_supplier,
    'invoice_number', p_invoice_number,
    'note', p_note,
    'items', p_items
  );
begin
  if auth.uid() is null then raise exception 'Usuário não autenticado'; end if;
  if p_operation_id is null then raise exception 'Identificador da operação não informado'; end if;

  insert into public.stock_operation_idempotency (
    operation_id, operation_type, request_payload, created_by
  ) values (
    p_operation_id, 'recebimento', payload, auth.uid()
  )
  on conflict (operation_id) do nothing
  returning operation_id into claimed_id;

  if claimed_id is null then
    select * into saved_operation from public.stock_operation_idempotency where operation_id = p_operation_id;
    if saved_operation.operation_type <> 'recebimento'
       or saved_operation.created_by <> auth.uid()
       or saved_operation.request_payload <> payload then
      raise exception 'A identificação desta operação já foi utilizada com outros dados';
    end if;
    if saved_operation.result_id is null then raise exception 'A operação anterior ainda está sendo processada'; end if;
    return saved_operation.result_id;
  end if;

  receipt_id := public.record_receipt(p_supplier, p_invoice_number, p_note, p_items);
  update public.stock_operation_idempotency set result_id = receipt_id, completed_at = now() where operation_id = p_operation_id;
  return receipt_id;
end;
$$;

create or replace function public.record_receipt_idempotent(
  p_operation_id uuid,
  p_supplier_id uuid,
  p_invoice_number text default null,
  p_note text default null,
  p_items jsonb default '[]'::jsonb
) returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  claimed_id uuid;
  saved_operation public.stock_operation_idempotency;
  receipt_id uuid;
  payload jsonb := jsonb_build_object(
    'supplier_id', p_supplier_id,
    'invoice_number', p_invoice_number,
    'note', p_note,
    'items', p_items
  );
begin
  if auth.uid() is null then raise exception 'Usuário não autenticado'; end if;
  if p_operation_id is null then raise exception 'Identificador da operação não informado'; end if;

  insert into public.stock_operation_idempotency (
    operation_id, operation_type, request_payload, created_by
  ) values (
    p_operation_id, 'recebimento', payload, auth.uid()
  )
  on conflict (operation_id) do nothing
  returning operation_id into claimed_id;

  if claimed_id is null then
    select * into saved_operation from public.stock_operation_idempotency where operation_id = p_operation_id;
    if saved_operation.operation_type <> 'recebimento'
       or saved_operation.created_by <> auth.uid()
       or saved_operation.request_payload <> payload then
      raise exception 'A identificação desta operação já foi utilizada com outros dados';
    end if;
    if saved_operation.result_id is null then raise exception 'A operação anterior ainda está sendo processada'; end if;
    return saved_operation.result_id;
  end if;

  receipt_id := public.record_receipt(p_supplier_id, p_invoice_number, p_note, p_items);
  update public.stock_operation_idempotency set result_id = receipt_id, completed_at = now() where operation_id = p_operation_id;
  return receipt_id;
end;
$$;

grant execute on function public.record_movement_idempotent(uuid, uuid, public.movement_type, numeric, text, text, text, text, boolean) to authenticated;
grant execute on function public.record_receipt_idempotent(uuid, text, text, text, jsonb) to authenticated;
grant execute on function public.record_receipt_idempotent(uuid, uuid, text, text, jsonb) to authenticated;

commit;

