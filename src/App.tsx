import { Fragment, useCallback, useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import { type Session } from "@supabase/supabase-js";
import { supabase } from "./lib/supabase";
import type { Cliente, ClienteInput, ItemPedido, Pedido, PedidoDetalhado, PedidoStatus, Produto, StoreProfile, Tecnico } from "./types";

type Page = "dashboard" | "clientes" | "produtos" | "tecnicos" | "pedidos" | "gestao" | "agenda" | "configuracoes";
type OrderLine = { produto_id: string; quantidade: number };
type ActionResult<T> = { ok: true; value: T } | { ok: false };
type ScheduleDraft = { tecnicoIds: string[]; data: string; duracaoMinutos: number };

const installationSkills: Record<string, string> = {
  camera_sensor: "Câmeras e sensores",
  fechadura_iluminacao: "Fechaduras e iluminação",
};

function requiredSkills(order: PedidoDetalhado) {
  return [...new Set(order.itens.flatMap((item) => item.produto?.habilidades_instalacao ?? []))];
}

function suggestedTechnicianIds(order: PedidoDetalhado, technicians: Tecnico[]) {
  return requiredSkills(order).flatMap((skill) => {
    const assigned = order.tecnico_ids?.find((id) => technicians.some((technician) => technician.id === id && technician.ativo && technician.habilidades_instalacao?.includes(skill)));
    const capable = technicians.find((technician) => technician.ativo && technician.habilidades_instalacao?.includes(skill));
    const id = assigned ?? capable?.id;
    return id ? [id] : [];
  }).filter((id, index, ids) => ids.indexOf(id) === index);
}

const saoPauloDate = (date: Date) => {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Sao_Paulo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const part = (type: string) => parts.find((item) => item.type === type)?.value ?? "";
  return `${part("year")}-${part("month")}-${part("day")}`;
};

const statusLabel: Record<PedidoStatus, string> = {
  orcamento: "Orçamento",
  aprovado: "Aprovado",
  agendado: "Agendado",
  em_andamento: "Em andamento",
  concluido: "Concluído",
  cancelado: "Cancelado",
};

const currency = new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" });
const dateTime = new Intl.DateTimeFormat("pt-BR", { dateStyle: "short", timeStyle: "short", timeZone: "America/Sao_Paulo" });
const dateOnly = new Intl.DateTimeFormat("pt-BR", { dateStyle: "medium", timeZone: "America/Sao_Paulo" });

function formatSaoPauloDateTimeInput(date: Date) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Sao_Paulo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);
  const part = (type: string) => parts.find((item) => item.type === type)?.value ?? "";
  return `${part("year")}-${part("month")}-${part("day")}T${part("hour")}:${part("minute")}`;
}

function toLocalDateTimeInput(value: string | null) {
  return value ? formatSaoPauloDateTimeInput(new Date(value)) : "";
}

function saoPauloDateTimeToDate(value: string) {
  const wallClockAsUtc = new Date(`${value}:00Z`);
  const representedLocalTime = formatSaoPauloDateTimeInput(wallClockAsUtc);
  const representedLocalAsUtc = new Date(`${representedLocalTime}:00Z`);
  return new Date(wallClockAsUtc.getTime() - (representedLocalAsUtc.getTime() - wallClockAsUtc.getTime()));
}

function localDateTimeMinimum() {
  const now = new Date();
  now.setSeconds(0, 0);
  now.setMinutes(now.getMinutes() + 1);
  return formatSaoPauloDateTimeInput(now);
}

function getClientAddress(client: Cliente) {
  const parts = [
    [client.rua, client.numero].filter(Boolean).join(", "),
    client.complemento,
    client.bairro,
  ].filter(Boolean);
  return parts.join(" · ");
}

function clientValuesFromForm(form: FormData, prefix = ""): ClienteInput {
  const value = (name: string) => String(form.get(`${prefix}${name}`) ?? "").trim();
  const rua = value("rua");
  const numero = value("numero");
  const complemento = value("complemento");
  const bairro = value("bairro");
  return {
    nome: value("nome"),
    telefone: value("telefone"),
    email: value("email") || null,
    rua,
    numero,
    complemento: complemento || null,
    bairro,
  };
}

