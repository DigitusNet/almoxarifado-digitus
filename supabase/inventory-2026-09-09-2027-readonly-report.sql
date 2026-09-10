-- RELATÓRIO SOMENTE LEITURA da conferência encerrada em 09/09/2026 às 20:27.
-- Este arquivo contém apenas SELECT. Não corrige nem modifica qualquer dado.

with target_inventory as (
  select i.*
  from public.inventory_sessions i
  where i.closed_at >= timestamptz '2026-09-09 20:26:00-03'
    and i.closed_at <  timestamptz '2026-09-09 20:29:00-03'
  order by abs(extract(epoch from (i.closed_at - timestamptz '2026-09-09 20:27:00-03')))
  limit 1
), inventory_movements as (
  select m.*
  from public.movements m
  join target_inventory i on m.recipient = 'Inventário: ' || i.title
  where m.created_at between i.closed_at - interval '2 minutes' and i.closed_at + interval '2 minutes'
)
select
  c.product_name as produto,
  c.expected_stock as quantidade_esperada_snapshot,
  c.counted_stock as quantidade_contada,
  c.counted_stock - c.expected_stock as diferenca_real_da_conferencia,
  case when m.movement_type = 'entrada' then m.quantity else -m.quantity end as ajuste_realizado,
  m.stock_before as estoque_antes_registrado,
  m.stock_after as estoque_depois_registrado,
  m.created_at as horario,
  m.id as id_movimentacao,
  c.product_id as id_produto,
  m.note as motivo,
  case
    when c.counted_stock = c.expected_stock and m.id is not null then 'ANOMALIA: item correto gerou ajuste'
    when c.counted_stock <> c.expected_stock and m.id is null then 'ATENÇÃO: divergência sem movimentação localizada'
    else 'Compatível'
  end as diagnostico
from target_inventory i
join public.inventory_counts c on c.inventory_id = i.id
left join inventory_movements m on m.product_id = c.product_id
order by m.created_at nulls last, c.product_name;

-- Resumo de todos os ajustes positivos e negativos localizados.
with target_inventory as (
  select i.* from public.inventory_sessions i
  where i.closed_at >= timestamptz '2026-09-09 20:26:00-03'
    and i.closed_at <  timestamptz '2026-09-09 20:29:00-03'
  order by abs(extract(epoch from (i.closed_at - timestamptz '2026-09-09 20:27:00-03')))
  limit 1
)
select
  i.id as id_conferencia,
  i.title as conferencia,
  i.started_at as inicio,
  i.closed_at as finalizacao,
  count(*) filter (where c.counted_stock = c.expected_stock) as itens_corretos,
  count(*) filter (where c.counted_stock <> c.expected_stock) as divergencias_snapshot,
  coalesce(sum(case when m.movement_type = 'entrada' then m.quantity else 0 end), 0) as total_adicionado,
  coalesce(sum(case when m.movement_type = 'saida' then m.quantity else 0 end), 0) as total_retirado
from target_inventory i
join public.inventory_counts c on c.inventory_id = i.id
left join public.movements m
  on m.product_id = c.product_id
 and m.recipient = 'Inventário: ' || i.title
 and m.created_at between i.closed_at - interval '2 minutes' and i.closed_at + interval '2 minutes'
group by i.id, i.title, i.started_at, i.closed_at;
