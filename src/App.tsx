import { Fragment, useCallback, useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import { supabase } from "./lib/supabase";
import type { Cliente, ClienteInput, ItemPedido, Pedido, PedidoDetalhado, PedidoStatus, Produto, Tecnico } from "./types";

type Page = "dashboard" | "clientes" | "produtos" | "pedidos" | "gestao" | "agenda";
type OrderLine = { produto_id: string; quantidade: number };
type ActionResult<T> = { ok: true; value: T } | { ok: false };

const statusLabel: Record<PedidoStatus, string> = {
  orcamento: "Orçamento",
  aprovado: "Aprovado",
  agendado: "Agendado",
  em_andamento: "Em andamento",
  concluido: "Concluído",
  cancelado: "Cancelado",
};

const currency = new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" });
const dateTime = new Intl.DateTimeFormat("pt-BR", { dateStyle: "short", timeStyle: "short" });
const dateOnly = new Intl.DateTimeFormat("pt-BR", { dateStyle: "medium" });

function toLocalDateTimeInput(value: string | null) {
  if (!value) return "";
  const date = new Date(value);
  date.setMinutes(date.getMinutes() - date.getTimezoneOffset());
  return date.toISOString().slice(0, 16);
}

function localDateTimeMinimum() {
  const now = new Date();
  now.setSeconds(0, 0);
  now.setMinutes(now.getMinutes() + 1);
  now.setMinutes(now.getMinutes() - now.getTimezoneOffset());
  return now.toISOString().slice(0, 16);
}

function getClientAddress(client: Cliente) {
  if (!client.rua) return client.endereco;
  const parts = [
    [client.rua, client.numero].filter(Boolean).join(", "),
    client.complemento,
    client.bairro,
    client.cidade,
    client.estado,
    client.cep,
  ].filter(Boolean);
  return parts.join(" · ");
}

function clientValuesFromForm(form: FormData, prefix = ""): ClienteInput {
  const value = (name: string) => String(form.get(`${prefix}${name}`) ?? "").trim();
  const rua = value("rua");
  const numero = value("numero");
  const complemento = value("complemento");
  const bairro = value("bairro");
  const cidade = value("cidade");
  const estado = value("estado");
  const cep = value("cep");
  return {
    nome: value("nome"),
    telefone: value("telefone"),
    email: value("email") || null,
    rua,
    numero,
    complemento: complemento || null,
    bairro,
    cidade: cidade || null,
    estado: estado || null,
    cep: cep || null,
    endereco: [[rua, numero].filter(Boolean).join(", "), complemento, bairro, cidade, estado, cep].filter(Boolean).join(" · "),
  };
}

function ClientAddressFields({ prefix = "" }: { prefix?: string }) {
  return <>
    <Field label="Rua"><input name={`${prefix}rua`} required /></Field>
    <Field label="Número"><input name={`${prefix}numero`} placeholder="Nº ou S/N" required /></Field>
    <Field label="Complemento (opcional)"><input name={`${prefix}complemento`} /></Field>
    <Field label="Bairro"><input name={`${prefix}bairro`} required /></Field>
    <Field label="Cidade (opcional)"><input name={`${prefix}cidade`} /></Field>
    <Field label="Estado (opcional)"><input name={`${prefix}estado`} maxLength={2} /></Field>
    <Field label="CEP (opcional)"><input name={`${prefix}cep`} inputMode="numeric" /></Field>
  </>;
}

function asErrorMessage(error: unknown) {
  if (error && typeof error === "object" && "message" in error && typeof error.message === "string") {
    return error.message;
  }
  return "Ocorreu um erro inesperado. Tente novamente.";
}

function StatusBadge({ status }: { status: PedidoStatus }) {
  return <span className={`status-badge status-${status}`}>{statusLabel[status]}</span>;
}

function App() {
  const db = supabase;
  const [page, setPage] = useState<Page>("dashboard");
  const [clientes, setClientes] = useState<Cliente[]>([]);
  const [tecnicos, setTecnicos] = useState<Tecnico[]>([]);
  const [produtos, setProdutos] = useState<Produto[]>([]);
  const [pedidos, setPedidos] = useState<PedidoDetalhado[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [errorMessage, setErrorMessage] = useState("");
  const [successMessage, setSuccessMessage] = useState("");
  const loadedOnce = useRef(false);

  const reload = useCallback(async () => {
    if (!db) return;
    if (!loadedOnce.current) setLoading(true);
    setErrorMessage("");
    const [clientsResult, techniciansResult, productsResult, ordersResult, itemsResult] = await Promise.all([
      db.from("clientes").select("*").order("nome"),
      db.from("tecnicos").select("*").order("nome"),
      db.from("produtos").select("*").order("categoria").order("nome"),
      db.from("pedidos").select("*").order("created_at", { ascending: false }),
      db.from("itens_pedido").select("*"),
    ]);
    const firstError = clientsResult.error ?? techniciansResult.error ?? productsResult.error ?? ordersResult.error ?? itemsResult.error;
    if (firstError) {
      setErrorMessage(`Não foi possível carregar os dados: ${firstError.message}`);
      loadedOnce.current = true;
      setLoading(false);
      return;
    }

    const clients = (clientsResult.data ?? []) as Cliente[];
    const technicians = (techniciansResult.data ?? []) as Tecnico[];
    const products = (productsResult.data ?? []) as Produto[];
    const itemRows = (itemsResult.data ?? []) as ItemPedido[];
    const clientById = new Map(clients.map((client) => [client.id, client]));
    const technicianById = new Map(technicians.map((technician) => [technician.id, technician]));
    const productById = new Map(products.map((product) => [product.id, product]));
    const itemsByOrder = new Map<string, ItemPedido[]>();
    for (const item of itemRows) {
      itemsByOrder.set(item.pedido_id, [...(itemsByOrder.get(item.pedido_id) ?? []), item]);
    }

    setClientes(clients);
    setTecnicos(technicians);
    setProdutos(products);
    setPedidos(((ordersResult.data ?? []) as Pedido[]).map((order) => ({
      ...order,
      cliente: clientById.get(order.cliente_id),
      tecnico: order.tecnico_id ? technicianById.get(order.tecnico_id) : undefined,
      itens: (itemsByOrder.get(order.id) ?? []).map((item) => ({ ...item, produto: productById.get(item.produto_id) })),
    })));
    loadedOnce.current = true;
    setLoading(false);
  }, [db]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const runAction = async <T,>(action: () => Promise<T>, success?: string): Promise<ActionResult<T>> => {
    setBusy(true);
    setErrorMessage("");
    setSuccessMessage("");
    try {
      const value = await action();
      if (success) setSuccessMessage(success);
      await reload();
      return { ok: true, value };
    } catch (error) {
      setErrorMessage(asErrorMessage(error));
      return { ok: false };
    } finally {
      setBusy(false);
    }
  };

  if (!db) {
    return (
      <main className="setup-screen">
        <div className="setup-card">
          <div className="brand-mark">S</div>
          <p className="eyebrow">SMARTLAR · GESTÃO</p>
          <h1>Conecte seu projeto Supabase</h1>
          <p>Configure as variáveis de ambiente para carregar os dados reais do sistema.</p>
          <ol>
            <li>Copie <code>.env.example</code> para <code>.env.local</code>.</li>
            <li>Preencha a URL do projeto e a chave pública (anon) do Supabase.</li>
            <li>Execute a migration <code>supabase/migrations/20261001000000_smartlar.sql</code>.</li>
            <li>Reinicie o servidor de desenvolvimento.</li>
          </ol>
          <div className="setup-note">Nunca coloque a chave <code>service_role</code> no frontend.</div>
        </div>
      </main>
    );
  }

  const navItems: { id: Page; title: string; icon: string }[] = [
    { id: "dashboard", title: "Visão geral", icon: "⌂" },
    { id: "clientes", title: "Clientes", icon: "♙" },
    { id: "produtos", title: "Produtos", icon: "▦" },
    { id: "pedidos", title: "Pedidos", icon: "☷" },
    { id: "gestao", title: "Gestão de pedidos", icon: "▤" },
    { id: "agenda", title: "Agenda técnica", icon: "▣" },
  ];

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand">
          <div className="brand-mark">S</div>
          <div><strong>smartlar</strong><span>PAINEL DE GESTÃO</span></div>
        </div>
        <div className="workspace-label">MENU PRINCIPAL</div>
        <nav>
          {navItems.map((item) => (
            <button className={`nav-link ${page === item.id ? "active" : ""}`} key={item.id} onClick={() => setPage(item.id)}>
              <span className="nav-icon">{item.icon}</span>{item.title}
            </button>
          ))}
        </nav>
        <div className="sidebar-bottom">
          <div className="sidebar-avatar">RF</div>
          <div className="sidebar-user"><strong>Rafael Ferreira</strong><span>Administrador</span></div>
          <span className="online-dot" title="Sistema conectado" />
        </div>
      </aside>

      <main className="main-area">
        <header className="topbar">
          <div className="breadcrumbs">SmartLar <span>/</span> {navItems.find((item) => item.id === page)?.title}</div>
          <div className="topbar-right"><span className="live-dot" /> Banco conectado <span className="topbar-divider" />{new Intl.DateTimeFormat("pt-BR", { dateStyle: "long" }).format(new Date())}</div>
        </header>
        <div className="page-content">
          {errorMessage && <div className="notice notice-error" role="alert"><strong>Não foi possível concluir.</strong> {errorMessage}<button onClick={() => setErrorMessage("")} aria-label="Fechar aviso">×</button></div>}
          {successMessage && <div className="notice notice-success" role="status">{successMessage}<button onClick={() => setSuccessMessage("")} aria-label="Fechar aviso">×</button></div>}
          {loading ? <div className="loading-state"><span className="spinner" />Carregando informações do Supabase...</div> : (
            <>
              {page === "dashboard" && <Dashboard pedidos={pedidos} onNavigate={setPage} />}
              {page === "clientes" && <ClientsPage clientes={clientes} pedidos={pedidos} onSave={(values) => runAction(async () => {
                const { error } = await db.from("clientes").insert(values);
                if (error) throw error;
              }, "Cliente cadastrado com sucesso.")} />}
              {page === "produtos" && <ProductsPage produtos={produtos} onSave={(values) => runAction(async () => {
                const { error } = await db.from("produtos").insert(values);
                if (error) throw error;
              }, "Produto cadastrado com sucesso.")} onPriceChange={(id, price) => runAction(async () => {
                const { error } = await db.from("produtos").update({ preco_unitario: price }).eq("id", id);
                if (error) throw error;
              }, "Preço atualizado.")} onActiveChange={(id, ativo) => runAction(async () => {
                const { error } = await db.from("produtos").update({ ativo }).eq("id", id);
                if (error) throw error;
              }, ativo ? "Produto reativado." : "Produto excluído do catálogo; o histórico foi preservado.")} />}
              {page === "pedidos" && <OrdersPage clientes={clientes} produtos={produtos}
                busy={busy}
                onCreateClient={(values) => runAction(async () => {
                  const { data, error } = await db.from("clientes").insert(values).select("id").single();
                  if (error) throw error;
                  return data.id;
                }, "Cliente cadastrado. Finalizando o orçamento.")}
                onCreate={(clienteId, observacoes, itens) => runAction(async () => {
                  const { error } = await db.rpc("criar_pedido_com_itens", {
                    p_cliente_id: clienteId, p_observacoes: observacoes,
                    p_itens: itens.map((item) => ({ produto_id: item.produto_id, quantidade: item.quantidade })),
                  });
                  if (error) throw error;
                }, "Orçamento criado e salvo no Supabase.")}
              />}
              {page === "gestao" && <OrderManagementPage pedidos={pedidos} clientes={clientes} tecnicos={tecnicos} onNavigate={() => setPage("pedidos")}
                busy={busy} onStatusChange={(pedido, status, tecnicoId, dataInstalacao) => runAction(async () => {
                  const updates: Partial<Pedido> = { status };
                  if (status === "agendado") {
                    updates.tecnico_id = tecnicoId;
                    updates.data_instalacao = dataInstalacao;
                  }
                  const { error } = await db.from("pedidos").update(updates).eq("id", pedido.id);
                  if (error) throw error;
                }, `Pedido atualizado para "${statusLabel[status]}".`)} />}
              {page === "agenda" && <SchedulePage pedidos={pedidos} tecnicos={tecnicos} busy={busy}
                onStatusChange={(pedido, status) => runAction(async () => {
                  const { error } = await db.from("pedidos").update({ status }).eq("id", pedido.id);
                  if (error) throw error;
                }, `Instalação marcada como "${statusLabel[status]}".`)} />}
            </>
          )}
        </div>
      </main>
    </div>
  );
}

function PageHeading({ eyebrow, title, description, action }: { eyebrow: string; title: string; description: string; action?: ReactNode }) {
  return <div className="page-heading"><div><p className="eyebrow">{eyebrow}</p><h1>{title}</h1><p className="heading-description">{description}</p></div>{action}</div>;
}

function Dashboard({ pedidos, onNavigate }: { pedidos: PedidoDetalhado[]; onNavigate: (page: Page) => void }) {
  const hour = new Date().getHours();
  const greeting = hour < 12 ? "Bom dia" : hour < 18 ? "Boa tarde" : "Boa noite";
  const startOfMonth = new Date();
  startOfMonth.setDate(1);
  startOfMonth.setHours(0, 0, 0, 0);
  const nextWeek = new Date();
  nextWeek.setDate(nextWeek.getDate() + 7);
  const monthOrders = pedidos.filter((order) => new Date(order.created_at) >= startOfMonth);
  const completedRevenue = monthOrders.filter((order) => order.status === "concluido").reduce((sum, order) => sum + Number(order.valor_total), 0);
  const receivable = pedidos.filter((order) => ["aprovado", "agendado", "em_andamento"].includes(order.status)).reduce((sum, order) => sum + Number(order.valor_total), 0);
  const appointments = pedidos.filter((order) => order.status === "agendado" && order.data_instalacao && new Date(order.data_instalacao) >= new Date() && new Date(order.data_instalacao) <= nextWeek).sort((a, b) => (a.data_instalacao ?? "").localeCompare(b.data_instalacao ?? ""));
  const awaitingSchedule = pedidos.filter((order) => order.status === "aprovado");
  const quotes = pedidos.filter((order) => order.status === "orcamento");
  const weeklyCounts = Array.from({ length: 7 }, (_, index) => {
    const day = new Date();
    day.setHours(0, 0, 0, 0);
    day.setDate(day.getDate() - (6 - index));
    const nextDay = new Date(day);
    nextDay.setDate(nextDay.getDate() + 1);
    return {
      label: day.toLocaleDateString("pt-BR", { weekday: "short" }).replace(".", ""),
      count: pedidos.filter((order) => {
        const created = new Date(order.created_at);
        return created >= day && created < nextDay;
      }).length,
    };
  });
  const maxDailyOrders = Math.max(1, ...weeklyCounts.map((day) => day.count));
  const statusCounts = (Object.keys(statusLabel) as PedidoStatus[]).map((status) => ({
    status,
    count: pedidos.filter((order) => order.status === status).length,
  }));
  const maxStatusCount = Math.max(1, ...statusCounts.map((item) => item.count));
  const metrics = [
    { label: "Pedidos no mês", value: String(monthOrders.length), note: "Criados neste mês", icon: "▤", color: "blue" },
    { label: "Faturado no mês", value: currency.format(completedRevenue), note: "Pedidos concluídos", icon: "↗", color: "green" },
    { label: "A receber", value: currency.format(receivable), note: "Aprovados e em instalação", icon: "◷", color: "amber" },
    { label: "Aguardando agenda", value: String(awaitingSchedule.length), note: "Pedidos aprovados", icon: "▦", color: "violet" },
  ];

  return <>
    <PageHeading eyebrow="RESUMO DA OPERAÇÃO" title={`${greeting}, Rafael`} description="Aqui está o resumo da operação da SmartLar." action={<button className="button button-primary" onClick={() => onNavigate("pedidos")}><span>＋</span> Novo orçamento</button>} />
    <section className="metrics-grid">{metrics.map((metric) => <article className="metric-card" key={metric.label}>
      <div className={`metric-icon ${metric.color}`}>{metric.icon}</div><div className="metric-label">{metric.label}</div><strong>{metric.value}</strong><span className="metric-note">{metric.note}</span>
    </article>)}</section>
    <div className="dashboard-charts">
      <section className="panel chart-panel">
        <div className="panel-heading"><div><h2>Pedidos nos últimos 7 dias</h2><p>Novos pedidos por dia de criação</p></div></div>
        <div className="weekly-chart" role="img" aria-label="Gráfico de pedidos criados por dia nos últimos sete dias">
          {weeklyCounts.map((day) => <div className="weekly-chart-column" key={day.label}>
            <strong>{day.count}</strong><div className="weekly-chart-track"><span style={{ height: `${Math.max(day.count ? 12 : 3, (day.count / maxDailyOrders) * 100)}%` }} /></div><small>{day.label}</small>
          </div>)}
        </div>
      </section>
      <section className="panel chart-panel">
        <div className="panel-heading"><div><h2>Pedidos por status</h2><p>Distribuição atual da carteira</p></div></div>
        <div className="status-chart">{statusCounts.map(({ status, count }) => <div className="status-chart-row" key={status}>
          <span>{statusLabel[status]}</span><div className="status-chart-track"><i className={`status-chart-fill status-${status}`} style={{ width: `${(count / maxStatusCount) * 100}%` }} /></div><strong>{count}</strong>
        </div>)}</div>
      </section>
    </div>
    <div className="dashboard-grid">
      <section className="panel">
        <div className="panel-heading"><div><h2>Próximas instalações</h2><p>Agenda dos próximos 7 dias</p></div><button className="text-button" onClick={() => onNavigate("agenda")}>Ver agenda <span>→</span></button></div>
        {appointments.length === 0 ? <EmptyState title="Agenda livre por enquanto" text="Instalações marcadas para os próximos dias aparecem aqui." /> :
          <div className="appointment-list">{appointments.map((order) => <div className="appointment-row" key={order.id}>
            <div className="appointment-date"><strong>{order.data_instalacao ? new Date(order.data_instalacao).toLocaleDateString("pt-BR", { day: "2-digit" }) : "—"}</strong><span>{order.data_instalacao ? new Date(order.data_instalacao).toLocaleDateString("pt-BR", { month: "short" }).replace(".", "") : ""}</span></div>
            <div className="appointment-info"><strong>{order.cliente?.nome ?? "Cliente"}</strong><span>{order.cliente ? getClientAddress(order.cliente) : "Endereço não informado"}</span></div>
            <div className="appointment-tech"><strong>{order.tecnico?.nome ?? "Sem técnico"}</strong><span>{order.data_instalacao ? new Date(order.data_instalacao).toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" }) : ""}</span></div>
          </div>)}</div>}
      </section>
      <section className="panel">
        <div className="panel-heading"><div><h2>Orçamentos aguardando</h2><p>{quotes.length} aguardando retorno</p></div><button className="text-button" onClick={() => onNavigate("gestao")}>Ver pedidos <span>→</span></button></div>
        {quotes.length === 0 ? <EmptyState title="Tudo em dia" text="Novos orçamentos vão aparecer nesta lista." /> :
          <div className="quote-list">{quotes.slice(0, 5).map((order) => <div className="quote-row" key={order.id}>
            <div className="client-avatar">{order.cliente?.nome.slice(0, 1) ?? "?"}</div><div className="quote-info"><strong>{order.cliente?.nome ?? "Cliente"}</strong><span>{dateOnly.format(new Date(order.created_at))}</span></div><strong className="quote-price">{currency.format(Number(order.valor_total))}</strong>
          </div>)}</div>}
      </section>
    </div>
    <div className="quick-actions"><div><span className="quick-icon">↗</span><div><strong>Atalhos rápidos</strong><span>O que você gostaria de fazer?</span></div></div>
      <button className="quick-action" onClick={() => onNavigate("clientes")}>＋ Cadastrar cliente</button><button className="quick-action" onClick={() => onNavigate("pedidos")}>▤ Criar orçamento</button><button className="quick-action" onClick={() => onNavigate("agenda")}>▣ Ver agenda</button>
    </div>
  </>;
}

function ClientsPage({ clientes, pedidos, onSave }: { clientes: Cliente[]; pedidos: PedidoDetalhado[]; onSave: (values: ClienteInput) => Promise<ActionResult<void>> }) {
  const [search, setSearch] = useState("");
  const [selected, setSelected] = useState<string | null>(null);
  const [formOpen, setFormOpen] = useState(false);
  const visible = clientes.filter((client) => `${client.nome} ${client.telefone} ${client.email ?? ""} ${getClientAddress(client)}`.toLocaleLowerCase("pt-BR").includes(search.toLocaleLowerCase("pt-BR")));

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const formElement = event.currentTarget;
    const form = new FormData(formElement);
    const result = await onSave(clientValuesFromForm(form));
    if (!result.ok) return;
    formElement.reset();
    setFormOpen(false);
  };

  return <>
    <PageHeading eyebrow="RELACIONAMENTO" title="Clientes" description="Cadastre e acompanhe as informações de quem confia na SmartLar." action={<button className="button button-primary" onClick={() => setFormOpen(!formOpen)}>＋ Novo cliente</button>} />
    {formOpen && <form className="panel form-panel" onSubmit={(event) => void submit(event)}><div className="panel-heading"><div><h2>Novo cliente</h2><p>Telefone e endereço são obrigatórios.</p></div><button type="button" className="icon-button" onClick={() => setFormOpen(false)}>×</button></div>
      <div className="form-grid"><Field label="Nome completo"><input name="nome" required /></Field><Field label="WhatsApp / telefone"><input name="telefone" type="tel" required /></Field><Field label="E-mail (opcional)"><input name="email" type="email" /></Field><ClientAddressFields /></div><div className="form-actions"><button className="button button-primary">Salvar cliente</button></div>
    </form>}
    <section className="panel">
      <div className="list-toolbar"><div><h2>Todos os clientes <span className="count-pill">{clientes.length}</span></h2><p>Pesquise por nome, telefone ou endereço.</p></div><label className="search-box"><span>⌕</span><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Buscar cliente..." /></label></div>
      <div className="table-wrap"><table><thead><tr><th>CLIENTE</th><th>TELEFONE</th><th>E-MAIL</th><th>ENDEREÇO</th><th>PEDIDOS</th><th /></tr></thead><tbody>
        {visible.map((client) => {
          const clientOrders = pedidos.filter((order) => order.cliente_id === client.id);
          return <Fragment key={client.id}>
            <tr>
              <td><div className="table-client"><div className="client-avatar">{client.nome.slice(0, 1)}</div><strong>{client.nome}</strong></div></td><td>{client.telefone}</td><td>{client.email || "—"}</td><td className="address-cell" title={getClientAddress(client)}>{getClientAddress(client)}</td><td><span className="count-pill">{clientOrders.length}</span></td><td><button className="text-button" onClick={() => setSelected(selected === client.id ? null : client.id)}>{selected === client.id ? "Fechar" : "Ver pedidos"}</button></td>
            </tr>
            {selected === client.id && <tr className="client-details-row"><td colSpan={6}>
              <div className="selected-client-orders"><strong>Pedidos de {client.nome}</strong>
                {clientOrders.length === 0 ? <p>Este cliente ainda não tem pedidos.</p> : clientOrders.map((order) => <div className="mini-order" key={order.id}><span>#{order.id.slice(0, 8)}</span><StatusBadge status={order.status} /><strong>{currency.format(Number(order.valor_total))}</strong><span>{dateOnly.format(new Date(order.created_at))}</span></div>)}
              </div>
            </td></tr>}
          </Fragment>;
        })}
      </tbody></table>{visible.length === 0 && <EmptyState title="Nenhum cliente encontrado" text="Tente outro nome ou telefone." />}</div>
    </section>
  </>;
}

function ProductsPage({ produtos, onSave, onPriceChange, onActiveChange }: { produtos: Produto[]; onSave: (values: Omit<Produto, "id" | "ativo">) => Promise<ActionResult<void>>; onPriceChange: (id: string, price: number) => Promise<ActionResult<void>>; onActiveChange: (id: string, active: boolean) => Promise<ActionResult<void>> }) {
  const [formOpen, setFormOpen] = useState(false);
  const [editingPrice, setEditingPrice] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [category, setCategory] = useState("todas");
  const activeProducts = produtos.filter((product) => product.ativo);
  const categories = [...new Set(activeProducts.map((product) => product.categoria))].sort((a, b) => a.localeCompare(b, "pt-BR"));
  const filteredProducts = activeProducts.filter((product) =>
    (category === "todas" || product.categoria === category)
    && `${product.nome} ${product.categoria} ${product.descricao}`.toLocaleLowerCase("pt-BR").includes(search.toLocaleLowerCase("pt-BR")));
  const groups = filteredProducts.reduce<Record<string, Produto[]>>((result, product) => {
    result[product.categoria] = [...(result[product.categoria] ?? []), product];
    return result;
  }, {});

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const formElement = event.currentTarget;
    const form = new FormData(formElement);
    const result = await onSave({ nome: String(form.get("nome")).trim(), categoria: String(form.get("categoria")).trim(), preco_unitario: Number(form.get("preco")), descricao: String(form.get("descricao")).trim() });
    if (!result.ok) return;
    formElement.reset();
    setFormOpen(false);
  };

  return <>
    <PageHeading eyebrow="CATÁLOGO" title="Produtos" description="Organize os equipamentos e mantenha os preços atualizados." action={<button className="button button-primary" onClick={() => setFormOpen(!formOpen)}>＋ Novo produto</button>} />
    {formOpen && <form className="panel form-panel" onSubmit={(event) => void submit(event)}><div className="panel-heading"><div><h2>Cadastrar produto</h2><p>Defina nome, categoria e preço de venda.</p></div><button type="button" className="icon-button" onClick={() => setFormOpen(false)}>×</button></div><div className="form-grid">
      <Field label="Nome do produto"><input name="nome" required /></Field><Field label="Categoria"><input name="categoria" placeholder="Ex.: Segurança" required /></Field><Field label="Preço unitário (R$)"><input name="preco" type="number" step="0.01" min="0" required /></Field><Field label="Descrição"><input name="descricao" /></Field>
    </div><div className="form-actions"><button className="button button-primary">Salvar produto</button></div></form>}
    <div className="catalog-filters"><label className="search-box"><span>⌕</span><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Buscar produto..." /></label><Field label="Categoria"><select value={category} onChange={(event) => setCategory(event.target.value)}><option value="todas">Todas as categorias</option>{categories.map((item) => <option key={item} value={item}>{item}</option>)}</select></Field></div>
    <div className="catalog-summary"><strong>{filteredProducts.length}</strong> produtos ativos <span>·</span> {Object.keys(groups).length} categorias</div>
    {Object.entries(groups).map(([category, categoryProducts]) => <section className="catalog-section" key={category}><div className="catalog-heading"><div className="category-icon">▦</div><h2>{category}</h2><span className="count-pill">{categoryProducts.length}</span></div><div className="product-grid">
      {categoryProducts.map((product) => <article className="product-card" key={product.id}><div className="product-card-top"><div className="product-icon">{product.categoria.toLowerCase().includes("ilum") ? "☼" : product.categoria.toLowerCase().includes("seg") ? "◈" : "⌘"}</div><div className="product-card-actions"><button className="icon-button" title="Editar preço" aria-label={`Editar preço de ${product.nome}`} onClick={() => setEditingPrice(editingPrice === product.id ? null : product.id)}>✎</button><button className="icon-button product-delete" title="Excluir produto sem apagar pedidos históricos" aria-label={`Excluir ${product.nome}`} onClick={() => { if (window.confirm(`Excluir "${product.nome}" do catálogo? Os pedidos históricos serão preservados.`)) void onActiveChange(product.id, false); }}>×</button></div></div><span className="product-category">{product.categoria}</span><h3>{product.nome}</h3><p>{product.descricao || "Sem descrição adicional."}</p>{editingPrice === product.id ? <form className="inline-price-form" onSubmit={async (event) => { event.preventDefault(); const value = Number(new FormData(event.currentTarget).get("price")); const result = await onPriceChange(product.id, value); if (result.ok) setEditingPrice(null); }}><input aria-label="Novo preço" name="price" type="number" step="0.01" min="0" defaultValue={product.preco_unitario} required /><button className="button button-primary button-small">Salvar</button></form> : <div className="product-price">{currency.format(Number(product.preco_unitario))}<span> / unidade</span></div>}</article>)}
    </div></section>)}
    {filteredProducts.length === 0 && <EmptyState title="Nenhum produto encontrado" text="Ajuste a busca ou escolha outra categoria." />}
  </>;
}

function OrdersPage({ clientes, produtos, busy, onCreate, onCreateClient }: {
  clientes: Cliente[]; produtos: Produto[]; busy: boolean;
  onCreate: (clienteId: string, observacoes: string, itens: OrderLine[]) => Promise<ActionResult<void>>;
  onCreateClient: (values: ClienteInput) => Promise<ActionResult<string>>;
}) {
  const formRef = useRef<HTMLFormElement>(null);
  const [lines, setLines] = useState<OrderLine[]>([{ produto_id: "", quantidade: 1 }]);
  const [newClientMode, setNewClientMode] = useState(false);
  const resetForm = () => {
    formRef.current?.reset();
    setLines([{ produto_id: "", quantidade: 1 }]);
    setNewClientMode(false);
  };
  const currentTotal = lines.reduce((sum, line) => {
    const product = produtos.find((item) => item.id === line.produto_id);
    return sum + (product ? product.preco_unitario * line.quantidade : 0);
  }, 0);

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    let clienteId = String(form.get("cliente_id"));
    const observacoes = String(form.get("observacoes")).trim();
    if (clienteId === "novo") {
      const result = await onCreateClient(clientValuesFromForm(form, "novo_"));
      if (!result.ok) return;
      clienteId = result.value;
    }
    const orderLines = lines.filter((line) => line.produto_id);
    if (!clienteId || orderLines.length === 0 || orderLines.some((line) => line.quantidade < 1)) return;
    const result = await onCreate(clienteId, observacoes, orderLines);
    if (!result.ok) return;
    resetForm();
  };

  return <>
    <PageHeading eyebrow="VENDAS" title="Pedidos" description="Monte um orçamento para um cliente, com os equipamentos e quantidades necessários." action={<button className="button button-secondary" onClick={resetForm}>↺ Limpar campos</button>} />
    <form ref={formRef} className="panel form-panel order-form" onSubmit={(event) => void submit(event)}>
      <div className="panel-heading"><div><h2>Novo orçamento</h2><p>Adicione um cliente e um ou mais produtos.</p></div></div>
      <div className="form-grid"><Field label="Cliente"><select name="cliente_id" required defaultValue="" onChange={(event) => setNewClientMode(event.target.value === "novo")}><option value="" disabled>Selecione um cliente</option>{clientes.map((client) => <option key={client.id} value={client.id}>{client.nome} · {client.telefone}</option>)}<option value="novo">＋ Cadastrar cliente agora</option></select></Field><Field label="Observações"><input name="observacoes" placeholder="Detalhes importantes do serviço..." /></Field></div>
      {newClientMode && <div className="inline-client-form"><strong>Novo cliente para este orçamento</strong><div className="form-grid"><Field label="Nome completo"><input name="novo_nome" required /></Field><Field label="WhatsApp / telefone"><input name="novo_telefone" type="tel" required /></Field><Field label="E-mail (opcional)"><input name="novo_email" type="email" /></Field><ClientAddressFields prefix="novo_" /></div></div>}
      <div className="order-lines-heading"><strong>Produtos do pedido</strong><button type="button" className="text-button" disabled={!lines[lines.length - 1]?.produto_id} onClick={() => setLines((current) => [...current, { produto_id: "", quantidade: 1 }])}>＋ Adicionar produto</button></div>
      {lines.map((line, index) => { const product = produtos.find((item) => item.id === line.produto_id); return <div className="order-line" key={index}><select aria-label={`Produto ${index + 1}`} required={index < lines.length - 1 || Boolean(line.produto_id)} value={line.produto_id} onChange={(event) => {
        const selectedProduct = event.target.value;
        setLines((current) => {
          const updated = current.map((item, itemIndex) => itemIndex === index ? { ...item, produto_id: selectedProduct } : item);
          return index === current.length - 1 && selectedProduct ? [...updated, { produto_id: "", quantidade: 1 }] : updated;
        });
      }}><option value="" disabled>Selecione um produto</option>{produtos.filter((item) => item.ativo).map((item) => <option key={item.id} value={item.id}>{item.nome} · {currency.format(Number(item.preco_unitario))}</option>)}</select><label className="quantity-input"><span>Qtd.</span><input type="number" min="1" step="1" required value={line.quantidade} onChange={(event) => setLines((current) => current.map((item, itemIndex) => itemIndex === index ? { ...item, quantidade: Math.max(1, Number(event.target.value) || 1) } : item))} /></label><strong className="line-subtotal">{currency.format(product ? product.preco_unitario * line.quantidade : 0)}</strong>{lines.length > 1 && <button type="button" className="icon-button remove-line" aria-label="Remover produto" onClick={() => setLines((current) => current.filter((_, itemIndex) => itemIndex !== index))}>×</button>}</div>; })}
      <div className="order-total"><span>Total do orçamento</span><strong>{currency.format(currentTotal)}</strong></div>
      <div className="form-actions"><button type="button" className="button button-secondary" onClick={resetForm}>Limpar campos</button><button className="button button-primary" disabled={busy || currentTotal <= 0}>Salvar como orçamento</button></div>
    </form>
  </>;
}

function OrderManagementPage({ pedidos, clientes, tecnicos, busy, onNavigate, onStatusChange }: {
  pedidos: PedidoDetalhado[]; clientes: Cliente[]; tecnicos: Tecnico[]; busy: boolean; onNavigate: () => void;
  onStatusChange: (pedido: PedidoDetalhado, status: PedidoStatus, tecnicoId?: string, dataInstalacao?: string) => Promise<ActionResult<void>>;
}) {
  const [statusFilter, setStatusFilter] = useState("todos");
  const [clientFilter, setClientFilter] = useState("");
  const [minimum, setMinimum] = useState("");
  const [maximum, setMaximum] = useState("");
  const [createdAfter, setCreatedAfter] = useState("");
  const [createdBefore, setCreatedBefore] = useState("");
  const [installationAfter, setInstallationAfter] = useState("");
  const [installationBefore, setInstallationBefore] = useState("");
  const [expanded, setExpanded] = useState<string | null>(null);
  const [schedule, setSchedule] = useState<Record<string, { tecnicoId: string; data: string }>>({});
  const filtered = pedidos.filter((order) => {
    const created = new Date(order.created_at);
    const installation = order.data_instalacao ? new Date(order.data_instalacao) : null;
    const minimumValue = minimum === "" ? null : Number(minimum);
    const maximumValue = maximum === "" ? null : Number(maximum);
    const createdStart = createdAfter ? new Date(`${createdAfter}T00:00:00`) : null;
    const createdEnd = createdBefore ? new Date(`${createdBefore}T23:59:59.999`) : null;
    const installationStart = installationAfter ? new Date(`${installationAfter}T00:00:00`) : null;
    const installationEnd = installationBefore ? new Date(`${installationBefore}T23:59:59.999`) : null;
    return (statusFilter === "todos" || order.status === statusFilter)
      && (!clientFilter || order.cliente_id === clientFilter)
      && (minimumValue === null || Number(order.valor_total) >= minimumValue)
      && (maximumValue === null || Number(order.valor_total) <= maximumValue)
      && (!createdStart || created >= createdStart)
      && (!createdEnd || created <= createdEnd)
      && (!installationStart || (installation !== null && installation >= installationStart))
      && (!installationEnd || (installation !== null && installation <= installationEnd));
  });

  return <>
    <PageHeading eyebrow="OPERAÇÃO" title="Gestão de pedidos" description="Consulte detalhes, aplique filtros e avance cada pedido pelo fluxo de atendimento." action={<button className="button button-primary" onClick={onNavigate}>＋ Novo orçamento</button>} />
    <section className="panel">
      <div className="list-toolbar"><div><h2>Pedidos <span className="count-pill">{filtered.length} / {pedidos.length}</span></h2><p>O agendamento exige técnico e data futura.</p></div></div>
      <div className="order-filters">
        <Field label="Status"><select value={statusFilter} onChange={(event) => setStatusFilter(event.target.value)}><option value="todos">Todos</option>{Object.entries(statusLabel).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></Field>
        <Field label="Cliente"><select value={clientFilter} onChange={(event) => setClientFilter(event.target.value)}><option value="">Todos</option>{clientes.map((client) => <option key={client.id} value={client.id}>{client.nome}</option>)}</select></Field>
        <Field label="Valor mínimo (R$)"><input type="number" min="0" step="0.01" value={minimum} onChange={(event) => setMinimum(event.target.value)} /></Field>
        <Field label="Valor máximo (R$)"><input type="number" min="0" step="0.01" value={maximum} onChange={(event) => setMaximum(event.target.value)} /></Field>
        <Field label="Criado a partir de"><input type="date" value={createdAfter} onChange={(event) => setCreatedAfter(event.target.value)} /></Field>
        <Field label="Criado até"><input type="date" value={createdBefore} onChange={(event) => setCreatedBefore(event.target.value)} /></Field>
        <Field label="Instalação a partir de"><input type="date" value={installationAfter} onChange={(event) => setInstallationAfter(event.target.value)} /></Field>
        <Field label="Instalação até"><input type="date" value={installationBefore} onChange={(event) => setInstallationBefore(event.target.value)} /></Field>
      </div>
      <div className="table-wrap"><table className="orders-table"><thead><tr><th>PEDIDO</th><th>CLIENTE</th><th>CRIADO EM</th><th>INSTALAÇÃO</th><th>VALOR</th><th>STATUS</th><th /></tr></thead><tbody>
        {filtered.map((order) => <FragmentOrder key={order.id} order={order} expanded={expanded === order.id} onToggle={() => setExpanded(expanded === order.id ? null : order.id)} tecnicos={tecnicos} schedule={schedule[order.id] ?? { tecnicoId: order.tecnico_id ?? "", data: toLocalDateTimeInput(order.data_instalacao) }} onScheduleChange={(value) => setSchedule((current) => ({ ...current, [order.id]: value }))} busy={busy} onStatusChange={onStatusChange} />)}
      </tbody></table>{filtered.length === 0 && <EmptyState title="Nenhum pedido neste filtro" text="Ajuste os filtros para ver pedidos." />}</div>
    </section>
  </>;
}

function FragmentOrder({ order, expanded, onToggle, tecnicos, schedule, onScheduleChange, busy, onStatusChange }: {
  order: PedidoDetalhado; expanded: boolean; onToggle: () => void; tecnicos: Tecnico[]; schedule: { tecnicoId: string; data: string };
  onScheduleChange: (schedule: { tecnicoId: string; data: string }) => void; busy: boolean;
  onStatusChange: (pedido: PedidoDetalhado, status: PedidoStatus, tecnicoId?: string, dataInstalacao?: string) => Promise<ActionResult<void>>;
}) {
  const nextStatus: Partial<Record<PedidoStatus, PedidoStatus>> = { orcamento: "aprovado", aprovado: "agendado", agendado: "em_andamento", em_andamento: "concluido" };
  const canCancel = order.status === "orcamento" || order.status === "aprovado";
  const scheduleDate = schedule.data ? new Date(schedule.data) : null;
  const validFutureSchedule = scheduleDate !== null && Number.isFinite(scheduleDate.getTime()) && scheduleDate.getTime() > Date.now();
  return <>
    <tr className="order-row"><td><strong className="order-number">#{order.id.slice(0, 8).toUpperCase()}</strong></td><td><strong>{order.cliente?.nome ?? "Cliente"}</strong><span className="table-subtitle">{order.cliente?.telefone ?? ""}</span></td><td>{dateOnly.format(new Date(order.created_at))}</td><td>{order.data_instalacao ? dateTime.format(new Date(order.data_instalacao)) : "—"}</td><td><strong>{currency.format(Number(order.valor_total))}</strong></td><td><StatusBadge status={order.status} /></td><td><button className="text-button" onClick={onToggle}>{expanded ? "Fechar" : "Detalhes"}</button></td></tr>
    {expanded && <tr className="expanded-order"><td colSpan={7}><div className="order-detail-grid"><div><span className="detail-label">PRODUTOS</span>{order.itens.map((item) => <div className="detail-item" key={item.id}>{item.quantidade} × {item.produto?.nome ?? "Produto"} ({currency.format(Number(item.preco_unitario))} cada) <strong>{currency.format(Number(item.subtotal))}</strong></div>)}{order.observacoes && <p className="detail-notes">{order.observacoes}</p>}</div><div><span className="detail-label">CLIENTE E INSTALAÇÃO</span><p>{order.cliente ? getClientAddress(order.cliente) : "Endereço não informado"}</p><p>Contato: {order.cliente?.telefone ?? "Não informado"} · {order.cliente?.email ?? "Sem e-mail"}</p><p>Técnico: {order.tecnico?.nome ?? "Ainda não definido"}</p>
      <p>Pagamento: {order.forma_pagamento ?? "A definir"}</p>
      {order.status === "aprovado" && <div className="schedule-inline"><label>Técnico<select required value={schedule.tecnicoId} onChange={(event) => onScheduleChange({ ...schedule, tecnicoId: event.target.value })}><option value="">Selecione</option>{tecnicos.map((tech) => <option key={tech.id} value={tech.id}>{tech.nome}</option>)}</select></label><label>Data e hora<input type="datetime-local" min={localDateTimeMinimum()} value={schedule.data} onChange={(event) => onScheduleChange({ ...schedule, data: event.target.value })} /></label></div>}
      <div className="order-actions">{nextStatus[order.status] && <button disabled={busy || (order.status === "aprovado" && (!schedule.tecnicoId || !validFutureSchedule))} className="button button-primary button-small" onClick={() => void onStatusChange(order, nextStatus[order.status]!, schedule.tecnicoId, scheduleDate?.toISOString())}>{order.status === "aprovado" ? "Agendar instalação" : `Avançar para ${statusLabel[nextStatus[order.status]!]}`}</button>}{canCancel && <button disabled={busy} className="button button-danger-ghost button-small" onClick={() => void onStatusChange(order, "cancelado")}>Cancelar pedido</button>}</div>
    </div></div></td></tr>}
  </>;
}

function SchedulePage({ pedidos, tecnicos, busy, onStatusChange }: { pedidos: PedidoDetalhado[]; tecnicos: Tecnico[]; busy: boolean; onStatusChange: (pedido: PedidoDetalhado, status: PedidoStatus) => Promise<ActionResult<void>> }) {
  const [selectedTech, setSelectedTech] = useState("");
  useEffect(() => { if (!selectedTech && tecnicos[0]) setSelectedTech(tecnicos[0].id); }, [selectedTech, tecnicos]);
  const installations = pedidos.filter((order) => order.tecnico_id === selectedTech && ["agendado", "em_andamento"].includes(order.status)).sort((a, b) => (a.data_instalacao ?? "").localeCompare(b.data_instalacao ?? ""));
  const selectedTechnician = tecnicos.find((tech) => tech.id === selectedTech);

  return <>
    <PageHeading eyebrow="OPERAÇÃO" title="Agenda técnica" description="Consulte as instalações de cada técnico e atualize o andamento no local." />
    <div className="tech-tabs">{tecnicos.map((technician) => <button className={`tech-tab ${selectedTech === technician.id ? "active" : ""}`} key={technician.id} onClick={() => setSelectedTech(technician.id)}><span className="tech-avatar">{technician.nome.slice(0, 1)}</span><span><strong>{technician.nome}</strong><small>{technician.especialidade}</small></span></button>)}</div>
    <section className="panel schedule-panel"><div className="panel-heading"><div><h2>Instalações de {selectedTechnician?.nome ?? "técnico"}</h2><p>{installations.length} instalação(ões) pendente(s)</p></div><span className="tech-specialty">{selectedTechnician?.especialidade}</span></div>
      {installations.length === 0 ? <EmptyState title="Nenhuma instalação pendente" text="Quando pedidos forem agendados para este técnico, aparecerão aqui." /> : <div className="schedule-list">{installations.map((order) => <article className="schedule-card" key={order.id}><div className="schedule-card-date"><span>{order.data_instalacao ? new Date(order.data_instalacao).toLocaleDateString("pt-BR", { weekday: "short" }).replace(".", "") : ""}</span><strong>{order.data_instalacao ? new Date(order.data_instalacao).toLocaleDateString("pt-BR", { day: "2-digit" }) : "—"}</strong><small>{order.data_instalacao ? new Date(order.data_instalacao).toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" }) : ""}</small></div><div className="schedule-card-main"><div className="schedule-card-heading"><strong>{order.cliente?.nome}</strong><StatusBadge status={order.status} /></div><span>⌖ {order.cliente ? getClientAddress(order.cliente) : "Endereço não informado"}</span><span>☎ {order.cliente?.telefone}</span><div className="schedule-products">{order.itens.map((item) => `${item.quantidade} × ${item.produto?.nome ?? "Produto"}`).join(" · ")}</div></div><div className="schedule-card-action">{order.status === "agendado" ? <button className="button button-primary button-small" disabled={busy} onClick={() => void onStatusChange(order, "em_andamento")}>Iniciar instalação →</button> : <button className="button button-primary button-small" disabled={busy} onClick={() => void onStatusChange(order, "concluido")}>Concluir instalação ✓</button>}</div></article>)}</div>}
    </section>
  </>;
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return <label className="field"><span>{label}</span>{children}</label>;
}

function EmptyState({ title, text }: { title: string; text: string }) {
  return <div className="empty-state"><div className="empty-icon">⌑</div><strong>{title}</strong><span>{text}</span></div>;
}

export default App;
