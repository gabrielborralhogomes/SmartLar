export type PedidoStatus =
  | "orcamento"
  | "aprovado"
  | "agendado"
  | "em_andamento"
  | "concluido"
  | "cancelado";

export type Cliente = {
  id: string;
  ativo: boolean;
  nome: string;
  telefone: string;
  email: string | null;
  rua: string | null;
  numero: string | null;
  complemento: string | null;
  bairro: string | null;
  created_at: string;
};

export type ClienteInput = Omit<Cliente, "id" | "created_at" | "ativo">;

export type StoreProfile = {
  id: number;
  nome: string;
  telefone: string | null;
  rua: string | null;
  numero: string | null;
  complemento: string | null;
  bairro: string | null;
  updated_at: string;
};

export type Tecnico = {
  id: string;
  nome: string;
  telefone: string;
  especialidade: string;
  habilidades_instalacao: string[];
  ativo: boolean;
};

export type Produto = {
  id: string;
  nome: string;
  categoria: string;
  preco_unitario: number;
  descricao: string;
  ativo: boolean;
  habilidades_instalacao: string[];
};

export type ItemPedido = {
  id: string;
  pedido_id: string;
  produto_id: string;
  quantidade: number;
  preco_unitario: number;
  subtotal: number;
};

export type Pedido = {
  id: string;
  cliente_id: string;
  status: PedidoStatus;
  data_instalacao: string | null;
  duracao_instalacao_minutos: number;
  tecnico_ids: string[];
  valor_total: number;
  forma_pagamento: string | null;
  observacoes: string;
  created_at: string;
};

export type PedidoDetalhado = Pedido & {
  cliente?: Cliente;
  tecnicos?: Tecnico[];
  itens: (ItemPedido & { produto?: Produto })[];
};