function ClientAddressFields({ prefix = "" }: { prefix?: string }) {
  return <>
    <Field label="Rua"><input name={`${prefix}rua`} required /></Field>
    <Field label="Número"><input name={`${prefix}numero`} placeholder="Nº ou S/N" required /></Field>
    <Field label="Complemento (opcional)"><input name={`${prefix}complemento`} /></Field>
    <Field label="Bairro"><input name={`${prefix}bairro`} required /></Field>
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
  const [session, setSession] = useState<Session | null>(null);
  const [authLoading, setAuthLoading] = useState(true);
  const [authError, setAuthError] = useState("");
  const [page, setPage] = useState<Page>("dashboard");
  const [profileMenuOpen, setProfileMenuOpen] = useState(false);
  const [profile, setProfile] = useState<StoreProfile | null>(null);
  const [clientes, setClientes] = useState<Cliente[]>([]);
  const [tecnicos, setTecnicos] = useState<Tecnico[]>([]);
  const [produtos, setProdutos] = useState<Produto[]>([]);
  const [pedidos, setPedidos] = useState<PedidoDetalhado[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [errorMessage, setErrorMessage] = useState("");
  const [successMessage, setSuccessMessage] = useState("");
  const loadedOnce = useRef(false);

  useEffect(() => {
    if (!db) {
      setAuthLoading(false);
      return;
    }
    let mounted = true;
    const { data: authListener } = db.auth.onAuthStateChange((_event, nextSession) => {
      setSession(nextSession);
      setAuthLoading(false);
      loadedOnce.current = false;
      if (!nextSession) {
        setClientes([]);
        setTecnicos([]);
        setProdutos([]);
        setPedidos([]);
        setProfile(null);
        setPage("dashboard");
      }
    });
    void db.auth.getSession().then(({ data, error }) => {
      if (!mounted) return;
      if (error) setAuthError(error.message);
      setSession(data.session);
      setAuthLoading(false);
    });
    return () => {
      mounted = false;
      authListener.subscription.unsubscribe();
    };
  }, [db]);

  const reload = useCallback(async () => {
    if (!db || !session) return;
    if (!loadedOnce.current) setLoading(true);
    setErrorMessage("");
    const [clientsResult, techniciansResult, productsResult, ordersResult, itemsResult, orderTechniciansResult, profileResult] = await Promise.all([
      db.from("clientes").select("*").order("nome"),
      db.from("tecnicos").select("*").order("nome"),
      db.from("produtos").select("*").order("categoria").order("nome"),
      db.from("pedidos").select("*").order("created_at", { ascending: false }),
      db.from("itens_pedido").select("*"),
      db.from("pedido_tecnicos").select("pedido_id, tecnico_id"),
      db.from("configuracao_loja").select("*").eq("id", 1).single(),
    ]);
    const firstError = clientsResult.error ?? techniciansResult.error ?? productsResult.error ?? ordersResult.error ?? itemsResult.error ?? orderTechniciansResult.error ?? profileResult.error;
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
    const techniciansByOrder = new Map<string, string[]>();
    for (const item of itemRows) {
      itemsByOrder.set(item.pedido_id, [...(itemsByOrder.get(item.pedido_id) ?? []), item]);
    }
    for (const assignment of orderTechniciansResult.data ?? []) {
      techniciansByOrder.set(assignment.pedido_id, [...(techniciansByOrder.get(assignment.pedido_id) ?? []), assignment.tecnico_id]);
    }

    setClientes(clients);
    setTecnicos(technicians);
    setProdutos(products);
    setProfile(profileResult.data as StoreProfile);
    setPedidos(((ordersResult.data ?? []) as Pedido[]).map((order) => ({
      ...order,
      cliente: clientById.get(order.cliente_id),
      tecnico_ids: techniciansByOrder.get(order.id) ?? [],
      tecnicos: (techniciansByOrder.get(order.id) ?? []).flatMap((id) => {
        const technician = technicianById.get(id);
        return technician ? [technician] : [];
      }),
      itens: (itemsByOrder.get(order.id) ?? []).map((item) => ({ ...item, produto: productById.get(item.produto_id) })),
    })));
    loadedOnce.current = true;
    setLoading(false);
  }, [db, session]);

  useEffect(() => {
    if (session) void reload();
    else setLoading(false);
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

  if (authLoading) {
    return <main className="setup-screen"><div className="loading-state"><span className="spinner" />Verificando sessão...</div></main>;
  }

  if (!session) {
    return <LoginPage db={db} initialError={authError} onClearError={() => setAuthError("")} />;
  }

  const navItems: { id: Page; title: string; icon: string }[] = [
    { id: "dashboard", title: "Visão geral", icon: "⌂" },
    { id: "clientes", title: "Clientes", icon: "♙" },
    { id: "produtos", title: "Produtos", icon: "▦" },
    { id: "tecnicos", title: "Técnicos", icon: "♟" },
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
          <button className="profile-trigger" aria-expanded={profileMenuOpen} onClick={() => setProfileMenuOpen(!profileMenuOpen)}>
            <span className="sidebar-avatar">{(profile?.nome || "Rafael").slice(0, 1).toLocaleUpperCase("pt-BR")}</span>
            <span className="sidebar-user"><strong>{profile?.nome || "Rafael Ferreira"}</strong><span>{session.user.email}</span></span>
            <span className="online-dot" title="Sessão ativa" />
          </button>
          {profileMenuOpen && <div className="profile-menu">
            <button onClick={() => { setPage("configuracoes"); setProfileMenuOpen(false); }}>⚙ Configurações</button>
            <button className="logout-action" onClick={async () => {
              const { error } = await db.auth.signOut();
              if (error) setErrorMessage(`Não foi possível sair: ${error.message}`);
              else setProfileMenuOpen(false);
            }}>↪ Sair</button>
          </div>}
        </div>
      </aside>

      <main className="main-area">
        <header className="topbar">
          <div className="breadcrumbs">SmartLar <span>/</span> {navItems.find((item) => item.id === page)?.title ?? "Configurações"}</div>
          <div className="topbar-right">{new Intl.DateTimeFormat("pt-BR", { dateStyle: "long" }).format(new Date())}</div>
        </header>
        <div className="page-content">
          {errorMessage && <div className="notice notice-error" role="alert"><strong>Não foi possível concluir.</strong> {errorMessage}<button onClick={() => setErrorMessage("")} aria-label="Fechar aviso">×</button></div>}
          {successMessage && <div className="notice notice-success" role="status">{successMessage}<button onClick={() => setSuccessMessage("")} aria-label="Fechar aviso">×</button></div>}
          {loading ? <div className="loading-state"><span className="spinner" />Carregando informações do Supabase...</div> : (
            <>
              {page === "dashboard" && <Dashboard pedidos={pedidos} ownerName={profile?.nome || "Rafael"} onNavigate={setPage} />}
              {page === "clientes" && <ClientsPage clientes={clientes} pedidos={pedidos} onSave={(values) => runAction(async () => {
                const { error } = await db.from("clientes").insert(values);
                if (error) throw error;
              }, "Cliente cadastrado com sucesso.")} onActiveChange={(id, ativo) => runAction(async () => {
                const { error } = await db.from("clientes").update({ ativo }).eq("id", id);
                if (error) throw error;
              }, ativo ? "Cliente reativado." : "Cliente excluído; o histórico de pedidos foi preservado.")} />}
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
              {page === "tecnicos" && <TechniciansPage tecnicos={tecnicos} busy={busy}
                onSave={(values) => runAction(async () => {
                  const { error } = await db.from("tecnicos").insert(values);
                  if (error) throw error;
                }, "Técnico cadastrado.")}
                onActiveChange={(id, ativo) => runAction(async () => {
                  const { error } = await db.from("tecnicos").update({ ativo }).eq("id", id);
                  if (error) throw error;
                }, ativo ? "Técnico reativado." : "Técnico desativado; os pedidos históricos foram preservados.")} />}
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
                }, "Orçamento criado.")}
              />}
              {page === "gestao" && <OrderManagementPage pedidos={pedidos} clientes={clientes} tecnicos={tecnicos} onNavigate={() => setPage("pedidos")}
                busy={busy} onStatusChange={(pedido, status, schedule) => runAction(async () => {
                  if (status === "agendado") {
                    if (!schedule) throw new Error("Informe a equipe, o horário e a duração da instalação.");
                    const { error } = await db.rpc("agendar_pedido", {
                      p_pedido_id: pedido.id,
                      p_tecnico_ids: schedule.tecnicoIds,
                      p_data_instalacao: saoPauloDateTimeToDate(schedule.data).toISOString(),
                      p_duracao_minutos: schedule.duracaoMinutos,
                    });
                    if (error) throw error;
                  } else {
                    const { error } = await db.from("pedidos").update({ status }).eq("id", pedido.id);
                    if (error) throw error;
                  }
                }, `Pedido atualizado para "${statusLabel[status]}".`)} />}
              {page === "agenda" && <SchedulePage pedidos={pedidos} tecnicos={tecnicos} busy={busy}
                onStatusChange={(pedido, status) => runAction(async () => {
                  const { error } = await db.from("pedidos").update({ status }).eq("id", pedido.id);
                  if (error) throw error;
                }, `Instalação marcada como "${statusLabel[status]}".`)} />}
              {page === "configuracoes" && profile && <ProfileSettingsPage profile={profile} loginEmail={session.user.email ?? ""}
                busy={busy}
                onSave={(values) => runAction(async () => {
                  const { error } = await db.from("configuracao_loja").upsert({ id: 1, ...values }).select().single();
                  if (error) throw error;
                }, "Configurações da loja salvas.")} onChangeEmail={async (email) => {
                  setBusy(true);
                  setErrorMessage("");
                  setSuccessMessage("");
                  try {
                    const { error } = await db.auth.updateUser({ email });
                    if (error) throw error;
                    setSuccessMessage("Pedido de alteração enviado. Confirme o novo e-mail pela mensagem recebida; até a confirmação, o login atual continua válido.");
                  } catch (error) {
                    setErrorMessage(`Não foi possível solicitar a alteração: ${asErrorMessage(error)}`);
                  } finally {
                    setBusy(false);
                  }
                }} />}
            </>
          )}
        </div>
      </main>
    </div>
  );
}

