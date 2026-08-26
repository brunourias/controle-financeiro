import { getApps, initializeApp } from "firebase/app";
import { getAuth, GoogleAuthProvider, onAuthStateChanged, signInWithPopup, signOut, type User } from "firebase/auth";
import { collection, doc, getDoc, getDocs, getFirestore, serverTimestamp, updateDoc, writeBatch } from "firebase/firestore";
import { categorize, type DocumentKind, type ParsedTransaction } from "./pdfParser";

const config = {
  apiKey: import.meta.env.VITE_FIREBASE_API_KEY,
  authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN,
  projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID,
  storageBucket: import.meta.env.VITE_FIREBASE_STORAGE_BUCKET,
  messagingSenderId: import.meta.env.VITE_FIREBASE_MESSAGING_SENDER_ID,
  appId: import.meta.env.VITE_FIREBASE_APP_ID,
};

export const firebaseConfigured = Boolean(config.apiKey && config.authDomain && config.projectId && config.appId);
const app = firebaseConfigured ? (getApps()[0] ?? initializeApp(config)) : null;
const auth = app ? getAuth(app) : null;
const db = app ? getFirestore(app) : null;

export type CloudDocument = {
  hash: string;
  name: string;
  kind: DocumentKind;
  month: string;
  pageCount: number;
  transactionCount: number;
  invoiceMonthNormalized?: boolean;
};

export function observeUser(callback: (user: User | null) => void) {
  if (!auth) { callback(null); return () => undefined; }
  return onAuthStateChanged(auth, callback);
}

export async function loginWithGoogle() {
  if (!auth) throw new Error("Firebase ainda não foi configurado.");
  return signInWithPopup(auth, new GoogleAuthProvider());
}

export async function logoutFirebase() { if (auth) await signOut(auth); }

