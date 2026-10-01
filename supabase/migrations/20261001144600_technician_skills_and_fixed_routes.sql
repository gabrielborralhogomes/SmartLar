begin;

alter table public.tecnicos
  add column if not exists habilidades_instalacao text[] not null default '{}';

update public.tecnicos
set habilidades_instalacao = case
  when lower(nome) = 'lucas' then array['camera_sensor']::text[]
  when lower(nome) = 'pedro' then array['fechadura_iluminacao']::text[]
  else habilidades_instalacao
end;

alter table public.tecnicos
  add constraint tecnicos_habilidades_instalacao_valid
  check (habilidades_instalacao <@ array['camera_sensor', 'fechadura_iluminacao']::text[]);

alter table public.produtos
  add column if not exists habilidades_instalacao text[] not null default '{}';

update public.produtos
set habilidades_instalacao = case
  when lower(nome) like '%câmera%' or lower(nome) like '%sensor%'
    then array['camera_sensor']::text[]
  when lower(nome) like '%fechadura%' or lower(nome) like '%lâmpada%'
    or lower(nome) like '%interruptor%'
    then array['fechadura_iluminacao']::text[]
  when lower(nome) like '%hub%'
    then array['camera_sensor', 'fechadura_iluminacao']::text[]
  else habilidades_instalacao
end;

alter table public.produtos
  add constraint produtos_habilidades_instalacao_valid
  check (habilidades_instalacao <@ array['camera_sensor', 'fechadura_iluminacao']::text[]);

alter table public.pedidos
  add column if not exists duracao_instalacao_minutos integer not null default 60
    check (duracao_instalacao_minutos between 15 and 480);

create table if not exists public.pedido_tecnicos (
  pedido_id uuid not null references public.pedidos(id) on delete cascade,
  tecnico_id uuid not null references public.tecnicos(id) on delete restrict,
  primary key (pedido_id, tecnico_id)
);

create index if not exists pedido_tecnicos_tecnico_pedido_idx
  on public.pedido_tecnicos(tecnico_id, pedido_id);

insert into public.pedido_tecnicos (pedido_id, tecnico_id)
select id, tecnico_id
from public.pedidos
where tecnico_id is not null
on conflict do nothing;

alter table public.pedido_tecnicos enable row level security;
create policy "authenticated access pedido_tecnicos" on public.pedido_tecnicos
  for all to authenticated using (auth.uid() is not null) with check (auth.uid() is not null);
revoke all on public.pedido_tecnicos from anon;
grant select, insert, update, delete on public.pedido_tecnicos to authenticated;

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
  where technician.id = any(p_tecnico_ids);

  if v_selected_count < cardinality(p_tecnico_ids) then
    raise exception 'Um ou mais técnicos selecionados não existem.';
  end if;

  select coalesce(array_agg(distinct capability.skill), '{}')
  into v_selected_skills
  from public.tecnicos technician
  cross join lateral unnest(technician.habilidades_instalacao) as capability(skill)
  where technician.id = any(p_tecnico_ids);
  if not (v_selected_skills @> v_required_skills) then
    raise exception 'Os técnicos selecionados não cobrem todas as especialidades dos produtos.';
  end if;

  update public.pedidos
  set status = 'agendado',
      tecnico_id = p_tecnico_ids[1],
      data_instalacao = p_data_instalacao,
      duracao_instalacao_minutos = p_duracao_minutos
  where id = p_pedido_id;

  delete from public.pedido_tecnicos where pedido_id = p_pedido_id;
  insert into public.pedido_tecnicos (pedido_id, tecnico_id)
  select p_pedido_id, selected_id
  from unnest(p_tecnico_ids) as selected(selected_id);
end;
$$;

revoke execute on function public.agendar_pedido(uuid, uuid[], timestamptz, integer) from public, anon;
grant execute on function public.agendar_pedido(uuid, uuid[], timestamptz, integer) to authenticated;

commit;
