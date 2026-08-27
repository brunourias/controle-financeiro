"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { categorizeTransaction, parseSantanderPdf, type Category, type DocumentKind, type ParsedTransaction } from "../src/lib/pdfParser";
import { documentExists, firebaseConfigured, hashFile, loadFinancialHistory, loginWithGoogle, logoutFirebase, normalizeSavedIncomeSigns, normalizeSavedInvoiceMonths, normalizeSavedStatementAmounts, observeUser, reclassifyFinancialHistory, saveFinancialImport, updateMatchingFinancialTransactions, type CloudDocument } from "../src/lib/firebaseClient";

type FileKind = DocumentKind;
type View = "upload" | "review" | "dashboard";
type AppUser = { uid: string; displayName: string | null; email: string | null };
const CATEGORY_META: Record<Category, { color: string }> = {
  "Alimentação": { color: "#073b72" }, "Moradia": { color: "#179765" },
  "Sem Parar": { color: "#ff675d" }, "Abastecimento": { color: "#b87500" }, "Assinaturas": { color: "#7654c8" }, "Saúde": { color: "#e44f87" }, "Compras": { color: "#d88c20" },
  "PIX recebido": { color: "#159465" }, "PIX enviado": { color: "#2e78b7" }, "Transferência recebida": { color: "#4b9b76" }, "Transferência enviada": { color: "#4a72b8" }, "Boleto": { color: "#9b6e00" }, "Plano celular": { color: "#5b6bb5" }, "Renda": { color: "#159465" }, "Outros": { color: "#9aa5b1" },
};
const CATEGORY_NAMES = Object.keys(CATEGORY_META) as Category[];
const MOVEMENT_CATEGORIES: Category[] = ["PIX enviado", "PIX recebido", "Transferência enviada", "Transferência recebida", "Renda"];
const money = (value: number) => new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" }).format(value);
const shortDate = (value: string) => new Intl.DateTimeFormat("pt-BR", { day: "2-digit", month: "short" }).format(new Date(`${value}T12:00:00`));
const monthLabel = (value: string) => value ? new Intl.DateTimeFormat("pt-BR", { month: "short", year: "2-digit" }).format(new Date(`${value}-01T12:00:00`)) : "Todos";
const merchantKey = (value: string) => value.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/\d+/g, "").replace(/[^a-z]+/g, " ").trim();
const DEMO_TRANSACTIONS: ParsedTransaction[] = [
  ["Supermercado Vila", "Alimentação", "2026-06-12", -386.42, "invoice"], ["Restaurante Manjericão", "Alimentação", "2026-07-11", -248.90, "invoice"],
  ["Auto Posto Central", "Transporte", "2026-07-09", -250, "invoice"], ["Streaming Plus", "Assinaturas", "2026-08-08", -39.90, "invoice"],
  ["Condomínio Residencial", "Moradia", "2026-08-07", -890, "statement"], ["Supermercado Vila", "Alimentação", "2026-08-12", -486.42, "invoice"],
].map(([description, category, date, amount, source], index) => ({ id: `demo-${index}`, description: String(description), category: category as Category, date: String(date), month: String(date).slice(0, 7), amount: Number(amount), source: source as FileKind, confidence: "alta", raw: String(description) }));

function UploadCard({ kind, title, files, onFiles, onClear }: { kind: FileKind; title: string; files: File[]; onFiles: (kind: FileKind, files: File[]) => void; onClear: (kind: FileKind) => void }) {
  const input = useRef<HTMLInputElement>(null);
  return <div className={`upload-card ${files.length ? "is-ready" : ""}`}>
    <button className="upload-main" onClick={() => input.current?.click()} type="button"><span className="pdf-icon">PDF</span><span><strong>{title}</strong><small>{files.length ? `${files.length} arquivo${files.length > 1 ? "s" : ""} selecionado${files.length > 1 ? "s" : ""}` : "Selecione um ou vários PDFs"}</small></span><span className="upload-status">{files.length || "+"}</span></button>
    <input ref={input} hidden multiple type="file" accept="application/pdf,.pdf" aria-label={`Importar ${title}`} onChange={(event) => onFiles(kind, Array.from(event.target.files ?? []))} />
    {files.length > 0 && <button className="clear-files" type="button" onClick={() => onClear(kind)}>Limpar seleção</button>}
  </div>;
}

