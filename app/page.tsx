"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { categorize, parseSantanderPdf, type Category, type DocumentKind, type ParsedTransaction } from "../src/lib/pdfParser";
import { documentExists, firebaseConfigured, hashFile, loadFinancialHistory, loginWithGoogle, logoutFirebase, observeUser, reclassifyFinancialHistory, saveFinancialImport, type CloudDocument } from "../src/lib/firebaseClient";

type FileKind = DocumentKind;
type View = "upload" | "review" | "dashboard";
type AppUser = { uid: string; displayName: string | null; email: string | null };
const CATEGORY_META: Record<Category, { color: string }> = {
  "Alimentação": { color: "#073b72" }, "Moradia": { color: "#179765" }, "Transporte": { color: "#ff675d" },
  "Assinaturas": { color: "#7654c8" }, "Saúde": { color: "#e44f87" }, "Compras": { color: "#d88c20" },
  "Transferências": { color: "#2e78b7" }, "Outros": { color: "#9aa5b1" },
};
const CATEGORY_NAMES = Object.keys(CATEGORY_META) as Category[];
const money = (value: number) => new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" }).format(value);
const shortDate = (value: string) => new Intl.DateTimeFormat("pt-BR", { day: "2-digit", month: "short" }).format(new Date(`${value}T12:00:00`));
const monthLabel = (value: string) => value ? new Intl.DateTimeFormat("pt-BR", { month: "short", year: "2-digit" }).format(new Date(`${value}-01T12:00:00`)) : "Todos";
const merchantKey = (value: string) => value.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/\d+/g, "").replace(/[^a-z]+/g, " ").trim();
const DEMO_TRANSACTIONS: ParsedTransaction[] = [
  ["Supermercado Vila", "Alimentação", "2026-06-12", -386.42, "invoice"], ["Restaurante Manjericão", "Alimentação", "2026-07-11", -248.90, "invoice"],
  ["Auto Posto Central", "Transporte", "2026-07-09", -250, "invoice"], ["Streaming Plus", "Assinaturas", "2026-08-08", -39.90, "invoice"],
  ["Condomínio Residencial", "Moradia", "2026-08-07", -890, "statement"], ["Supermercado Vila", "Alimentação", "2026-08-12", -486.42, "invoice"],
].map(([description, category, date, amount, source], index) => ({ id: `demo-${index}`, description: String(description), category: category as Category, date: String(date), month: String(date).slice(0, 7), amount: Number(amount), source: source as FileKind, confidence: "alta", raw: String(description) }));

function UploadCard({ kind, title, files, onFiles }: { kind: FileKind; title: string; files: File[]; onFiles: (kind: FileKind, files: File[]) => void }) {
  const input = useRef<HTMLInputElement>(null);
  return <div className={`upload-card ${files.length ? "is-ready" : ""}`}>
    <button className="upload-main" onClick={() => input.current?.click()} type="button"><span className="pdf-icon">PDF</span><span><strong>{title}</strong><small>{files.length ? `${files.length} arquivo${files.length > 1 ? "s" : ""} selecionado${files.length > 1 ? "s" : ""}` : "Selecione um ou vários PDFs"}</small></span><span className="upload-status">{files.length || "+"}</span></button>
    <input ref={input} hidden multiple type="file" accept="application/pdf,.pdf" aria-label={`Importar ${title}`} onChange={(event) => onFiles(kind, Array.from(event.target.files ?? []))} />
  </div>;
}

