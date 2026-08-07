-- Quadros do Painel: lembretes e solicitações de materiais.
-- Execute este arquivo inteiro no SQL Editor do Supabase uma única vez.

create table if not exists public.dashboard_reminders (
  id uuid primary key default gen_random_uuid(),
  recipient text not null,
  description text not null,
  due_date date not null,
  status text not null default 'aberto' check (status in ('aberto', 'concluido')),
  created_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  closed_at timestamptz
);

create table if not exists public.material_requests (
  id uuid primary key default gen_random_uuid(),
  requester text not null,
  description text not null,
  status text not null default 'aberta' check (status in ('aberta', 'atendida', 'cancelada')),
  created_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists dashboard_reminders_open_due_idx
  on public.dashboard_reminders (due_date) where status = 'aberto';
create index if not exists material_requests_open_created_idx
  on public.material_requests (created_at desc) where status = 'aberta';

alter table public.dashboard_reminders enable row level security;
alter table public.material_requests enable row level security;

drop policy if exists "Authenticated users can view dashboard reminders" on public.dashboard_reminders;
drop policy if exists "Managers can create dashboard reminders" on public.dashboard_reminders;
drop policy if exists "Managers can update dashboard reminders" on public.dashboard_reminders;
create policy "Authenticated users can view dashboard reminders" on public.dashboard_reminders
  for select to authenticated using (true);
create policy "Managers can create dashboard reminders" on public.dashboard_reminders
  for insert to authenticated with check (
    auth.uid() = created_by and coalesce(public.current_user_role()::text, '') in ('admin', 'operador')
  );
create policy "Managers can update dashboard reminders" on public.dashboard_reminders
  for update to authenticated using (coalesce(public.current_user_role()::text, '') in ('admin', 'operador'))
  with check (coalesce(public.current_user_role()::text, '') in ('admin', 'operador'));

drop policy if exists "Authenticated users can view material requests" on public.material_requests;
drop policy if exists "Managers can create material requests" on public.material_requests;
drop policy if exists "Managers can update material requests" on public.material_requests;
create policy "Authenticated users can view material requests" on public.material_requests
  for select to authenticated using (true);
create policy "Managers can create material requests" on public.material_requests
  for insert to authenticated with check (
    auth.uid() = created_by and coalesce(public.current_user_role()::text, '') in ('admin', 'operador')
  );
create policy "Managers can update material requests" on public.material_requests
  for update to authenticated using (coalesce(public.current_user_role()::text, '') in ('admin', 'operador'))
  with check (coalesce(public.current_user_role()::text, '') in ('admin', 'operador'));

grant select, insert, update on public.dashboard_reminders to authenticated;
grant select, insert, update on public.material_requests to authenticated;
