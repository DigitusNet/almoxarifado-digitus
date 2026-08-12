-- Segurança de recebimentos, XML e remoção de produtos.
-- Execute este arquivo inteiro no SQL Editor do Supabase.

alter table public.products
  add column if not exists is_active boolean,
  add column if not exists archived_at timestamptz,
  add column if not exists archived_by uuid references public.profiles(id) on delete set null;

update public.products set is_active = true where is_active is null;

alter table public.products
  alter column is_active set default true,
  alter column is_active set not null;

alter table public.receipts
  add column if not exists source_fingerprint text;

create unique index if not exists receipts_source_fingerprint_unique
  on public.receipts (source_fingerprint)
  where source_fingerprint is not null;

drop policy if exists "Admins can delete products" on public.products;

create or replace function public.receipt_fingerprint(p_supplier text, p_invoice_number text)
returns text
language sql
immutable
as $$
  select case
    when nullif(trim(coalesce(p_invoice_number, '')), '') is null then null
    else lower(trim(coalesce(p_supplier, ''))) || '|' || lower(trim(p_invoice_number))
  end
$$;

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

    insert into public.receipt_items (receipt_id, product_id, product_name, product_code, quantity, unit_of_measure, unit_cost)
    values (receipt_id, product_record.id, product_record.name, product_record.code, item_quantity, product_record.unit_of_measure, item_unit_cost);

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
begin
  return public._record_receipt(p_supplier, null, p_invoice_number, p_note, p_items);
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
  supplier_name text;
begin
  select name into supplier_name from public.suppliers where id = p_supplier_id and active = true;
  if supplier_name is null then raise exception 'Selecione um fornecedor ativo'; end if;
  return public._record_receipt(supplier_name, p_supplier_id, p_invoice_number, p_note, p_items);
end;
$$;

create or replace function public.import_xml_receipt(
  p_supplier text,
  p_invoice_number text,
  p_note text default null,
  p_items jsonb default '[]'::jsonb
) returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  entry jsonb;
  product_record public.products;
  item_product_id uuid;
  item_name text;
  item_code text;
  item_unit text;
  supplier_id uuid;
  prepared_items jsonb := '[]'::jsonb;
begin
  if auth.uid() is null or coalesce(public.current_user_role()::text, '') not in ('admin', 'operador') then
    raise exception 'Apenas administradores e operadores podem importar notas fiscais';
  end if;
  if nullif(trim(coalesce(p_supplier, '')), '') is null then raise exception 'Informe o fornecedor'; end if;
  if nullif(trim(coalesce(p_invoice_number, '')), '') is null then raise exception 'Informe o número da nota fiscal'; end if;
  if jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) = 0 then raise exception 'Escolha ao menos um item para importar'; end if;

  for entry in select value from jsonb_array_elements(p_items)
  loop
    if nullif(trim(coalesce(entry ->> 'product_id', '')), '') is not null then
      item_product_id := (entry ->> 'product_id')::uuid;
      select * into product_record
      from public.products
      where id = item_product_id and is_active = true
      for update;
      if not found then raise exception 'Produto selecionado não foi encontrado ou está arquivado'; end if;
    else
      item_name := coalesce(nullif(trim(entry ->> 'product_name'), ''), 'Item sem descrição');
      item_code := nullif(trim(entry ->> 'product_code'), '');
      if item_code is null then raise exception 'O item % não possui código para cadastro automático', item_name; end if;
      item_unit := case lower(trim(coalesce(entry ->> 'unit_of_measure', '')))
        when 'metro' then 'metro'
        when 'par' then 'par'
        when 'caixa' then 'caixa'
        else 'unidade'
      end;

      select * into product_record
      from public.products
      where lower(trim(code)) = lower(item_code)
      for update;

      if found then
        if product_record.is_active = false then
          update public.products
          set is_active = true, archived_at = null, archived_by = null, updated_at = now()
          where id = product_record.id
          returning * into product_record;
        end if;
      else
        insert into public.products (
          name, code, category, stock, minimum_stock, unit_of_measure, tracking_mode,
          description, average_cost, is_active
        ) values (
          item_name, item_code, 'Produtos', 0, 0, item_unit, 'quantidade',
          'Cadastrado automaticamente pela importação de NF-e', coalesce(nullif(entry ->> 'unit_cost', '')::numeric, 0), true
        ) returning * into product_record;
      end if;
    end if;

    prepared_items := prepared_items || jsonb_build_array(jsonb_build_object(
      'product_id', product_record.id,
      'quantity', entry -> 'quantity',
      'unit_cost', coalesce(entry -> 'unit_cost', '0'::jsonb)
    ));
  end loop;

  select id into supplier_id
  from public.suppliers
  where active = true and lower(trim(name)) = lower(trim(p_supplier))
  limit 1;

  return public._record_receipt(p_supplier, supplier_id, p_invoice_number, p_note, prepared_items);
end;
$$;

create or replace function public.delete_or_archive_product(p_product_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  target_product public.products;
  has_history boolean;
begin
  if auth.uid() is null or coalesce(public.current_user_role()::text, '') <> 'admin' then
    raise exception 'Apenas administradores podem remover produtos';
  end if;

  select * into target_product from public.products where id = p_product_id for update;
  if not found then raise exception 'Produto não encontrado'; end if;

  select (
    exists (select 1 from public.movements where product_id = p_product_id)
    or exists (select 1 from public.receipt_items where product_id = p_product_id)
    or exists (select 1 from public.inventory_counts where product_id = p_product_id)
    or exists (select 1 from public.serial_items where product_id = p_product_id)
  ) into has_history;

  if has_history then
    update public.products
    set is_active = false, archived_at = now(), archived_by = auth.uid(), updated_at = now()
    where id = p_product_id;
    return jsonb_build_object('action', 'archived');
  end if;

  delete from public.products where id = p_product_id;
  return jsonb_build_object('action', 'deleted', 'image_path', target_product.image_path);
end;
$$;

revoke all on function public._record_receipt(text, uuid, text, text, jsonb) from public;
grant execute on function public.record_receipt(text, text, text, jsonb) to authenticated;
grant execute on function public.record_receipt(uuid, text, text, jsonb) to authenticated;
grant execute on function public.import_xml_receipt(text, text, text, jsonb) to authenticated;
grant execute on function public.delete_or_archive_product(uuid) to authenticated;
