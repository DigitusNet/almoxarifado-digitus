-- Integra Movimentações, Serial/MAC, pendências e histórico em transações únicas.
-- Preserva os registros existentes. Execute no SQL Editor do Supabase.

begin;

alter table public.serial_items
  add column if not exists current_technician text,
  add column if not exists withdrawn_at timestamptz,
  add column if not exists due_at timestamptz,
  add column if not exists work_order text,
  add column if not exists installation_technician text,
  add column if not exists installed_at timestamptz;

alter table public.technician_pendencies
  add column if not exists installation_customer text,
  add column if not exists installation_work_order text,
  add column if not exists installed_at timestamptz;

alter table public.technician_pending_events
  add column if not exists customer_name text,
  add column if not exists work_order text,
  add column if not exists occurred_at timestamptz;

update public.technician_pending_events set occurred_at=created_at where occurred_at is null;
alter table public.technician_pending_events alter column occurred_at set default now(), alter column occurred_at set not null;

create table if not exists public.technician_pending_items (
  pending_id uuid not null references public.technician_pendencies(id) on delete cascade,
  serial_item_id uuid not null references public.serial_items(id) on delete restrict,
  created_at timestamptz not null default now(),
  primary key (pending_id, serial_item_id)
);

drop index if exists public.technician_pending_items_open_unit_unique;
create index if not exists technician_pending_items_unit_idx
  on public.technician_pending_items (serial_item_id);

alter table public.movements add column if not exists pending_id uuid references public.technician_pendencies(id) on delete set null;
alter table public.serial_movements add column if not exists pending_id uuid references public.technician_pendencies(id) on delete set null;

update public.movements movement
set pending_id = pending.id
from public.technician_pendencies pending
where pending.movement_id = movement.id and movement.pending_id is null;

alter table public.technician_pending_items enable row level security;
drop policy if exists "Authenticated users view technician pending items" on public.technician_pending_items;
create policy "Authenticated users view technician pending items" on public.technician_pending_items
  for select to authenticated using (true);

create index if not exists movements_pending_idx on public.movements(pending_id);
create index if not exists serial_movements_pending_idx on public.serial_movements(pending_id);
create index if not exists technician_pending_events_occurred_idx on public.technician_pending_events(occurred_at desc, id desc);

-- Vincula pendências antigas que já guardavam um identificador exato. Não
-- altera estoque: a saída correspondente já fez esse desconto anteriormente.
insert into public.technician_pending_items(pending_id,serial_item_id)
select pending.id,item.id
from public.technician_pendencies pending
join public.serial_items item on item.product_id=pending.product_id
  and (nullif(trim(pending.mac_address),'') is not null or nullif(trim(pending.serial_number),'') is not null or nullif(trim(pending.asset_tag),'') is not null)
  and (nullif(trim(pending.mac_address),'') is null or lower(trim(item.mac_address))=lower(trim(pending.mac_address)))
  and (nullif(trim(pending.serial_number),'') is null or lower(trim(item.serial_number))=lower(trim(pending.serial_number)))
  and (nullif(trim(pending.asset_tag),'') is null or lower(trim(item.asset_tag))=lower(trim(pending.asset_tag)))
where pending.resolution='aberta'
  and not exists(select 1 from public.technician_pending_items existing where existing.pending_id=pending.id and existing.serial_item_id=item.id)
  and not exists(select 1 from public.technician_pending_items other_link join public.technician_pendencies other_pending on other_pending.id=other_link.pending_id where other_link.serial_item_id=item.id and other_pending.resolution='aberta' and other_pending.id<>pending.id)
on conflict do nothing;

insert into public.serial_movements(serial_item_id,action,previous_status,new_status,from_location_id,recipient,work_order,note,stock_impact,pending_id,created_by,created_at)
select item.id,'transferencia','disponivel','com_colaborador',item.current_location_id,pending.technician_name,pending.work_order,pending.note,-1,pending.id,pending.created_by,pending.withdrawn_at
from public.technician_pending_items link
join public.technician_pendencies pending on pending.id=link.pending_id and pending.resolution='aberta'
join public.serial_items item on item.id=link.serial_item_id and item.status='disponivel'
where not exists(select 1 from public.serial_movements history where history.pending_id=pending.id and history.serial_item_id=item.id);

