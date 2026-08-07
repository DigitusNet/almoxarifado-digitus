-- Permite apagar solicitações somente para administradores.
-- A conclusão por administrador ou operador já usa a política de UPDATE existente.

drop policy if exists "Admins can delete material requests" on public.material_requests;

create policy "Admins can delete material requests" on public.material_requests
  for delete to authenticated
  using (coalesce(public.current_user_role()::text, '') = 'admin');

grant delete on public.material_requests to authenticated;
