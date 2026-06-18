import type { WebToExt } from "./protocol";

interface VsCodeApi {
  postMessage(msg: WebToExt): void;
  getState<T>(): T | undefined;
  setState<T>(state: T): void;
}

declare function acquireVsCodeApi(): VsCodeApi;

export const vscode = acquireVsCodeApi();

export function post(msg: WebToExt): void {
  vscode.postMessage(msg);
}
