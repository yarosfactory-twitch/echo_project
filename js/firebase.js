// Ініціалізація Firebase (тариф Spark, без Cloud Functions).
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import {
  getAuth, signInAnonymously, onAuthStateChanged,
  GoogleAuthProvider, signInWithPopup, signOut,
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import { getFirestore } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { firebaseConfig } from "./config.js";

export {
  doc, collection, getDoc, getDocs, setDoc, updateDoc, deleteDoc, onSnapshot,
  query, where, orderBy, limit, serverTimestamp, writeBatch, deleteField,
  increment, arrayUnion,
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

export const app = initializeApp(firebaseConfig);
export const auth = getAuth(app);
export const db = getFirestore(app);
export { onAuthStateChanged, signOut };

/** Поточний користувач після відновлення сесії (або null). */
export function waitForUser() {
  return new Promise((resolve) => {
    const off = onAuthStateChanged(auth, (user) => { off(); resolve(user); });
  });
}

/** Гравці: анонімний акаунт Firebase. UID живе в браузері, тож після
 *  перезавантаження гравець повертається на своє місце. */
export async function ensureAnonUser() {
  const user = await waitForUser();
  if (user) return user;
  return (await signInAnonymously(auth)).user;
}

/** Ведучий: вхід через Google. */
export async function signInHost() {
  return (await signInWithPopup(auth, new GoogleAuthProvider())).user;
}
