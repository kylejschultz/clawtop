import { createState, reduceDashboard, type DashboardAction, type DashboardState } from "./model.js";

export class DashboardStore {
  private value: DashboardState;
  private readonly listeners = new Set<(state: DashboardState) => void>();
  constructor(mode: "demo" | "live") { this.value = createState(mode); }
  get(): DashboardState { return this.value; }
  dispatch = (action: DashboardAction): void => {
    this.value = reduceDashboard(this.value, action);
    for (const listener of this.listeners) listener(this.value);
  };
  subscribe(listener: (state: DashboardState) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}