export default function Home() {
  const [files, setFiles] = useState<Record<FileKind, File[]>>({ invoice: [], statement: [] });
  const [view, setView] = useState<View>("upload");
  const [tab, setTab] = useState<"overview" | "transactions" | "insights" | "intelligence" | "assistant" | "settings" | "save" | "goals" | "pix" | "income">("overview");
  const [transactions, setTransactions] = useState<ParsedTransaction[]>([]);
  const [pendingDocuments, setPendingDocuments] = useState<CloudDocument[]>([]);
  const [cloudDocuments, setCloudDocuments] = useState<CloudDocument[]>([]);
  const [user, setUser] = useState<AppUser | null>(null);
  const [selectedMonth, setSelectedMonth] = useState("");
  const [selectedCategory, setSelectedCategory] = useState<Category | "">("");
  const [selectedMerchant, setSelectedMerchant] = useState("");
  const [selectedGroup, setSelectedGroup] = useState<"" | "flexible">("");
  const [selectedSource, setSelectedSource] = useState<FileKind | "">("");
  const [parsing, setParsing] = useState(false);
  const [cloudBusy, setCloudBusy] = useState(false);
  const [error, setError] = useState("");
  const [warnings, setWarnings] = useState<string[]>([]);
  const [documentStats, setDocumentStats] = useState({ pages: 0, lines: 0 });
  const [monthlyGoal, setMonthlyGoal] = useState(0);
  const [cardLimit, setCardLimit] = useState(0);
  const [goalTarget, setGoalTarget] = useState(10000);
  const [goalSaved, setGoalSaved] = useState(0);
  const [goalDate, setGoalDate] = useState("");
  const [monthlyIncome, setMonthlyIncome] = useState(0);
  const [categoryBudgets, setCategoryBudgets] = useState<Partial<Record<Category, number>>>({});
  const [classificationRules, setClassificationRules] = useState<Array<{ pattern: string; category: Category }>>([]);
  const ready = files.invoice.length + files.statement.length > 0;

  useEffect(() => {
    if ("serviceWorker" in navigator) navigator.serviceWorker.register(`${import.meta.env.BASE_URL}sw.js`, { updateViaCache: "none" }).then((registration) => registration.update()).catch(() => undefined);
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
        const normalizedHistory = await normalizeSavedInvoiceMonths(account.uid, history.documents, history.transactions);
        history.documents = normalizedHistory.documents; history.transactions = await normalizeSavedStatementAmounts(account.uid, await normalizeSavedIncomeSigns(account.uid, normalizedHistory.transactions));
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

  useEffect(() => { setMonthlyGoal(Number(localStorage.getItem("fluxo-monthly-goal") ?? 0)); setCardLimit(Number(localStorage.getItem("fluxo-card-limit") ?? 0)); setGoalTarget(Number(localStorage.getItem("fluxo-goal-target") ?? 10000)); setGoalSaved(Number(localStorage.getItem("fluxo-goal-saved") ?? 0)); setGoalDate(localStorage.getItem("fluxo-goal-date") ?? ""); setMonthlyIncome(Number(localStorage.getItem("fluxo-monthly-income") ?? 0)); setCategoryBudgets(JSON.parse(localStorage.getItem("fluxo-category-budgets") ?? "{}")); setClassificationRules(JSON.parse(localStorage.getItem("fluxo-classification-rules") ?? "[]")); }, []);
  useEffect(() => { localStorage.setItem("fluxo-monthly-goal", String(monthlyGoal)); }, [monthlyGoal]);
  useEffect(() => { localStorage.setItem("fluxo-card-limit", String(cardLimit)); }, [cardLimit]);
  useEffect(() => { localStorage.setItem("fluxo-goal-target", String(goalTarget)); localStorage.setItem("fluxo-goal-saved", String(goalSaved)); localStorage.setItem("fluxo-goal-date", goalDate); }, [goalTarget, goalSaved, goalDate]);
  useEffect(() => { localStorage.setItem("fluxo-monthly-income", String(monthlyIncome)); }, [monthlyIncome]);
  useEffect(() => { localStorage.setItem("fluxo-category-budgets", JSON.stringify(categoryBudgets)); }, [categoryBudgets]);
  useEffect(() => { localStorage.setItem("fluxo-classification-rules", JSON.stringify(classificationRules)); }, [classificationRules]);

  const months = useMemo(() => Array.from(new Set(transactions.map((item) => item.month ?? item.date.slice(0, 7)))).sort(), [transactions]);
  const sourceByDocument = useMemo(() => new Map(cloudDocuments.map((document) => [document.hash, document.kind])), [cloudDocuments]);
  const visibleTransactions = useMemo(() => transactions.filter((item) => (!selectedMonth || (item.month ?? item.date.slice(0, 7)) === selectedMonth) && (!selectedCategory || (CATEGORY_NAMES.includes(item.category) ? item.category : "Outros") === selectedCategory) && (!selectedMerchant || merchantKey(item.description) === selectedMerchant) && (!selectedGroup || ["Alimentação", "Compras", "Assinaturas", "Sem Parar", "Abastecimento"].includes(item.category)) && (!selectedSource || (sourceByDocument.get(item.documentHash ?? "") ?? item.source) === selectedSource)), [transactions, selectedMonth, selectedCategory, selectedMerchant, selectedSource, sourceByDocument]);
  const allOutflows = useMemo(() => visibleTransactions.filter((item) => item.amount < 0).map((item) => CATEGORY_NAMES.includes(item.category) ? item : { ...item, category: "Outros" as Category }), [visibleTransactions]);
  const movementOutflows = useMemo(() => allOutflows.filter((item) => MOVEMENT_CATEGORIES.includes(item.category)), [allOutflows]);
  // Toda saída da fatura ou do extrato compõe o total mensal. A separação
  // de PIX e transferências é usada apenas nos insights de economia.
  const expenses = allOutflows;
  const consumptionExpenses = useMemo(() => allOutflows.filter((item) => !MOVEMENT_CATEGORIES.includes(item.category)), [allOutflows]);
  const selectedInvoiceDocuments = useMemo(() => cloudDocuments.filter((document) => document.kind === "invoice" && (!selectedMonth || document.month === selectedMonth)), [cloudDocuments, selectedMonth]);
  const declaredInvoiceTotal = selectedInvoiceDocuments.reduce((sum, document) => sum + (document.declaredTotal ?? 0), 0);
  const parsedInvoiceTotal = Math.abs(expenses.filter((item) => item.source === "invoice").reduce((sum, item) => sum + item.amount, 0));
  // The cover of a card statement is Santander\'s authoritative amount. Purchase
  // rows still drive category breakdowns, but do not replace the amount due.
  const invoiceTotal = declaredInvoiceTotal || parsedInvoiceTotal;
  const statementTotal = Math.abs(expenses.filter((item) => item.source === "statement").reduce((sum, item) => sum + item.amount, 0));
  const total = invoiceTotal + statementTotal;
  const movementTotal = Math.abs(movementOutflows.reduce((sum, item) => sum + item.amount, 0));
  const detectedIncome = visibleTransactions.filter((item) => item.amount > 0).reduce((sum, item) => sum + item.amount, 0);
  const accountIncomeTransactions = useMemo(() => transactions.filter((item) => (!selectedMonth || (item.month ?? item.date.slice(0, 7)) === selectedMonth) && item.amount > 0 && (sourceByDocument.get(item.documentHash ?? "") ?? item.source) === "statement"), [transactions, selectedMonth, sourceByDocument]);
  const accountIncomeTotal = accountIncomeTransactions.reduce((sum, item) => sum + item.amount, 0);
  const accountIncomeByType = (category: Category) => accountIncomeTransactions.filter((item) => item.category === category).reduce((sum, item) => sum + item.amount, 0);

  const categoryData = useMemo(() => {
    const values = CATEGORY_NAMES.map((name) => ({ name, value: Math.abs(consumptionExpenses.filter((item) => item.category === name).reduce((sum, item) => sum + item.amount, 0)), color: CATEGORY_META[name].color })).filter((item) => item.value > 0);
    const categoryTotal = values.reduce((sum, item) => sum + item.value, 0);
    return values.map((item) => ({ ...item, share: categoryTotal ? item.value / categoryTotal * 100 : 0, percentage: categoryTotal ? Math.round(item.value / categoryTotal * 100) : 0 })).sort((a, b) => b.value - a.value);
  }, [consumptionExpenses]);
  const consumptionTotal = Math.abs(consumptionExpenses.reduce((sum, item) => sum + item.amount, 0));
  const donut = `conic-gradient(${categoryData.map((item, index) => { const start = categoryData.slice(0, index).reduce((sum, entry) => sum + entry.share, 0); return `${item.color} ${start}% ${start + item.share}%`; }).join(",") || "#e9eef3 0 100%"} )`;
  const pendingHashes = useMemo(() => new Set(pendingDocuments.map((document) => document.hash)), [pendingDocuments]);
  const reviewTransactions = useMemo(() => transactions.filter((item) => item.documentHash && pendingHashes.has(item.documentHash)), [transactions, pendingHashes]);
  const monthlySeries = useMemo(() => months.map((month) => {
    const expensesForMonth = transactions.filter((item) => (item.month ?? item.date.slice(0, 7)) === month && item.amount < 0).map((item) => CATEGORY_NAMES.includes(item.category) ? item : { ...item, category: "Outros" as Category });
    return { month, total: Math.abs(expensesForMonth.reduce((sum, item) => sum + item.amount, 0)), categories: CATEGORY_NAMES.map((category) => ({ category, value: Math.abs(expensesForMonth.filter((item) => item.category === category).reduce((sum, item) => sum + item.amount, 0)) })) };
  }), [months, transactions]);
  const recentMonths = useMemo(() => {
    const now = new Date();
    return Array.from({ length: 6 }, (_, index) => {
      const date = new Date(now.getFullYear(), now.getMonth() - index, 1);
      return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}`;
    }).reverse();
  }, []);
  const missingInvoiceMonths = useMemo(() => {
    const imported = new Set(cloudDocuments.filter((document) => document.kind === "invoice").map((document) => document.month));
    return recentMonths.filter((month) => !imported.has(month));
  }, [cloudDocuments, recentMonths]);
  const missingStatementMonths = useMemo(() => {
    const imported = new Set(cloudDocuments.filter((document) => document.kind === "statement").map((document) => document.month));
    return recentMonths.filter((month) => !imported.has(month));
  }, [cloudDocuments, recentMonths]);
  const invoicesNeedingVerification = useMemo(() => cloudDocuments.filter((document) => document.kind === "invoice" && !document.declaredTotal), [cloudDocuments]);

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
        if (seen.has(hash) || pendingDocuments.some((document) => document.hash === hash)) { duplicateCount += 1; continue; }
        const alreadySaved = cloudDocuments.some((document) => document.hash === hash) || Boolean(user && await documentExists(user.uid, hash));
        seen.add(hash);
        const result = await parseSantanderPdf(entry.file, entry.kind);
        if (alreadySaved) batchWarnings.push(`${entry.file.name}: documento já existente; seus dados serão atualizados com a nova leitura.`);
        pages += result.pageCount; lines += result.lineCount; batchWarnings.push(...result.warnings);
        batchDocuments.push({ hash, name: entry.file.name, kind: entry.kind, month: result.month, pageCount: result.pageCount, transactionCount: result.transactions.length, ...(typeof result.declaredTotal === "number" ? { declaredTotal: result.declaredTotal } : {}), invoiceMonthNormalized: entry.kind === "invoice", invoiceMonthByDueDate: entry.kind === "invoice" });
        batchTransactions.push(...result.transactions.map((item) => { const rule = classificationRules.find((entry) => merchantKey(item.description).includes(entry.pattern)); return { ...item, category: rule?.category ?? item.category, month: result.month, documentHash: hash, documentName: entry.file.name }; }));
      }
      if (duplicateCount) batchWarnings.push(`${duplicateCount} documento${duplicateCount > 1 ? "s repetidos foram ignorados" : " repetido foi ignorado"}.`);
      if (!batchTransactions.length) throw new Error(duplicateCount ? "Os mesmos arquivos foram selecionados mais de uma vez nesta importação." : "Não encontramos movimentações nesses documentos.");
      setTransactions((history) => [...history.filter((item) => !batchDocuments.some((document) => document.hash === item.documentHash)), ...batchTransactions].sort((a, b) => b.date.localeCompare(a.date)));
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
        const history = await loadFinancialHistory(user.uid); setTransactions(history.transactions); setCloudDocuments(history.documents); setPendingDocuments([]); setFiles({ invoice: [], statement: [] }); setView("dashboard");
      } catch (caught) { setError(caught instanceof Error ? caught.message : "Não foi possível salvar no Firebase."); }
      finally { setCloudBusy(false); }
    } else setView("dashboard");
  };
  const saveClassification = (item: ParsedTransaction, patch: Pick<ParsedTransaction, "description" | "category">) => {
    const pattern = merchantKey(item.description);
    setTransactions((items) => items.map((entry) => merchantKey(entry.description) === pattern ? { ...entry, category: patch.category, confidence: "alta" } : entry));
    setClassificationRules((rules) => rules.some((rule) => rule.pattern === pattern && rule.category === patch.category) ? rules : [...rules, { pattern, category: patch.category }]);
    if (user && firebaseConfigured) {
      const matchingIds = transactions.filter((entry) => merchantKey(entry.description) === pattern).map((entry) => entry.id);
      updateMatchingFinancialTransactions(user.uid, matchingIds, { category: patch.category }).catch((caught) => setError(caught instanceof Error ? caught.message : "Não foi possível salvar a classificação."));
    }
  };
    const startDemo = () => { setTransactions(DEMO_TRANSACTIONS); setFiles({ invoice: [], statement: [] }); setSelectedMonth("2026-08"); setView("dashboard"); };

  if (view === "upload") return <UploadView files={files} ready={ready} parsing={parsing} error={error} user={user} cloudDocuments={cloudDocuments} onFiles={onFiles} onClear={(kind) => setFiles((current) => ({ ...current, [kind]: [] }))} analyze={analyze} startDemo={startDemo} setError={setError} backToDashboard={transactions.length ? () => setView("dashboard") : undefined} />;

  if (view === "review") return <main className="review-page"><header className="review-header"><div className="brand"><span>f</span> fluxo</div><button className="ghost" onClick={() => setView("upload")}>← Trocar arquivos</button></header><section className="review-content"><p className="eyebrow">ETAPA 2 DE 3</p><h1>Revise as movimentações</h1><p className="lead">Encontramos <strong>{reviewTransactions.length} movimentações novas</strong> em {pendingDocuments.length} documentos. Os meses foram identificados automaticamente.</p>{warnings.map((warning) => <div className="warning-box" key={warning}>⚠ {warning}</div>)}{error && <div className="error-box">{error}</div>}<div className="document-months">{pendingDocuments.map((document) => <span key={document.hash}><b>{monthLabel(document.month)}</b>{document.name}</span>)}</div><div className="review-summary"><div><small>Faturas</small><strong>{reviewTransactions.filter((item) => item.source === "invoice").length}</strong></div><div><small>Extratos</small><strong>{reviewTransactions.filter((item) => item.source === "statement").length}</strong></div><div><small>Linhas analisadas</small><strong>{documentStats.lines}</strong></div></div><div className="review-table"><div className="review-row review-labels"><span>Data</span><span>Descrição</span><span>Categoria</span><span>Valor</span><span /></div>{reviewTransactions.map((item) => <div className="review-row" key={`${item.documentHash}-${item.id}`}><time>{shortDate(item.date)}</time><input value={item.description} onChange={(event) => updateTransaction(item, { description: event.target.value, category: categorize(event.target.value) })} /><select value={item.category} onChange={(event) => updateTransaction(item, { category: event.target.value as Category })}>{CATEGORY_NAMES.map((name) => <option key={name}>{name}</option>)}</select><strong className={item.amount > 0 ? "income" : ""}>{money(item.amount)}</strong><button aria-label={`Remover ${item.description}`} onClick={() => setTransactions((items) => items.filter((entry) => !(entry.id === item.id && entry.documentHash === item.documentHash)))}>×</button></div>)}</div><div className="review-actions"><button className="ghost" onClick={() => setView("upload")}>Voltar</button><button className="primary" disabled={!reviewTransactions.length || cloudBusy} onClick={confirmImport}>{cloudBusy ? "Salvando…" : firebaseConfigured && user ? "Salvar no Firebase e analisar →" : "Continuar sem salvar →"}</button></div></section></main>;

  return <main className="app-shell"><aside className="sidebar"><div className="brand"><span>f</span> fluxo</div><nav><div className="nav-group"><p>VISÃO</p><button className={tab === "overview" ? "active" : ""} onClick={() => { setSelectedMonth(months.at(-1) ?? ""); setSelectedCategory(""); setSelectedMerchant(""); setSelectedGroup(""); setSelectedSource(""); setTab("overview"); }}>⌂ <span>Visão geral</span></button></div><div className="nav-group"><p>MOVIMENTAÇÕES</p><button className={tab === "transactions" ? "active" : ""} onClick={() => { setSelectedCategory(""); setSelectedMerchant(""); setSelectedGroup(""); setSelectedSource(""); setTab("transactions"); }}>↕ <span>Todos os lançamentos</span></button><button className={tab === "transactions" && selectedSource === "invoice" ? "active" : ""} onClick={() => { setSelectedCategory(""); setSelectedMerchant(""); setSelectedGroup(""); setSelectedSource("invoice"); setTab("transactions"); }}>▣ <span>Cartão de crédito</span></button><button className={tab === "transactions" && selectedSource === "statement" ? "active" : ""} onClick={() => { setSelectedCategory(""); setSelectedMerchant(""); setSelectedGroup(""); setSelectedSource("statement"); setTab("transactions"); }}>⌂ <span>Conta corrente</span></button><button className={tab === "pix" ? "active" : ""} onClick={() => setTab("pix")}>↗ <span>PIX</span></button><button className={tab === "income" ? "active" : ""} onClick={() => { setSelectedCategory(""); setSelectedMerchant(""); setSelectedGroup(""); setSelectedSource(""); setTab("income"); }}>↓ <span>Entradas na conta</span></button></div><div className="nav-group"><p>ANÁLISES</p><button className={tab === "insights" ? "active" : ""} onClick={() => setTab("insights")}>↗ <span>Comparação mensal</span></button><button className={tab === "intelligence" ? "active" : ""} onClick={() => setTab("intelligence")}>◉ <span>Análises e IA</span></button><button className={tab === "assistant" ? "active" : ""} onClick={() => setTab("assistant")}>✦ <span>Assistente</span></button></div><div className="nav-group"><p>PLANEJAMENTO</p><button className={tab === "save" ? "active" : ""} onClick={() => setTab("save")}>♧ <span>Economizar</span></button><button className={tab === "goals" ? "active" : ""} onClick={() => setTab("goals")}>◎ <span>Objetivos</span></button></div><div className="nav-group"><p>AJUSTES</p><button className={tab === "settings" ? "active" : ""} onClick={() => setTab("settings")}>⚙ <span>Configurações</span></button></div></nav><button className="new-import" onClick={() => setView("upload")}>＋ Importar histórico</button></aside><section className="content"><header><div>{tab !== "overview" && <button className="back-button back-overview" onClick={() => { setSelectedMonth(months.at(-1) ?? ""); setSelectedCategory(""); setSelectedMerchant(""); setSelectedGroup(""); setSelectedSource(""); setTab("overview"); }}>← Voltar à visão geral</button>}<p className="eyebrow">HISTÓRICO FINANCEIRO</p><h2>{tab === "overview" ? "Visão geral" : tab === "transactions" ? "Transações" : tab === "insights" ? "Comparação financeira" : tab === "intelligence" ? "Análises e IA" : tab === "assistant" ? "Assistente financeiro" : tab === "settings" ? "Configurações" : tab === "income" ? "Entradas na conta" : tab === "save" ? "Plano para economizar" : tab === "goals" ? "Objetivos financeiros" : "PIX"}</h2></div><div className="header-tools"><select value={selectedMonth} onChange={(event) => setSelectedMonth(event.target.value)}><option value="">Todos os meses</option>{months.map((month) => <option key={month} value={month}>{monthLabel(month)}</option>)}</select><div className="avatar">{user?.displayName?.slice(0, 2).toUpperCase() ?? "BR"}</div></div></header>
    {(missingInvoiceMonths.length > 0 || missingStatementMonths.length > 0) && <div className="missing-months"><span>◷</span><div><strong>Complete seu histórico dos últimos 6 meses</strong>{missingInvoiceMonths.length > 0 && <small><b>Faturas do cartão:</b> {missingInvoiceMonths.map(monthLabel).join(", ")}.</small>}{missingStatementMonths.length > 0 && <small><b>Extratos bancários:</b> {missingStatementMonths.map(monthLabel).join(", ")}.</small>}</div><button onClick={() => setView("upload")}>Importar PDFs</button></div>}
    {invoicesNeedingVerification.length > 0 && <div className="missing-months"><span>!</span><div><strong>Há faturas antigas sem total conferido</strong><small><b>Pendentes:</b> {invoicesNeedingVerification.map((document) => `${document.name} (${monthLabel(document.month)})`).join(", ")}. Elas não alteram o mês atual quando este já exibe “total declarado na fatura”.</small></div><button onClick={() => setView("upload")}>Importar pendentes</button></div>}
    {tab === "overview" && <><div className="summary-grid"><article className="hero-card"><p>Total da fatura em {monthLabel(selectedMonth)}</p><strong>{money(total)}</strong><span>valor oficial informado pelo Santander</span><div className="spark"><i/><i/><i/><i/><i/><i/><i/><i/></div></article><article><p>Cartão de crédito</p><strong>{money(invoiceTotal)}</strong><span>{declaredInvoiceTotal ? "total declarado na fatura" : expenses.filter((item) => item.source === "invoice").length + " compra(s) identificada(s)"}</span><div className="progress"><i style={{ width: (total ? invoiceTotal / total * 100 : 0) + "%" }} /></div></article><article><p>Conta corrente</p><strong>{money(statementTotal)}</strong><span>boletos, débitos e despesas no extrato</span><div className="progress green"><i style={{ width: (total ? statementTotal / total * 100 : 0) + "%" }} /></div></article></div><div className="dashboard-grid"><article className="category-card"><div className="card-title"><div><p className="eyebrow">COMPRAS DETALHADAS</p><h3>Onde foram as compras reconhecidas</h3></div></div><div className="category-body"><div className="donut" style={{ background: donut }}><span><b>{money(consumptionTotal)}</b><small>compras</small></span></div><div className="legend">{categoryData.map((item) => <button key={item.name} className="category-filter" onClick={() => { setSelectedCategory(item.name); setSelectedGroup(""); setTab("transactions"); }}><i style={{ background: item.color }} /><span>{item.name}</span><strong>{money(item.value)}</strong><b>{item.percentage}%</b></button>)}<p className="category-explanation">O gráfico soma {money(consumptionTotal)} em compras reconhecidas. O total da fatura pode incluir saldo anterior, encargos ou lançamentos não detalhados pelo PDF.</p></div></article><article className="saving-card"><span className="bulb">✦</span><p className="eyebrow">PRIORIDADE DO MÊS</p><h3>{categoryData[0]?.name ?? "Sem gastos"}: <em>{money(categoryData[0]?.value ?? 0)}</em></h3><p>{categoryData[0] ? <>Representa {categoryData[0].percentage}% das compras detalhadas.</> : <>Importe dados para ver sua principal categoria.</>}</p><button onClick={() => setTab("intelligence")}>Ver análise →</button></article></div><TransactionList items={expenses.slice(0, 5)} title="Últimas saídas" action={() => setTab("transactions")} /></>}
    {tab === "transactions" && <>{selectedSource === "invoice" && <InstallmentPanel transactions={visibleTransactions} selectedMonth={selectedMonth} />}<TransactionList items={visibleTransactions} title={`${selectedSource === "invoice" ? "Cartão de crédito · " : selectedSource === "statement" ? "Extrato bancário · " : ""}${selectedCategory ? `${selectedCategory} · ` : ""}Transações de ${monthLabel(selectedMonth)}`} onReview={saveClassification} onClearCategory={selectedCategory || selectedMerchant || selectedGroup || selectedSource ? () => { setSelectedCategory(""); setSelectedMerchant(""); setSelectedGroup(""); setSelectedSource(""); } : undefined} /></>}
    {tab === "insights" && <><MonthlyEvolution series={monthlySeries} /></>}
    {tab === "settings" && <BudgetAndRules expenses={consumptionExpenses} rules={classificationRules} budgets={categoryBudgets} setBudgets={setCategoryBudgets} setRules={setClassificationRules} />}
    {tab === "assistant" && <FinancialAssistant transactions={transactions} months={months} selectedMonth={selectedMonth} goalTarget={goalTarget} goalSaved={goalSaved} onShowCategory={(category) => { setSelectedMerchant(""); setSelectedGroup(""); setSelectedSource(""); setSelectedCategory(category); setTab("transactions"); }} onShowFlexible={() => { setSelectedCategory(""); setSelectedMerchant(""); setSelectedSource(""); setSelectedGroup("flexible"); setTab("transactions"); }} />}
    {tab === "intelligence" && <SmartInsights transactions={transactions} expenses={consumptionExpenses} months={months} selectedMonth={selectedMonth} invoiceTotal={invoiceTotal} monthlyGoal={monthlyGoal} cardLimit={cardLimit} setMonthlyGoal={setMonthlyGoal} setCardLimit={setCardLimit} budgets={categoryBudgets} onShowMerchant={(merchant) => { setSelectedCategory(""); setSelectedGroup(""); setSelectedSource(""); setSelectedMerchant(merchant); setTab("transactions"); }} onShowFlexible={() => { setSelectedCategory(""); setSelectedMerchant(""); setSelectedSource(""); setSelectedGroup("flexible"); setTab("transactions"); }} onShowCategory={(category) => { setSelectedMerchant(""); setSelectedGroup(""); setSelectedSource(""); setSelectedCategory(category); setTab("transactions"); }} />}
    {tab === "save" && <SavingsCoach expenses={consumptionExpenses} transactions={transactions} selectedMonth={selectedMonth} />}
    {tab === "pix" && <PixPanel transactions={transactions} selectedMonth={selectedMonth} />}
    {tab === "income" && <><div className="summary-grid income-summary"><article className="hero-card"><p>Entradas em {monthLabel(selectedMonth)}</p><strong>{money(accountIncomeTotal)}</strong><span>{accountIncomeTransactions.length} crédito(s) identificados no extrato</span></article><article><p>PIX recebidos</p><strong>{money(accountIncomeByType("PIX recebido"))}</strong><span>créditos via PIX</span></article><article><p>Transferências e renda</p><strong>{money(accountIncomeByType("Transferência recebida") + accountIncomeByType("Renda"))}</strong><span>transferências, salário e outros créditos</span></article></div><TransactionList items={accountIncomeTransactions} title={`Entradas de ${monthLabel(selectedMonth)}`} /></>}

    {tab === "goals" && <GoalPlanner expenses={consumptionExpenses} selectedMonth={selectedMonth} goalTarget={goalTarget} goalSaved={goalSaved} goalDate={goalDate} monthlyIncome={monthlyIncome} detectedIncome={detectedIncome} setGoalTarget={setGoalTarget} setGoalSaved={setGoalSaved} setGoalDate={setGoalDate} setMonthlyIncome={setMonthlyIncome} />}
    <p className="prototype-note">Os PDFs permanecem no dispositivo. Somente transações revisadas são sincronizadas.</p></section></main>;
}

function UploadView({ files, ready, parsing, error, user, cloudDocuments, onFiles, onClear, analyze, startDemo, setError, backToDashboard }: { files: Record<FileKind, File[]>; ready: boolean; parsing: boolean; error: string; user: AppUser | null; cloudDocuments: CloudDocument[]; onFiles: (kind: FileKind, files: File[]) => void; onClear: (kind: FileKind) => void; analyze: () => void; startDemo: () => void; setError: (value: string) => void; backToDashboard?: () => void }) {
  const count = files.invoice.length + files.statement.length;
  return <main className="upload-page"><section className="brand-panel"><div className="brand"><span>f</span> fluxo</div><div className="brand-copy"><p className="eyebrow">Seu dinheiro, mais claro</p><h1>Construa seu histórico.<br />Poupe com intenção.</h1><p>Importe vários meses. O Fluxo identifica o período, evita documentos repetidos e mostra sua evolução.</p></div><div className="security-pill">🔒 Os PDFs ficam neste dispositivo</div></section><section className="import-panel"><div className="mobile-brand"><span>f</span> fluxo</div>{backToDashboard && <button className="back-button upload-back" onClick={backToDashboard}>← Voltar ao painel</button>}<div className="step">ETAPA 1 DE 3</div><h2>Importar histórico</h2><p className="lead">Selecione um ou vários PDFs do Santander, mesmo que sejam de meses diferentes.</p><div className={`firebase-status ${firebaseConfigured && user ? "connected" : ""}`}>{firebaseConfigured ? user ? <><span>✓</span><div><strong>Firebase conectado</strong><small>{user.email} · {cloudDocuments.length} documentos salvos</small></div><button onClick={logoutFirebase}>Sair</button></> : <><span>☁</span><div><strong>Entre para salvar seu histórico</strong><small>Sincronize entre computador e celular.</small></div><button onClick={() => loginWithGoogle().catch((caught) => setError(caught instanceof Error ? caught.message : "Falha no login."))}>Entrar com Google</button></> : <><span>!</span><div><strong>Firebase aguardando configuração</strong><small>A análise funciona, mas ainda não será salva na nuvem.</small></div></>}</div><div className="uploads"><UploadCard kind="invoice" title="Faturas do cartão" files={files.invoice} onFiles={onFiles} onClear={onClear} /><UploadCard kind="statement" title="Extratos bancários" files={files.statement} onFiles={onFiles} onClear={onClear} /></div><div className="privacy-note"><span>✓</span><p><strong>Processamento privado</strong><br />Somente as transações revisadas são enviadas ao Firebase.</p></div>{error && <div className="error-box">{error}</div>}<button className="primary" disabled={!ready || parsing} onClick={analyze}>{parsing ? "Lendo os documentos…" : ready ? `Analisar ${count} documento${count > 1 ? "s" : ""} →` : "Selecione seus PDFs"}</button>{parsing && <div className="loading-line"><i /></div>}<button className="demo" onClick={startDemo}>Explorar comparação demonstrativa</button></section></main>;
}

function MonthlyEvolution({ series }: { series: Array<{ month: string; total: number; categories: Array<{ category: Category; value: number }> }> }) {
  const maximum = Math.max(...series.map((item) => item.total), 1);
  const activeCategories = CATEGORY_NAMES.filter((category) => series.some((item) => item.categories.some((entry) => entry.category === category && entry.value > 0)));
  return <article className="evolution-card"><div className="card-title"><div><p className="eyebrow">EVOLUÇÃO POR CATEGORIA</p><h3>Comparação mensal de saídas</h3></div><span>{series.length} meses</span></div>{series.length < 2 ? <p className="empty-state">Importe pelo menos dois meses para comparar sua evolução.</p> : <><p className="evolution-help">Cada barra representa o total gasto no mês. As cores mostram a composição por categoria.</p><div className="evolution-chart">{series.map((item) => <div className="evolution-column" key={item.month}><strong>{money(item.total)}</strong><div className="evolution-track" style={{ height: `${Math.max(24, item.total / maximum * 170)}px` }}>{item.categories.filter((category) => category.value > 0).map((category) => <i key={category.category} title={`${category.category}: ${money(category.value)}`} style={{ background: CATEGORY_META[category.category].color, height: `${category.value / item.total * 100}%` }} />)}</div><span>{monthLabel(item.month)}</span></div>)}</div><div className="evolution-legend">{activeCategories.map((category) => <span key={category}><i style={{ background: CATEGORY_META[category].color }} />{category}</span>)}</div></>}</article>;
}


function SavingsCoach({ expenses, transactions, selectedMonth }: { expenses: ParsedTransaction[]; transactions: ParsedTransaction[]; selectedMonth: string }) {
  const currentMonth = selectedMonth || Array.from(new Set(transactions.map((item)=>item.month ?? item.date.slice(0,7)))).sort().at(-1) || "";
  const current = expenses.filter((item)=>(item.month ?? item.date.slice(0,7))===currentMonth);
  const amount = (items: ParsedTransaction[]) => Math.abs(items.reduce((sum,item)=>sum+item.amount,0));
  const category = (name: Category) => current.filter((item)=>item.category===name);
  const food = amount(category("Alimentação")), purchases = amount(category("Compras")), subscriptions = amount(category("Assinaturas")), tolls = amount(category("Sem Parar")), fuel = amount(category("Abastecimento"));
  const flexible = food+purchases+subscriptions+tolls+fuel;
  const recurring = Object.values(expenses.reduce<Record<string,{name:string;months:Set<string>;total:number}>>((all,item)=>{const key=merchantKey(item.description), entry=all[key]??{name:item.description,months:new Set<string>(),total:0};entry.months.add(item.month??item.date.slice(0,7));entry.total+=Math.abs(item.amount);all[key]=entry;return all;},{})).filter((item)=>item.months.size>=2).sort((a,b)=>b.total-a.total).slice(0,4);
  const biggest = [{name:"Alimentação",value:food,tip:"Defina um teto semanal para restaurantes, delivery e lanches."},{name:"Compras",value:purchases,tip:"Espere 24 horas antes de compras não planejadas; isso reduz decisões por impulso."},{name:"Assinaturas",value:subscriptions,tip:"Cancele ou pause serviços que não foram usados nas últimas semanas."},{name:"Abastecimento",value:fuel,tip:"Defina um limite por abastecimento e acompanhe a frequência dos postos."},{name:"Sem Parar",value:tolls,tip:"Revise a frequência de pedágios e os trajetos mais recorrentes."}].sort((a,b)=>b.value-a.value)[0];
  const target = flexible * .1;
  return <section className="savings-coach"><article className="saving-hero"><p className="eyebrow">SEU PLANO PRÁTICO</p><h3>Uma redução de 10% nos gastos flexíveis pode liberar <em>{money(target)}</em></h3><p>Baseado em {money(flexible)} de alimentação, compras, assinaturas e transporte em {monthLabel(currentMonth)}.</p></article><div className="coach-grid"><article><span>1</span><div><p className="eyebrow">PRIORIDADE DO MÊS</p><h3>{biggest?.name ?? "Sem dados suficientes"}: {money(biggest?.value ?? 0)}</h3><p>{biggest?.tip ?? "Importe mais meses para receber uma recomendação personalizada."}</p></div></article><article><span>2</span><div><p className="eyebrow">GASTOS SUPERFLUOS</p><h3>{money(purchases + food)} em compras e alimentação</h3><p>Separe esse valor em um limite semanal. Pequenas escolhas nesses grupos têm impacto rápido no orçamento.</p></div></article><article><span>3</span><div><p className="eyebrow">RECORRÊNCIAS PARA REVISAR</p><h3>{recurring.length ? recurring.map((item)=>item.name).join(" · ") : "Nenhuma recorrência confirmada ainda"}</h3><p>{recurring.length ? "Confira se esses pagamentos ainda entregam valor antes da próxima cobrança." : "Com dois ou mais meses importados, o sistema identifica serviços recorrentes."}</p></div></article><article><span>4</span><div><p className="eyebrow">AÇÃO DE HOJE</p><h3>Transfira {money(target)} para sua reserva</h3><p>Se for muito, comece com metade. O importante é transformar a economia identificada em dinheiro separado.</p></div></article></div><p className="coach-note">Estas são sugestões de organização financeira baseadas nas transações importadas; você decide o que faz sentido para a sua rotina.</p></section>;
}




function PixPanel({ transactions, selectedMonth }: { transactions: ParsedTransaction[]; selectedMonth: string }) {
  const pix = transactions.filter((item) => (!selectedMonth || (item.month ?? item.date.slice(0,7)) === selectedMonth) && item.source === "statement" && /pix (?:enviado|recebido)/i.test(item.description));
  const sent = pix.filter((item) => /pix enviado/i.test(item.description)), received = pix.filter((item) => /pix recebido/i.test(item.description));
  const totalSent = Math.abs(sent.reduce((sum,item)=>sum+item.amount,0)), totalReceived = received.reduce((sum,item)=>sum+Math.abs(item.amount),0);
  const list = (items: ParsedTransaction[], empty: string) => items.length ? items.map((item)=><div className="pix-row" key={item.id}><div><b>{item.description}</b><small>{shortDate(item.date)} · Extrato bancário</small></div><strong className={item.amount>0?"income":""}>{money(item.amount)}</strong></div>) : <p className="empty-state">{empty}</p>;
  return <section className="pix-page"><div className="pix-summary"><article><p>PIX enviados</p><strong>{money(totalSent)}</strong><small>{sent.length} transações</small></article><article><p>PIX recebidos</p><strong className="income">{money(totalReceived)}</strong><small>{received.length} transações</small></article></div><div className="pix-columns"><article><div className="card-title"><div><p className="eyebrow">SAÍDAS</p><h3>PIX enviados</h3></div></div>{list(sent,"Nenhum PIX enviado neste período.")}</article><article><div className="card-title"><div><p className="eyebrow">ENTRADAS</p><h3>PIX recebidos</h3></div></div>{list(received,"Nenhum PIX recebido neste período.")}</article></div></section>;
}

function BudgetAndRules({ expenses, budgets, rules, setBudgets, setRules }: { expenses: ParsedTransaction[]; budgets: Partial<Record<Category, number>>; rules: Array<{ pattern: string; category: Category }>; setBudgets: (value: Partial<Record<Category, number>>) => void; setRules: (value: Array<{ pattern: string; category: Category }>) => void }) {
  const spending = (category: Category) => Math.abs(expenses.filter((item)=>item.category===category).reduce((sum,item)=>sum+item.amount,0));
  return <section className="budget-rules"><article><p className="eyebrow">ORÇAMENTO POR CATEGORIA</p><h3>Defina seus limites mensais</h3><div className="budget-grid">{CATEGORY_NAMES.filter((category)=>!["PIX recebido","PIX enviado","Transferência recebida","Transferência enviada"].includes(category)).map((category)=><label key={category}><span>{category}<small>Gasto: {money(spending(category))}</small></span><input type="number" min="0" placeholder="Sem limite" value={budgets[category]||""} onChange={(event)=>setBudgets({...budgets,[category]:Number(event.target.value)})}/></label>)}</div></article><article><p className="eyebrow">REGRAS QUE APRENDEM</p><h3>Classificações personalizadas</h3><p className="rule-help">Ao revisar uma transação, o sistema cria uma regra para os próximos lançamentos semelhantes.</p>{rules.length ? <div className="rules-list">{rules.map((rule,index)=><span key={`${rule.pattern}-${index}`}>{rule.pattern} → {rule.category}<button onClick={()=>setRules(rules.filter((_,position)=>position!==index))}>×</button></span>)}</div> : <p className="empty-state">Revise uma transação para criar sua primeira regra.</p>}</article></section>;
}
function InstallmentPanel({ transactions, selectedMonth }: { transactions: ParsedTransaction[]; selectedMonth: string }) {
  const active = transactions.filter((item)=>(!selectedMonth || (item.month??item.date.slice(0,7))===selectedMonth) && item.amount<0).map((item)=>{ const match=item.description.match(/(?:parcela\s*)?(\d{1,2})\s*\/\s*(\d{1,2})/i); return match ? { ...item, current:Number(match[1]), total:Number(match[2]) } : null; }).filter(Boolean) as Array<ParsedTransaction & { current:number; total:number }>;
  const future = active.reduce((sum,item)=>sum+Math.abs(item.amount)*(item.total-item.current),0);
  return <article className="installment-panel"><p className="eyebrow">PARCELAS IDENTIFICADAS</p><h3>{active.length ? `${active.length} compra(s) ainda comprometem suas próximas faturas` : "Nenhuma parcela identificada neste período"}</h3><p>{active.length ? `Restam aproximadamente ${money(future)} nas parcelas em aberto.` : "Compras com formatos como 03/12 aparecerão aqui automaticamente."}</p>{active.slice(0,4).map((item)=><div key={item.id}><span>{item.description}</span><b>{item.current}/{item.total}</b><strong>{money(Math.abs(item.amount))}/mês</strong></div>)}</article>;
}

function GoalPlanner({ expenses, selectedMonth, goalTarget, goalSaved, goalDate, monthlyIncome, detectedIncome, setGoalTarget, setGoalSaved, setGoalDate, setMonthlyIncome }: { expenses: ParsedTransaction[]; selectedMonth: string; goalTarget: number; goalSaved: number; goalDate: string; monthlyIncome: number; detectedIncome: number; setGoalTarget: (value: number) => void; setGoalSaved: (value: number) => void; setGoalDate: (value: string) => void; setMonthlyIncome: (value: number) => void }) {
  const currentMonth = selectedMonth || "", spent = Math.abs(expenses.filter((item)=>(item.month??item.date.slice(0,7))===currentMonth).reduce((sum,item)=>sum+item.amount,0));
  const income = monthlyIncome || detectedIncome, balance = income-spent, date = goalDate ? new Date(`${goalDate}T12:00:00`) : null, now = new Date();
  const monthsLeft = date ? Math.max(1, Math.ceil(date.getFullYear()*12+date.getMonth()-now.getFullYear()*12-now.getMonth())) : 12, remaining = Math.max(0,goalTarget-goalSaved), required=remaining/monthsLeft, progress=goalTarget?Math.min(100,Math.round(goalSaved/goalTarget*100)):0;
  return <section className="goal-page"><p className="eyebrow">PLANEJAMENTO PERSONALIZADO</p><h3>Transforme sua meta em um plano mensal</h3><p className="goal-lead">Informe renda, valor e prazo. Usaremos suas despesas importadas para dizer exatamente quanto separar e o que ajustar.</p><article className="goal-planner"><div><p className="eyebrow">OBJETIVO ATUAL</p><h3>Juntar {money(goalTarget)}</h3><p>{money(goalSaved)} já reservado · faltam {money(remaining)}</p><div className="goal-progress"><i style={{width:`${progress}%`}} /></div><small>{progress}% concluído</small></div><div className="goal-form"><label>Renda mensal<input type="number" min="0" value={monthlyIncome||""} placeholder={detectedIncome?`Detectada: ${money(detectedIncome)}`:"Informe sua renda"} onChange={(event)=>setMonthlyIncome(Number(event.target.value))}/><small>{monthlyIncome?"Valor informado por você":detectedIncome?"Estimativa pelas entradas do extrato":"Não identificada automaticamente"}</small></label><label>Meta<input type="number" min="1" value={goalTarget||""} onChange={(event)=>setGoalTarget(Number(event.target.value))}/></label><label>Já tenho<input type="number" min="0" value={goalSaved||""} onChange={(event)=>setGoalSaved(Number(event.target.value))}/></label><label>Até quando<input type="month" value={goalDate} onChange={(event)=>setGoalDate(event.target.value)}/></label></div><div className="goal-action"><strong>Reserve {money(required)} por mês</strong><span>{goalDate?`para chegar até ${monthLabel(goalDate)}`:"em uma projeção de 12 meses"}</span><p>{income ? balance>=required?"Sua sobra estimada suporta esse aporte. Programe uma transferência assim que receber.":`Faltam ${money(required-Math.max(0,balance))} por mês. Use a seção Economizar para escolher cortes práticos.`:"Informe sua renda para validar a viabilidade."}</p></div></article>{income>0&&<div className="goal-summary"><article><small>RENDA CONSIDERADA</small><strong>{money(income)}</strong></article><article><small>GASTOS DO PERÍODO</small><strong>{money(spent)}</strong></article><article><small>SOBRA ESTIMADA</small><strong className={balance<0?"negative":""}>{money(balance)}</strong></article></div>}</section>;
}

function FinancialAssistant({ transactions, months, selectedMonth, goalTarget, goalSaved, onShowCategory, onShowFlexible }: { transactions: ParsedTransaction[]; months: string[]; selectedMonth: string; goalTarget: number; goalSaved: number; onShowCategory: (category: Category) => void; onShowFlexible: () => void }) {
  const [question, setQuestion] = useState("Por que gastei mais?");
  const currentMonth = selectedMonth || months.at(-1) || "";
  const current = transactions.filter((item) => (item.month ?? item.date.slice(0, 7)) === currentMonth);
  const expenses = current.filter((item) => item.amount < 0 && !MOVEMENT_CATEGORIES.includes(CATEGORY_NAMES.includes(item.category) ? item.category : "Outros"));
  const income = current.filter((item) => item.amount > 0);
  const spent = Math.abs(expenses.reduce((sum, item) => sum + item.amount, 0));
  const received = income.reduce((sum, item) => sum + item.amount, 0);
  const previousMonth = months[months.indexOf(currentMonth) - 1] ?? "";
  const previousSpent = Math.abs(transactions.filter((item) => (item.month ?? item.date.slice(0, 7)) === previousMonth && item.amount < 0).reduce((sum, item) => sum + item.amount, 0));
  const categoryTotals = CATEGORY_NAMES.map((category) => ({ category, value: Math.abs(expenses.filter((item) => item.category === category).reduce((sum, item) => sum + item.amount, 0)) })).sort((a, b) => b.value - a.value);
  const biggest = categoryTotals[0];
  const flexible = categoryTotals.filter((item) => ["Alimentação", "Compras", "Assinaturas", "Sem Parar", "Abastecimento"].includes(item.category)).reduce((sum, item) => sum + item.value, 0);
  const uncertain = current.filter((item) => item.confidence !== "alta" || item.category === "Outros").length;
  const averageOutflow = months.length ? months.reduce((sum, month) => sum + Math.abs(transactions.filter((item) => (item.month ?? item.date.slice(0, 7)) === month && item.amount < 0 && !MOVEMENT_CATEGORIES.includes(CATEGORY_NAMES.includes(item.category) ? item.category : "Outros")).reduce((partial, item) => partial + item.amount, 0)), 0) / months.length : 0;
  const averageIncome = months.length ? months.reduce((sum, month) => sum + transactions.filter((item) => (item.month ?? item.date.slice(0, 7)) === month && item.amount > 0).reduce((partial, item) => partial + item.amount, 0), 0) / months.length : 0;
  const remainingGoal = Math.max(0, goalTarget - goalSaved);
  const prompts = ["Por que gastei mais?", "Onde economizar?", "Como está meu fluxo de caixa?", "Como acelerar minha meta?"];
  const answer = question.toLowerCase().includes("econom") ? <><strong>Oportunidade prática: {money(flexible * .1)}</strong><p>Reduzir 10% dos gastos flexíveis deste período libera esse valor. O total analisado foi {money(flexible)}.</p><button onClick={onShowFlexible}>Ver lançamentos usados →</button></> : question.toLowerCase().includes("fluxo") ? <><strong>Projeção dos próximos 30 dias: {money(averageIncome - averageOutflow)}</strong><p>Média de entradas: {money(averageIncome)}; média de saídas: {money(averageOutflow)}. Esta é uma estimativa baseada nos {months.length} meses importados.</p></> : question.toLowerCase().includes("meta") ? <><strong>Faltam {money(remainingGoal)} para sua meta</strong><p>Separar {money(Math.max(0, averageIncome - averageOutflow))} por mês, mantendo o padrão atual, é o seu ponto de partida estimado.</p></> : <><strong>{biggest?.category ?? "Sem dados"} foi a maior categoria: {money(biggest?.value ?? 0)}</strong><p>{previousSpent ? <>Você gastou {spent > previousSpent ? money(spent - previousSpent) + " a mais" : money(previousSpent - spent) + " a menos"} que no mês anterior.</> : <>Foram {expenses.length} saídas analisadas em {monthLabel(currentMonth)}.</>}</p>{biggest && <button onClick={() => onShowCategory(biggest.category)}>Ver lançamentos usados →</button>}</>;
  return <section className="assistant-page"><article className="assistant-hero"><div><p className="eyebrow">IA EXPLICÁVEL</p><h3>Pergunte sobre seu dinheiro</h3><p>As respostas usam somente os lançamentos importados e sempre mostram a base da recomendação.</p></div><span>✦</span></article><div className="assistant-prompts">{prompts.map((prompt) => <button key={prompt} className={question === prompt ? "active" : ""} onClick={() => setQuestion(prompt)}>{prompt}</button>)}</div><label className="assistant-question"><span>Sua pergunta</span><input value={question} onChange={(event) => setQuestion(event.target.value)} placeholder="Ex.: Onde posso economizar este mês?" /></label><article className="assistant-answer"><p className="eyebrow">RESPOSTA BASEADA NO HISTÓRICO</p>{answer}</article><div className="ai-signal-grid"><article><p>RESUMO DO MÊS</p><strong>{money(spent)} em saídas</strong><span>{money(received)} em entradas</span></article><article><p>QUALIDADE DOS DADOS</p><strong>{uncertain} lançamento(s) a confirmar</strong><span>Revise itens de confiança média ou em “Outros”.</span></article><article><p>PREVISÃO DE FECHAMENTO</p><strong>{money(averageOutflow)} de média mensal</strong><span>Referência calculada com seu histórico importado.</span></article></div></section>;
}

function SmartInsights({ transactions, expenses, months, selectedMonth, invoiceTotal, monthlyGoal, cardLimit, setMonthlyGoal, setCardLimit, budgets, onShowMerchant, onShowFlexible, onShowCategory }: { transactions: ParsedTransaction[]; expenses: ParsedTransaction[]; months: string[]; selectedMonth: string; invoiceTotal: number; monthlyGoal: number; cardLimit: number; setMonthlyGoal: (value: number) => void; setCardLimit: (value: number) => void; budgets: Partial<Record<Category, number>>; onShowMerchant: (merchant: string) => void; onShowFlexible: () => void; onShowCategory: (category: Category) => void }) {
  const currentMonth = selectedMonth || months.at(-1) || "";
  const current = expenses.filter((item) => (item.month ?? item.date.slice(0, 7)) === currentMonth);
  const previous = expenses.filter((item) => (item.month ?? item.date.slice(0, 7)) === months[months.indexOf(currentMonth) - 1]);
  const total = Math.abs(current.reduce((sum, item) => sum + item.amount, 0)), before = Math.abs(previous.reduce((sum, item) => sum + item.amount, 0));
  const change = before ? Math.round((total / before - 1) * 100) : 0, goalGap = monthlyGoal ? Math.max(0, total - monthlyGoal) : 0, limitPercent = cardLimit ? Math.round(invoiceTotal / cardLimit * 100) : 0;
  const groups = Object.values(expenses.reduce<Record<string, { name: string; count: number; months: Set<string>; total: number }>>((all, item) => { const key = merchantKey(item.description), entry = all[key] ?? { name: item.description, count: 0, months: new Set<string>(), total: 0 }; entry.count++; entry.months.add(item.month ?? item.date.slice(0,7)); entry.total += Math.abs(item.amount); all[key] = entry; return all; }, {}));
  const recurring = groups.filter((item) => item.months.size >= 2).sort((a,b) => b.total-a.total).slice(0,3);
  const top = groups.sort((a,b) => b.total-a.total).slice(0,3);
  const duplicates = Object.values(current.reduce<Record<string,number>>((all,item) => { const key = `${merchantKey(item.description)}-${Math.abs(item.amount)}-${item.date}`; all[key]=(all[key]??0)+1; return all; },{})).filter((n)=>n>1).length;
  const flexible = current.filter((item) => ["Alimentação","Compras","Assinaturas","Sem Parar","Abastecimento"].includes(item.category)).reduce((sum,item)=>sum+Math.abs(item.amount),0);
  const average = months.length ? months.map((month)=>Math.abs(expenses.filter((item)=>(item.month??item.date.slice(0,7))===month).reduce((sum,item)=>sum+item.amount,0))).reduce((sum,value)=>sum+value,0)/months.length : 0;
  const categoryTotal = (items: ParsedTransaction[], category: Category) => Math.abs(items.filter((item)=>item.category===category).reduce((sum,item)=>sum+item.amount,0));
  const rising = CATEGORY_NAMES.map((category)=>({category, now:categoryTotal(current,category), before:categoryTotal(previous,category)})).filter((item)=>item.before>0 && item.now>item.before).sort((a,b)=>b.now/b.before-a.now/a.before)[0];
  const concentrationEntry = CATEGORY_NAMES.map((category) => ({ category, value: categoryTotal(current, category) })).sort((a, b) => b.value - a.value)[0];
  const concentration = total ? Math.round((concentrationEntry?.value ?? 0) / total * 100) : 0;
  const today = new Date(), isCurrent = currentMonth === `${today.getFullYear()}-${String(today.getMonth()+1).padStart(2,"0")}`;
  const forecast = isCurrent ? total / Math.max(today.getDate(),1) * new Date(today.getFullYear(),today.getMonth()+1,0).getDate() : 0;
  const budgetAlert = CATEGORY_NAMES.map((category) => ({ category, spent: categoryTotal(current, category), budget: budgets[category] ?? 0 })).filter((item) => item.budget > 0 && item.spent >= item.budget * .8).sort((a,b) => b.spent/b.budget-a.spent/a.budget)[0];
  const averageTransaction = current.length ? total / current.length : 0;
  const unusual = [...current].sort((a, b) => Math.abs(b.amount) - Math.abs(a.amount)).find((item) => averageTransaction > 0 && Math.abs(item.amount) >= averageTransaction * 3);
  const monthlySummary = before ? (total > before ? <>Neste mês, você gastou {money(total - before)} a mais que no anterior. A maior concentração está em {concentrationEntry?.category ?? "suas categorias principais"}.</> : <>Neste mês, você gastou {money(before - total)} a menos que no anterior. A maior concentração está em {concentrationEntry?.category ?? "suas categorias principais"}.</>) : <>Foram analisadas {current.length} saídas em {monthLabel(currentMonth)}. Importe mais um mês para comparar a evolução.</>;

  return <section className="smart-insights"><div className="card-title"><div><p className="eyebrow">ANÁLISE INTELIGENTE</p><h3>Alertas e oportunidades</h3></div><span>{currentMonth ? monthLabel(currentMonth) : "Histórico"}</span></div><div className="insight-settings"><label>Meta de gastos mensais<input type="number" min="0" value={monthlyGoal || ""} placeholder="Ex.: 5000" onChange={(event)=>setMonthlyGoal(Number(event.target.value))}/></label><label>Limite do cartão<input type="number" min="0" value={cardLimit || ""} placeholder="Ex.: 10000" onChange={(event)=>setCardLimit(Number(event.target.value))}/></label></div><div className="insight-list"><article className="monthly-summary"><span>✧</span><div><p className="eyebrow">RESUMO AUTOMÁTICO</p><h3>O que mudou neste mês</h3><p>{monthlySummary}</p></div></article>{unusual && <button type="button" className="alert clickable-insight" onClick={() => onShowCategory(unusual.category)}><span>!</span><div><p className="eyebrow">GASTO FORA DO PADRÃO</p><h3>{unusual.description}</h3><p>{money(Math.abs(unusual.amount))}, cerca de {Math.round(Math.abs(unusual.amount) / averageTransaction)}× o valor médio por lançamento. Ver detalhes →</p></div></button>}{before>0 && <article className={change>0?"alert":"opportunity"}><span>{change>0?"↑":"↓"}</span><div><p className="eyebrow">COMPARAÇÃO MENSAL</p><h3>{change>0?`${change}% acima`:`${Math.abs(change)}% abaixo`} do mês anterior</h3><p>{money(total)} neste mês, contra {money(before)} no anterior.</p></div></article>}{rising && <article className="alert"><span>↗</span><div><p className="eyebrow">CATEGORIA EM ALTA</p><h3>{rising.category} cresceu {Math.round((rising.now/rising.before-1)*100)}%</h3><p>Foi de {money(rising.before)} para {money(rising.now)} em relação ao mês anterior.</p></div></article>}{concentration>=40 && concentrationEntry && <button type="button" className="alert clickable-insight" onClick={() => onShowCategory(concentrationEntry.category)}><span>◉</span><div><p className="eyebrow">CONCENTRAÇÃO</p><h3>{concentration}% dos gastos em {concentrationEntry.category}</h3><p>Uma categoria concentra boa parte do período. Clique para ver os lançamentos →</p></div></button>}{forecast>0 && <article><span>⌁</span><div><p className="eyebrow">PREVISÃO DE FECHAMENTO</p><h3>{money(forecast)} estimados para o fim do mês</h3><p>Estimativa baseada no ritmo dos gastos já lançados neste mês.</p></div></article>}{budgetAlert && <article className={budgetAlert.spent >= budgetAlert.budget ? "alert" : "opportunity"}><span>◒</span><div><p className="eyebrow">ORÇAMENTO POR CATEGORIA</p><h3>{budgetAlert.category}: {Math.round(budgetAlert.spent/budgetAlert.budget*100)}% do limite usado</h3><p>{money(budgetAlert.spent)} de {money(budgetAlert.budget)}. {budgetAlert.spent>=budgetAlert.budget?"O orçamento foi ultrapassado.":"Você está perto do teto definido."}</p></div></article>}{monthlyGoal>0 && <article className={goalGap?"alert":"opportunity"}><span>◎</span><div><p className="eyebrow">META DE GASTOS</p><h3>{goalGap? `${money(goalGap)} acima da meta`:"Meta mantida neste período"}</h3><p>Teto: {money(monthlyGoal)}. Gastos flexíveis: {money(flexible)}.</p></div></article>}{cardLimit>0 && <article className={limitPercent>=90?"alert":"opportunity"}><span>▣</span><div><p className="eyebrow">FATURA DO CARTÃO</p><h3>{limitPercent}% do limite utilizado</h3><p>{money(invoiceTotal)} de {money(cardLimit)}. {limitPercent>=70?"Acompanhe novas compras.":"Há margem confortável."}</p></div></article>}{recurring.length>0 && <article><span>↻</span><div><p className="eyebrow">GASTOS RECORRENTES</p><h3>{recurring.map((item)=>item.name).join(" · ")}</h3><p>Estes estabelecimentos aparecem em pelo menos dois meses. Revise serviços que não usa.</p></div></article>}{duplicates>0 && <article className="alert"><span>!</span><div><p className="eyebrow">POSSÍVEL COBRANÇA REPETIDA</p><h3>{duplicates} grupo(s) com valor, data e descrição iguais</h3><p>Confira antes de contestar: pode ser uma parcela ou lançamento legítimo.</p></div></article>}<article className="top-spending"><span>★</span><div><p className="eyebrow">MAIORES GASTOS ACUMULADOS</p><h3>Veja os lançamentos que mais pesaram</h3>{top.length ? <div className="top-spending-list">{top.map((item) => <button key={merchantKey(item.name)} onClick={() => onShowMerchant(merchantKey(item.name))}><span>{item.name}</span><b>{money(item.total)}</b><small>Ver lançamentos →</small></button>)}</div> : <p>Ainda não há dados suficientes.</p>}<p className="top-spending-note">Clique em um item para ver o detalhamento.</p></div></article><button type="button" className="opportunity clickable-insight" onClick={onShowFlexible}><span>✦</span><div><p className="eyebrow">OPORTUNIDADE DE ECONOMIA</p><h3>{money(flexible)} em gastos flexíveis</h3><p>Compras, alimentação, abastecimento, pedágios e assinaturas são a parcela mais ajustável. <b>Ver lançamentos →</b></p></div></button></div></section>;
}

function TransactionList({ items, title, action, onReview, onClearCategory }: { items: ParsedTransaction[]; title: string; action?: () => void; onReview?: (item: ParsedTransaction, patch: Pick<ParsedTransaction, "description" | "category">) => void; onClearCategory?: () => void }) {
  const [sortBy, setSortBy] = useState<"date" | "amount">("date");
  const [editingCategory, setEditingCategory] = useState<string | null>(null);
  const uncertain = items.filter((item) => item.category === "Outros" || item.confidence !== "alta").length;
  const sortedItems = [...items].sort((a, b) => sortBy === "date" ? b.date.localeCompare(a.date) : Math.abs(b.amount) - Math.abs(a.amount));
  return <article className="transactions-card full"><div className="card-title"><div><p className="eyebrow">MOVIMENTAÇÕES</p><h3>{title}</h3>{onReview && uncertain > 0 && <small className="review-count">{uncertain} movimento(s) para revisar</small>}{onClearCategory && <button className="clear-category" onClick={onClearCategory}>× Limpar filtro</button>}</div><div className="transaction-tools"><button className={sortBy === "date" ? "selected" : ""} onClick={() => setSortBy("date")}>Ordenar por data</button><button className={sortBy === "amount" ? "selected" : ""} onClick={() => setSortBy("amount")}>Maior valor</button>{action && <button onClick={action}>Ver todas</button>}</div></div>{sortedItems.length ? sortedItems.map((item) => { const displayCategory = CATEGORY_NAMES.includes(item.category) ? item.category : "Outros"; const review = Boolean(onReview && (displayCategory === "Outros" || item.confidence !== "alta")); return <div className={`transaction ${review ? "needs-review" : ""}`} key={`${item.documentHash ?? "local"}-${item.id}`}><span className="merchant">{item.description[0]?.toUpperCase() ?? "?"}</span><div>{review ? <><input aria-label={`Descrição de ${item.description}`} defaultValue={item.description} onBlur={(event) => { const description = event.currentTarget.value.trim() || item.description; onReview?.(item, { description, category: categorizeTransaction(description, item.amount) }); }} /><select aria-label={`Categoria de ${item.description}`} value={displayCategory} onChange={(event) => onReview?.(item, { description: item.description, category: event.target.value as Category })}>{CATEGORY_NAMES.map((category) => <option key={category}>{category}</option>)}</select><small>Revise a descrição ou selecione a categoria correta.</small></> : <><b>{item.description}</b><small>{displayCategory} · {shortDate(item.date)} · {item.source === "invoice" ? "Fatura" : "Extrato"}</small>{onReview && (editingCategory === item.id ? <span className="category-editor"><select aria-label={`Nova categoria de ${item.description}`} value={item.category} onChange={(event) => { onReview(item, { description: item.description, category: event.target.value as Category }); setEditingCategory(null); }}>{CATEGORY_NAMES.map((category) => <option key={category}>{category}</option>)}</select><button type="button" onClick={() => setEditingCategory(null)}>Cancelar</button></span> : <button type="button" className="change-category" onClick={() => setEditingCategory(item.id)}>Alterar categoria</button>)}</>}</div><strong className={item.amount > 0 ? "income" : ""}>{money(item.amount)}</strong></div>; }) : <p className="empty-state">Nenhuma transação neste período.</p>}</article>;
}