export async function hashFile(file: File) {
  const digest = await crypto.subtle.digest("SHA-256", await file.arrayBuffer());
  return Array.from(new Uint8Array(digest)).map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function documentExists(uid: string, hash: string) {
  if (!db) return false;
  return (await getDoc(doc(db, "users", uid, "documents", hash))).exists();
}

export async function loadFinancialHistory(uid: string) {
  if (!db) return { documents: [] as CloudDocument[], transactions: [] as ParsedTransaction[] };
  const [documentsSnapshot, transactionsSnapshot] = await Promise.all([
    getDocs(collection(db, "users", uid, "documents")),
    getDocs(collection(db, "users", uid, "transactions")),
  ]);
  return {
    documents: documentsSnapshot.docs.map((entry) => entry.data() as CloudDocument),
    transactions: transactionsSnapshot.docs.map((entry) => ({ ...entry.data(), id: entry.id }) as ParsedTransaction).sort((a, b) => b.date.localeCompare(a.date)),
  };
}

export async function normalizeSavedIncomeSigns(uid: string, transactions: ParsedTransaction[]) {
  if (!db) return transactions;
  const corrected = transactions.map((item) => /liquido de vencimento/i.test(item.description) && item.amount < 0 ? { ...item, amount: Math.abs(item.amount) } : item);
  const changed = corrected.filter((item, index) => item.amount !== transactions[index].amount);
  for (let offset = 0; offset < changed.length; offset += 400) {
    const batch = writeBatch(db);
    for (const item of changed.slice(offset, offset + 400)) batch.update(doc(db, "users", uid, "transactions", item.id), { amount: item.amount, correctedIncomeAt: serverTimestamp() });
    await batch.commit();
  }
  return corrected;
}

export async function normalizeSavedInvoiceMonths(uid: string, documents: CloudDocument[], transactions: ParsedTransaction[]) {
  if (!db) return { documents, transactions };
  const legacyInvoices = documents.filter((item) => item.kind === "invoice" && !item.invoiceMonthNormalized);
  if (!legacyInvoices.length) return { documents, transactions };
  const monthByHash = new Map(legacyInvoices.map((item) => {
    const date = new Date(`${item.month}-01T12:00:00`);
    date.setMonth(date.getMonth() - 1);
    return [item.hash, `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}`];
  }));
  const batch = writeBatch(db);
  for (const item of legacyInvoices) batch.update(doc(db, "users", uid, "documents", item.hash), { month: monthByHash.get(item.hash), invoiceMonthNormalized: true });
  const corrected = transactions.map((item) => monthByHash.has(item.documentHash ?? "") ? { ...item, month: monthByHash.get(item.documentHash ?? "")! } : item);
  for (const item of corrected.filter((item) => monthByHash.has(item.documentHash ?? ""))) batch.update(doc(db, "users", uid, "transactions", item.id), { month: item.month });
  await batch.commit();
  return { documents: documents.map((item) => monthByHash.has(item.hash) ? { ...item, month: monthByHash.get(item.hash)!, invoiceMonthNormalized: true } : item), transactions: corrected };
}

export async function reclassifyFinancialHistory(uid: string, transactions: ParsedTransaction[]) {
  if (!db) return { transactions, corrected: 0 };
  const correctedTransactions = transactions.map((item) => (item as ParsedTransaction & { manuallyReviewed?: boolean }).manuallyReviewed ? item : ({ ...item, category: categorize(item.description) }));
  const changed = correctedTransactions.filter((item, index) => item.category !== transactions[index].category);
  for (let offset = 0; offset < changed.length; offset += 400) {
    const batch = writeBatch(db);
    for (const item of changed.slice(offset, offset + 400)) {
      batch.update(doc(db, "users", uid, "transactions", item.id), { category: item.category, reclassifiedAt: serverTimestamp() });
    }
    await batch.commit();
  }
  return { transactions: correctedTransactions, corrected: changed.length };
}

export async function updateFinancialTransaction(uid: string, id: string, patch: Pick<ParsedTransaction, "description" | "category">) {
  if (!db) throw new Error("Firebase ainda não foi configurado.");
  await updateDoc(doc(db, "users", uid, "transactions", id), { ...patch, manuallyReviewed: true, manuallyReviewedAt: serverTimestamp() });
}

export async function updateMatchingFinancialTransactions(uid: string, ids: string[], patch: Pick<ParsedTransaction, "category">) {
  if (!db || !ids.length) return;
  for (let offset = 0; offset < ids.length; offset += 400) {
    const batch = writeBatch(db);
    for (const id of ids.slice(offset, offset + 400)) batch.update(doc(db, "users", uid, "transactions", id), { ...patch, manuallyReviewed: true, manuallyReviewedAt: serverTimestamp() });
    await batch.commit();
  }
}

export async function saveFinancialImport(uid: string, documents: CloudDocument[], transactions: ParsedTransaction[]) {
  if (!db) throw new Error("Firebase ainda não foi configurado.");
  // Reprocessing a PDF must replace its previous transactions, otherwise
  // corrections to the parser would leave old incorrect entries in the history.
  const replacing = new Set(documents.map((item) => item.hash));
  const existing = await getDocs(collection(db, "users", uid, "transactions"));
  const oldEntries = existing.docs.filter((entry) => replacing.has(String(entry.data().documentHash ?? "")));
  for (let offset = 0; offset < oldEntries.length; offset += 400) {
    const batch = writeBatch(db);
    for (const entry of oldEntries.slice(offset, offset + 400)) batch.delete(entry.ref);
    await batch.commit();
  }
  const operations: Array<{ path: string[]; data: Record<string, unknown> }> = [];
  for (const documentRecord of documents) operations.push({ path: ["users", uid, "documents", documentRecord.hash], data: { ...documentRecord, importedAt: serverTimestamp() } });
  for (const item of transactions) operations.push({ path: ["users", uid, "transactions", `${item.documentHash}-${item.id}`], data: { ...item, importedAt: serverTimestamp() } });
  for (let offset = 0; offset < operations.length; offset += 400) {
    const batch = writeBatch(db);
    for (const operation of operations.slice(offset, offset + 400)) batch.set(doc(db, operation.path.join("/")), operation.data, { merge: true });
    await batch.commit();
  }
}

