begin;

insert into public.pedido_tecnicos (pedido_id, tecnico_id)
select pedido.id, pedido.tecnico_id
from public.pedidos pedido
where pedido.tecnico_id is not null
on conflict do nothing;

do $$
begin
  if exists (
    select 1
    from public.pedidos pedido
    where pedido.status in ('agendado', 'em_andamento', 'concluido')
      and not exists (
        select 1
        from public.pedido_tecnicos assignment
        where assignment.pedido_id = pedido.id
      )
  ) then
    raise exception 'Existem instalações sem técnico atribuído. Corrija as atribuições antes de remover pedidos.tecnico_id.';
  end if;
end;
$$;

alter table public.pedidos
  drop constraint if exists pedido_agendado_tem_tecnico_e_data;

alter table public.pedidos
  add constraint pedido_agendado_tem_data
  check (status not in ('agendado', 'em_andamento', 'concluido') or data_instalacao is not null);

create or replace function public.validar_fluxo_pedido()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if tg_op = 'INSERT' and new.status <> 'orcamento' then
    raise exception 'Um pedido novo deve começar como orçamento.';
  end if;

  if tg_op = 'UPDATE' and new.status is distinct from old.status then
    if not (
      (old.status = 'orcamento' and new.status in ('aprovado', 'cancelado'))
      or (old.status = 'aprovado' and new.status in ('agendado', 'cancelado'))
      or (old.status = 'agendado' and new.status = 'em_andamento')
      or (old.status = 'em_andamento' and new.status = 'concluido')
    ) then
      raise exception 'Transição de status inválida: % -> %.', old.status, new.status;
    end if;
  end if;

  if new.status in ('agendado', 'em_andamento', 'concluido')
    and not exists (
      select 1
      from public.pedido_tecnicos assignment
      where assignment.pedido_id = new.id
    ) then
    raise exception 'A instalação exige pelo menos um técnico atribuído.';
  end if;

  if new.status = 'agendado'
    and new.data_instalacao <= now()
    and (
      tg_op = 'INSERT'
      or (tg_op = 'UPDATE' and (
        new.status is distinct from old.status
        or new.data_instalacao is distinct from old.data_instalacao
      ))
    ) then
    raise exception 'A data de instalação deve ser futura.';
  end if;

  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists pedidos_validar_fluxo on public.pedidos;
create trigger pedidos_validar_fluxo
before insert or update of status, data_instalacao on public.pedidos
for each row execute function public.validar_fluxo_pedido();

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

  select coalesce(array_agg(distinct required.skill), '{}')
  into v_required_skills
  from public.itens_pedido item
  join public.produtos product on product.id = item.produto_id
  cross join lateral unnest(product.habilidades_instalacao) as required(skill)
  where item.pedido_id = p_pedido_id;
  if cardinality(v_required_skills) = 0 then
    raise exception 'Configure as especialidades de instalação dos produtos antes de agendar.';
  end if;

  select count(*)
  into v_selected_count
  from public.tecnicos technician
  where technician.id = any(p_tecnico_ids)
    and technician.ativo;
  if v_selected_count < cardinality(p_tecnico_ids) then
    raise exception 'Um ou mais técnicos selecionados não existem ou estão inativos.';
  end if;

  select coalesce(array_agg(distinct capability.skill), '{}')
  into v_selected_skills
  from public.tecnicos technician
  cross join lateral unnest(technician.habilidades_instalacao) as capability(skill)
  where technician.id = any(p_tecnico_ids)
    and technician.ativo;
  if not (v_selected_skills @> v_required_skills) then
    raise exception 'Os técnicos selecionados não cobrem todas as especialidades dos produtos.';
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

create or replace function public.validar_equipe_pedido()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if (tg_op = 'DELETE' or new.pedido_id is distinct from old.pedido_id)
    and exists (
      select 1
      from public.pedidos pedido
      where pedido.id = old.pedido_id
        and pedido.status in ('agendado', 'em_andamento', 'concluido')
        and not exists (
          select 1
          from public.pedido_tecnicos assignment
          where assignment.pedido_id = old.pedido_id
            and assignment.tecnico_id <> old.tecnico_id
        )
    ) then
    raise exception 'Não é possível remover o último técnico de uma instalação agendada ou concluída.';
  end if;

  if tg_op = 'DELETE' then
    return old;
  end if;
  return new;
end;
$$;

drop trigger if exists pedido_tecnicos_preservar_equipe on public.pedido_tecnicos;
create trigger pedido_tecnicos_preservar_equipe
before delete or update on public.pedido_tecnicos
for each row execute function public.validar_equipe_pedido();

alter table public.pedidos
  drop column tecnico_id;

commit;
