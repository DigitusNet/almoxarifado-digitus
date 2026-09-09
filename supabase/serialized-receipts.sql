-- Recebimentos transacionais de produtos por quantidade e por MAC/Serial.
-- Migração aditiva: não altera registros, saldos ou históricos existentes.
begin;

alter table public.serial_items
  add column if not exists receipt_id uuid references public.receipts(id) on delete set null;

create index if not exists serial_items_receipt_id_idx
  on public.serial_items(receipt_id) where receipt_id is not null;

create or replace function public.record_integrated_receipt_idempotent(
  p_operation_id uuid,
  p_supplier text,
  p_supplier_id uuid default null,
  p_invoice_number text default null,
  p_note text default null,
  p_items jsonb default '[]'::jsonb
) returns uuid
language plpgsql
security definer
set search_path=public
as $$
declare
  claimed_id uuid;
  previous_operation public.stock_operation_idempotency;
  payload jsonb;
  saved_receipt_id uuid;
  supplier_name text;
  source_key text;
  entry jsonb;
  unit_entry jsonb;
  product_record public.products;
  item_product_id uuid;
  item_quantity numeric(12,3);
  item_unit_cost numeric(12,2);
  unit_count integer;
  new_average_cost numeric(12,2);
  central_location_id uuid;
  normalized_mac text;
  normalized_serial text;
  normalized_asset text;