update public.serial_items item
set status='com_colaborador',current_technician=pending.technician_name,withdrawn_at=pending.withdrawn_at,due_at=pending.due_at,work_order=pending.work_order,customer_name=null,customer_reference=null,updated_at=now()
from public.technician_pending_items link
join public.technician_pendencies pending on pending.id=link.pending_id and pending.resolution='aberta'
where item.id=link.serial_item_id and item.status='disponivel';

-- Os índices existentes já protegem os valores literais. Estes também impedem
-- duplicidade causada apenas por espaços ou diferenças entre maiúsculas/minúsculas.
create unique index if not exists serial_items_mac_normalized_unique
  on public.serial_items (lower(trim(mac_address))) where nullif(trim(mac_address),'') is not null;
create unique index if not exists serial_items_asset_normalized_unique
  on public.serial_items (lower(trim(asset_tag))) where nullif(trim(asset_tag),'') is not null;
create unique index if not exists serial_items_serial_normalized_unique
  on public.serial_items (lower(trim(serial_number))) where nullif(trim(serial_number),'') is not null;

create or replace function public.record_integrated_technician_movement(
  p_product_id uuid,
  p_quantity numeric,
  p_technician text,
  p_withdrawn_at timestamptz,
  p_due_at timestamptz,
  p_work_order text default null,
  p_note text default null,
  p_units jsonb default '[]'::jsonb
) returns public.technician_pendencies
language plpgsql security definer set search_path = public as $$
declare
  product_record public.products;
  saved_movement public.movements;
  saved_pending public.technician_pendencies;
  unit_data jsonb;
  unit_ids uuid[] := array[]::uuid[];
  resolved_id uuid;
  mac_id uuid;
  asset_id uuid;
  serial_id uuid;
  unit_record public.serial_items;
  central_location_id uuid;
  technician_location_id uuid;
  v_collaborator_id uuid;
