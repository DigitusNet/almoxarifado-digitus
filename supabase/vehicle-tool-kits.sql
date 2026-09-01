begin;

alter table public.serial_items add column if not exists tool_number text;
create unique index if not exists serial_items_product_tool_number_unique
  on public.serial_items(product_id, lower(trim(tool_number))) where nullif(trim(tool_number),'') is not null;

create table if not exists public.vehicle_tool_kits (
  id uuid primary key default gen_random_uuid(), vehicle_id uuid not null unique references public.vehicles(id) on delete cascade,
  name text not null, created_by uuid references auth.users(id), created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);
create table if not exists public.vehicle_tool_kit_requirements (
  id uuid primary key default gen_random_uuid(), kit_id uuid not null references public.vehicle_tool_kits(id) on delete cascade,
  product_id uuid not null references public.products(id) on delete restrict, required_quantity integer not null default 1 check(required_quantity>0),
  unique(kit_id,product_id)
);
create table if not exists public.vehicle_tool_kit_items (
  id uuid primary key default gen_random_uuid(), kit_id uuid not null references public.vehicle_tool_kits(id) on delete cascade,
  serial_item_id uuid not null references public.serial_items(id) on delete restrict,
  status text not null default 'no_veiculo' check(status in ('no_veiculo','ausente','manutencao','substituida')),
  added_at timestamptz not null default now(), removed_at timestamptz
);
create unique index if not exists vehicle_tool_kit_items_active_unique on public.vehicle_tool_kit_items(serial_item_id) where removed_at is null;
create table if not exists public.vehicle_tool_kit_events (
  id uuid primary key default gen_random_uuid(), kit_id uuid not null references public.vehicle_tool_kits(id) on delete cascade,
  serial_item_id uuid references public.serial_items(id) on delete restrict, replacement_serial_item_id uuid references public.serial_items(id) on delete restrict,
  event_type text not null check(event_type in ('adicionado','removido','transferido','manutencao','baixa','substituido')),
  from_vehicle_id uuid references public.vehicles(id), to_vehicle_id uuid references public.vehicles(id), note text,
  created_by uuid references auth.users(id), created_at timestamptz not null default now()
);

alter table public.vehicle_tool_kits enable row level security;
alter table public.vehicle_tool_kit_requirements enable row level security;
alter table public.vehicle_tool_kit_items enable row level security;
alter table public.vehicle_tool_kit_events enable row level security;
drop policy if exists "Authenticated view vehicle kits" on public.vehicle_tool_kits;
drop policy if exists "Authenticated view vehicle kit requirements" on public.vehicle_tool_kit_requirements;
drop policy if exists "Authenticated view vehicle kit items" on public.vehicle_tool_kit_items;
drop policy if exists "Authenticated view vehicle kit events" on public.vehicle_tool_kit_events;
create policy "Authenticated view vehicle kits" on public.vehicle_tool_kits for select to authenticated using(true);
create policy "Authenticated view vehicle kit requirements" on public.vehicle_tool_kit_requirements for select to authenticated using(true);
create policy "Authenticated view vehicle kit items" on public.vehicle_tool_kit_items for select to authenticated using(true);
create policy "Authenticated view vehicle kit events" on public.vehicle_tool_kit_events for select to authenticated using(true);