export default function Home() {
  const [files, setFiles] = useState<Record<FileKind, File[]>>({ invoice: [], statement: [] });
  const [view, setView] = useState<View>("upload");
  const [tab, setTab] = useState<"overview" | "transactions" | "insights">("overview");
  const [transactions, setTransactions] = useState<ParsedTransaction[]>([]);
  const [pendingDocuments, setPendingDocuments] = useState<CloudDocument[]>([]);
  const [cloudDocuments, setCloudDocuments] = useState<CloudDocument[]>([]);
  const [user, setUser] = useState<AppUser | null>(null);
  const [selectedMonth, setSelectedMonth] = useState("");
  const [parsing, setParsing] = useState(false);
  const [cloudBusy, setCloudBusy] = useState(false);
  const [error, setError] = useState("");
  const [warnings, setWarnings] = useState<string[]>([]);
  const [documentStats, setDocumentStats] = useState({ pages: 0, lines: 0 });
  const [monthlyGoal, setMonthlyGoal] = useState(0);
  const [cardLimit, setCardLimit] = useState(0);
  const ready = files.invoice.length + files.statement.length > 0;

  useEffect(() => {
    if ("serviceWorker" in navigator) navigator.serviceWorker.register(`${import.meta.env.BASE_URL}sw.js`).catch(() => undefined);
    return observeUser(async (account) => {
      setUser(account ? { uid: account.uid, displayName: account.displayName, email: account.email } : null);
      if (!account) {
        setTransactions([]);
        setCloudDocuments([]);
        setPendingDocuments([]);
        setSelectedMonth("");
        setView("upload");
        return;
      }
      setCloudBusy(true);
      setError("");
      try {
        const history = await loadFinancialHistory(account.uid);
        // Show the saved history first. A background category update must never
        // prevent the user from seeing transactions that were already saved.
        setTransactions(history.transactions);
        setCloudDocuments(history.documents);
        const latest = history.transactions.map((item) => item.month ?? item.date.slice(0, 7)).sort().at(-1);
        if (latest) setSelectedMonth(latest);
        if (history.transactions.length || history.documents.length) setView("dashboard");

        try {
          const corrected = await reclassifyFinancialHistory(account.uid, history.transactions);
          setTransactions(corrected.transactions);
        } catch {
          // The original history is already on screen; retry this non-essential
          // migration on a later login instead of interrupting the experience.
        }
      } catch (caught) {
        setError(caught instanceof Error ? `Não foi possível carregar seu histórico: ${caught.message}` : "Não foi possível carregar seu histórico salvo. Tente entrar novamente.");
      } finally { setCloudBusy(false); }
    });
  }, []);

  useEffect(() => { setMonthlyGoal(Number(localStorage.getItem("fluxo-monthly-goal") ?? 0)); setCardLimit(Number(localStorage.getItem("fluxo-card-limit") ?? 0)); }, []);
  useEffect(() => { localStorage.setItem("fluxo-monthly-goal", String(monthlyGoal)); }, [monthlyGoal]);
  useEffect(() => { localStorage.setItem("fluxo-card-limit", String(cardLimit)); }, [cardLimit]);

  const months = useMemo(() => Array.from(new Set(transactions.map((item) => item.month ?? item.date.slice(0, 7)))).sort(), [transactions]);
  const visibleTransactions = useMemo(() => selectedMonth ? transactions.filter((item) => (item.month ?? item.date.slice(0, 7)) === selectedMonth) : transactions, [transactions, selectedMonth]);
  const expenses = useMemo(() => visibleTransactions.filter((item) => item.amount < 0), [visibleTransactions]);
  const invoiceTotal = Math.abs(expenses.filter((item) => item.source === "invoice").reduce((sum, item) => sum + item.amount, 0));
  const statementTotal = Math.abs(expenses.filter((item) => item.source === "statement").reduce((sum, item) => sum + item.amount, 0));
  const total = invoiceTotal + statementTotal;
  const categoryData = useMemo(() => CATEGORY_NAMES.map((name) => { const value = Math.abs(expenses.filter((item) => item.category === name).reduce((sum, item) => sum + item.amount, 0)); return { name, value, percentage: total ? Math.round(value / total * 100) : 0, color: CATEGORY_META[name].color }; }).filter((item) => item.value > 0).sort((a, b) => b.value - a.value), [expenses, total]);
  const donut = `conic-gradient(${categoryData.map((item, index) => { const start = categoryData.slice(0, index).reduce((sum, entry) => sum + entry.percentage, 0); return `${item.color} ${start}% ${start + item.percentage}%`; }).join(",") || "#e9eef3 0 100%"})`;
  const pendingHashes = useMemo(() => new Set(pendingDocuments.map((document) => document.hash)), [pendingDocuments]);
  const reviewTransactions = useMemo(() => transactions.filter((item) => item.documentHash && pendingHashes.has(item.documentHash)), [transactions, pendingHashes]);
  const monthlySeries = useMemo(() => months.map((month) => ({ month, total: Math.abs(transactions.filter((item) => (item.month ?? item.date.slice(0, 7)) === month && item.amount < 0).reduce((sum, item) => sum + item.amount, 0)), categories: CATEGORY_NAMES.map((category) => ({ category, value: Math.abs(transactions.filter((item) => (item.month ?? item.date.slice(0, 7)) === month && item.amount < 0 && item.category === category).reduce((sum, item) => sum + item.amount, 0)) })) })), [months, transactions]);

  const onFiles = (kind: FileKind, selected: File[]) => {
    if (selected.some((file) => file.type !== "application/pdf" && !file.name.toLowerCase().endsWith(".pdf"))) { setError("Selecione apenas arquivos no formato PDF."); return; }
    setError(""); setFiles((current) => ({ ...current, [kind]: selected }));
  };

  const analyze = async () => {
    const selected = [...files.invoice.map((file) => ({ file, kind: "invoice" as const })), ...files.statement.map((file) => ({ file, kind: "statement" as const }))];
    if (!selected.length) return;
    setParsing(true); setError(""); setWarnings([]);
    try {
      const batchDocuments: CloudDocument[] = [], batchTransactions: ParsedTransaction[] = [], batchWarnings: string[] = [];
      const seen = new Set<string>(); let duplicateCount = 0, pages = 0, lines = 0;
      for (const entry of selected) {
        const hash = await hashFile(entry.file);
        if (seen.has(hash) || pendingDocuments.some((document) => document.hash === hash) || cloudDocuments.some((document) => document.hash === hash) || (user && await documentExists(user.uid, hash))) { duplicateCount += 1; continue; }
        seen.add(hash);
        const result = await parseSantanderPdf(entry.file, entry.kind);
        pages += result.pageCount; lines += result.lineCount; batchWarnings.push(...result.warnings);
        batchDocuments.push({ hash, name: entry.file.name, kind: entry.kind, month: result.month, pageCount: result.pageCount, transactionCount: result.transactions.length });
        batchTransactions.push(...result.transactions.map((item) => ({ ...item, month: result.month, documentHash: hash, documentName: entry.file.name })));
      }
      if (duplicateCount) batchWarnings.push(`${duplicateCount} documento${duplicateCount > 1 ? "s repetidos foram ignorados" : " repetido foi ignorado"}.`);
      if (!batchTransactions.length) throw new Error(duplicateCount ? "Todos os documentos selecionados já estão no seu histórico." : "Não encontramos movimentações nesses documentos.");
      setTransactions((history) => [...history, ...batchTransactions].sort((a, b) => b.date.localeCompare(a.date)));
      setPendingDocuments(batchDocuments); setWarnings(batchWarnings); setDocumentStats({ pages, lines });
      setSelectedMonth(batchDocuments.map((document) => document.month).sort().at(-1) ?? ""); setView("review");
    } catch (caught) { setError(caught instanceof Error ? caught.message : "Falha inesperada ao analisar os PDFs."); }
    finally { setParsing(false); }
  };

  const updateTransaction = (item: ParsedTransaction, patch: Partial<ParsedTransaction>) => setTransactions((items) => items.map((entry) => entry.id === item.id && entry.documentHash === item.documentHash ? { ...entry, ...patch } : entry));
  const confirmImport = async () => {
    if (firebaseConfigured && user) {
      setCloudBusy(true); setError("");
      try {
        await saveFinancialImport(user.uid, pendingDocuments, reviewTransactions);
        const history = await loadFinancialHistory(user.uid); setTransactions(history.transactions); setCloudDocuments(history.documents); setPendingDocuments([]); setView("dashboard");
      } catch (caught) { setError(caught instanceof Error ? caught.message : "Não foi possível salvar no Firebase."); }
      finally { setCloudBusy(false); }
    } else setView("dashboard");
  };
  const startDemo = () => { setTransactions(DEMO_TRANSACTIONS); setSelectedMonth("2026-08"); setView("dashboard"); };

  if (view === "upload") return <UploadView files={files} ready={ready} parsing={parsing} error={error} user={user} cloudDocuments={cloudDocuments} onFiles={onFiles} analyze={analyze} startDemo={startDemo} setError={setError} />;

  if (view === "review") return <main className="review-page"><header className="review-header"><div className="brand"><span>f</span> fluxo</div><button className="ghost" onClick={() => setView("upload")}>← Trocar arquivos</button></header><section className="review-content"><p className="eyebrow">ETAPA 2 DE 3</p><h1>Revise as movimentações</h1><p className="lead">Encontramos <strong>{reviewTransactions.length} movimentações novas</strong> em {pendingDocuments.length} documentos. Os meses foram identificados automaticamente.</p>{warnings.map((warning) => <div className="warning-box" key={warning}>⚠ {warning}</div>)}{error && <div className="error-box">{error}</div>}<div className="document-months">{pendingDocuments.map((document) => <span key={document.hash}><b>{monthLabel(document.month)}</b>{document.name}</span>)}</div><div className="review-summary"><div><small>Faturas</small><strong>{reviewTransactions.filter((item) => item.source === "invoice").length}</strong></div><div><small>Extratos</small><strong>{reviewTransactions.filter((item) => item.source === "statement").length}</strong></div><div><small>Linhas analisadas</small><strong>{documentStats.lines}</strong></div></div><div className="review-table"><div className="review-row review-labels"><span>Data</span><span>Descrição</span><span>Categoria</span><span>Valor</span><span /></div>{reviewTransactions.map((item) => <div className="review-row" key={`${item.documentHash}-${item.id}`}><time>{shortDate(item.date)}</time><input value={item.description} onChange={(event) => updateTransaction(item, { description: event.target.value, category: categorize(event.target.value) })} /><select value={item.category} onChange={(event) => updateTransaction(item, { category: event.target.value as Category })}>{CATEGORY_NAMES.map((name) => <option key={name}>{name}</option>)}</select><strong className={item.amount > 0 ? "income" : ""}>{money(item.amount)}</strong><button aria-label={`Remover ${item.description}`} onClick={() => setTransactions((items) => items.filter((entry) => !(entry.id === item.id && entry.documentHash === item.documentHash)))}>×</button></div>)}</div><div className="review-actions"><button className="ghost" onClick={() => setView("upload")}>Voltar</button><button className="primary" disabled={!reviewTransactions.length || cloudBusy} onClick={confirmImport}>{cloudBusy ? "Salvando…" : firebaseConfigured && user ? "Salvar no Firebase e analisar →" : "Continuar sem salvar →"}</button></div></section></main>;

  return <main className="app-shell"><aside className="sidebar"><div className="brand"><span>f</span> fluxo</div><nav><button className={tab === "overview" ? "active" : ""} onClick={() => setTab("overview")}>⌂ <span>Visão geral</span></button><button className={tab === "transactions" ? "active" : ""} onClick={() => setTab("transactions")}>↕ <span>Transações</span></button><button className={tab === "insights" ? "active" : ""} onClick={() => setTab("insights")}>✦ <span>Comparar</span><b>{months.length}</b></button></nav><button className="new-import" onClick={() => setView("upload")}>＋ Importar histórico</button></aside><section className="content"><header><div><p className="eyebrow">HISTÓRICO FINANCEIRO</p><h2>{tab === "overview" ? "Visão geral" : tab === "transactions" ? "Transações" : "Comparação mensal"}</h2></div><div className="header-tools"><select value={selectedMonth} onChange={(event) => setSelectedMonth(event.target.value)}><option value="">Todos os meses</option>{months.map((month) => <option key={month} value={month}>{monthLabel(month)}</option>)}</select><div className="avatar">{user?.displayName?.slice(0, 2).toUpperCase() ?? "BR"}</div></div></header>
    {tab === "overview" && <><div className="summary-grid"><article className="hero-card"><p>Gastos em {monthLabel(selectedMonth)}</p><strong>{money(total)}</strong><span>{expenses.length} movimentações de saída</span><div className="spark"><i/><i/><i/><i/><i/><i/><i/><i/></div></article><article><p>Fatura do cartão</p><strong>{money(invoiceTotal)}</strong><span>{expenses.filter((item) => item.source === "invoice").length} compras</span><div className="progress"><i style={{ width: `${total ? invoiceTotal / total * 100 : 0}%` }} /></div></article><article><p>Saídas da conta</p><strong>{money(statementTotal)}</strong><span>débitos, Pix e boletos</span><div className="progress green"><i style={{ width: `${total ? statementTotal / total * 100 : 0}%` }} /></div></article></div><div className="dashboard-grid"><article className="category-card"><div className="card-title"><div><p className="eyebrow">DISTRIBUIÇÃO</p><h3>Onde você mais gastou</h3></div></div><div className="category-body"><div className="donut" style={{ background: donut }}><span><b>{money(total)}</b><small>total</small></span></div><div className="legend">{categoryData.map((item) => <div key={item.name}><i style={{ background: item.color }} /><span>{item.name}</span><b>{item.percentage}%</b></div>)}</div></div></article><article className="saving-card"><span className="bulb">✦</span><p className="eyebrow">MAIOR CATEGORIA</p><h3>{categoryData[0]?.name ?? "Sem gastos"}: <em>{money(categoryData[0]?.value ?? 0)}</em></h3><p>Representa {categoryData[0]?.percentage ?? 0}% dos gastos deste período.</p><button onClick={() => setTab("insights")}>Comparar meses →</button></article></div><SmartInsights transactions={transactions} expenses={expenses} months={months} selectedMonth={selectedMonth} invoiceTotal={invoiceTotal} monthlyGoal={monthlyGoal} cardLimit={cardLimit} setMonthlyGoal={setMonthlyGoal} setCardLimit={setCardLimit} /><TransactionList items={visibleTransactions.slice(0, 5)} title="Últimas transações" action={() => setTab("transactions")} /></>}
    {tab === "transactions" && <TransactionList items={visibleTransactions} title={`Transações de ${monthLabel(selectedMonth)}`} />}
    {tab === "insights" && <><MonthlyEvolution series={monthlySeries} /><SmartInsights transactions={transactions} expenses={expenses} months={months} selectedMonth={selectedMonth} invoiceTotal={invoiceTotal} monthlyGoal={monthlyGoal} cardLimit={cardLimit} setMonthlyGoal={setMonthlyGoal} setCardLimit={setCardLimit} /></>}
    <p className="prototype-note">Os PDFs permanecem no dispositivo. Somente transações revisadas são sincronizadas.</p></section></main>;
}

