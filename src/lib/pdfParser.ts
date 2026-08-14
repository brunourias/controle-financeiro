import * as pdfjs from "pdfjs-dist";

pdfjs.GlobalWorkerOptions.workerSrc = new URL(
  "pdfjs-dist/build/pdf.worker.min.mjs",
  import.meta.url,
).toString();

export type DocumentKind = "invoice" | "statement";
export type Category = "Alimentação" | "Moradia" | "Transporte" | "Assinaturas" | "Saúde" | "Compras" | "Transferências" | "Outros";

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
};

type PositionedText = { str: string; x: number; y: number };

const MONTHS: Record<string, number> = {
  jan: 1, fev: 2, mar: 3, abr: 4, mai: 5, jun: 6,
  jul: 7, ago: 8, set: 9, out: 10, nov: 11, dez: 12,
};

const SKIP_INVOICE = /(?:total da fatura|pagamento m[ií]nimo|limite dispon[ií]vel|melhor data|saldo anterior|encargos|anuidade|resumo da fatura|vencimento)/i;
const SKIP_STATEMENT = /(?:saldo (?:do dia|anterior|dispon[ií]vel|em conta)|resumo|ag[eê]ncia|conta corrente|extrato emitido)/i;

function normalize(value: string) {
  return value.replace(/\u00a0/g, " ").replace(/\s+/g, " ").trim();
}

function parseMoney(value: string): number | null {
  const cleaned = value.replace(/R\$\s?/gi, "").replace(/\s/g, "").replace(/\./g, "").replace(",", ".");
  const number = Number(cleaned.replace(/[DC]$/i, ""));
  if (!Number.isFinite(number)) return null;
  const debit = /D$/i.test(value) || /^-/.test(cleaned);
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
  const text = description.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
  if (/mercado|supermerc|atacad|padaria|restaur|lanch|ifood|delivery|hamburg|pizza|cafe|acougue/.test(text)) return "Alimentação";
  if (/aluguel|condominio|energia|eletric|agua|gas|internet|telefone|imovel/.test(text)) return "Moradia";
  if (/uber|99 |taxi|posto|combust|estacion|pedagio|metro|onibus|sem parar/.test(text)) return "Transporte";
  if (/netflix|spotify|amazon prime|disney|hbo|youtube|icloud|google one|assinatura/.test(text)) return "Assinaturas";
  if (/farmacia|drog|hospital|clinica|laborat|medic|odonto|saude/.test(text)) return "Saúde";
  if (/pix|ted|doc |transfer/.test(text)) return "Transferências";
  if (/loja|shopping|magazine|amazon|mercado livre|shopee|roupa|calcado/.test(text)) return "Compras";
  return "Outros";
}

function signedAmount(kind: DocumentKind, description: string, rawAmount: string, parsed: number) {
  if (kind === "invoice") return -Math.abs(parsed);
  if (/[DC]$/i.test(rawAmount) || /^-/.test(rawAmount.trim())) return parsed;
  const credit = /recebid|cr[eé]dito|dep[oó]sito|sal[aá]rio|estorno|resgate|rendimento/i.test(description);
  return credit ? Math.abs(parsed) : -Math.abs(parsed);
}

function transactionFromLine(line: string, kind: DocumentKind, index: number): ParsedTransaction | null {
  const dated = extractDate(line);
  if (!dated) return null;
  if ((kind === "invoice" ? SKIP_INVOICE : SKIP_STATEMENT).test(dated.rest)) return null;
  const amountMatch = dated.rest.match(/(?:R\$\s*)?(-?\d{1,3}(?:\.\d{3})*,\d{2}|-?\d+,\d{2})\s*([DC])?\s*$/i);
  if (!amountMatch || amountMatch.index === undefined) return null;
  const description = normalize(dated.rest.slice(0, amountMatch.index).replace(/\s+\d{2}\/\d{2}\s*$/, ""));
  if (description.length < 2) return null;
  const rawAmount = `${amountMatch[1]}${amountMatch[2] ?? ""}`;
  const parsed = parseMoney(rawAmount);
  if (parsed === null || Math.abs(parsed) > 100_000_000) return null;
  return {
    id: `${kind}-${index}-${dated.date}-${Math.abs(parsed)}`,
    date: dated.date,
    description,
    amount: signedAmount(kind, description, rawAmount, parsed),
    category: categorize(description),
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
  for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber += 1) {
    const page = await document.getPage(pageNumber);
    const content = await page.getTextContent();
    const items = content.items.flatMap((item) => {
      if (!("str" in item) || !("transform" in item)) return [];
      return [{ str: item.str, x: item.transform[4], y: item.transform[5] }];
    });
    allLines.push(...itemsToLines(items));
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
  const dueDate = allLines.map((line) => line.match(/vencimento\D{0,20}(\d{1,2})[\/.-](\d{1,2})[\/.-](\d{2,4})/i)).find(Boolean);
  const filenameDate = file.name.match(/(?:^|\D)(20\d{2})[-_. ]?(0[1-9]|1[0-2])(?:\D|$)/) ?? file.name.match(/(?:^|\D)(0[1-9]|1[0-2])[-_. ]?(20\d{2})(?:\D|$)/);
  const transactionMonths = unique.map((item) => item.date.slice(0, 7));
  const mostCommonMonth = Array.from(new Set(transactionMonths)).sort((a, b) => transactionMonths.filter((month) => month === b).length - transactionMonths.filter((month) => month === a).length)[0];
  let month = mostCommonMonth ?? new Date().toISOString().slice(0, 7);
  if (kind === "invoice" && dueDate) {
    const year = dueDate[3].length === 2 ? `20${dueDate[3]}` : dueDate[3];
    month = `${year}-${dueDate[2].padStart(2, "0")}`;
  } else if (filenameDate) {
    month = filenameDate[1].length === 4 ? `${filenameDate[1]}-${filenameDate[2]}` : `${filenameDate[2]}-${filenameDate[1]}`;
  }
  return { transactions: unique.map((item) => ({ ...item, month })), pageCount: document.numPages, lineCount: allLines.length, warnings, month };
}
