"use client";

import { useEffect, useMemo, useRef, useState } from "react";

type FileKind = "invoice" | "statement";

const categories = [
  { name: "Alimentação", value: 31, color: "#073b72" },
  { name: "Moradia", value: 24, color: "#179765" },
  { name: "Transporte", value: 16, color: "#ff675d" },
  { name: "Assinaturas", value: 9, color: "#7654c8" },
  { name: "Outros", value: 20, color: "#9aa5b1" },
];

const transactions = [
  ["Supermercado Vila", "Alimentação", "12 ago", "R$ 386,42"],
  ["Restaurante Manjericão", "Alimentação", "11 ago", "R$ 148,90"],
  ["Auto Posto Central", "Transporte", "09 ago", "R$ 250,00"],
  ["Streaming Plus", "Assinaturas", "08 ago", "R$ 39,90"],
];

function UploadCard({
  kind,
  title,
  file,
  onFile,
}: {
  kind: FileKind;
  title: string;
  file?: File;
  onFile: (kind: FileKind, file?: File) => void;
}) {
  const input = useRef<HTMLInputElement>(null);
  return (
    <div className={`upload-card ${file ? "is-ready" : ""}`}>
      <button className="upload-main" onClick={() => input.current?.click()} type="button">
        <span className="pdf-icon">PDF</span>
        <span>
          <strong>{title}</strong>
          <small>{file?.name ?? "Selecione um arquivo PDF"}</small>
        </span>
        <span className="upload-status">{file ? "✓" : "+"}</span>
      </button>
      <input
        ref={input}
        hidden
        type="file"
        accept="application/pdf,.pdf"
        aria-label={`Importar ${title}`}
        onChange={(event) => onFile(kind, event.target.files?.[0])}
      />
    </div>
  );
}

