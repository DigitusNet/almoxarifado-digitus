-- Recebimento de mercadorias por fornecedor e nota fiscal.
-- Execute este arquivo inteiro no SQL Editor do Supabase.

create table if not exists public.receipts (
  id uuid primary key default gen_random_uuid(),
  supplier text not null,
  invoice_number text,
  note text,
  received_at timestamptz not null default now(),
  created_by uuid references public.profiles(id) on delete set null
);

create table if not exists public.receipt_items (
  id uuid primary key default gen_random_uuid(),
  receipt_id uuid not null references public.receipts(id) on delete restrict,
  product_id uuid not null references public.products(id) on delete restrict,
  product_name text not null,
  product_code text not null,
  quantity numeric(12,3) not null check (quantity > 0),
  unit_of_measure text not null default 'unidade',
  created_at timestamptz not null default now()
);

create index if not exists receipt_items_receipt_id_idx on public.receipt_items (receipt_id);

alter table public.receipts enable row level security;
alter table public.receipt_items enable row level security;

drop policy if exists "Authenticated users can view receipts" on public.receipts;
create policy "Authenticated users can view receipts"
  on public.receipts for select to authenticated using (true);

drop policy if exists "Authenticated users can view receipt items" on public.receipt_items;
create policy "Authenticated users can view receipt items"
  on public.receipt_items for select to authenticated using (true);

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
  line_note text;
begin
  if auth.uid() is null or coalesce(public.current_user_role()::text, '') not in ('admin', 'operador') then
    raise exception 'Apenas administradores e operadores podem registrar recebimentos';
  end if;

  if nullif(trim(coalesce(p_supplier, '')), '') is null then
    raise exception 'Informe o fornecedor';
  end if;

  if jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) = 0 then
    raise exception 'Adicione pelo menos um material ao recebimento';
  end if;

  insert into public.receipts (supplier, invoice_number, note, created_by)
  values (
    trim(p_supplier),
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
      'Recebimento: ' || trim(p_supplier),
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

grant execute on function public.record_receipt(text, text, text, jsonb) to authenticated;