function LoginPage({ db, initialError, onClearError }: { db: NonNullable<typeof supabase>; initialError: string; onClearError: () => void }) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [errorMessage, setErrorMessage] = useState(initialError);

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setBusy(true);
    setErrorMessage("");
    onClearError();
    try {
      const { error } = await db.auth.signInWithPassword({ email: email.trim(), password });
      if (error) throw error;
    } catch (error) {
      setErrorMessage(asErrorMessage(error));
    } finally {
      setBusy(false);
    }
  };

  return <main className="setup-screen">
    <form className="setup-card auth-card" onSubmit={(event) => void submit(event)}>
      <div className="brand-mark">S</div>
      <p className="eyebrow">SMARTLAR · GESTÃO</p>
      <h1>Entrar</h1>
      <p>Acesse sua conta para abrir o painel da loja.</p>
      {errorMessage && <div className="notice notice-error" role="alert">{errorMessage}</div>}
      <div className="auth-fields">
        <Field label="E-mail"><input type="email" autoComplete="username" value={email} onChange={(event) => setEmail(event.target.value)} required /></Field>
        <Field label="Senha"><input type="password" autoComplete="current-password" value={password} onChange={(event) => setPassword(event.target.value)} required /></Field>
      </div>
      <button className="button button-primary auth-submit" disabled={busy}>{busy ? "Entrando..." : "Entrar"}</button>
      <div className="setup-note">A conta inicial deve ser criada pelo administrador em Authentication → Users no Supabase.</div>
    </form>
  </main>;
}

