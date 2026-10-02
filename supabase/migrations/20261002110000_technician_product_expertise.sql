begin;

create table if not exists public.tecnico_produtos (
  tecnico_id uuid not null references public.tecnicos(id) on delete cascade,
  produto_id uuid not null references public.produtos(id) on delete restrict,
  primary key (tecnico_id, produto_id)
);

create index if not exists tecnico_produtos_produto_tecnico_idx
  on public.tecnico_produtos(produto_id, tecnico_id);

alter table public.tecnico_produtos enable row level security;
drop policy if exists "authenticated access tecnico_produtos" on public.tecnico_produtos;
create policy "authenticated access tecnico_produtos" on public.tecnico_produtos
  for all to authenticated using (auth.uid() is not null) with check (auth.uid() is not null);
revoke all on public.tecnico_produtos from anon;
grant select, insert, update, delete on public.tecnico_produtos to authenticated;

insert into public.tecnico_produtos (tecnico_id, produto_id)
select distinct technician.id, product.id
from public.tecnicos technician
join public.produtos product
  on cardinality(product.habilidades_instalacao) > 0
  and product.habilidades_instalacao && technician.habilidades_instalacao
on conflict do nothing;

create or replace function public.salvar_tecnico_com_produtos(
  p_tecnico_id uuid,
  p_nome text,
  p_telefone text,
  p_produto_ids uuid[]
)
returns uuid
language plpgsql
set search_path = public
as $$
declare
  v_tecnico_id uuid;
  v_especialidade text;
  v_produto_count integer;
begin
  if auth.uid() is null then
    raise exception 'É necessário entrar no sistema para salvar um técnico.';
  end if;
  if p_nome is null or length(trim(p_nome)) = 0
    or p_telefone is null or length(trim(p_telefone)) = 0 then
    raise exception 'Informe o nome e o telefone do técnico.';
  end if;
  if p_produto_ids is null or cardinality(p_produto_ids) = 0 then
    raise exception 'Selecione ao menos um produto que o técnico sabe instalar.';
  end if;
  if cardinality(p_produto_ids) <> (
    select count(distinct id) from unnest(p_produto_ids) as selected(id)
  ) then
    raise exception 'A seleção contém produtos duplicados.';
  end if;

  select count(*), string_agg(product.nome, ' · ' order by product.nome)
  into v_produto_count, v_especialidade
  from public.produtos product
  where product.id = any(p_produto_ids);
  if v_produto_count <> cardinality(p_produto_ids) then
    raise exception 'Um ou mais produtos selecionados não existem.';
  end if;

  if p_tecnico_id is null then
    insert into public.tecnicos (nome, telefone, especialidade, habilidades_instalacao, categorias_atendimento)
    values (trim(p_nome), trim(p_telefone), v_especialidade, '{}', '{}')
    returning id into v_tecnico_id;
  else
    update public.tecnicos
    set nome = trim(p_nome),
        telefone = trim(p_telefone),
        especialidade = v_especialidade
    where id = p_tecnico_id
    returning id into v_tecnico_id;
    if not found then
      raise exception 'Técnico não encontrado.';
    end if;
  end if;

  delete from public.tecnico_produtos where tecnico_id = v_tecnico_id;
  insert into public.tecnico_produtos (tecnico_id, produto_id)
  select v_tecnico_id, selected.product_id
  from unnest(p_produto_ids) as selected(product_id);

  return v_tecnico_id;
end;
$$;

revoke execute on function public.salvar_tecnico_com_produtos(uuid, text, text, uuid[]) from public, anon;
grant execute on function public.salvar_tecnico_com_produtos(uuid, text, text, uuid[]) to authenticated;

create or replace function public.agendar_pedido(
  p_pedido_id uuid,
  p_tecnico_ids uuid[],
  p_data_instalacao timestamptz,
  p_duracao_minutos integer default 60
)
returns void
language plpgsql
set search_path = public
as $$
declare
  v_status public.pedido_status;
  v_required_products uuid[];
  v_selected_products uuid[];
  v_selected_count integer;
begin
  if p_data_instalacao is null or p_data_instalacao <= now() then
    raise exception 'A data de instalação deve ser futura.';
  end if;
  if p_duracao_minutos is null or p_duracao_minutos not between 15 and 480 then
    raise exception 'A duração deve ficar entre 15 e 480 minutos.';
  end if;
  if p_tecnico_ids is null or cardinality(p_tecnico_ids) not between 1 and 2 then
    raise exception 'Selecione um ou dois técnicos para a instalação.';
  end if;
  if cardinality(p_tecnico_ids) <> (
    select count(distinct id) from unnest(p_tecnico_ids) as selected(id)
  ) then
    raise exception 'A seleção contém técnicos duplicados.';
  end if;

  select status into v_status
  from public.pedidos
  where id = p_pedido_id
  for update;
  if not found then
    raise exception 'Pedido não encontrado.';
  end if;
  if v_status <> 'aprovado' then
    raise exception 'Somente pedidos aprovados podem ser agendados.';
  end if;

  select coalesce(array_agg(distinct item.produto_id), '{}')
  into v_required_products
  from public.itens_pedido item
  where item.pedido_id = p_pedido_id;
  if cardinality(v_required_products) = 0 then
    raise exception 'O pedido não possui produtos.';
  end if;

  perform technician.id
  from public.tecnicos technician
  where technician.id = any(p_tecnico_ids)
  order by technician.id
  for update;

  select count(*)
  into v_selected_count
  from public.tecnicos technician
  where technician.id = any(p_tecnico_ids)
    and technician.ativo;
  if v_selected_count < cardinality(p_tecnico_ids) then
    raise exception 'Um ou mais técnicos selecionados não existem ou estão inativos.';
  end if;

  select coalesce(array_agg(distinct expertise.produto_id), '{}')
  into v_selected_products
  from public.tecnico_produtos expertise
  join public.tecnicos technician on technician.id = expertise.tecnico_id
  where technician.id = any(p_tecnico_ids)
    and technician.ativo;
  if not (v_selected_products @> v_required_products) then
    raise exception 'A equipe selecionada não sabe instalar todos os produtos do pedido.';
  end if;

  if exists (
    select 1
    from public.pedidos existing_order
    join public.pedido_tecnicos assignment on assignment.pedido_id = existing_order.id
    where existing_order.id <> p_pedido_id
      and existing_order.status in ('agendado', 'em_andamento')
      and assignment.tecnico_id = any(p_tecnico_ids)
      and p_data_instalacao < existing_order.data_instalacao
        + make_interval(mins => existing_order.duracao_instalacao_minutos)
      and existing_order.data_instalacao < p_data_instalacao
        + make_interval(mins => p_duracao_minutos)
  ) then
    raise exception 'Um técnico selecionado já tem uma instalação nesse horário. Escolha outro horário ou equipe.';
  end if;

  delete from public.pedido_tecnicos where pedido_id = p_pedido_id;
  insert into public.pedido_tecnicos (pedido_id, tecnico_id)
  select p_pedido_id, selected_id
  from unnest(p_tecnico_ids) as selected(selected_id);

  update public.pedidos
  set status = 'agendado',
      data_instalacao = p_data_instalacao,
      duracao_instalacao_minutos = p_duracao_minutos
  where id = p_pedido_id;
end;
$$;

revoke execute on function public.agendar_pedido(uuid, uuid[], timestamptz, integer) from public, anon;
grant execute on function public.agendar_pedido(uuid, uuid[], timestamptz, integer) to authenticated;

commit;
