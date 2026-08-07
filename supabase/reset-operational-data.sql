-- Zera os dados operacionais do almoxarifado.
-- PRESERVA: usuários do Auth, perfis e estrutura do sistema.
-- Execute no SQL Editor do Supabase somente quando quiser iniciar do zero.

begin;

delete from public.tool_loans;
delete from public.serial_movements;
delete from public.serial_items;

delete from public.receipt_items;
delete from public.receipts;

delete from public.inventory_counts;
delete from public.inventory_sessions;

delete from public.movements;
delete from public.products;
-- As fotos antigas permanecem apenas como arquivos sem vínculo no Storage.
-- Elas não aparecem no sistema depois que os produtos são apagados.

delete from public.stock_locations;
delete from public.vehicles;
delete from public.collaborators;
delete from public.suppliers;

-- Recria somente o local padrão necessário para novos cadastros.
insert into public.stock_locations (name, location_type)
values ('Almoxarifado Central', 'central');

commit;