export default function Home() {
  const [files, setFiles] = useState<Partial<Record<FileKind, File>>>({});
  const [view, setView] = useState<"upload" | "dashboard">("upload");
  const [tab, setTab] = useState<"overview" | "transactions" | "insights">("overview");
  const ready = Boolean(files.invoice && files.statement);
  useEffect(() => {
    if ("serviceWorker" in navigator) {
      navigator.serviceWorker.register(`${import.meta.env.BASE_URL}sw.js`).catch(() => undefined);
    }
  }, []);
  const donut = useMemo(
    () => `conic-gradient(${categories.map((c, i) => `${c.color} ${categories.slice(0, i).reduce((a, b) => a + b.value, 0)}% ${categories.slice(0, i + 1).reduce((a, b) => a + b.value, 0)}%`).join(",")})`,
    [],
  );

  const onFile = (kind: FileKind, file?: File) => {
    if (file && file.type !== "application/pdf" && !file.name.toLowerCase().endsWith(".pdf")) return;
    setFiles((current) => ({ ...current, [kind]: file }));
  };

  if (view === "upload") {
    return (
      <main className="upload-page">
        <section className="brand-panel">
          <div className="brand"><span>f</span> fluxo</div>
          <div className="brand-copy">
            <p className="eyebrow">Seu dinheiro, mais claro</p>
            <h1>Entenda seus gastos.<br />Poupe com intenção.</h1>
            <p>Transforme sua fatura e seu extrato em uma visão simples do seu mês — sem planilhas.</p>
          </div>
          <div className="security-pill">🔒 Seus documentos ficam neste dispositivo</div>
        </section>
        <section className="import-panel">
          <div className="mobile-brand"><span>f</span> fluxo</div>
          <div className="step">ETAPA 1 DE 2</div>
          <h2>Olá, Bruno 👋</h2>
          <p className="lead">Importe os documentos de agosto para prepararmos sua análise.</p>
          <div className="uploads">
            <UploadCard kind="invoice" title="Fatura do cartão" file={files.invoice} onFile={onFile} />
            <UploadCard kind="statement" title="Extrato bancário" file={files.statement} onFile={onFile} />
          </div>
          <div className="privacy-note"><span>✓</span><p><strong>Processamento privado</strong><br />Nesta primeira versão, seus arquivos não são enviados ao banco nem armazenados na nuvem.</p></div>
          <button className="primary" disabled={!ready} onClick={() => setView("dashboard")}>
            {ready ? "Analisar meus gastos →" : "Importe os dois documentos"}
          </button>
          <button className="demo" onClick={() => setView("dashboard")}>Explorar com dados de demonstração</button>
        </section>
      </main>
    );
  }

  return (
    <main className="app-shell">
      <aside className="sidebar">
        <div className="brand"><span>f</span> fluxo</div>
        <nav>
          <button className={tab === "overview" ? "active" : ""} onClick={() => setTab("overview")}>⌂ <span>Visão geral</span></button>
          <button className={tab === "transactions" ? "active" : ""} onClick={() => setTab("transactions")}>↕ <span>Transações</span></button>
          <button className={tab === "insights" ? "active" : ""} onClick={() => setTab("insights")}>✦ <span>Insights</span><b>3</b></button>
        </nav>
        <button className="new-import" onClick={() => setView("upload")}>＋ Nova importação</button>
      </aside>
      <section className="content">
        <header><div><p className="eyebrow">AGOSTO DE 2026</p><h2>{tab === "overview" ? "Visão geral" : tab === "transactions" ? "Transações" : "Seus insights"}</h2></div><div className="avatar">BR</div></header>
        {tab === "overview" && <>
          <div className="summary-grid">
            <article className="hero-card"><p>Gastos do mês</p><strong>R$ 6.840,00</strong><span className="trend up">↑ 12% em relação a julho</span><div className="spark"><i/><i/><i/><i/><i/><i/><i/><i/></div></article>
            <article><p>Fatura do cartão</p><strong>R$ 4.920,00</strong><span>vence em 9 dias</span><div className="progress"><i style={{width:"72%"}} /></div></article>
            <article><p>Saídas da conta</p><strong>R$ 1.920,00</strong><span>débitos, Pix e boletos</span><div className="progress green"><i style={{width:"38%"}} /></div></article>
          </div>
          <div className="dashboard-grid">
            <article className="category-card"><div className="card-title"><div><p className="eyebrow">DISTRIBUIÇÃO</p><h3>Onde você mais gastou</h3></div><button>Detalhes</button></div><div className="category-body"><div className="donut" style={{background:donut}}><span><b>R$ 6.840</b><small>total</small></span></div><div className="legend">{categories.map(c=><div key={c.name}><i style={{background:c.color}}/><span>{c.name}</span><b>{c.value}%</b></div>)}</div></div></article>
            <article className="saving-card"><span className="bulb">✦</span><p className="eyebrow">OPORTUNIDADE DO MÊS</p><h3>Você pode economizar <em>R$ 620</em></h3><p>Pequenos ajustes em restaurantes e assinaturas podem liberar esse valor.</p><button onClick={() => setTab("insights")}>Ver recomendações →</button></article>
          </div>
          <article className="transactions-card"><div className="card-title"><div><p className="eyebrow">MOVIMENTAÇÕES</p><h3>Últimas transações</h3></div><button onClick={() => setTab("transactions")}>Ver todas</button></div>{transactions.slice(0,3).map((t)=><div className="transaction" key={t[0]}><span className="merchant">{t[0][0]}</span><div><b>{t[0]}</b><small>{t[1]} · {t[2]}</small></div><strong>{t[3]}</strong></div>)}</article>
        </>}
        {tab === "transactions" && <article className="transactions-card full"><div className="card-title"><div><p className="eyebrow">AGOSTO</p><h3>Transações identificadas</h3></div><button>Filtrar</button></div>{transactions.map((t)=><div className="transaction" key={t[0]}><span className="merchant">{t[0][0]}</span><div><b>{t[0]}</b><small>{t[1]} · {t[2]}</small></div><strong>{t[3]}</strong></div>)}</article>}
        {tab === "insights" && <div className="insight-list"><article className="alert"><span>↑</span><div><p className="eyebrow">ATENÇÃO</p><h3>Restaurantes subiram 28%</h3><p>Foram R$ 310 a mais do que no mês passado.</p></div></article><article><span>↻</span><div><p className="eyebrow">RECORRÊNCIAS</p><h3>3 assinaturas encontradas</h3><p>Uma delas não teve uso aparente nos últimos meses.</p></div></article><article className="opportunity"><span>✦</span><div><p className="eyebrow">OPORTUNIDADE</p><h3>Economize cerca de R$ 240/mês</h3><p>Reduzindo delivery em dois pedidos por semana.</p><button>Criar meta →</button></div></article></div>}
        <p className="prototype-note">Prévia com dados de demonstração. A leitura automática do conteúdo dos PDFs será conectada na próxima etapa.</p>
      </section>
    </main>
  );
}
