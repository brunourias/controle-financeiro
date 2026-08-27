import * as pdfjs from "pdfjs-dist";

pdfjs.GlobalWorkerOptions.workerSrc = new URL(
  "pdfjs-dist/build/pdf.worker.min.mjs",
  import.meta.url,
).toString();

export type DocumentKind = "invoice" | "statement";
export type Category = "Alimentação" | "Moradia" | "Sem Parar" | "Abastecimento" | "Assinaturas" | "Saúde" | "Compras" | "PIX recebido" | "PIX enviado" | "Transferência recebida" | "Transferência enviada" | "Boleto" | "Plano celular" | "Renda" | "Outros";

export type ParsedTransaction = {
  id: string;
  date: string;
  description: string;
  amount: number;
  category: Category;
  source: DocumentKind;
  confidence: "alta" | "média";
  raw: string;
  month?: string;
  documentHash?: string;
  documentName?: string;
};

export type ParseResult = {
  transactions: ParsedTransaction[];
  pageCount: number;
  lineCount: number;
  warnings: string[];
  month: string;
  // The invoice cover is Santander's authoritative amount due. It is kept
  // separate from purchase rows, which are used only for categorisation.
  declaredTotal?: number;
};

type PositionedText = { str: string; x: number; y: number };

const MONTHS: Record<string, number> = {
  jan: 1, fev: 2, mar: 3, abr: 4, mai: 5, jun: 6,
  jul: 7, ago: 8, set: 9, out: 10, nov: 11, dez: 12,
};

const SKIP_INVOICE = /(?:total da fatura|pagamento m[ií]nimo|pagamento de fatura|limite dispon[ií]vel|melhor data|saldo anterior|encargos|anuidade|resumo da fatura|vencimento|ft-ci|central cob|nosso n[uú]mero|c[oó]digo de barras)/i;
const SKIP_STATEMENT = /(?:saldo (?:do dia|anterior|dispon[ií]vel|em conta)|resumo|ag[eê]ncia|conta corrente|extrato emitido)/i;

function normalize(value: string) {
  return value.replace(/\u00a0/g, " ").replace(/\s+/g, " ").trim();
}

function parseMoney(value: string): number | null {
  const cleaned = value.replace(/R\$\s?/gi, "").replace(/\s/g, "").replace(/\./g, "").replace(",", ".");
  const number = Number(cleaned.replace(/[DC-]$/i, ""));
  if (!Number.isFinite(number)) return null;
  const debit = /[D-]$/i.test(value) || /^-/.test(cleaned);
  return debit ? -Math.abs(number) : number;
}