begin
  if auth.uid() is null or coalesce(public.current_user_role()::text,'') not in ('admin','operador') then
    raise exception 'Apenas administradores e operadores podem registrar saídas';
  end if;
  if p_quantity is null or p_quantity <= 0 then raise exception 'A quantidade deve ser maior que zero'; end if;
  if nullif(trim(coalesce(p_technician,'')),'') is null then raise exception 'Informe o técnico responsável'; end if;
  if p_due_at <= p_withdrawn_at then raise exception 'O prazo deve ser posterior à retirada'; end if;

  select * into product_record from public.products where id=p_product_id and coalesce(is_active,true)=true for update;
  if not found then raise exception 'Produto não encontrado ou arquivado'; end if;
  if product_record.stock < p_quantity then raise exception 'Estoque insuficiente. Saldo atual: %', product_record.stock; end if;

  if product_record.tracking_mode = 'serializado' then
    if p_quantity <> trunc(p_quantity) then raise exception 'Produtos com controle individual exigem quantidade inteira'; end if;
    if jsonb_typeof(coalesce(p_units,'[]'::jsonb)) <> 'array' or jsonb_array_length(coalesce(p_units,'[]'::jsonb)) <> p_quantity::integer then
      raise exception 'Informe os identificadores de cada uma das % unidade(s)', p_quantity;
    end if;

    for unit_data in select value from jsonb_array_elements(p_units) loop
      resolved_id := null; mac_id := null; asset_id := null; serial_id := null;
      if nullif(trim(coalesce(unit_data->>'mac','')),'') is null
         and nullif(trim(coalesce(unit_data->>'asset_tag','')),'') is null
         and nullif(trim(coalesce(unit_data->>'serial_number','')),'') is null then
        raise exception 'Informe MAC, patrimônio ou serial para cada unidade';
      end if;

      if nullif(trim(coalesce(unit_data->>'mac','')),'') is not null then
        select id into mac_id from public.serial_items where lower(trim(mac_address))=lower(trim(unit_data->>'mac'));
        if mac_id is null then raise exception 'Equipamento não encontrado no cadastro Serial/MAC.'; end if;
        resolved_id := mac_id;
      end if;
      if nullif(trim(coalesce(unit_data->>'asset_tag','')),'') is not null then
        select id into asset_id from public.serial_items where lower(trim(asset_tag))=lower(trim(unit_data->>'asset_tag'));
        if asset_id is null then raise exception 'Equipamento não encontrado no cadastro Serial/MAC.'; end if;
        if resolved_id is not null and resolved_id <> asset_id then
          raise exception 'O MAC e o patrimônio informados pertencem a equipamentos diferentes. Verifique os dados antes de continuar.';
        end if;
        resolved_id := asset_id;
      end if;
      if nullif(trim(coalesce(unit_data->>'serial_number','')),'') is not null then
        select id into serial_id from public.serial_items where lower(trim(serial_number))=lower(trim(unit_data->>'serial_number'));
        if serial_id is null then raise exception 'Equipamento não encontrado no cadastro Serial/MAC.'; end if;
        if resolved_id is not null and resolved_id <> serial_id then raise exception 'Os identificadores informados pertencem a equipamentos diferentes.'; end if;
        resolved_id := serial_id;
      end if;
      if resolved_id = any(unit_ids) then raise exception 'A mesma unidade foi informada mais de uma vez'; end if;
      select * into unit_record from public.serial_items where id=resolved_id for update;
      if unit_record.product_id <> p_product_id then raise exception 'O equipamento informado pertence a outro produto'; end if;
      if unit_record.status <> 'disponivel' then
        if unit_record.status='instalado_cliente' then raise exception 'Este equipamento já está instalado no cliente %.', coalesce(unit_record.customer_name,'não informado'); end if;
        raise exception 'Este equipamento não está disponível para saída. Situação atual: %; responsável: %.', unit_record.status, coalesce(unit_record.current_technician,unit_record.customer_name,'não informado');
      end if;
      if exists(select 1 from public.technician_pending_items link join public.technician_pendencies pending on pending.id=link.pending_id where link.serial_item_id=resolved_id and pending.resolution='aberta') then
        raise exception 'Este equipamento já possui uma pendência aberta';
      end if;
      unit_ids := array_append(unit_ids,resolved_id);
    end loop;
  elsif jsonb_array_length(coalesce(p_units,'[]'::jsonb)) > 0 then
    raise exception 'Este produto é controlado por quantidade e não aceita unidades Serial/MAC';
  end if;

  select id into central_location_id from public.stock_locations where location_type='central' and active=true order by created_at limit 1;
  select c.id into v_collaborator_id from public.collaborators c where c.active=true and lower(trim(c.name))=lower(trim(p_technician)) order by c.created_at limit 1;
  if v_collaborator_id is not null then
    select sl.id into technician_location_id from public.stock_locations sl where sl.location_type='colaborador' and sl.collaborator_id=v_collaborator_id limit 1;
    if technician_location_id is null then
      insert into public.stock_locations(name,location_type,collaborator_id) values('Colaborador: '||trim(p_technician),'colaborador',v_collaborator_id) returning id into technician_location_id;
    end if;
  end if;

  update public.products set stock=stock-p_quantity,updated_at=now() where id=p_product_id;
  insert into public.movements(product_id,movement_type,quantity,recipient,note,holder_type,work_order,field_usage,stock_impact,stock_before,stock_after,created_by,created_at)
  values(p_product_id,'saida',p_quantity,trim(p_technician),nullif(trim(coalesce(p_note,'')),''),'tecnico',nullif(trim(coalesce(p_work_order,'')),''),false,-p_quantity,product_record.stock,product_record.stock-p_quantity,auth.uid(),p_withdrawn_at)
  returning * into saved_movement;

  insert into public.technician_pendencies(movement_id,product_id,quantity,technician_name,withdrawn_at,due_at,work_order,note,created_by)
  values(saved_movement.id,p_product_id,p_quantity,trim(p_technician),p_withdrawn_at,p_due_at,nullif(trim(coalesce(p_work_order,'')),''),nullif(trim(coalesce(p_note,'')),''),auth.uid()) returning * into saved_pending;
  update public.movements set pending_id=saved_pending.id where id=saved_movement.id;

  foreach resolved_id in array unit_ids loop
    select * into unit_record from public.serial_items where id=resolved_id;
    insert into public.technician_pending_items(pending_id,serial_item_id) values(saved_pending.id,resolved_id);
    insert into public.serial_movements(serial_item_id,action,previous_status,new_status,from_location_id,to_location_id,recipient,work_order,note,stock_impact,pending_id,created_by,created_at)
    values(resolved_id,'transferencia',unit_record.status,'com_colaborador',unit_record.current_location_id,technician_location_id,trim(p_technician),nullif(trim(coalesce(p_work_order,'')),''),nullif(trim(coalesce(p_note,'')),''),-1,saved_pending.id,auth.uid(),p_withdrawn_at);
    update public.serial_items set status='com_colaborador',current_location_id=technician_location_id,current_technician=trim(p_technician),withdrawn_at=p_withdrawn_at,due_at=p_due_at,work_order=nullif(trim(coalesce(p_work_order,'')),''),customer_name=null,customer_reference=null,updated_at=now() where id=resolved_id;
  end loop;

  insert into public.technician_pending_events(pending_id,event_type,to_technician,new_due_at,note,created_by,occurred_at)
  values(saved_pending.id,'retirada',trim(p_technician),p_due_at,nullif(trim(coalesce(p_note,'')),''),auth.uid(),p_withdrawn_at);
  return saved_pending;
