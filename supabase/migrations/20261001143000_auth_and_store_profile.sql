begin;

create table if not exists public.configuracao_loja (
  id integer primary key check (id = 1),
  nome text not null default 'Rafael Ferreira',
  telefone text,
  rua text,
  numero text,
  complemento text,
  bairro text,
  updated_at timestamptz not null default now()
);

insert into public.configuracao_loja (id, nome)
values (1, 'Rafael Ferreira')
on conflict (id) do nothing;

alter table public.configuracao_loja enable row level security;

drop policy if exists "demo acesso clientes" on public.clientes;
drop policy if exists "demo acesso tecnicos" on public.tecnicos;
drop policy if exists "demo acesso produtos" on public.produtos;
drop policy if exists "demo acesso pedidos" on public.pedidos;
drop policy if exists "demo acesso itens" on public.itens_pedido;
drop policy if exists "demo acesso historico" on public.historico_status;

create policy "authenticated access clientes" on public.clientes
  for all to authenticated using (auth.uid() is not null) with check (auth.uid() is not null);
create policy "authenticated access tecnicos" on public.tecnicos
  for all to authenticated using (auth.uid() is not null) with check (auth.uid() is not null);
create policy "authenticated access produtos" on public.produtos
  for all to authenticated using (auth.uid() is not null) with check (auth.uid() is not null);
create policy "authenticated access pedidos" on public.pedidos
  for all to authenticated using (auth.uid() is not null) with check (auth.uid() is not null);
create policy "authenticated access itens" on public.itens_pedido
  for all to authenticated using (auth.uid() is not null) with check (auth.uid() is not null);
create policy "authenticated access historico" on public.historico_status
  for all to authenticated using (auth.uid() is not null) with check (auth.uid() is not null);
create policy "authenticated access configuracao loja" on public.configuracao_loja
  for all to authenticated using (auth.uid() is not null) with check (auth.uid() is not null);

revoke all on public.clientes, public.tecnicos, public.produtos, public.pedidos,
  public.itens_pedido, public.historico_status, public.configuracao_loja from anon;
grant select, insert, update, delete on public.clientes, public.tecnicos, public.produtos,
  public.pedidos, public.itens_pedido, public.historico_status, public.configuracao_loja to authenticated;
grant usage, select on sequence public.historico_status_id_seq to authenticated;
revoke all on sequence public.historico_status_id_seq from anon;

revoke execute on function public.criar_pedido_com_itens(uuid, text, jsonb) from public, anon;
grant execute on function public.criar_pedido_com_itens(uuid, text, jsonb) to authenticated;

commit;