function ProfileSettingsPage({ profile, loginEmail, busy, onSave, onChangeEmail }: {
  profile: StoreProfile;
  loginEmail: string;
  busy: boolean;
  onSave: (values: Omit<StoreProfile, "id" | "updated_at">) => Promise<ActionResult<void>>;
  onChangeEmail: (email: string) => Promise<void>;
}) {
  const submitProfile = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const result = await onSave({
      nome: String(form.get("nome")).trim(),
      telefone: String(form.get("telefone")).trim() || null,
      rua: String(form.get("rua")).trim(),
      numero: String(form.get("numero")).trim(),
      complemento: String(form.get("complemento")).trim() || null,
      bairro: String(form.get("bairro")).trim(),
    });
    if (!result.ok) return;
  };

  const submitEmail = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const email = String(form.get("email")).trim();
    if (email && email !== loginEmail) await onChangeEmail(email);
  };

  return <>
    <PageHeading eyebrow="PERFIL" title="Configurações" description="Atualize os dados do Rafael e o endereço da loja." />
    <form className="panel form-panel profile-settings-form" onSubmit={(event) => void submitProfile(event)}>
      <div className="panel-heading"><div><h2>Dados da loja</h2><p>Nome, contato e localização exibidos no painel.</p></div></div>
      <div className="form-grid">
        <Field label="Nome"><input name="nome" defaultValue={profile.nome} required /></Field>
        <Field label="Contato / telefone"><input name="telefone" type="tel" defaultValue={profile.telefone ?? ""} /></Field>
        <Field label="Rua"><input name="rua" defaultValue={profile.rua ?? ""} required /></Field>
        <Field label="Número"><input name="numero" defaultValue={profile.numero ?? ""} required /></Field>
        <Field label="Complemento (opcional)"><input name="complemento" defaultValue={profile.complemento ?? ""} /></Field>
        <Field label="Bairro"><input name="bairro" defaultValue={profile.bairro ?? ""} required /></Field>
      </div>
      <div className="form-actions"><button className="button button-primary" disabled={busy}>Salvar configurações</button></div>
    </form>
    <form className="panel form-panel profile-settings-form" onSubmit={(event) => void submitEmail(event)}>
      <div className="panel-heading"><div><h2>E-mail de login</h2><p>A alteração só terá efeito depois da confirmação enviada ao novo endereço.</p></div></div>
      <div className="form-grid"><Field label="Novo e-mail"><input name="email" type="email" defaultValue={loginEmail} required /></Field></div>
      <div className="form-actions"><button className="button button-secondary" disabled={busy}>Solicitar alteração de e-mail</button></div>
    </form>
  </>;
}

function PageHeading({ eyebrow, title, description, action }: { eyebrow: string; title: string; description: string; action?: ReactNode }) {
  return <div className="page-heading"><div><p className="eyebrow">{eyebrow}</p><h1>{title}</h1><p className="heading-description">{description}</p></div>{action}</div>;
}

