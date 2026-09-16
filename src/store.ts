import type { HistoryStore } from "./history.js";
import { createState, reduceDashboard, type DashboardAction, type DashboardState } from "./model.js";

export class DashboardStore {
  private value: DashboardState;
  private readonly listeners = new Set<(state: DashboardState) => void>();
  constructor(mode: "demo" | "live", private readonly history?: HistoryStore) { this.value = createState(mode); }
  get(): DashboardState { return this.value; }
  dispatch = (action: DashboardAction): void => {
    const previous = this.value;
    this.value = reduceDashboard(this.value, action);
    if (action.type === "snapshot" && this.history) {
      const sessions = { ...this.value.sessions };
      for (const [key, session] of Object.entries(sessions)) if (session.gatewayId === action.gateway.id) sessions[key] = this.history.restore(session);
      this.value = { ...this.value, sessions };
    }
    this.history?.persist(previous, this.value);
    for (const listener of this.listeners) listener(this.value);
  };
  subscribe(listener: (state: DashboardState) => void): () => void { this.listeners.add(listener); return () => this.listeners.delete(listener); }
}