create or replace function public.save_vehicle_tool_kit(p_vehicle_id uuid,p_name text,p_requirements jsonb,p_serial_item_ids uuid[],p_note text default null)
returns public.vehicle_tool_kits language plpgsql security definer set search_path=public as $$
declare k public.vehicle_tool_kits; sid uuid; s public.serial_items; vehicle_location uuid; req jsonb; affected integer; current_stock numeric; vehicle_name text;
begin
 if auth.uid() is null or coalesce(public.current_user_role()::text,'') not in ('admin','operador') then raise exception 'Apenas administradores e operadores podem montar kits'; end if;
 if not exists(select 1 from public.vehicles where id=p_vehicle_id and active=true) then raise exception 'Veículo não encontrado ou inativo'; end if;
 select name into vehicle_name from public.vehicles where id=p_vehicle_id;
 insert into public.vehicle_tool_kits(vehicle_id,name,created_by) values(p_vehicle_id,coalesce(nullif(trim(p_name),''),'Kit do veículo'),auth.uid())
 on conflict(vehicle_id) do update set name=excluded.name,updated_at=now() returning * into k;
 if p_requirements is not null then
   delete from public.vehicle_tool_kit_requirements where kit_id=k.id;
   for req in select value from jsonb_array_elements(p_requirements) loop
     insert into public.vehicle_tool_kit_requirements(kit_id,product_id,required_quantity) values(k.id,(req->>'product_id')::uuid,greatest(1,(req->>'quantity')::integer));
   end loop;
 end if;
 select id into vehicle_location from public.stock_locations where location_type='veiculo' and vehicle_id=p_vehicle_id limit 1;
 if vehicle_location is null then insert into public.stock_locations(name,location_type,vehicle_id) select 'Veículo: '||name,'veiculo',id from public.vehicles where id=p_vehicle_id returning id into vehicle_location; end if;
 foreach sid in array coalesce(p_serial_item_ids,array[]::uuid[]) loop
   select * into s from public.serial_items where id=sid for update;
   if not found or coalesce((select category from public.products where id=s.product_id),'') <> 'Ferramentas' then raise exception 'A unidade selecionada não é uma ferramenta válida'; end if;
   if s.status<>'disponivel' and not exists(select 1 from public.vehicle_tool_kit_items where kit_id=k.id and serial_item_id=sid and removed_at is null) then raise exception 'A ferramenta % não está disponível',coalesce(s.tool_number,s.asset_tag,s.serial_number); end if;
   if exists(select 1 from public.vehicle_tool_kit_items i join public.vehicle_tool_kits x on x.id=i.kit_id join public.vehicles v on v.id=x.vehicle_id where i.serial_item_id=sid and i.removed_at is null and i.kit_id<>k.id) then raise exception 'Esta ferramenta já está vinculada a outro veículo'; end if;
   insert into public.vehicle_tool_kit_items(kit_id,serial_item_id) values(k.id,sid) on conflict(serial_item_id) where removed_at is null do nothing;
   get diagnostics affected = row_count;
   if s.status='disponivel' then
     if affected=0 then raise exception 'Esta ferramenta já está vinculada a um kit'; end if;
     select stock into current_stock from public.products where id=s.product_id for update;
     if current_stock<1 then raise exception 'Estoque insuficiente'; end if;
     update public.products set stock=current_stock-1,updated_at=now() where id=s.product_id;
     update public.serial_items set status='com_veiculo',current_location_id=vehicle_location,updated_at=now() where id=sid;
     insert into public.serial_movements(serial_item_id,action,previous_status,new_status,to_location_id,recipient,note,stock_impact,created_by) select sid,'transferencia','disponivel','com_veiculo',vehicle_location,name,p_note,-1,auth.uid() from public.vehicles where id=p_vehicle_id;
     insert into public.movements(product_id,movement_type,quantity,recipient,note,holder_type,field_usage,stock_impact,stock_before,stock_after,created_by)
       values(s.product_id,'saida',1,vehicle_name,coalesce(p_note,'Ferramenta adicionada ao kit do veículo'),'veiculo',false,-1,current_stock,current_stock-1,auth.uid());
     insert into public.vehicle_tool_kit_events(kit_id,serial_item_id,event_type,to_vehicle_id,note,created_by) values(k.id,sid,'adicionado',p_vehicle_id,p_note,auth.uid());
   end if;
 end loop;
 return k;
end $$;

