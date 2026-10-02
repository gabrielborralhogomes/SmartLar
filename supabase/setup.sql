-- SmartLar database setup for a new Supabase project.
-- Create the administrator in Authentication > Users before running this script.
-- Execute once in the SQL Editor. This script also inserts demo data.
-- Do not run against an existing database; this is not an incremental upgrade.

-- Etapa 1 de 13
create extension if not exists pgcrypto;

create type public.pedido_status as enum (
  'orcamento',
  'aprovado',
  'agendado',
  'em_andamento',
  'concluido',
  'cancelado'
);

create table public.clientes (
  id uuid primary key default gen_random_uuid(),
  nome text not null check (length(trim(nome)) > 0),
  telefone text not null check (length(trim(telefone)) > 0),
  email text unique,
  endereco text not null check (length(trim(endereco)) > 0),
  created_at timestamptz not null default now()
);

create table public.tecnicos (
  id uuid primary key default gen_random_uuid(),
  nome text not null check (length(trim(nome)) > 0),
  telefone text not null,
  especialidade text not null,
  created_at timestamptz not null default now()
);

create table public.produtos (
  id uuid primary key default gen_random_uuid(),
  nome text not null unique,
  categoria text not null,
  preco_unitario numeric(12, 2) not null check (preco_unitario >= 0),
  descricao text not null default '',
  ativo boolean not null default true,
  created_at timestamptz not null default now()
);

create table public.pedidos (
  id uuid primary key default gen_random_uuid(),
  cliente_id uuid not null references public.clientes(id) on delete restrict,
  tecnico_id uuid references public.tecnicos(id) on delete restrict,
  status public.pedido_status not null default 'orcamento',
  data_instalacao timestamptz,
  valor_total numeric(12, 2) not null default 0 check (valor_total >= 0),
  forma_pagamento text,
  observacoes text not null default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint pedido_agendado_tem_tecnico_e_data
    check (status not in ('agendado', 'em_andamento', 'concluido') or (tecnico_id is not null and data_instalacao is not null))
);

create table public.itens_pedido (
  id uuid primary key default gen_random_uuid(),
  pedido_id uuid not null references public.pedidos(id) on delete cascade,
  produto_id uuid not null references public.produtos(id) on delete restrict,
  quantidade integer not null check (quantidade > 0),
  preco_unitario numeric(12, 2) not null check (preco_unitario >= 0),
  subtotal numeric(14, 2) generated always as (quantidade * preco_unitario) stored
);

create table public.historico_status (
  id bigint generated always as identity primary key,
  pedido_id uuid not null references public.pedidos(id) on delete cascade,
  status public.pedido_status not null,
  alterado_em timestamptz not null default now()
);

create index pedidos_status_data_idx on public.pedidos(status, data_instalacao);
create index pedidos_cliente_idx on public.pedidos(cliente_id);
create index itens_pedido_pedido_idx on public.itens_pedido(pedido_id);
create index historico_status_pedido_idx on public.historico_status(pedido_id, alterado_em desc);

create function public.validar_fluxo_pedido()
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

  new.updated_at := now();
  return new;
end;
$$;

create trigger pedidos_validar_fluxo
before insert or update of status, tecnico_id, data_instalacao on public.pedidos
for each row execute function public.validar_fluxo_pedido();

create function public.registrar_historico_status()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if tg_op = 'INSERT' then
    insert into public.historico_status (pedido_id, status)
    values (new.id, new.status);
  elsif new.status is distinct from old.status then
    insert into public.historico_status (pedido_id, status)
    values (new.id, new.status);
  end if;
  return new;
end;
$$;

create trigger pedidos_historico_status
after insert or update of status on public.pedidos
for each row execute function public.registrar_historico_status();

create function public.recalcular_total_pedido()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  v_pedido_id uuid;
begin
  v_pedido_id := case when tg_op = 'DELETE' then old.pedido_id else new.pedido_id end;
  update public.pedidos
  set valor_total = coalesce(
    (select sum(subtotal) from public.itens_pedido where pedido_id = v_pedido_id),
    0
  )
  where id = v_pedido_id;

  if tg_op = 'UPDATE' and old.pedido_id is distinct from new.pedido_id then
    update public.pedidos
    set valor_total = coalesce(
      (select sum(subtotal) from public.itens_pedido where pedido_id = old.pedido_id),
      0
    )
    where id = old.pedido_id;
  end if;
  if tg_op = 'DELETE' then
    return old;
  end if;
  return new;
