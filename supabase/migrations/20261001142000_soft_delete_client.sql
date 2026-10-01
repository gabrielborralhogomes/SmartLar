alter table public.clientes
  add column if not exists ativo boolean not null default true;
