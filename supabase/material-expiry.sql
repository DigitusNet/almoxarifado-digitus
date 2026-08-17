-- Validade de materiais por lote.
-- Execute este arquivo inteiro uma única vez no SQL Editor do Supabase.

alter table public.receipt_items
  add column if not exists batch_number text,
  add column if not exists expiry_date date;

create index if not exists receipt_items_expiry_date_idx
  on public.receipt_items (expiry_date)
  where expiry_date is not null;

-- Atualiza o recebimento para gravar lote e validade informados no sistema.
create or replace function public._record_receipt(
  p_supplier_name text,
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
  receipt_id uuid;
  entry jsonb;
  product_record public.products;
  item_product_id uuid;
  item_quantity numeric(12,3);
  item_unit_cost numeric(12,2);
  item_batch_number text;
  item_expiry_date date;
  new_average_cost numeric(12,2);
  line_note text;
  source_key text;
begin
  if auth.uid() is null or coalesce(public.current_user_role()::text, '') not in ('admin', 'operador') then
    raise exception 'Apenas administradores e operadores podem registrar recebimentos';
  end if;
  if nullif(trim(coalesce(p_supplier_name, '')), '') is null then
    raise exception 'Informe o fornecedor';
  end if;
  if jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) = 0 then
    raise exception 'Adicione pelo menos um material ao recebimento';
  end if;

  source_key := public.receipt_fingerprint(p_supplier_name, p_invoice_number);
  if source_key is not null and exists (
    select 1
    from public.receipts
    where source_fingerprint = source_key
      or (
        source_fingerprint is null
        and lower(trim(supplier)) = lower(trim(p_supplier_name))
        and lower(trim(coalesce(invoice_number, ''))) = lower(trim(coalesce(p_invoice_number, '')))
      )
  ) then
    raise exception 'Esta nota fiscal já foi registrada para este fornecedor.';
  end if;

  insert into public.receipts (supplier, supplier_id, invoice_number, note, created_by, source_fingerprint)
  values (
    trim(p_supplier_name), p_supplier_id, nullif(trim(p_invoice_number), ''),
    nullif(trim(p_note), ''), auth.uid(), source_key
  ) returning id into receipt_id;

  for entry in select value from jsonb_array_elements(p_items)
  loop
    if nullif(trim(coalesce(entry ->> 'product_id', '')), '') is null then
      raise exception 'Selecione um produto para cada material recebido';
    end if;
    item_product_id := (entry ->> 'product_id')::uuid;
    item_quantity := (entry ->> 'quantity')::numeric;
    item_unit_cost := coalesce(nullif(entry ->> 'unit_cost', '')::numeric, 0);
    item_batch_number := nullif(trim(entry ->> 'batch_number'), '');
    item_expiry_date := nullif(trim(entry ->> 'expiry_date'), '')::date;
    line_note := nullif(trim(entry ->> 'note'), '');
    if item_quantity <= 0 then raise exception 'A quantidade recebida deve ser maior que zero'; end if;
    if item_unit_cost < 0 then raise exception 'O valor unitário não pode ser negativo'; end if;

    select * into product_record
    from public.products
    where id = item_product_id and is_active = true
    for update;
    if not found then raise exception 'Produto não encontrado ou arquivado'; end if;
    if product_record.tracking_mode = 'serializado' then
      raise exception 'O item % exige Serial/MAC. Cadastre cada unidade na tela Serial / MAC.', product_record.name;
    end if;

    new_average_cost := round(((product_record.stock * product_record.average_cost) + (item_quantity * item_unit_cost)) / (product_record.stock + item_quantity), 2);
    update public.products
    set stock = stock + item_quantity, average_cost = new_average_cost, updated_at = now()
    where id = product_record.id;

    insert into public.receipt_items (
      receipt_id, product_id, product_name, product_code, quantity, unit_of_measure, unit_cost,
      batch_number, expiry_date
    ) values (
      receipt_id, product_record.id, product_record.name, product_record.code, item_quantity, product_record.unit_of_measure, item_unit_cost,
      item_batch_number, item_expiry_date
    );

    insert into public.movements (product_id, movement_type, quantity, recipient, note, holder_type, field_usage, created_by)
    values (
      product_record.id, 'entrada', item_quantity, 'Recebimento: ' || trim(p_supplier_name),
      concat_ws(' · ', case when nullif(trim(p_invoice_number), '') is not null then 'NF: ' || trim(p_invoice_number) end, line_note, nullif(trim(p_note), '')),
      'outro', false, auth.uid()
    );
  end loop;

  return receipt_id;
end;
$$;