function UploadView({ files, ready, parsing, error, user, cloudDocuments, onFiles, analyze, startDemo, setError }: { files: Record<FileKind, File[]>; ready: boolean; parsing: boolean; error: string; user: AppUser | null; cloudDocuments: CloudDocument[]; onFiles: (kind: FileKind, files: File[]) => void; analyze: () => void; startDemo: () => void; setError: (value: string) => void }) {
  const count = files.invoice.length + files.statement.length;
  return <main className="upload-page"><section className="brand-panel"><div className="brand"><span>f</span> fluxo</div><div className="brand-copy"><p className="eyebrow">Seu dinheiro, mais claro</p><h1>Construa seu histórico.<br />Poupe com intenção.</h1><p>Importe vários meses. O Fluxo identifica o período, evita documentos repetidos e mostra sua evolução.</p></div><div className="security-pill">🔒 Os PDFs ficam neste dispositivo</div></section><section className="import-panel"><div className="mobile-brand"><span>f</span> fluxo</div><div className="step">ETAPA 1 DE 3</div><h2>Importar histórico</h2><p className="lead">Selecione um ou vários PDFs do Santander, mesmo que sejam de meses diferentes.</p><div className={`firebase-status ${firebaseConfigured && user ? "connected" : ""}`}>{firebaseConfigured ? user ? <><span>✓</span><div><strong>Firebase conectado</strong><small>{user.email} · {cloudDocuments.length} documentos salvos</small></div><button onClick={logoutFirebase}>Sair</button></> : <><span>☁</span><div><strong>Entre para salvar seu histórico</strong><small>Sincronize entre computador e celular.</small></div><button onClick={() => loginWithGoogle().catch((caught) => setError(caught instanceof Error ? caught.message : "Falha no login."))}>Entrar com Google</button></> : <><span>!</span><div><strong>Firebase aguardando configuração</strong><small>A análise funciona, mas ainda não será salva na nuvem.</small></div></>}</div><div className="uploads"><UploadCard kind="invoice" title="Faturas do cartão" files={files.invoice} onFiles={onFiles} /><UploadCard kind="statement" title="Extratos bancários" files={files.statement} onFiles={onFiles} /></div><div className="privacy-note"><span>✓</span><p><strong>Processamento privado</strong><br />Somente as transações revisadas são enviadas ao Firebase.</p></div>{error && <div className="error-box">{error}</div>}<button className="primary" disabled={!ready || parsing} onClick={analyze}>{parsing ? "Lendo os documentos…" : ready ? `Analisar ${count} documento${count > 1 ? "s" : ""} →` : "Selecione seus PDFs"}</button>{parsing && <div className="loading-line"><i /></div>}<button className="demo" onClick={startDemo}>Explorar comparação demonstrativa</button></section></main>;
}

