import type { BoardToExt } from "./protocol";

interface VsCodeApi {
  postMessage(msg: BoardToExt): void;
  getState<T>(): T | undefined;
  setState<T>(state: T): void;
}

declare function acquireVsCodeApi(): VsCodeApi;

export const vscode = acquireVsCodeApi();

export function post(msg: BoardToExt): void {
  vscode.postMessage(msg);
}
