begin;

alter table public.tecnicos
  add column if not exists categorias_atendimento text[] not null default '{}';

update public.tecnicos technician
set categorias_atendimento = coalesce((
  select array_agg(distinct product.categoria order by product.categoria)
  from public.produtos product
  where cardinality(product.habilidades_instalacao) = 0
    or product.habilidades_instalacao && technician.habilidades_instalacao
), '{}')
where cardinality(technician.categorias_atendimento) = 0;

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
  v_required_skills text[];
  v_selected_skills text[];
  v_required_categories text[];
  v_selected_categories text[];
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

  select coalesce(array_agg(distinct product.categoria), '{}'),
         coalesce(array_agg(distinct required.skill) filter (where required.skill is not null), '{}')
  into v_required_categories, v_required_skills
  from public.itens_pedido item
  join public.produtos product on product.id = item.produto_id
  left join lateral unnest(product.habilidades_instalacao) as required(skill) on true
  where item.pedido_id = p_pedido_id;

  if cardinality(v_required_categories) = 0 then
    raise exception 'O pedido não possui produtos com categoria definida.';
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

  select coalesce(array_agg(distinct category) filter (where category is not null), '{}'),
         coalesce(array_agg(distinct capability.skill) filter (where capability.skill is not null), '{}')
  into v_selected_categories, v_selected_skills
  from public.tecnicos technician
  left join lateral unnest(technician.categorias_atendimento) as served(category) on true
  left join lateral unnest(technician.habilidades_instalacao) as capability(skill) on true
  where technician.id = any(p_tecnico_ids)
    and technician.ativo;

  if not (v_selected_categories @> v_required_categories) then
    raise exception 'A equipe selecionada não atende a todas as categorias dos produtos.';
  end if;
  if cardinality(v_required_skills) > 0 and not (v_selected_skills @> v_required_skills) then
    raise exception 'Os conhecimentos técnicos da equipe não atendem aos produtos do pedido.';
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