function MonthlyEvolution({ series }: { series: Array<{ month: string; total: number; categories: Array<{ category: Category; value: number }> }> }) {
  const maximum = Math.max(...series.map((item) => item.total), 1);
  return <article className="evolution-card"><div className="card-title"><div><p className="eyebrow">EVOLUÇÃO POR CATEGORIA</p><h3>Comparação mensal</h3></div><span>{series.length} meses</span></div>{series.length < 2 ? <p className="empty-state">Importe pelo menos dois meses para comparar sua evolução.</p> : <div className="evolution-chart">{series.map((item) => <div className="evolution-column" key={item.month}><strong>{money(item.total)}</strong><div className="evolution-track" style={{ height: `${Math.max(18, item.total / maximum * 170)}px` }}>{item.categories.filter((category) => category.value > 0).map((category) => <i key={category.category} title={`${category.category}: ${money(category.value)}`} style={{ background: CATEGORY_META[category.category].color, height: `${category.value / item.total * 100}%` }} />)}</div><span>{monthLabel(item.month)}</span></div>)}</div>}<div className="evolution-legend">{CATEGORY_NAMES.map((category) => <span key={category}><i style={{ background: CATEGORY_META[category].color }} />{category}</span>)}</div></article>;
}


function SmartInsights({ transactions, expenses, months, selectedMonth, invoiceTotal, monthlyGoal, cardLimit, setMonthlyGoal, setCardLimit }: { transactions: ParsedTransaction[]; expenses: ParsedTransaction[]; months: string[]; selectedMonth: string; invoiceTotal: number; monthlyGoal: number; cardLimit: number; setMonthlyGoal: (value: number) => void; setCardLimit: (value: number) => void }) {
  const currentMonth = selectedMonth || months.at(-1) || "";
  const current = expenses.filter((item) => (item.month ?? item.date.slice(0, 7)) === currentMonth);
  const previous = expenses.filter((item) => (item.month ?? item.date.slice(0, 7)) === months[months.indexOf(currentMonth) - 1]);
  const total = Math.abs(current.reduce((sum, item) => sum + item.amount, 0)), before = Math.abs(previous.reduce((sum, item) => sum + item.amount, 0));
  const change = before ? Math.round((total / before - 1) * 100) : 0, goalGap = monthlyGoal ? Math.max(0, total - monthlyGoal) : 0, limitPercent = cardLimit ? Math.round(invoiceTotal / cardLimit * 100) : 0;
  const groups = Object.values(expenses.reduce<Record<string, { name: string; count: number; months: Set<string>; total: number }>>((all, item) => { const key = merchantKey(item.description), entry = all[key] ?? { name: item.description, count: 0, months: new Set<string>(), total: 0 }; entry.count++; entry.months.add(item.month ?? item.date.slice(0,7)); entry.total += Math.abs(item.amount); all[key] = entry; return all; }, {}));
  const recurring = groups.filter((item) => item.months.size >= 2).sort((a,b) => b.total-a.total).slice(0,3);
  const top = groups.sort((a,b) => b.total-a.total).slice(0,3);
  const duplicates = Object.values(current.reduce<Record<string,number>>((all,item) => { const key = `${merchantKey(item.description)}-${Math.abs(item.amount)}-${item.date}`; all[key]=(all[key]??0)+1; return all; },{})).filter((n)=>n>1).length;
  const flexible = current.filter((item) => ["Alimentação","Compras","Assinaturas","Transporte"].includes(item.category)).reduce((sum,item)=>sum+Math.abs(item.amount),0);
  const average = months.length ? months.map((month)=>Math.abs(expenses.filter((item)=>(item.month??item.date.slice(0,7))===month).reduce((sum,item)=>sum+item.amount,0))).reduce((sum,value)=>sum+value,0)/months.length : 0;
  return <section className="smart-insights"><div className="card-title"><div><p className="eyebrow">ANÁLISE INTELIGENTE</p><h3>Alertas e oportunidades</h3></div><span>{currentMonth ? monthLabel(currentMonth) : "Histórico"}</span></div><div className="insight-settings"><label>Meta de gastos mensais<input type="number" min="0" value={monthlyGoal || ""} placeholder="Ex.: 5000" onChange={(event)=>setMonthlyGoal(Number(event.target.value))}/></label><label>Limite do cartão<input type="number" min="0" value={cardLimit || ""} placeholder="Ex.: 10000" onChange={(event)=>setCardLimit(Number(event.target.value))}/></label></div><div className="insight-list">{before>0 && <article className={change>0?"alert":"opportunity"}><span>{change>0?"↑":"↓"}</span><div><p className="eyebrow">COMPARAÇÃO MENSAL</p><h3>{change>0?`${change}% acima`:`${Math.abs(change)}% abaixo`} do mês anterior</h3><p>{money(total)} neste mês, contra {money(before)} no anterior.</p></div></article>}{monthlyGoal>0 && <article className={goalGap?"alert":"opportunity"}><span>◎</span><div><p className="eyebrow">META DE GASTOS</p><h3>{goalGap? `${money(goalGap)} acima da meta`:"Meta mantida neste período"}</h3><p>Teto: {money(monthlyGoal)}. Gastos flexíveis: {money(flexible)}.</p></div></article>}{cardLimit>0 && <article className={limitPercent>=90?"alert":"opportunity"}><span>▣</span><div><p className="eyebrow">FATURA DO CARTÃO</p><h3>{limitPercent}% do limite utilizado</h3><p>{money(invoiceTotal)} de {money(cardLimit)}. {limitPercent>=70?"Acompanhe novas compras.":"Há margem confortável."}</p></div></article>}{recurring.length>0 && <article><span>↻</span><div><p className="eyebrow">GASTOS RECORRENTES</p><h3>{recurring.map((item)=>item.name).join(" · ")}</h3><p>Estes estabelecimentos aparecem em pelo menos dois meses. Revise serviços que não usa.</p></div></article>}{duplicates>0 && <article className="alert"><span>!</span><div><p className="eyebrow">POSSÍVEL COBRANÇA REPETIDA</p><h3>{duplicates} grupo(s) com valor, data e descrição iguais</h3><p>Confira antes de contestar: pode ser uma parcela ou lançamento legítimo.</p></div></article>}<article><span>★</span><div><p className="eyebrow">ONDE O DINHEIRO FICOU</p><h3>{top.map((item)=>item.name).join(" · ") || "Ainda não há dados suficientes"}</h3><p>Estabelecimentos com maior gasto acumulado. Média mensal observada: {money(average)}.</p></div></article><article className="opportunity"><span>✦</span><div><p className="eyebrow">OPORTUNIDADE DE ECONOMIA</p><h3>{money(flexible)} em gastos flexíveis</h3><p>Compras, alimentação, transporte e assinaturas são a parcela mais ajustável.</p></div></article></div></section>;
}

function TransactionList({ items, title, action }: { items: ParsedTransaction[]; title: string; action?: () => void }) {
  return <article className="transactions-card full"><div className="card-title"><div><p className="eyebrow">MOVIMENTAÇÕES</p><h3>{title}</h3></div>{action && <button onClick={action}>Ver todas</button>}</div>{items.length ? items.map((item) => <div className="transaction" key={`${item.documentHash ?? "local"}-${item.id}`}><span className="merchant">{item.description[0]?.toUpperCase() ?? "?"}</span><div><b>{item.description}</b><small>{item.category} · {shortDate(item.date)} · {item.source === "invoice" ? "Fatura" : "Extrato"}</small></div><strong className={item.amount > 0 ? "income" : ""}>{money(item.amount)}</strong></div>) : <p className="empty-state">Nenhuma transação neste período.</p>}</article>;
}