end;
$$;

create trigger itens_pedido_recalcular_total
after insert or update or delete on public.itens_pedido
for each row execute function public.recalcular_total_pedido();

create function public.criar_pedido_com_itens(
  p_cliente_id uuid,
  p_observacoes text,
  p_itens jsonb
)
returns uuid
language plpgsql
set search_path = public
as $$
declare
  v_pedido_id uuid;
  v_inseridos integer;
begin
  if p_itens is null or jsonb_typeof(p_itens) <> 'array' or jsonb_array_length(p_itens) = 0 then
    raise exception 'Adicione pelo menos um produto ao pedido.';
  end if;

  insert into public.pedidos (cliente_id, observacoes)
  values (p_cliente_id, coalesce(p_observacoes, ''))
  returning id into v_pedido_id;

  insert into public.itens_pedido (pedido_id, produto_id, quantidade, preco_unitario)
  select v_pedido_id, p.id, item.quantidade, p.preco_unitario
  from jsonb_to_recordset(p_itens) as item(produto_id uuid, quantidade integer)
  join public.produtos p on p.id = item.produto_id and p.ativo;

  get diagnostics v_inseridos = row_count;
  if v_inseridos <> jsonb_array_length(p_itens) then
    raise exception 'Um ou mais produtos não existem ou estão inativos.';
  end if;

  return v_pedido_id;
end;
$$;

grant execute on function public.criar_pedido_com_itens(uuid, text, jsonb) to anon, authenticated;

alter table public.clientes enable row level security;
alter table public.tecnicos enable row level security;
alter table public.produtos enable row level security;
alter table public.pedidos enable row level security;
alter table public.itens_pedido enable row level security;
alter table public.historico_status enable row level security;

-- Acesso aberto somente para a demonstração técnica; antes de produção, troque por políticas autenticadas por usuário/empresa.
create policy "demo acesso clientes" on public.clientes for all to anon, authenticated using (true) with check (true);
create policy "demo acesso tecnicos" on public.tecnicos for all to anon, authenticated using (true) with check (true);
create policy "demo acesso produtos" on public.produtos for all to anon, authenticated using (true) with check (true);
create policy "demo acesso pedidos" on public.pedidos for all to anon, authenticated using (true) with check (true);
create policy "demo acesso itens" on public.itens_pedido for all to anon, authenticated using (true) with check (true);
create policy "demo acesso historico" on public.historico_status for all to anon, authenticated using (true) with check (true);

insert into public.tecnicos (id, nome, telefone, especialidade) values
  ('10000000-0000-4000-8000-000000000001', 'Lucas', '(11) 98888-1001', 'Câmeras e sensores'),
  ('10000000-0000-4000-8000-000000000002', 'Pedro', '(11) 98888-1002', 'Fechaduras e iluminação')
on conflict (id) do nothing;

insert into public.clientes (id, nome, telefone, email, endereco) values
  ('20000000-0000-4000-8000-000000000001', 'Mariana Costa', '(11) 99911-2201', 'mariana@example.com', 'Rua das Flores, 120, Pinheiros, São Paulo - SP'),
  ('20000000-0000-4000-8000-000000000002', 'André Martins', '(11) 99911-2202', 'andre@example.com', 'Av. Paulista, 845, Bela Vista, São Paulo - SP'),
  ('20000000-0000-4000-8000-000000000003', 'Camila Souza', '(11) 99911-2203', 'camila@example.com', 'Rua Harmonia, 56, Vila Madalena, São Paulo - SP'),
  ('20000000-0000-4000-8000-000000000004', 'Rogério Lima', '(11) 99911-2204', 'rogerio@example.com', 'Alameda Santos, 410, Jardins, São Paulo - SP'),
  ('20000000-0000-4000-8000-000000000005', 'Beatriz Nunes', '(11) 99911-2205', 'beatriz@example.com', 'Rua Cayowaá, 980, Perdizes, São Paulo - SP')
