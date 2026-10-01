begin;

update public.clientes
set rua = endereco
where (rua is null or length(trim(rua)) = 0)
  and endereco is not null
  and length(trim(endereco)) > 0;

alter table public.clientes
  drop column if exists endereco;

commit;
