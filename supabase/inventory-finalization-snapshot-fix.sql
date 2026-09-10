-- Correção para as PRÓXIMAS finalizações de conferência.
-- Não atualiza, exclui, insere ou reprocessa nenhum dado histórico ao ser instalado.

create or replace function public.finish_inventory(
  p_inventory_id uuid,
  p_final_note text
) returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  inventory public.inventory_sessions;
  item public.inventory_counts;
  current_stock numeric(12,3);
  adjustment numeric(12,3);
  next_stock numeric(12,3);
  divergence_count integer;
  units_to_add numeric(12,3);
  units_to_remove numeric(12,3);
begin
  if auth.uid() is null or coalesce(public.current_user_role()::text, '') not in ('admin', 'operador') then
    raise exception 'Apenas administradores e operadores podem finalizar uma conferência';
  end if;

  select * into inventory
  from public.inventory_sessions
  where id = p_inventory_id and status = 'aberto'
  for update;
  if not found then raise exception 'Inventário não encontrado ou já finalizado'; end if;

  if exists (select 1 from public.inventory_counts where inventory_id = p_inventory_id and counted_stock is null) then
    raise exception 'Informe a quantidade física de todos os itens antes de finalizar';
  end if;

  select
    count(*) filter (where counted_stock <> expected_stock),
    coalesce(sum(greatest(counted_stock - expected_stock, 0)), 0),
    coalesce(sum(greatest(expected_stock - counted_stock, 0)), 0)
  into divergence_count, units_to_add, units_to_remove
  from public.inventory_counts
  where inventory_id = p_inventory_id;

  if divergence_count = 0 and (units_to_add <> 0 or units_to_remove <> 0) then
    raise exception 'Falha de consistência na prévia da conferência. Nenhum estoque foi alterado.';
  end if;

  for item in
    select * from public.inventory_counts
    where inventory_id = p_inventory_id
    order by product_name
    for update
  loop
    select stock into current_stock from public.products where id = item.product_id for update;
    if not found then raise exception 'O item % não existe mais no catálogo', item.product_name; end if;

    adjustment := item.counted_stock - item.expected_stock;
    if adjustment <> 0 then
      next_stock := current_stock + adjustment;
      if next_stock < 0 then
        raise exception 'O ajuste deixaria o estoque de % negativo. Nenhum estoque foi alterado.', item.product_name;
      end if;

      update public.products set stock = next_stock, updated_at = now() where id = item.product_id;

      insert into public.movements (
        product_id, movement_type, quantity, recipient, note, holder_type, field_usage,
        stock_impact, stock_before, stock_after, created_by
      ) values (
        item.product_id,
        case when adjustment > 0 then 'entrada'::public.movement_type else 'saida'::public.movement_type end,
        abs(adjustment), 'Inventário: ' || inventory.title,
        'Ajuste de inventário. ' || coalesce(nullif(trim(p_final_note), ''), 'Contagem física confirmada.'),
        'outro', false, adjustment, current_stock, next_stock, auth.uid()
      );
    end if;

    update public.inventory_counts set adjustment_applied = true where id = item.id;
  end loop;

  update public.inventory_sessions
  set status = 'finalizado', closed_by = auth.uid(), closed_at = now(), final_note = nullif(trim(p_final_note), '')
  where id = p_inventory_id;
end;
$$;

grant execute on function public.finish_inventory(uuid, text) to authenticated;