function Dashboard({ pedidos, ownerName, onNavigate }: { pedidos: PedidoDetalhado[]; ownerName: string; onNavigate: (page: Page) => void }) {
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
    <PageHeading eyebrow="RESUMO DA OPERAÇÃO" title={`${greeting}, ${ownerName.split(" ")[0]}`} description="Aqui está o resumo da operação da SmartLar." action={<button className="button button-primary" onClick={() => onNavigate("pedidos")}><span>＋</span> Novo orçamento</button>} />
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
            <div className="appointment-tech"><strong>{order.tecnicos?.map((technician) => technician.nome).join(" + ") || "Sem técnico"}</strong><span>{order.data_instalacao ? new Date(order.data_instalacao).toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" }) : ""}</span></div>
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

function ClientsPage({ clientes, pedidos, onSave, onActiveChange }: { clientes: Cliente[]; pedidos: PedidoDetalhado[]; onSave: (values: ClienteInput) => Promise<ActionResult<void>>; onActiveChange: (id: string, active: boolean) => Promise<ActionResult<void>> }) {
  const [search, setSearch] = useState("");
  const [selected, setSelected] = useState<string | null>(null);
  const [formOpen, setFormOpen] = useState(false);
  const [showInactive, setShowInactive] = useState(false);
  const isClientActive = (client: Cliente) => client.ativo !== false;
  const activeClients = clientes.filter(isClientActive);
  const visible = clientes.filter((client) => isClientActive(client) !== showInactive && `${client.nome} ${client.telefone} ${client.email ?? ""} ${getClientAddress(client)}`.toLocaleLowerCase("pt-BR").includes(search.toLocaleLowerCase("pt-BR")));

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
      <div className="list-toolbar"><div><h2>Clientes {showInactive ? "excluídos" : "ativos"} <span className="count-pill">{showInactive ? clientes.length - activeClients.length : activeClients.length}</span></h2><p>Pesquise por nome, telefone ou endereço.</p></div><div className="client-list-filters"><label className="search-box"><span>⌕</span><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Buscar cliente..." /></label><button className="button button-secondary" onClick={() => setShowInactive(!showInactive)}>{showInactive ? "Ver clientes ativos" : "Ver excluídos"}</button></div></div>
      <div className="table-wrap"><table><thead><tr><th>CLIENTE</th><th>TELEFONE</th><th>E-MAIL</th><th>ENDEREÇO</th><th>PEDIDOS</th><th>AÇÕES</th></tr></thead><tbody>
        {visible.map((client) => {
          const clientOrders = pedidos.filter((order) => order.cliente_id === client.id);
          const isActive = isClientActive(client);
          return <Fragment key={client.id}>
            <tr>
              <td><div className="table-client"><div className="client-avatar">{client.nome.slice(0, 1)}</div><strong>{client.nome}</strong></div></td><td>{client.telefone}</td><td>{client.email || "—"}</td><td className="address-cell" title={getClientAddress(client)}>{getClientAddress(client)}</td><td><span className="count-pill">{clientOrders.length}</span></td><td><div className="client-actions"><button className="text-button" onClick={() => setSelected(selected === client.id ? null : client.id)}>{selected === client.id ? "Fechar" : "Ver pedidos"}</button><button className={`text-button ${isActive ? "client-delete" : ""}`} onClick={() => {
                if (isActive && !window.confirm(`Excluir ${client.nome}? Os pedidos já registrados serão preservados.`)) return;
                void onActiveChange(client.id, !isActive);
              }}>{isActive ? "Excluir" : "Restaurar"}</button></div></td>
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
    const result = await onSave({
      nome: String(form.get("nome")).trim(),
      categoria: String(form.get("categoria")).trim(),
      preco_unitario: Number(form.get("preco")),
      descricao: String(form.get("descricao")).trim(),
      habilidades_instalacao: form.getAll("habilidades_instalacao").map(String),
    });
    if (!result.ok) return;
    formElement.reset();
    setFormOpen(false);
  };

  return <>
    <PageHeading eyebrow="CATÁLOGO" title="Produtos" description="Organize os equipamentos e mantenha os preços atualizados." action={<button className="button button-primary" onClick={() => setFormOpen(!formOpen)}>＋ Novo produto</button>} />
    {formOpen && <form className="panel form-panel" onSubmit={(event) => void submit(event)}><div className="panel-heading"><div><h2>Cadastrar produto</h2><p>Defina nome, categoria, preço e especialidades necessárias para instalar.</p></div><button type="button" className="icon-button" onClick={() => setFormOpen(false)}>×</button></div><div className="form-grid">
      <Field label="Nome do produto"><input name="nome" required /></Field><Field label="Categoria"><input name="categoria" placeholder="Ex.: Segurança" required /></Field><Field label="Preço unitário (R$)"><input name="preco" type="number" step="0.01" min="0" required /></Field><Field label="Descrição"><input name="descricao" /></Field>
      <fieldset className="skill-field"><legend>Especialidades necessárias</legend>{Object.entries(installationSkills).map(([skill, label]) => <label key={skill}><input type="checkbox" name="habilidades_instalacao" value={skill} />{label}</label>)}</fieldset>
    </div><div className="form-actions"><button className="button button-primary">Salvar produto</button></div></form>}
    <div className="catalog-filters"><label className="search-box"><span>⌕</span><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Buscar produto..." /></label><Field label="Categoria"><select value={category} onChange={(event) => setCategory(event.target.value)}><option value="todas">Todas as categorias</option>{categories.map((item) => <option key={item} value={item}>{item}</option>)}</select></Field></div>
    <div className="catalog-summary"><strong>{filteredProducts.length}</strong> produtos ativos <span>·</span> {Object.keys(groups).length} categorias</div>
    {Object.entries(groups).map(([category, categoryProducts]) => <section className="catalog-section" key={category}><div className="catalog-heading"><div className="category-icon">▦</div><h2>{category}</h2><span className="count-pill">{categoryProducts.length}</span></div><div className="product-grid">
      {categoryProducts.map((product) => <article className="product-card" key={product.id}><div className="product-card-top"><div className="product-icon">{product.categoria.toLowerCase().includes("ilum") ? "☼" : product.categoria.toLowerCase().includes("seg") ? "◈" : "⌘"}</div><div className="product-card-actions"><button className="icon-button" title="Editar preço" aria-label={`Editar preço de ${product.nome}`} onClick={() => setEditingPrice(editingPrice === product.id ? null : product.id)}>✎</button><button className="icon-button product-delete" title="Excluir produto sem apagar pedidos históricos" aria-label={`Excluir ${product.nome}`} onClick={() => { if (window.confirm(`Excluir "${product.nome}" do catálogo? Os pedidos históricos serão preservados.`)) void onActiveChange(product.id, false); }}>×</button></div></div><span className="product-category">{product.categoria}</span><h3>{product.nome}</h3><p>{product.descricao || "Sem descrição adicional."}</p>{editingPrice === product.id ? <form className="inline-price-form" onSubmit={async (event) => { event.preventDefault(); const value = Number(new FormData(event.currentTarget).get("price")); const result = await onPriceChange(product.id, value); if (result.ok) setEditingPrice(null); }}><input aria-label="Novo preço" name="price" type="number" step="0.01" min="0" defaultValue={product.preco_unitario} required /><button className="button button-primary button-small">Salvar</button></form> : <div className="product-price">{currency.format(Number(product.preco_unitario))}<span> / unidade</span></div>}</article>)}
    </div></section>)}
    {filteredProducts.length === 0 && <EmptyState title="Nenhum produto encontrado" text="Ajuste a busca ou escolha outra categoria." />}
  </>;
}

function TechniciansPage({ tecnicos, busy, onSave, onActiveChange }: {
  tecnicos: Tecnico[];
  busy: boolean;
  onSave: (values: Omit<Tecnico, "id" | "ativo">) => Promise<ActionResult<void>>;
  onActiveChange: (id: string, active: boolean) => Promise<ActionResult<void>>;
}) {
  const [formOpen, setFormOpen] = useState(false);
  const [showInactive, setShowInactive] = useState(false);
  const [formError, setFormError] = useState("");
  const visibleTechnicians = tecnicos.filter((technician) => showInactive || technician.ativo);

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const formElement = event.currentTarget;
    const form = new FormData(formElement);
    const skills = form.getAll("habilidades_instalacao").map(String);
    if (!skills.length) {
      setFormError("Selecione pelo menos uma especialidade.");
      return;
    }
    setFormError("");
    const result = await onSave({
      nome: String(form.get("nome")).trim(),
      telefone: String(form.get("telefone")).trim(),
      habilidades_instalacao: skills,
      especialidade: skills.map((skill) => installationSkills[skill]).join(" e "),
    });
    if (!result.ok) return;
    formElement.reset();
    setFormOpen(false);
  };

  return <>
    <PageHeading eyebrow="EQUIPE" title="Técnicos" description="Cadastre técnicos e gerencie quem pode receber novas instalações." action={<button className="button button-primary" onClick={() => setFormOpen(!formOpen)}>＋ Novo técnico</button>} />
    {formOpen && <form className="panel form-panel" onSubmit={(event) => void submit(event)}>
      <div className="panel-heading"><div><h2>Cadastrar técnico</h2><p>Informe contato e especialidades de instalação.</p></div><button type="button" className="icon-button" onClick={() => setFormOpen(false)}>×</button></div>
      <div className="form-grid">
        <Field label="Nome"><input name="nome" required /></Field>
        <Field label="Telefone"><input name="telefone" type="tel" required /></Field>
        <fieldset className="skill-field"><legend>Especialidades</legend>{Object.entries(installationSkills).map(([skill, label]) => <label key={skill}><input type="checkbox" name="habilidades_instalacao" value={skill} />{label}</label>)}</fieldset>
      </div>
      {formError && <div className="notice notice-error" role="alert">{formError}</div>}
      <div className="form-actions"><button className="button button-primary" disabled={busy}>Salvar técnico</button></div>
    </form>}
    <section className="panel">
      <div className="list-toolbar"><div><h2>{showInactive ? "Todos os técnicos" : "Técnicos ativos"} <span className="count-pill">{visibleTechnicians.length}</span></h2><p>Técnicos desativados não podem receber novas instalações; o histórico permanece disponível.</p></div><button className="button button-secondary" onClick={() => setShowInactive(!showInactive)}>{showInactive ? "Ver ativos" : "Ver também desativados"}</button></div>
      <div className="technician-list">{visibleTechnicians.map((technician) => <article className="technician-row" key={technician.id}>
        <div className="tech-avatar">{technician.nome.slice(0, 1)}</div>
        <div className="technician-info"><strong>{technician.nome}</strong><span>{technician.telefone}</span><small>{technician.especialidade}</small></div>
        <span className={`technician-state ${technician.ativo ? "active" : ""}`}>{technician.ativo ? "Ativo" : "Desativado"}</span>
        <button className={`button button-small ${technician.ativo ? "button-danger-ghost" : "button-secondary"}`} disabled={busy} onClick={() => {
          if (technician.ativo && !window.confirm(`Desativar ${technician.nome}? Os pedidos históricos serão preservados.`)) return;
          void onActiveChange(technician.id, !technician.ativo);
        }}>{technician.ativo ? "Desativar" : "Reativar"}</button>
      </article>)}
      {visibleTechnicians.length === 0 && <EmptyState title="Nenhum técnico cadastrado" text="Adicione um técnico para poder atribuir instalações." />}</div>
    </section>
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
      <div className="form-grid"><Field label="Cliente"><select name="cliente_id" required defaultValue="" onChange={(event) => setNewClientMode(event.target.value === "novo")}><option value="" disabled>Selecione um cliente</option>{clientes.filter((client) => client.ativo !== false).map((client) => <option key={client.id} value={client.id}>{client.nome} · {client.telefone}</option>)}<option value="novo">＋ Cadastrar cliente agora</option></select></Field><Field label="Observações"><input name="observacoes" placeholder="Detalhes importantes do serviço..." /></Field></div>
      {newClientMode && <div className="inline-client-form"><strong>Novo cliente para este orçamento</strong><div className="form-grid"><Field label="Nome completo"><input name="novo_nome" required /></Field><Field label="WhatsApp / telefone"><input name="novo_telefone" type="tel" required /></Field><Field label="E-mail (opcional)"><input name="novo_email" type="email" /></Field><ClientAddressFields prefix="novo_" /></div></div>}
      <div className="order-lines-heading"><strong>Produtos do pedido</strong></div>
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
  onStatusChange: (pedido: PedidoDetalhado, status: PedidoStatus, schedule?: ScheduleDraft) => Promise<ActionResult<void>>;
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
  const [schedule, setSchedule] = useState<Record<string, ScheduleDraft>>({});
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
        {filtered.map((order) => <FragmentOrder key={order.id} order={order} expanded={expanded === order.id} onToggle={() => setExpanded(expanded === order.id ? null : order.id)} tecnicos={tecnicos} schedule={schedule[order.id] ?? { tecnicoIds: suggestedTechnicianIds(order, tecnicos), data: toLocalDateTimeInput(order.data_instalacao), duracaoMinutos: order.duracao_instalacao_minutos ?? 60 }} onScheduleChange={(value) => setSchedule((current) => ({ ...current, [order.id]: value }))} busy={busy} onStatusChange={onStatusChange} />)}
      </tbody></table>{filtered.length === 0 && <EmptyState title="Nenhum pedido neste filtro" text="Ajuste os filtros para ver pedidos." />}</div>
    </section>
  </>;
}

function FragmentOrder({ order, expanded, onToggle, tecnicos, schedule, onScheduleChange, busy, onStatusChange }: {
  order: PedidoDetalhado; expanded: boolean; onToggle: () => void; tecnicos: Tecnico[]; schedule: ScheduleDraft;
  onScheduleChange: (schedule: ScheduleDraft) => void; busy: boolean;
  onStatusChange: (pedido: PedidoDetalhado, status: PedidoStatus, schedule?: ScheduleDraft) => Promise<ActionResult<void>>;
}) {
  const nextStatus: Partial<Record<PedidoStatus, PedidoStatus>> = { orcamento: "aprovado", aprovado: "agendado", agendado: "em_andamento", em_andamento: "concluido" };
  const canCancel = order.status === "orcamento" || order.status === "aprovado";
  const scheduleDate = schedule.data ? saoPauloDateTimeToDate(schedule.data) : null;
  const validFutureSchedule = scheduleDate !== null && Number.isFinite(scheduleDate.getTime()) && scheduleDate.getTime() > Date.now();
  const skills = requiredSkills(order);
  const coveredSkills = new Set(tecnicos.filter((technician) => technician.ativo && schedule.tecnicoIds.includes(technician.id)).flatMap((technician) => technician.habilidades_instalacao ?? []));
  const teamCoversSkills = skills.every((skill) => coveredSkills.has(skill));
  const assignedNames = order.tecnicos?.map((technician) => technician.nome).join(" + ");
  return <>
    <tr className="order-row"><td><strong className="order-number">#{order.id.slice(0, 8).toUpperCase()}</strong></td><td><strong>{order.cliente?.nome ?? "Cliente"}</strong><span className="table-subtitle">{order.cliente?.telefone ?? ""}</span></td><td>{dateOnly.format(new Date(order.created_at))}</td><td>{order.data_instalacao ? dateTime.format(new Date(order.data_instalacao)) : "—"}</td><td><strong>{currency.format(Number(order.valor_total))}</strong></td><td><StatusBadge status={order.status} /></td><td><button className="text-button" onClick={onToggle}>{expanded ? "Fechar" : "Detalhes"}</button></td></tr>
    {expanded && <tr className="expanded-order"><td colSpan={7}><div className="order-detail-grid"><div><span className="detail-label">PRODUTOS</span>{order.itens.map((item) => <div className="detail-item" key={item.id}>{item.quantidade} × {item.produto?.nome ?? "Produto"} ({currency.format(Number(item.preco_unitario))} cada) <strong>{currency.format(Number(item.subtotal))}</strong></div>)}{order.observacoes && <p className="detail-notes">{order.observacoes}</p>}</div><div><span className="detail-label">CLIENTE E INSTALAÇÃO</span><p>{order.cliente ? getClientAddress(order.cliente) : "Endereço não informado"}</p><p>Contato: {order.cliente?.telefone ?? "Não informado"} · {order.cliente?.email ?? "Sem e-mail"}</p><p>Técnico(s): {assignedNames ?? "Ainda não definido"}</p>
      <p>Pagamento: {order.forma_pagamento ?? "A definir"}</p>
      {order.status === "aprovado" && <><div className="schedule-inline schedule-team">{tecnicos.filter((tech) => tech.ativo).map((tech) => <label className="schedule-tech-option" key={tech.id}><input type="checkbox" checked={schedule.tecnicoIds.includes(tech.id)} onChange={(event) => onScheduleChange({ ...schedule, tecnicoIds: event.target.checked ? [...schedule.tecnicoIds, tech.id] : schedule.tecnicoIds.filter((id) => id !== tech.id) })} /><span>{tech.nome}<small>{tech.especialidade}</small></span></label>)}</div><p className="skill-hint">Especialidades exigidas: {skills.map((skill) => installationSkills[skill] ?? skill).join(" + ") || "não configuradas"}</p><div className="schedule-inline"><label>Data e hora<input type="datetime-local" min={localDateTimeMinimum()} value={schedule.data} onChange={(event) => onScheduleChange({ ...schedule, data: event.target.value })} /></label><label>Duração (minutos)<input type="number" min="15" max="480" step="15" value={schedule.duracaoMinutos} onChange={(event) => onScheduleChange({ ...schedule, duracaoMinutos: Number(event.target.value) })} /></label></div>{!teamCoversSkills && <p className="skill-hint skill-error">A equipe selecionada não cobre todas as especialidades exigidas.</p>}</>}
      <div className="order-actions">{nextStatus[order.status] && <button disabled={busy || (order.status === "aprovado" && (!schedule.tecnicoIds.length || !teamCoversSkills || !validFutureSchedule || schedule.duracaoMinutos < 15 || schedule.duracaoMinutos > 480))} className="button button-primary button-small" onClick={() => void onStatusChange(order, nextStatus[order.status]!, order.status === "aprovado" ? schedule : undefined)}>{order.status === "aprovado" ? "Agendar instalação" : `Avançar para ${statusLabel[nextStatus[order.status]!]}`}</button>}{canCancel && <button disabled={busy} className="button button-danger-ghost button-small" onClick={() => void onStatusChange(order, "cancelado")}>Cancelar pedido</button>}</div>
    </div></div></td></tr>}
  </>;
}

function SchedulePage({ pedidos, tecnicos, busy, onStatusChange }: {
  pedidos: PedidoDetalhado[];
  tecnicos: Tecnico[];
  busy: boolean;
  onStatusChange: (pedido: PedidoDetalhado, status: PedidoStatus) => Promise<ActionResult<void>>;
}) {
  const [selectedTech, setSelectedTech] = useState("");
  const today = saoPauloDate(new Date());
  useEffect(() => { if (!selectedTech && tecnicos[0]) setSelectedTech(tecnicos[0].id); }, [selectedTech, tecnicos]);
  const selectedTechnician = tecnicos.find((tech) => tech.id === selectedTech);
  const installations = pedidos
    .filter((order) => order.tecnico_ids.includes(selectedTech)
      && ["agendado", "em_andamento"].includes(order.status)
      && order.data_instalacao
      && saoPauloDate(new Date(order.data_instalacao)) === today)
    .sort((a, b) => (a.data_instalacao ?? "").localeCompare(b.data_instalacao ?? ""));

  return <>
    <PageHeading eyebrow="OPERAÇÃO" title="Agenda técnica" description="Veja as instalações de hoje em ordem de horário e atualize o andamento do serviço." />
    <div className="tech-tabs">{tecnicos.map((technician) => <button className={`tech-tab ${selectedTech === technician.id ? "active" : ""}`} key={technician.id} onClick={() => setSelectedTech(technician.id)}><span className="tech-avatar">{technician.nome.slice(0, 1)}</span><span><strong>{technician.nome}</strong><small>{technician.especialidade}</small></span></button>)}</div>
    <section className="panel schedule-panel"><div className="panel-heading"><div><h2>Instalações de {selectedTechnician?.nome ?? "técnico"} · Hoje</h2><p>{installations.length} instalação(ões) · {new Intl.DateTimeFormat("pt-BR", { dateStyle: "full", timeZone: "America/Sao_Paulo" }).format(new Date(`${today}T12:00:00-03:00`))}</p></div><span className="tech-specialty">{selectedTechnician?.especialidade}</span></div>
      {installations.length === 0 ? <EmptyState title="Nenhuma instalação hoje" text="As instalações agendadas para hoje aparecerão aqui em ordem de horário." /> : <div className="schedule-list">
        {installations.map((order) => <article className="schedule-card" key={order.id}>
          <div className="schedule-card-date"><span>{order.data_instalacao ? new Date(order.data_instalacao).toLocaleDateString("pt-BR", { weekday: "short", timeZone: "America/Sao_Paulo" }).replace(".", "") : ""}</span><strong>{order.data_instalacao ? new Date(order.data_instalacao).toLocaleDateString("pt-BR", { day: "2-digit", timeZone: "America/Sao_Paulo" }) : "—"}</strong><small>{order.data_instalacao ? new Date(order.data_instalacao).toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit", timeZone: "America/Sao_Paulo" }) : ""}</small></div>
          <div className="schedule-card-main"><div className="schedule-card-heading"><strong>{order.cliente?.nome}</strong><StatusBadge status={order.status} /></div><span>⌖ {order.cliente ? getClientAddress(order.cliente) : "Endereço não informado"}</span><span>☎ {order.cliente?.telefone}</span><span>Técnicos: {order.tecnicos?.map((technician) => technician.nome).join(" + ") || "Não atribuído"} · {order.duracao_instalacao_minutos ?? 60} min</span><div className="schedule-products">{order.itens.map((item) => `${item.quantidade} × ${item.produto?.nome ?? "Produto"}`).join(" · ")}</div></div>
          <div className="schedule-card-action">{order.status === "agendado" ? <button className="button button-primary button-small" disabled={busy} onClick={() => void onStatusChange(order, "em_andamento")}>Iniciar instalação →</button> : <button className="button button-primary button-small" disabled={busy} onClick={() => void onStatusChange(order, "concluido")}>Concluir instalação ✓</button>}</div>
        </article>)}
      </div>}
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