end $$;

create or replace function public.resolve_integrated_technician_pending(
  p_pending_id uuid,
  p_action text,
  p_technician text default null,
  p_due_at timestamptz default null,
  p_customer_name text default null,
  p_work_order text default null,
  p_occurred_at timestamptz default null,
  p_note text default null
) returns public.technician_pendencies
language plpgsql security definer set search_path=public as $$
declare
  pending public.technician_pendencies;
  saved_pending public.technician_pendencies;
  unit_record public.serial_items;
  old_technician text;
  old_due timestamptz;
  event_time timestamptz := coalesce(p_occurred_at,now());
  central_location_id uuid;
  target_location_id uuid;
  v_collaborator_id uuid;
  current_stock numeric;
  linked_count integer;
  stock_return_quantity numeric := 0;
  has_pending_installation boolean;
  has_pending_return boolean;
begin
  if auth.uid() is null or coalesce(public.current_user_role()::text,'') not in ('admin','operador') then raise exception 'Apenas administradores e operadores podem resolver pendências'; end if;
  select * into pending from public.technician_pendencies where id=p_pending_id for update;
  if not found then raise exception 'Pendência não encontrada'; end if;
  if pending.resolution <> 'aberta' then
    if (p_action='utilizado' and pending.resolution='utilizado')
       or (p_action='devolvido' and pending.resolution='devolvido') then
      return pending;
    end if;
    raise exception 'Esta pendência já foi finalizada como %',pending.resolution;
  end if;
  old_technician:=pending.technician_name; old_due:=pending.due_at;
  select count(*) into linked_count from public.technician_pending_items where pending_id=p_pending_id;

  if p_action='utilizado' then
    if linked_count>0 and nullif(trim(coalesce(p_customer_name,'')),'') is null then raise exception 'Informe o nome do cliente'; end if;
    for unit_record in select item.* from public.serial_items item join public.technician_pending_items link on link.serial_item_id=item.id where link.pending_id=p_pending_id for update loop
      select exists(select 1 from public.serial_movements movement where movement.pending_id=p_pending_id and movement.serial_item_id=unit_record.id and movement.action='instalacao') into has_pending_installation;
      select exists(select 1 from public.serial_movements movement where movement.pending_id=p_pending_id and movement.serial_item_id=unit_record.id and movement.action in ('retorno','devolucao')) into has_pending_return;
      if has_pending_return then raise exception 'A unidade % já foi devolvida ao almoxarifado e não pode ser instalada por esta pendência',coalesce(unit_record.mac_address,unit_record.asset_tag,unit_record.serial_number); end if;
      if unit_record.status='instalado_cliente' and not has_pending_installation then
        raise exception 'A unidade % já está instalada no cliente % por outro registro',coalesce(unit_record.mac_address,unit_record.asset_tag,unit_record.serial_number),coalesce(unit_record.customer_name,'não informado');
      end if;
      if unit_record.status not in ('com_colaborador','disponivel','instalado_cliente') then
        raise exception 'A unidade % está em uma situação incompatível: %',coalesce(unit_record.mac_address,unit_record.asset_tag,unit_record.serial_number),unit_record.status;
      end if;
      if not has_pending_installation then
        insert into public.serial_movements(serial_item_id,action,previous_status,new_status,from_location_id,recipient,customer_name,customer_reference,work_order,note,stock_impact,pending_id,created_by,created_at)
        values(unit_record.id,'instalacao',unit_record.status,'instalado_cliente',unit_record.current_location_id,trim(p_customer_name),trim(p_customer_name),nullif(trim(coalesce(p_work_order,'')),''),nullif(trim(coalesce(p_work_order,'')),''),nullif(trim(coalesce(p_note,'')),''),0,p_pending_id,auth.uid(),event_time);
      end if;
      update public.serial_items set status='instalado_cliente',current_location_id=null,customer_name=trim(p_customer_name),customer_reference=nullif(trim(coalesce(p_work_order,'')),''),current_technician=null,installation_technician=old_technician,installed_at=event_time,work_order=nullif(trim(coalesce(p_work_order,'')),''),due_at=null,updated_at=now() where id=unit_record.id;
    end loop;
    update public.technician_pendencies set resolution='utilizado',finalized_at=event_time,installed_at=event_time,installation_customer=nullif(trim(coalesce(p_customer_name,'')),''),installation_work_order=nullif(trim(coalesce(p_work_order,'')),''),note=coalesce(nullif(trim(coalesce(p_note,'')),''),note),updated_at=now() where id=p_pending_id returning * into saved_pending;
    insert into public.technician_pending_events(pending_id,event_type,from_technician,customer_name,work_order,note,created_by,occurred_at) values(p_pending_id,'utilizacao',old_technician,nullif(trim(coalesce(p_customer_name,'')),''),nullif(trim(coalesce(p_work_order,'')),''),nullif(trim(coalesce(p_note,'')),''),auth.uid(),event_time);

  elsif p_action='devolvido' then
    select id into central_location_id from public.stock_locations where location_type='central' and active=true order by created_at limit 1;
    if central_location_id is null then raise exception 'Almoxarifado central não encontrado'; end if;
    for unit_record in select item.* from public.serial_items item join public.technician_pending_items link on link.serial_item_id=item.id where link.pending_id=p_pending_id for update loop
      select exists(select 1 from public.serial_movements movement where movement.pending_id=p_pending_id and movement.serial_item_id=unit_record.id and movement.action='instalacao') into has_pending_installation;
      select exists(select 1 from public.serial_movements movement where movement.pending_id=p_pending_id and movement.serial_item_id=unit_record.id and movement.action in ('retorno','devolucao')) into has_pending_return;
      if has_pending_installation or unit_record.status='instalado_cliente' then raise exception 'A unidade % já foi instalada e não pode ser devolvida por esta pendência',coalesce(unit_record.mac_address,unit_record.asset_tag,unit_record.serial_number); end if;
      if unit_record.status not in ('com_colaborador','disponivel') then raise exception 'A unidade % está em uma situação incompatível: %',coalesce(unit_record.mac_address,unit_record.asset_tag,unit_record.serial_number),unit_record.status; end if;
      if not has_pending_return then
        insert into public.serial_movements(serial_item_id,action,previous_status,new_status,from_location_id,to_location_id,recipient,note,stock_impact,pending_id,created_by,created_at)
        values(unit_record.id,'retorno',unit_record.status,'disponivel',unit_record.current_location_id,central_location_id,'Almoxarifado Central',nullif(trim(coalesce(p_note,'')),''),1,p_pending_id,auth.uid(),event_time);
        stock_return_quantity:=stock_return_quantity+1;
      end if;
      update public.serial_items set status='disponivel',current_location_id=central_location_id,current_technician=null,withdrawn_at=null,due_at=null,work_order=null,customer_name=null,customer_reference=null,updated_at=now() where id=unit_record.id;
    end loop;
    if linked_count=0 then stock_return_quantity:=pending.quantity; end if;
    if stock_return_quantity>0 then
      select stock into current_stock from public.products where id=pending.product_id for update;
      update public.products set stock=current_stock+stock_return_quantity,updated_at=now() where id=pending.product_id;
      insert into public.movements(product_id,movement_type,quantity,recipient,note,holder_type,field_usage,stock_impact,stock_before,stock_after,pending_id,created_by,created_at)
      values(pending.product_id,'entrada',stock_return_quantity,old_technician,coalesce(nullif(trim(coalesce(p_note,'')),''),'Devolução de pendência de técnico'),'tecnico',false,stock_return_quantity,current_stock,current_stock+stock_return_quantity,p_pending_id,auth.uid(),event_time);
    end if;
    update public.technician_pendencies set resolution='devolvido',finalized_at=event_time,note=coalesce(nullif(trim(coalesce(p_note,'')),''),note),updated_at=now() where id=p_pending_id returning * into saved_pending;
    insert into public.technician_pending_events(pending_id,event_type,from_technician,note,created_by,occurred_at) values(p_pending_id,'devolucao',old_technician,nullif(trim(coalesce(p_note,'')),''),auth.uid(),event_time);

  elsif p_action='transferir' then
    if nullif(trim(coalesce(p_technician,'')),'') is null or p_due_at is null then raise exception 'Informe o novo técnico e o novo prazo'; end if;
    if p_due_at<=event_time then raise exception 'O novo prazo deve estar no futuro'; end if;
    if lower(trim(pending.technician_name))=lower(trim(p_technician)) and pending.due_at=p_due_at then return pending; end if;
    select c.id into v_collaborator_id from public.collaborators c where c.active=true and lower(trim(c.name))=lower(trim(p_technician)) order by c.created_at limit 1;
    if v_collaborator_id is not null then
      select sl.id into target_location_id from public.stock_locations sl where sl.location_type='colaborador' and sl.collaborator_id=v_collaborator_id limit 1;
      if target_location_id is null then insert into public.stock_locations(name,location_type,collaborator_id) values('Colaborador: '||trim(p_technician),'colaborador',v_collaborator_id) returning id into target_location_id; end if;
    end if;
    for unit_record in select item.* from public.serial_items item join public.technician_pending_items link on link.serial_item_id=item.id where link.pending_id=p_pending_id for update loop
      if unit_record.status<>'com_colaborador' then raise exception 'A unidade não está mais com o técnico e o repasse foi cancelado'; end if;
      insert into public.serial_movements(serial_item_id,action,previous_status,new_status,from_location_id,to_location_id,recipient,work_order,note,stock_impact,pending_id,created_by,created_at)
      values(unit_record.id,'transferencia',unit_record.status,'com_colaborador',unit_record.current_location_id,target_location_id,trim(p_technician),unit_record.work_order,nullif(trim(coalesce(p_note,'')),''),0,p_pending_id,auth.uid(),event_time);
      update public.serial_items set current_location_id=target_location_id,current_technician=trim(p_technician),due_at=p_due_at,updated_at=now() where id=unit_record.id;
    end loop;
    update public.technician_pendencies set technician_name=trim(p_technician),due_at=p_due_at,updated_at=now() where id=p_pending_id returning * into saved_pending;
    insert into public.technician_pending_events(pending_id,event_type,from_technician,to_technician,previous_due_at,new_due_at,note,created_by,occurred_at) values(p_pending_id,'transferencia',old_technician,trim(p_technician),old_due,p_due_at,nullif(trim(coalesce(p_note,'')),''),auth.uid(),event_time);

  elsif p_action='prorrogar' then
    if p_due_at is null or p_due_at<=old_due then raise exception 'O novo prazo deve ser posterior ao prazo atual'; end if;
    update public.serial_items item set due_at=p_due_at,updated_at=now() from public.technician_pending_items link where link.pending_id=p_pending_id and link.serial_item_id=item.id;
    update public.technician_pendencies set due_at=p_due_at,updated_at=now() where id=p_pending_id returning * into saved_pending;
    insert into public.technician_pending_events(pending_id,event_type,from_technician,previous_due_at,new_due_at,note,created_by,occurred_at) values(p_pending_id,'prorrogacao',old_technician,old_due,p_due_at,nullif(trim(coalesce(p_note,'')),''),auth.uid(),event_time);
  else raise exception 'Ação inválida';
  end if;
  return saved_pending;
end $$;

grant execute on function public.record_integrated_technician_movement(uuid,numeric,text,timestamptz,timestamptz,text,text,jsonb) to authenticated;
grant execute on function public.resolve_integrated_technician_pending(uuid,text,text,timestamptz,text,text,timestamptz,text) to authenticated;

commit;