on conflict (id) do nothing;

insert into public.produtos (id, nome, categoria, preco_unitario, descricao) values
  ('30000000-0000-4000-8000-000000000001', 'Câmera IP Wi-Fi', 'Segurança', 450.00, 'Câmera Full HD com visão noturna'),
  ('30000000-0000-4000-8000-000000000002', 'Sensor de presença', 'Segurança', 180.00, 'Sensor inteligente de movimento'),
  ('30000000-0000-4000-8000-000000000003', 'Fechadura digital', 'Segurança', 890.00, 'Acesso por senha e cartão'),
  ('30000000-0000-4000-8000-000000000004', 'Lâmpada inteligente RGB', 'Iluminação', 95.00, 'Lâmpada Wi-Fi dimerizável'),
  ('30000000-0000-4000-8000-000000000005', 'Interruptor smart', 'Iluminação', 160.00, 'Interruptor inteligente de duas teclas'),
  ('30000000-0000-4000-8000-000000000006', 'Hub de automação', 'Automação', 520.00, 'Central de controle para dispositivos')
on conflict (id) do nothing;

do $$
declare
  v_pedido uuid;
begin
  if exists (select 1 from public.pedidos) then
    return;
  end if;

  insert into public.pedidos (id, cliente_id, observacoes, created_at) values
    ('40000000-0000-4000-8000-000000000001', '20000000-0000-4000-8000-000000000001', 'Orçamento para monitoramento da entrada.', now()),
    ('40000000-0000-4000-8000-000000000002', '20000000-0000-4000-8000-000000000002', 'Avaliar compatibilidade com o portão existente.', now()),
    ('40000000-0000-4000-8000-000000000003', '20000000-0000-4000-8000-000000000003', 'Instalar câmera e sensor no acesso lateral.', now() - interval '2 days'),
    ('40000000-0000-4000-8000-000000000004', '20000000-0000-4000-8000-000000000004', 'Troca de fechadura e configuração.', now() - interval '3 days'),
    ('40000000-0000-4000-8000-000000000005', '20000000-0000-4000-8000-000000000005', 'Agendar instalação de iluminação da sala.', now()),
    ('40000000-0000-4000-8000-000000000006', '20000000-0000-4000-8000-000000000001', 'Automação da iluminação e assistente.', now() - interval '6 days'),
    ('40000000-0000-4000-8000-000000000007', '20000000-0000-4000-8000-000000000002', 'Instalação concluída e testada.', now() - interval '10 days'),
    ('40000000-0000-4000-8000-000000000008', '20000000-0000-4000-8000-000000000003', 'Cliente optou por aguardar a reforma.', now() - interval '12 days');

  insert into public.itens_pedido (pedido_id, produto_id, quantidade, preco_unitario) values
    ('40000000-0000-4000-8000-000000000001', '30000000-0000-4000-8000-000000000001', 2, 450.00),
    ('40000000-0000-4000-8000-000000000001', '30000000-0000-4000-8000-000000000002', 1, 180.00),
    ('40000000-0000-4000-8000-000000000002', '30000000-0000-4000-8000-000000000003', 1, 890.00),
    ('40000000-0000-4000-8000-000000000003', '30000000-0000-4000-8000-000000000001', 2, 450.00),
    ('40000000-0000-4000-8000-000000000003', '30000000-0000-4000-8000-000000000002', 1, 180.00),
    ('40000000-0000-4000-8000-000000000004', '30000000-0000-4000-8000-000000000003', 1, 890.00),
    ('40000000-0000-4000-8000-000000000005', '30000000-0000-4000-8000-000000000004', 4, 95.00),
    ('40000000-0000-4000-8000-000000000006', '30000000-0000-4000-8000-000000000005', 3, 160.00),
    ('40000000-0000-4000-8000-000000000006', '30000000-0000-4000-8000-000000000006', 1, 520.00),
    ('40000000-0000-4000-8000-000000000007', '30000000-0000-4000-8000-000000000001', 1, 450.00),
    ('40000000-0000-4000-8000-000000000008', '30000000-0000-4000-8000-000000000004', 2, 95.00);

  update public.pedidos set status = 'aprovado' where id in (
    '40000000-0000-4000-8000-000000000002', '40000000-0000-4000-8000-000000000003',
    '40000000-0000-4000-8000-000000000004', '40000000-0000-4000-8000-000000000005',
    '40000000-0000-4000-8000-000000000006', '40000000-0000-4000-8000-000000000007'
  );

  update public.pedidos
  set status = 'agendado', tecnico_id = '10000000-0000-4000-8000-000000000001',
      data_instalacao = date_trunc('day', now()) + interval '1 day 10 hours'
  where id = '40000000-0000-4000-8000-000000000003';
  update public.pedidos
  set status = 'agendado', tecnico_id = '10000000-0000-4000-8000-000000000002',
      data_instalacao = date_trunc('day', now()) + interval '2 days 14 hours'
  where id = '40000000-0000-4000-8000-000000000004';
  update public.pedidos
  set status = 'agendado', tecnico_id = '10000000-0000-4000-8000-000000000002',
      data_instalacao = date_trunc('day', now()) + interval '3 days 9 hours'
  where id = '40000000-0000-4000-8000-000000000007';
  update public.pedidos set status = 'em_andamento'
  where id = '40000000-0000-4000-8000-000000000007';
  update public.pedidos set status = 'concluido', forma_pagamento = 'Pix'
  where id = '40000000-0000-4000-8000-000000000007';
  update public.pedidos set status = 'cancelado'
  where id = '40000000-0000-4000-8000-000000000008';
