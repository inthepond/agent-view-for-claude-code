import React from "react";
import { createRoot } from "react-dom/client";
import { BoardApp } from "./BoardApp";
import "./board.css";

const root = createRoot(document.getElementById("root")!);
root.render(
  <React.StrictMode>
    <BoardApp />
  </React.StrictMode>,
);
