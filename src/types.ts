export type PedidoStatus =
  | "orcamento"
  | "aprovado"
  | "agendado"
  | "em_andamento"
  | "concluido"
  | "cancelado";

export type Cliente = {
  id: string;
  nome: string;
  telefone: string;
  email: string | null;
  endereco: string;
  created_at: string;
};

export type Tecnico = {
  id: string;
  nome: string;
  telefone: string;
  especialidade: string;
};

export type Produto = {
  id: string;
  nome: string;
  categoria: string;
  preco_unitario: number;
  descricao: string;
  ativo: boolean;
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
  tecnico_id: string | null;
  status: PedidoStatus;
  data_instalacao: string | null;
  valor_total: number;
  forma_pagamento: string | null;
  observacoes: string;
  created_at: string;
};

export type PedidoDetalhado = Pedido & {
  cliente?: Cliente;
  tecnico?: Tecnico;
  itens: (ItemPedido & { produto?: Produto })[];
};