function isoDate(day: number, month: number, year?: number) {
  const now = new Date();
  let resolvedYear = year ?? now.getFullYear();
  if (!year && month > now.getMonth() + 2) resolvedYear -= 1;
  return `${resolvedYear}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

function extractDate(line: string): { date: string; rest: string } | null {
  const numeric = line.match(/^\s*(\d{1,2})[\/.-](\d{1,2})(?:[\/.-](\d{2,4}))?\s+(.+)$/);
  if (numeric) {
    const year = numeric[3] ? Number(numeric[3].length === 2 ? `20${numeric[3]}` : numeric[3]) : undefined;
    return { date: isoDate(Number(numeric[1]), Number(numeric[2]), year), rest: numeric[4] };
  }
  const named = line.match(/^\s*(\d{1,2})\s+(jan|fev|mar|abr|mai|jun|jul|ago|set|out|nov|dez)[a-zç]*\s+(.+)$/i);
  if (named) return { date: isoDate(Number(named[1]), MONTHS[named[2].slice(0, 3).toLowerCase()]), rest: named[3] };
  return null;
}

export function categorize(description: string): Category {
  const text = description.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9]+/g, " ").replace(/\s+/g, " ").trim();
  // Regras observadas nos extratos e faturas Santander.
  if (/liquido de vencimento|salario|folha de pagamento/.test(text)) return "Renda";
  if (/pagamento de boleto/.test(text)) return "Boleto";
  if (/pix recebido/.test(text)) return "PIX recebido";
  if (/pix enviado/.test(text)) return "PIX enviado";
  if (/transferencia recebida|ted recebido|transfer recebido/.test(text)) return "Transferência recebida";
  if (/transferencia enviada|ted enviado|transfer enviado|pagamento de fatura|saque dinheiro|tributos municipais/.test(text)) return "Transferência enviada";
  if (/sem parar|conectcar|velo e|tag de pedagio|pedagio/.test(text)) return "Sem Parar";
  if (/abastece|posto|combust/.test(text)) return "Abastecimento";
  if (/uber|taxi|estacion|metro|onibus|estapar|blu gestao/.test(text)) return "Outros";
  if (/tim pos|tim controle|tim pre|claro pos|vivo pos|oi pos/.test(text)) return "Plano celular";
  if (/mercado livre|mercadolivre/.test(text)) return "Compras";
  if (/mercado|supermerc|atacad|padaria|restaur|lanch|ifood|delivery|hamburg|pizza|cafe|acougue|alimentacao|dom burger|kfc|blenz|nugali/.test(text)) return "Alimentação";
  if (/aluguel|condominio|energia|eletric|agua|esgoto|gas|internet|telefone|imovel|credito imobiliario|cabo|tim pos/.test(text)) return "Moradia";
  if (/netflix|spotify|amazon prime|amazonprime|disney|hbo|youtube|icloud|google one|tinder|roblox|hotmart|skyfit|academia|assinatura/.test(text)) return "Assinaturas";
  if (/farmacia|drog|hospital|clinica|laborat|medic|odonto|saude|rdsaude/.test(text)) return "Saúde";
  if (/mercado livre|mercadolivre|shopee|havan|casas bahia|leroy merlin|autozone|benetton|amazon|wallifer|bahia techmix/.test(text)) return "Compras";
  return "Outros";
}

export function categorizeTransaction(description: string, amount: number): Category {
  if (/\bpix\b/i.test(description)) return amount > 0 ? "PIX recebido" : "PIX enviado";
  return categorize(description);
}

function signedAmount(kind: DocumentKind, description: string, rawAmount: string, parsed: number) {
  if (kind === "invoice") return -Math.abs(parsed);
  if (/[DC-]$/i.test(rawAmount) || /^-/.test(rawAmount.trim())) return parsed;
  const credit = /recebid|cr[eé]dito|dep[oó]sito|sal[aá]rio|l[ií]quido de vencimento|estorno|resgate|rendimento/i.test(description);
  return credit ? Math.abs(parsed) : -Math.abs(parsed);
}

function transactionFromLine(line: string, kind: DocumentKind, index: number): ParsedTransaction | null {
  const dated = extractDate(line);
  if (!dated) return null;
  // Santander renders invoice columns on the same extracted text row. Totals such
  // as "Total de pagamentos" can be appended after a genuine purchase amount.
  const rest = kind === "invoice"
    ? dated.rest.split(/\b(?:total de pagamentos|total de compras|total de lan[cç]amentos|total a pagar)\b/i)[0]
    : dated.rest;
  if ((kind === "invoice" ? SKIP_INVOICE : SKIP_STATEMENT).test(rest)) return null;
  // Full dates on Santander invoices belong to boleto/document metadata, not purchases.
  if (kind === "invoice" && /^\s*\d{1,2}[\/.-]\d{1,2}[\/.-]\d{2,4}/.test(line)) return null;
  const moneyPattern = /(?:R\$\s*)?(-?\d{1,3}(?:\.\d{3})*,\d{2}|-?\d+,\d{2})\s*([DC-])?/gi;
  const matches = Array.from(rest.matchAll(moneyPattern));
  // Statement rows end with the running account balance. The first monetary
  // value is the transaction amount; invoice rows use their final amount.
  const amountMatch = kind === "statement" ? matches[0] : matches.at(-1);
  if (!amountMatch || amountMatch.index === undefined) return null;
  const description = normalize(rest.slice(0, amountMatch.index).replace(/\s+\d{2}\/\d{2}\s*$/, ""));
  if (description.length < 2) return null;
  const rawAmount = `${amountMatch[1]}${amountMatch[2] ?? ""}`;
  const parsed = parseMoney(rawAmount);
  if (parsed === null || Math.abs(parsed) > 100_000_000) return null;
  return {
    id: `${kind}-${index}-${dated.date}-${Math.abs(parsed)}`,
    date: dated.date,
    description,
    amount: signedAmount(kind, description, rawAmount, parsed),
    category: categorizeTransaction(description, signedAmount(kind, description, rawAmount, parsed)),
    source: kind,
    confidence: amountMatch[2] || /^\d{1,2}[\/.-]\d{1,2}/.test(line) ? "alta" : "média",
    raw: line,
  };
}

function itemsToLines(items: PositionedText[]) {
  const rows: Array<{ y: number; items: PositionedText[] }> = [];
  for (const item of items.filter((item) => normalize(item.str))) {
    let row = rows.find((candidate) => Math.abs(candidate.y - item.y) <= 2.5);
    if (!row) { row = { y: item.y, items: [] }; rows.push(row); }
    row.items.push(item);
  }
  return rows
    .sort((a, b) => b.y - a.y)
    .map((row) => normalize(row.items.sort((a, b) => a.x - b.x).map((item) => item.str).join(" ")))
    .filter(Boolean);
}

export async function parseSantanderPdf(file: File, kind: DocumentKind): Promise<ParseResult> {
  const data = new Uint8Array(await file.arrayBuffer());
  const task = pdfjs.getDocument({ data, useWorkerFetch: true });
  let document;
  try {
    document = await task.promise;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/password/i.test(message)) throw new Error("O PDF está protegido por senha. Salve uma cópia desbloqueada e tente novamente.");
    throw new Error("Não foi possível abrir este PDF. Confirme se o arquivo não está corrompido.");
  }

  const allLines: string[] = [];
  const invoiceHeaderLines: string[] = [];
  for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber += 1) {
    const page = await document.getPage(pageNumber);
    const content = await page.getTextContent();
    const items = content.items.flatMap((item) => {
      if (!("str" in item) || !("transform" in item)) return [];
      return [{ str: item.str, x: item.transform[4], y: item.transform[5] }];
    });
    // The first page of Santander invoices is a billing summary and boleto.
    // Purchases start on the following pages; parsing it creates false expenses.
    const pageLines = itemsToLines(items);
    if (kind === "invoice" && pageNumber === 1) { invoiceHeaderLines.push(...pageLines); continue; }
    allLines.push(...pageLines);
  }

  if (allLines.length < 5) {
    throw new Error("Este PDF parece ser uma imagem digitalizada. Exporte o documento diretamente pelo app Santander, em vez de fotografá-lo.");
  }

  const transactions = allLines
    .map((line, index) => transactionFromLine(line, kind, index))
    .filter((item): item is ParsedTransaction => Boolean(item));
  const unique = Array.from(new Map(transactions.map((item) => [`${item.source}|${item.date}|${item.description}|${item.amount}`, item])).values());
  const warnings: string[] = [];
  if (!unique.length) warnings.push("Nenhuma movimentação reconhecida. O layout deste PDF pode ser diferente do padrão esperado.");
  if (unique.length && unique.length < 3) warnings.push("Poucas movimentações foram reconhecidas; revise os resultados antes de continuar.");
  // On Santander invoices the due date is often on a different text row from
  // its label. The invoice belongs to the month that closed before that date.
  const dueDate = (kind === "invoice" ? invoiceHeaderLines : allLines).join(" ").match(/vencimento[\s\S]{0,120}?(\d{1,2})[\/.-](\d{1,2})[\/.-](\d{2,4})/i);
  const filenameDate = file.name.match(/(?:^|\D)(20\d{2})[-_. ]?(0[1-9]|1[0-2])(?:\D|$)/) ?? file.name.match(/(?:^|\D)(0[1-9]|1[0-2])[-_. ]?(20\d{2})(?:\D|$)/);
  const transactionMonths = unique.map((item) => item.date.slice(0, 7));
  const mostCommonMonth = Array.from(new Set(transactionMonths)).sort((a, b) => transactionMonths.filter((month) => month === b).length - transactionMonths.filter((month) => month === a).length)[0];
  let month = mostCommonMonth ?? new Date().toISOString().slice(0, 7);
  if (kind === "invoice" && dueDate) {
    const year = Number(dueDate[3].length === 2 ? `20${dueDate[3]}` : dueDate[3]);
    const dueMonth = Number(dueDate[2]);
    // The dashboard uses the billing/payment month shown by Santander, not
    // the purchase-cycle closing month. A bill due on 01/07 belongs to July.
    month = `${year}-${String(dueMonth).padStart(2, "0")}`;
  } else if (filenameDate) {
    month = filenameDate[1].length === 4 ? `${filenameDate[1]}-${filenameDate[2]}` : `${filenameDate[2]}-${filenameDate[1]}`;
  }
  const invoiceHeader = invoiceHeaderLines.join(" ");
  // PDF.js can insert column labels between “Pagamento Total” and the amount.
  // Accept that layout while keeping the first amount after this label.
  const declaredMatch = invoiceHeader.match(/pagamento\\s+total[\\s\\S]{0,180}?R\\$\\s*([\\d.]+,\\d{2})/i)
    ?? invoiceHeader.match(/total\\s+a\\s+pagar[\\s\\S]{0,180}?R\\$\\s*([\\d.]+,\\d{2})/i);
  const declaredTotal = kind === "invoice" ? parseMoney(declaredMatch?.[1] ?? "") ?? undefined : undefined;
  if (kind === "invoice" && !declaredTotal) warnings.push("Não foi possível conferir o valor total declarado na capa da fatura.");
  return { transactions: unique.map((item) => ({ ...item, month })), pageCount: document.numPages, lineCount: allLines.length, warnings, month, declaredTotal };
}

