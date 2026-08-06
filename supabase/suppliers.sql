-- Cadastro de fornecedores e vínculo com recebimentos.
-- Execute este arquivo inteiro no SQL Editor do Supabase.

create table if not exists public.suppliers (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  cnpj text,
  contact_name text,
  phone text,
  email text,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists suppliers_name_unique
  on public.suppliers (lower(name));

create unique index if not exists suppliers_cnpj_unique
  on public.suppliers (cnpj) where cnpj is not null;

alter table public.suppliers enable row level security;

drop policy if exists "Authenticated users can view suppliers" on public.suppliers;
create policy "Authenticated users can view suppliers"
  on public.suppliers for select to authenticated using (true);

drop policy if exists "Admins and operators manage suppliers" on public.suppliers;
create policy "Admins and operators manage suppliers"
  on public.suppliers for all to authenticated
  using (public.current_user_role() in ('admin', 'operador'))
  with check (public.current_user_role() in ('admin', 'operador'));

alter table public.receipts
  add column if not exists supplier_id uuid references public.suppliers(id) on delete set null;

create index if not exists receipts_supplier_id_idx on public.receipts (supplier_id);

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
  line_note text;
begin
  if auth.uid() is null or coalesce(public.current_user_role()::text, '') not in ('admin', 'operador') then
    raise exception 'Apenas administradores e operadores podem registrar recebimentos';
  end if;

  select name into supplier_name
  from public.suppliers
  where id = p_supplier_id and active = true;
  if supplier_name is null then raise exception 'Selecione um fornecedor ativo'; end if;

  if jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) = 0 then
    raise exception 'Adicione pelo menos um material ao recebimento';
  end if;

  insert into public.receipts (supplier, supplier_id, invoice_number, note, created_by)
  values (
    supplier_name,
    p_supplier_id,
    nullif(trim(p_invoice_number), ''),
    nullif(trim(p_note), ''),
    auth.uid()
  ) returning id into receipt_id;

  for entry in select value from jsonb_array_elements(p_items)
  loop
    item_product_id := (entry ->> 'product_id')::uuid;
    item_quantity := (entry ->> 'quantity')::numeric;
    line_note := nullif(trim(entry ->> 'note'), '');

    if item_quantity <= 0 then
      raise exception 'A quantidade recebida deve ser maior que zero';
    end if;

    select * into product_record
    from public.products
    where id = item_product_id
    for update;

    if not found then raise exception 'Produto não encontrado'; end if;
    if product_record.tracking_mode = 'serializado' then
      raise exception 'O item % exige Serial/MAC. Cadastre cada unidade na tela Serial / MAC.', product_record.name;
    end if;

    update public.products
    set stock = stock + item_quantity,
        updated_at = now()
    where id = product_record.id;

    insert into public.receipt_items (
      receipt_id, product_id, product_name, product_code, quantity, unit_of_measure
    ) values (
      receipt_id, product_record.id, product_record.name, product_record.code,
      item_quantity, product_record.unit_of_measure
    );

    insert into public.movements (
      product_id, movement_type, quantity, recipient, note, holder_type, field_usage, created_by
    ) values (
      product_record.id,
      'entrada',
      item_quantity,
      'Recebimento: ' || supplier_name,
      concat_ws(' · ',
        case when nullif(trim(p_invoice_number), '') is not null then 'NF: ' || trim(p_invoice_number) end,
        line_note,
        nullif(trim(p_note), '')
      ),
      'outro',
      false,
      auth.uid()
    );
  end loop;

  return receipt_id;
end;
$$;

grant execute on function public.record_receipt(uuid, text, text, jsonb) to authenticated;