create or replace function public.move_vehicle_tool(p_serial_item_id uuid,p_action text,p_target_vehicle_id uuid default null,p_replacement_id uuid default null,p_note text default null)
returns void language plpgsql security definer set search_path=public as $$
declare item public.vehicle_tool_kit_items; kit public.vehicle_tool_kits; s public.serial_items; central uuid; targetkit public.vehicle_tool_kits; targetloc uuid; current_stock numeric; vehicle_name text;
begin
 if auth.uid() is null or coalesce(public.current_user_role()::text,'') not in ('admin','operador') then raise exception 'Apenas administradores e operadores podem movimentar ferramentas de kits'; end if;
 select * into item from public.vehicle_tool_kit_items where serial_item_id=p_serial_item_id and removed_at is null for update; if not found then raise exception 'Ferramenta não vinculada a kit'; end if;
 select * into kit from public.vehicle_tool_kits where id=item.kit_id; select * into s from public.serial_items where id=p_serial_item_id for update;
 select name into vehicle_name from public.vehicles where id=kit.vehicle_id;
 if p_action='almoxarifado' then
   select id into central from public.stock_locations where location_type='central' and active=true order by created_at limit 1;
   update public.vehicle_tool_kit_items set removed_at=now(),status='ausente' where id=item.id;
   update public.serial_items set status='disponivel',current_location_id=central,updated_at=now() where id=s.id;
   select stock into current_stock from public.products where id=s.product_id for update;
   update public.products set stock=current_stock+1,updated_at=now() where id=s.product_id;
   insert into public.serial_movements(serial_item_id,action,previous_status,new_status,from_location_id,to_location_id,recipient,note,stock_impact,created_by) values(s.id,'retorno','com_veiculo','disponivel',s.current_location_id,central,'Almoxarifado',p_note,1,auth.uid());
   insert into public.vehicle_tool_kit_events(kit_id,serial_item_id,event_type,from_vehicle_id,note,created_by) values(kit.id,s.id,'removido',kit.vehicle_id,p_note,auth.uid());
   insert into public.movements(product_id,movement_type,quantity,recipient,note,holder_type,field_usage,stock_impact,stock_before,stock_after,created_by)
     values(s.product_id,'entrada',1,'Almoxarifado',coalesce(p_note,'Ferramenta devolvida pelo veículo '||vehicle_name),'veiculo',false,1,current_stock,current_stock+1,auth.uid());
 elsif p_action='transferir' then
   if p_target_vehicle_id is null or p_target_vehicle_id=kit.vehicle_id then raise exception 'Selecione outro veículo'; end if;
   insert into public.vehicle_tool_kits(vehicle_id,name,created_by) select id,'Kit '||name,auth.uid() from public.vehicles where id=p_target_vehicle_id and active=true on conflict(vehicle_id) do update set updated_at=now() returning * into targetkit;
   select id into targetloc from public.stock_locations where location_type='veiculo' and vehicle_id=p_target_vehicle_id limit 1;
   if targetloc is null then insert into public.stock_locations(name,location_type,vehicle_id) select 'Veículo: '||name,'veiculo',id from public.vehicles where id=p_target_vehicle_id returning id into targetloc; end if;
   update public.vehicle_tool_kit_items set removed_at=now(),status='substituida' where id=item.id; insert into public.vehicle_tool_kit_items(kit_id,serial_item_id) values(targetkit.id,s.id);
   insert into public.vehicle_tool_kit_requirements(kit_id,product_id,required_quantity) values(targetkit.id,s.product_id,1)
     on conflict(kit_id,product_id) do update set required_quantity=public.vehicle_tool_kit_requirements.required_quantity+1;
   update public.serial_items set current_location_id=targetloc,updated_at=now() where id=s.id;
   insert into public.serial_movements(serial_item_id,action,previous_status,new_status,from_location_id,to_location_id,recipient,note,stock_impact,created_by)
     select s.id,'transferencia','com_veiculo','com_veiculo',s.current_location_id,targetloc,name,p_note,0,auth.uid() from public.vehicles where id=p_target_vehicle_id;
   insert into public.vehicle_tool_kit_events(kit_id,serial_item_id,event_type,from_vehicle_id,to_vehicle_id,note,created_by) values(kit.id,s.id,'transferido',kit.vehicle_id,p_target_vehicle_id,p_note,auth.uid());
 elsif p_action in ('manutencao','baixa') then
   update public.vehicle_tool_kit_items set removed_at=now(),status=case when p_action='manutencao' then 'manutencao' else 'ausente' end where id=item.id;
   update public.serial_items set status=case when p_action='manutencao' then 'manutencao' else 'baixado' end,current_location_id=null,updated_at=now() where id=s.id;
   insert into public.serial_movements(serial_item_id,action,previous_status,new_status,from_location_id,note,stock_impact,created_by)
     values(s.id,case when p_action='manutencao' then 'laboratorio' else 'baixa' end,'com_veiculo',case when p_action='manutencao' then 'manutencao' else 'baixado' end,s.current_location_id,p_note,0,auth.uid());
   insert into public.vehicle_tool_kit_events(kit_id,serial_item_id,event_type,from_vehicle_id,note,created_by) values(kit.id,s.id,p_action,kit.vehicle_id,p_note,auth.uid());
 elsif p_action='substituir' then
   if p_replacement_id is null then raise exception 'Selecione a ferramenta substituta'; end if;
   perform public.move_vehicle_tool(p_serial_item_id,'manutencao',null,null,p_note);
   perform public.save_vehicle_tool_kit(kit.vehicle_id,kit.name,null,array[p_replacement_id],p_note);
   insert into public.vehicle_tool_kit_events(kit_id,serial_item_id,replacement_serial_item_id,event_type,from_vehicle_id,to_vehicle_id,note,created_by) values(kit.id,p_serial_item_id,p_replacement_id,'substituido',kit.vehicle_id,kit.vehicle_id,p_note,auth.uid());
 else raise exception 'Ação inválida'; end if;
