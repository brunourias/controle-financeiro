import { getApps, initializeApp } from "firebase/app";
import { getAuth, GoogleAuthProvider, onAuthStateChanged, signInWithPopup, signOut, type User } from "firebase/auth";
import { collection, doc, getDoc, getDocs, getFirestore, serverTimestamp, writeBatch } from "firebase/firestore";
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

export async function reclassifyFinancialHistory(uid: string, transactions: ParsedTransaction[]) {
  if (!db) return { transactions, corrected: 0 };
  const correctedTransactions = transactions.map((item) => ({ ...item, category: categorize(item.description) }));
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

export async function saveFinancialImport(uid: string, documents: CloudDocument[], transactions: ParsedTransaction[]) {
  if (!db) throw new Error("Firebase ainda não foi configurado.");
  const operations: Array<{ path: string[]; data: Record<string, unknown> }> = [];
  for (const documentRecord of documents) operations.push({ path: ["users", uid, "documents", documentRecord.hash], data: { ...documentRecord, importedAt: serverTimestamp() } });
  for (const item of transactions) operations.push({ path: ["users", uid, "transactions", `${item.documentHash}-${item.id}`], data: { ...item, importedAt: serverTimestamp() } });
  for (let offset = 0; offset < operations.length; offset += 400) {
    const batch = writeBatch(db);
    for (const operation of operations.slice(offset, offset + 400)) batch.set(doc(db, operation.path.join("/")), operation.data, { merge: true });
    await batch.commit();
  }
}