end;
$$;

-- Etapa 2 de 13
alter table public.clientes
  add column if not exists rua text,
  add column if not exists numero text,
  add column if not exists complemento text,
  add column if not exists bairro text,
  add column if not exists cidade text,
  add column if not exists estado text,
  add column if not exists cep text;

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

-- Etapa 3 de 13
begin;

update public.clientes
set rua = endereco
where (rua is null or length(trim(rua)) = 0)
  and endereco is not null
  and length(trim(endereco)) > 0;

alter table public.clientes
  drop column if exists endereco;

commit;

-- Etapa 4 de 13
alter table public.clientes
  add column if not exists ativo boolean not null default true;

-- Etapa 5 de 13
begin;

alter table public.clientes
  drop column if exists cidade,
  drop column if exists estado,
  drop column if exists cep;

create or replace function public.validar_endereco_cliente()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if length(trim(coalesce(new.rua, ''))) = 0
    or length(trim(coalesce(new.numero, ''))) = 0
    or length(trim(coalesce(new.bairro, ''))) = 0 then
    raise exception 'Rua, número e bairro são obrigatórios.';
  end if;
  return new;
end;
$$;

drop trigger if exists clientes_validar_endereco on public.clientes;
create trigger clientes_validar_endereco
before insert or update of rua, numero, complemento, bairro on public.clientes
for each row execute function public.validar_endereco_cliente();

commit;

-- Etapa 6 de 13
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

-- Etapa 7 de 13
begin;

alter table public.configuracao_loja
  add column if not exists cidade text not null default 'São Paulo',
  add column if not exists estado text not null default 'SP';

commit;

-- Etapa 8 de 13
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

-- Etapa 9 de 13
begin;

alter table public.tecnicos
  add column if not exists ativo boolean not null default true;

create or replace function public.validar_tecnico_ativo_em_pedido()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if not exists (
    select 1
    from public.tecnicos
    where id = new.tecnico_id
      and ativo
  ) then
    raise exception 'Não é possível atribuir um técnico inativo a uma instalação.';
  end if;
  return new;
end;
$$;

drop trigger if exists pedido_tecnicos_validar_ativo on public.pedido_tecnicos;
create trigger pedido_tecnicos_validar_ativo
before insert or update of tecnico_id on public.pedido_tecnicos
for each row execute function public.validar_tecnico_ativo_em_pedido();

commit;

-- Etapa 10 de 13
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

-- Etapa 11 de 13
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

-- Etapa 12 de 13
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

-- Etapa 13 de 13
begin;

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
  if p_tecnico_ids is null or cardinality(p_tecnico_ids) < 1 then
    raise exception 'Selecione pelo menos um técnico para a instalação.';
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
