-- Controle financeiro do estoque por custo médio.
-- Execute este arquivo inteiro no SQL Editor do Supabase.

alter table public.products
  add column if not exists average_cost numeric(12,2);

update public.products
set average_cost = 0
where average_cost is null;

alter table public.products
  alter column average_cost set default 0,
  alter column average_cost set not null;

alter table public.receipts
  add column if not exists supplier_id uuid references public.suppliers(id) on delete set null;

alter table public.receipt_items
  add column if not exists unit_cost numeric(12,2) not null default 0;

create or replace function public.record_receipt(
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
  receipt_id uuid;
  entry jsonb;
  product_record public.products;
  item_product_id uuid;
  item_quantity numeric(12,3);
  item_unit_cost numeric(12,2);
  new_average_cost numeric(12,2);
  line_note text;
begin
  if auth.uid() is null or coalesce(public.current_user_role()::text, '') not in ('admin', 'operador') then
    raise exception 'Apenas administradores e operadores podem registrar recebimentos';
  end if;
  if nullif(trim(coalesce(p_supplier, '')), '') is null then raise exception 'Informe o fornecedor'; end if;
  if jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) = 0 then raise exception 'Adicione pelo menos um material ao recebimento'; end if;

  insert into public.receipts (supplier, invoice_number, note, created_by)
  values (trim(p_supplier), nullif(trim(p_invoice_number), ''), nullif(trim(p_note), ''), auth.uid())
  returning id into receipt_id;

  for entry in select value from jsonb_array_elements(p_items)
  loop
    item_product_id := (entry ->> 'product_id')::uuid;
    item_quantity := (entry ->> 'quantity')::numeric;
    item_unit_cost := coalesce(nullif(entry ->> 'unit_cost', '')::numeric, 0);
    line_note := nullif(trim(entry ->> 'note'), '');
    if item_quantity <= 0 then raise exception 'A quantidade recebida deve ser maior que zero'; end if;
    if item_unit_cost < 0 then raise exception 'O valor unitário não pode ser negativo'; end if;

    select * into product_record from public.products where id = item_product_id for update;
    if not found then raise exception 'Produto não encontrado'; end if;
    if product_record.tracking_mode = 'serializado' then raise exception 'O item % exige Serial/MAC. Cadastre cada unidade na tela Serial / MAC.', product_record.name; end if;

    new_average_cost := round(((product_record.stock * product_record.average_cost) + (item_quantity * item_unit_cost)) / (product_record.stock + item_quantity), 2);
    update public.products
    set stock = stock + item_quantity, average_cost = new_average_cost, updated_at = now()
    where id = product_record.id;

    insert into public.receipt_items (receipt_id, product_id, product_name, product_code, quantity, unit_of_measure, unit_cost)
    values (receipt_id, product_record.id, product_record.name, product_record.code, item_quantity, product_record.unit_of_measure, item_unit_cost);

    insert into public.movements (product_id, movement_type, quantity, recipient, note, holder_type, field_usage, created_by)
    values (product_record.id, 'entrada', item_quantity, 'Recebimento: ' || trim(p_supplier), concat_ws(' · ', case when nullif(trim(p_invoice_number), '') is not null then 'NF: ' || trim(p_invoice_number) end, line_note, nullif(trim(p_note), '')), 'outro', false, auth.uid());
  end loop;
  return receipt_id;
end;
$$;

create or replace function public.record_receipt(
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
  supplier_name text;
  item_product_id uuid;
  item_quantity numeric(12,3);
  item_unit_cost numeric(12,2);
  new_average_cost numeric(12,2);
  line_note text;
begin
  if auth.uid() is null or coalesce(public.current_user_role()::text, '') not in ('admin', 'operador') then
    raise exception 'Apenas administradores e operadores podem registrar recebimentos';
  end if;
  select name into supplier_name from public.suppliers where id = p_supplier_id and active = true;
  if supplier_name is null then raise exception 'Selecione um fornecedor ativo'; end if;
  if jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) = 0 then raise exception 'Adicione pelo menos um material ao recebimento'; end if;

  insert into public.receipts (supplier, supplier_id, invoice_number, note, created_by)
  values (supplier_name, p_supplier_id, nullif(trim(p_invoice_number), ''), nullif(trim(p_note), ''), auth.uid())
  returning id into receipt_id;

  for entry in select value from jsonb_array_elements(p_items)
  loop
    item_product_id := (entry ->> 'product_id')::uuid;
    item_quantity := (entry ->> 'quantity')::numeric;
    item_unit_cost := coalesce(nullif(entry ->> 'unit_cost', '')::numeric, 0);
    line_note := nullif(trim(entry ->> 'note'), '');
    if item_quantity <= 0 then raise exception 'A quantidade recebida deve ser maior que zero'; end if;
    if item_unit_cost < 0 then raise exception 'O valor unitário não pode ser negativo'; end if;

    select * into product_record from public.products where id = item_product_id for update;
    if not found then raise exception 'Produto não encontrado'; end if;
    if product_record.tracking_mode = 'serializado' then raise exception 'O item % exige Serial/MAC. Cadastre cada unidade na tela Serial / MAC.', product_record.name; end if;

    new_average_cost := round(((product_record.stock * product_record.average_cost) + (item_quantity * item_unit_cost)) / (product_record.stock + item_quantity), 2);
    update public.products
    set stock = stock + item_quantity, average_cost = new_average_cost, updated_at = now()
    where id = product_record.id;

    insert into public.receipt_items (receipt_id, product_id, product_name, product_code, quantity, unit_of_measure, unit_cost)
    values (receipt_id, product_record.id, product_record.name, product_record.code, item_quantity, product_record.unit_of_measure, item_unit_cost);

    insert into public.movements (product_id, movement_type, quantity, recipient, note, holder_type, field_usage, created_by)
    values (product_record.id, 'entrada', item_quantity, 'Recebimento: ' || supplier_name, concat_ws(' · ', case when nullif(trim(p_invoice_number), '') is not null then 'NF: ' || trim(p_invoice_number) end, line_note, nullif(trim(p_note), '')), 'outro', false, auth.uid());
  end loop;
  return receipt_id;
end;
$$;

grant execute on function public.record_receipt(text, text, text, jsonb) to authenticated;
grant execute on function public.record_receipt(uuid, text, text, jsonb) to authenticated;
