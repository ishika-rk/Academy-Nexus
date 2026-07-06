import { initializeApp } from "firebase/app";
import { getAnalytics } from "firebase/analytics";
import { getFirestore } from "firebase/firestore";
import { getAuth, GoogleAuthProvider } from "firebase/auth";

const firebaseConfig = {
  apiKey: "AIzaSyCPGGqcQTkpkikVlwy4WrzReyo2QK9J3xs",
  authDomain: "academy-nexus-89e79.firebaseapp.com",
  projectId: "academy-nexus-89e79",
  storageBucket: "academy-nexus-89e79.firebasestorage.app",
  messagingSenderId: "359627934468",
  appId: "1:359627934468:web:b874924e9be8038de25e51",
  measurementId: "G-Q8E6E5699K"
};

const app = initializeApp(firebaseConfig);
export const analytics = getAnalytics(app);
export const db = getFirestore(app);
export const auth = getAuth(app);
export const googleProvider = new GoogleAuthProvider();
