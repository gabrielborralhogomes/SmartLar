begin;

alter table public.configuracao_loja
  add column if not exists cidade text not null default 'São Paulo',
  add column if not exists estado text not null default 'SP';

commit;