end $$;

grant execute on function public.save_vehicle_tool_kit(uuid,text,jsonb,uuid[],text) to authenticated;
grant execute on function public.move_vehicle_tool(uuid,text,uuid,uuid,text) to authenticated;

create or replace function public.set_tool_number(p_serial_item_id uuid,p_tool_number text)
returns void language plpgsql security definer set search_path=public as $$
begin
 if auth.uid() is null or coalesce(public.current_user_role()::text,'') not in ('admin','operador') then raise exception 'Apenas administradores e operadores podem identificar ferramentas'; end if;
 if nullif(trim(coalesce(p_tool_number,'')),'') is null then update public.serial_items set tool_number=null,updated_at=now() where id=p_serial_item_id; return; end if;
 if trim(p_tool_number) !~ '^[0-9]+$' then raise exception 'O número da ferramenta deve conter somente números'; end if;
 if coalesce((select p.category from public.serial_items s join public.products p on p.id=s.product_id where s.id=p_serial_item_id),'')<>'Ferramentas' then raise exception 'A identificação numérica é exclusiva para ferramentas'; end if;
 update public.serial_items set tool_number=trim(p_tool_number),updated_at=now() where id=p_serial_item_id;
end $$;
grant execute on function public.set_tool_number(uuid,text) to authenticated;

create or replace function public.register_vehicle_tool_item(
 p_product_id uuid,p_serial_number text,p_mac_address text,p_asset_tag text,p_tool_number text,
 p_status text,p_location_id uuid,p_customer_name text,p_customer_reference text,p_notes text
) returns public.serial_items language plpgsql security definer set search_path=public as $$
declare saved public.serial_items;
begin
 if coalesce((select category from public.products where id=p_product_id),'')<>'Ferramentas' then raise exception 'O número de ferramenta só pode ser usado na categoria Ferramentas'; end if;
 saved:=public.register_serial_item(p_product_id,p_serial_number,p_mac_address,p_asset_tag,p_status,p_location_id,p_customer_name,p_customer_reference,p_notes,false);
 perform public.set_tool_number(saved.id,p_tool_number);
 select * into saved from public.serial_items where id=saved.id;
 return saved;
end $$;
grant execute on function public.register_vehicle_tool_item(uuid,text,text,text,text,text,uuid,text,text,text) to authenticated;
commit;