begin
  if auth.uid() is null or coalesce(public.current_user_role()::text,'') not in ('admin','operador') then
    raise exception 'Apenas administradores e operadores podem registrar recebimentos';
  end if;
  if p_operation_id is null then raise exception 'Identificador da operação não informado'; end if;
  -- Serializa apenas novos recebimentos integrados para fechar a janela de corrida
  -- entre a validação amigável e a inclusão dos identificadores.
  perform pg_advisory_xact_lock(hashtextextended('integrated-receipt-identifiers',0));

  if p_supplier_id is not null then
    select name into supplier_name from public.suppliers where id=p_supplier_id and active=true;
    if supplier_name is null then raise exception 'Selecione um fornecedor ativo'; end if;
  else
    supplier_name:=nullif(trim(coalesce(p_supplier,'')),'');
    if supplier_name is null then raise exception 'Informe o fornecedor'; end if;
  end if;
  if jsonb_typeof(p_items)<>'array' or jsonb_array_length(p_items)=0 then raise exception 'Adicione pelo menos um material ao recebimento'; end if;

  payload:=jsonb_build_object('supplier',supplier_name,'supplier_id',p_supplier_id,'invoice_number',p_invoice_number,'note',p_note,'items',p_items);
  insert into public.stock_operation_idempotency(operation_id,operation_type,request_payload,created_by)
  values(p_operation_id,'recebimento',payload,auth.uid()) on conflict(operation_id) do nothing returning operation_id into claimed_id;
  if claimed_id is null then
    select * into previous_operation from public.stock_operation_idempotency where operation_id=p_operation_id;
    if previous_operation.operation_type<>'recebimento' or previous_operation.created_by<>auth.uid() or previous_operation.request_payload<>payload then
      raise exception 'A identificação desta operação já foi utilizada com outros dados';
    end if;
    if previous_operation.result_id is null then raise exception 'A operação anterior ainda está sendo processada'; end if;
    return previous_operation.result_id;
  end if;

  source_key:=public.receipt_fingerprint(supplier_name,p_invoice_number);
  if source_key is not null and exists(select 1 from public.receipts where source_fingerprint=source_key or (source_fingerprint is null and lower(trim(supplier))=lower(trim(supplier_name)) and lower(trim(coalesce(invoice_number,'')))=lower(trim(coalesce(p_invoice_number,''))))) then
    raise exception 'Esta nota fiscal já foi registrada para este fornecedor.';
  end if;

  select id into central_location_id from public.stock_locations where location_type='central' and active=true order by created_at limit 1;
  insert into public.receipts(supplier,supplier_id,invoice_number,note,created_by,source_fingerprint)
  values(supplier_name,p_supplier_id,nullif(trim(coalesce(p_invoice_number,'')),''),nullif(trim(coalesce(p_note,'')),''),auth.uid(),source_key)
  returning id into saved_receipt_id;

  for entry in select value from jsonb_array_elements(p_items) loop
    item_product_id:=(entry->>'product_id')::uuid;
    item_quantity:=(entry->>'quantity')::numeric;
    item_unit_cost:=coalesce(nullif(entry->>'unit_cost','')::numeric,0);
    if item_quantity<=0 then raise exception 'A quantidade recebida deve ser maior que zero'; end if;
    if item_unit_cost<0 then raise exception 'O valor unitário não pode ser negativo'; end if;
    select * into product_record from public.products where id=item_product_id and is_active=true for update;
    if not found then raise exception 'Produto não encontrado ou arquivado'; end if;

    if product_record.tracking_mode='serializado' then
      if item_quantity<>trunc(item_quantity) then raise exception 'A quantidade de % deve ser inteira',product_record.name; end if;
      if jsonb_typeof(coalesce(entry->'units','[]'::jsonb))<>'array' then raise exception 'Identificações inválidas para %',product_record.name; end if;
      unit_count:=jsonb_array_length(coalesce(entry->'units','[]'::jsonb));
      if unit_count<>item_quantity::integer then
        raise exception 'Existem % equipamentos que ainda não foram identificados. Cadastre MAC, Serial e Patrimônio antes de finalizar o recebimento.',item_quantity::integer-unit_count;
      end if;
      for unit_entry in select value from jsonb_array_elements(entry->'units') loop
        normalized_mac:=nullif(trim(unit_entry->>'mac'),'');
        normalized_serial:=nullif(trim(unit_entry->>'serial_number'),'');
        normalized_asset:=nullif(trim(unit_entry->>'asset_tag'),'');
        if normalized_mac is null then raise exception 'Todas as unidades de % precisam de MAC',product_record.name; end if;
        if normalized_serial is null then raise exception 'Todas as unidades de % precisam de Serial',product_record.name; end if;
        if normalized_asset is null then raise exception 'Todas as unidades de % precisam de Patrimônio',product_record.name; end if;
        if exists(select 1 from public.serial_items where regexp_replace(lower(mac_address),'[^a-z0-9]','','g')=regexp_replace(lower(normalized_mac),'[^a-z0-9]','','g')) then raise exception 'O MAC % já está cadastrado no sistema.',normalized_mac; end if;
        if exists(select 1 from public.serial_items where lower(trim(serial_number))=lower(normalized_serial)) then raise exception 'O serial % já está cadastrado no sistema.',normalized_serial; end if;
        if exists(select 1 from public.serial_items where lower(trim(asset_tag))=lower(normalized_asset)) then raise exception 'O patrimônio % já está cadastrado no sistema.',normalized_asset; end if;
        insert into public.serial_items(product_id,serial_number,mac_address,asset_tag,status,current_location_id,notes,receipt_id)
        values(product_record.id,normalized_serial,normalized_mac,normalized_asset,'disponivel',central_location_id,
          concat_ws(' · ','Entrada pelo recebimento #'||saved_receipt_id::text,case when nullif(trim(coalesce(p_invoice_number,'')),'') is not null then 'NF '||trim(p_invoice_number) end,'Fornecedor: '||supplier_name),saved_receipt_id);
      end loop;
    elsif coalesce(jsonb_array_length(coalesce(entry->'units','[]'::jsonb)),0)>0 then
      raise exception 'O produto % é controlado por quantidade e não aceita identificações individuais',product_record.name;
    end if;

    new_average_cost:=case when product_record.stock+item_quantity=0 then item_unit_cost else round(((product_record.stock*coalesce(product_record.average_cost,0))+(item_quantity*item_unit_cost))/(product_record.stock+item_quantity),2) end;
    update public.products set stock=stock+item_quantity,average_cost=new_average_cost,updated_at=now() where id=product_record.id;
    insert into public.receipt_items(receipt_id,product_id,product_name,product_code,quantity,unit_of_measure,unit_cost,batch_number,expiry_date)
    values(saved_receipt_id,product_record.id,product_record.name,product_record.code,item_quantity,product_record.unit_of_measure,item_unit_cost,
      nullif(trim(entry->>'batch_number'),''),nullif(entry->>'expiry_date','')::date);
    insert into public.movements(product_id,movement_type,quantity,recipient,note,holder_type,field_usage,stock_impact,stock_before,stock_after,created_by)
    values(product_record.id,'entrada',item_quantity,'Recebimento: '||supplier_name,
      concat_ws(' · ',case when nullif(trim(coalesce(p_invoice_number,'')),'') is not null then 'NF: '||trim(p_invoice_number) end,nullif(trim(entry->>'note'),''),nullif(trim(coalesce(p_note,'')),'')),
      'outro',false,item_quantity,product_record.stock,product_record.stock+item_quantity,auth.uid());
  end loop;

  update public.stock_operation_idempotency set result_id=saved_receipt_id,completed_at=now() where operation_id=p_operation_id;
  return saved_receipt_id;
end $$;

grant execute on function public.record_integrated_receipt_idempotent(uuid,text,uuid,text,text,jsonb) to authenticated;
commit;
