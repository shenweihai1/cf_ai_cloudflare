import { createRoot } from "react-dom/client";
import { App } from "./app";
import "./styles.css";

const root = document.getElementById("app");
if (root) {
  createRoot(root).render(<App />);
}
